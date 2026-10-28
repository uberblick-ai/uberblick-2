import * as Y from "yjs";
import { readRevisionResponse, snapshotRevision } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import { mintHubAuthMessage } from "../collab/rooms.js";
import { localSessionHeaders } from "../collab/local-session.js";
import { revisionSurface } from "../revision-attribution.js";

const unavailableMessages = {
  "local-only": "History is unavailable in a local-only workspace.",
  unreachable: "History is unavailable: the hub cannot be reached.",
  "not-downloaded": "Connect once to download history.",
  downloading: "History is still downloading. It will open when ready.",
  "sign-in-required": "History is unavailable: sign in to the hub on this computer.",
  forbidden: "History is unavailable: the hub refused access.",
  deleted: "History is unavailable: this document was deleted.",
  "revision-not-found": "History is unavailable: this revision no longer exists.",
  unsupported: "History is unavailable: this hub does not serve revisions.",
  "stale-state": "This document has changed or is not synced. Wait for sync, review the current content and try naming it again.",
  "invalid-name": "Use a name of 1 to 100 characters on one line.",
  "already-named": "This revision already has a name. Open history to see it.",
  archived: "Archived documents are read-only. Restore the document before changing revision names.",
  "restore-outcome-unknown": "The restore may have completed. Review the latest document and history before trying again.",
};

export class DocumentHistoryError extends Error {
  readonly history: DocumentHistoryStatus | undefined;
  readonly revision: string | undefined;
  constructor(readonly reason?: string, message?: string, details?: { history?: DocumentHistoryStatus | undefined; revision?: string }) {
    super(message ?? (reason === "not-downloaded" && details?.revision !== undefined
      ? `Revision “${details.revision}” is not downloaded on this computer. Connect to download it.`
      : reason !== undefined && Object.hasOwn(unavailableMessages, reason)
      ? unavailableMessages[reason as keyof typeof unavailableMessages]
      : "History is unavailable. Try again."));
    this.history = details?.history;
    this.revision = details?.revision;
  }
}

export interface DocumentHistoryStatus {
  complete: boolean;
  lastRefresh: string | null;
  refreshFailed: boolean;
  offline: boolean;
  newestDownloadedRevision: string | null;
}
export interface DocumentHistoryList { revisions: RevisionEntry[]; history: DocumentHistoryStatus }
export interface DocumentHistoryReadOptions { refresh?: true }

function readHistoryStatus(value: unknown): DocumentHistoryStatus | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const status = value as Record<string, unknown>;
  return typeof status.complete === "boolean" && typeof status.refreshFailed === "boolean" && typeof status.offline === "boolean" &&
    (status.lastRefresh === null || typeof status.lastRefresh === "string") &&
    (status.newestDownloadedRevision === null || typeof status.newestDownloadedRevision === "string")
    ? status as unknown as DocumentHistoryStatus : undefined;
}

export interface RestoredRevision { revision: RevisionEntry; applied: boolean }

export interface DocumentRevisionsClient {
  list(uuid: string, signal: AbortSignal, options?: DocumentHistoryReadOptions): Promise<DocumentHistoryList>;
  get(uuid: string, revision: string, signal: AbortSignal): Promise<Y.Doc>;
  name(uuid: string, name: string, checksum: string, signal: AbortSignal): Promise<RevisionEntry>;
  rename(uuid: string, revisionId: string, name: string, signal: AbortSignal): Promise<RevisionEntry>;
  removeName(uuid: string, revisionId: string, signal: AbortSignal): Promise<RevisionEntry>;
  restore(uuid: string, revisionId: string, checksum: string, signal: AbortSignal): Promise<RestoredRevision>;
}

/** Capture the displayed content before hashing can yield to incoming edits. */
export async function documentRevisionChecksum(document: Y.Doc): Promise<string> {
  const checksum = snapshotRevision(document).checksum;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(checksum));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function createDocumentRevisionsClient(
  workspace: string,
  subject: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): DocumentRevisionsClient {
  const continuations = new Map<string, string>();
  const generations = new Map<string, number>();
  const headers = async () => ({ Accept: "application/json", Authorization: `Bearer ${await mintHubAuthMessage(workspace, subject)}`,
    ...await localSessionHeaders() });
  const request = async (uuid: string, revision: string | null, signal: AbortSignal, options?: DocumentHistoryReadOptions) => {
    const key = JSON.stringify([uuid, revision, options?.refresh === true]);
    const generation = generations.get(uuid) ?? 0;
    const path = `/api/revisions?uuid=${encodeURIComponent(uuid)}${revision === null ? "" : `&revision=${encodeURIComponent(revision)}`}${options?.refresh ? "&refresh=true" : ""}`;
    const read = async (readId?: string) => {
      const response = await fetchImpl(`${path}${readId === undefined ? "" : `&readId=${encodeURIComponent(readId)}`}`, {
        cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), headers: await headers(),
      });
      return { response, body: await response.json() };
    };
    const readId = continuations.get(key);
    let answer = await read(readId);
    if (answer.response.status === 400 && answer.body?.error === "invalid_history_read" && readId !== undefined) {
      continuations.delete(key);
      answer = await read();
    }
    const { response, body } = answer;
    if ((generations.get(uuid) ?? 0) === generation) {
      continuations.delete(key);
      if (!signal.aborted && body?.reason === "downloading" && typeof body?.readId === "string") continuations.set(key, body.readId);
    }
    const history = readHistoryStatus(body?.history);
    if (!response.ok) throw new DocumentHistoryError(typeof body?.reason === "string" ? body.reason : undefined, undefined,
      { history, ...(typeof body?.revision === "string" ? { revision: body.revision } : revision === null ? {} : { revision }) });
    const { history: _history, ...payload } = body ?? {};
    const parsed = readRevisionResponse(JSON.stringify({ ...payload, type: "uberblick:revision-response", requestId: "http", ok: true }));
    if (parsed === null || !parsed.ok || history === undefined) throw new DocumentHistoryError();
    return { payload: parsed, history };
  };
  const write = async (uuid: string, operation: Record<string, string>, signal: AbortSignal): Promise<RestoredRevision> => {
    generations.set(uuid, (generations.get(uuid) ?? 0) + 1);
    continuations.delete(JSON.stringify([uuid, null, true]));
    const response = await fetchImpl("/api/revisions", {
      method: "POST", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { ...await headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, ...operation }),
    });
    const body = await response.json();
    if (!response.ok) {
      if (operation.operation === "restore" && body?.reason === "stale-state") {
        throw new DocumentHistoryError("stale-state", "This document changed. Review the newer changes in history and try again.");
      }
      if (operation.operation === "restore" && body?.reason === "archived") {
        throw new DocumentHistoryError("archived", "This document is archived. Restore the document first, then restore a revision.");
      }
      if (body?.reason === "already-named" && typeof body?.existingName?.text === "string") {
        const namer = body.existingName.namer;
        const surface = revisionSurface({
          kind: typeof namer?.surface?.kind === "string" ? namer.surface.kind : undefined,
          name: typeof namer?.surface?.name === "string" ? namer.surface.name : undefined,
        }, "namer");
        const by = typeof namer?.githubUsername === "string" ? ` by ${[namer.githubUsername, surface].filter(Boolean).join(" ")}` : "";
        throw new Error(`This revision is already named “${body.existingName.text}”${by}. Open history to see it.`);
      }
      throw new DocumentHistoryError(typeof body?.reason === "string" ? body.reason : undefined);
    }
    const parsed = readRevisionResponse(JSON.stringify({ ...body, type: "uberblick:revision-response", requestId: "http", ok: true }));
    if (parsed === null || !parsed.ok || !("revision" in parsed)) throw new DocumentHistoryError();
    if (operation.operation === "restore" && !("applied" in parsed)) throw new DocumentHistoryError();
    generations.set(uuid, (generations.get(uuid) ?? 0) + 1);
    continuations.delete(JSON.stringify([uuid, null, true]));
    return { revision: parsed.revision, applied: !("applied" in parsed) || parsed.applied !== false };
  };
  return {
    name: async (uuid, name, checksum, signal) => (await write(uuid, { operation: "name", name, expectedHash: checksum }, signal)).revision,
    rename: async (uuid, revisionId, name, signal) => (await write(uuid, { operation: "rename", revisionId, name }, signal)).revision,
    removeName: async (uuid, revisionId, signal) => (await write(uuid, { operation: "remove_name", revisionId }, signal)).revision,
    restore: async (uuid, revisionId, checksum, signal) => {
      try { return await write(uuid, { operation: "restore", revisionId, expectedHash: checksum }, signal); }
      catch (error) {
        if (error instanceof DocumentHistoryError && error.reason !== undefined && error.reason !== "unreachable") throw error;
        throw new DocumentHistoryError("unreachable", "The restore may have completed. Review the latest document and history before trying again.");
      }
    },
    list: async (uuid, signal, options) => {
      const { payload: response, history } = await request(uuid, null, signal, options);
      if (!("revisions" in response)) throw new DocumentHistoryError();
      return { revisions: response.revisions, history };
    },
    get: async (uuid, revision, signal) => {
      const { payload: response } = await request(uuid, revision, signal);
      if (!("state" in response)) throw new DocumentHistoryError();
      const doc = new Y.Doc();
      try { Y.applyUpdate(doc, response.state); return doc; }
      catch { doc.destroy(); throw new DocumentHistoryError(); }
    },
  };
}
