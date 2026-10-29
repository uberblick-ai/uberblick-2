import { createHash } from "node:crypto";
import type * as Y from "yjs";
import { getDirectoryEntry, getMeta, isDocId, snapshotRevision, type RevisionEntry, type RevisionRequest } from "@uberblick/schema";
import type { Replicas } from "./replica.js";
import { HistoryMirrorCache } from "./history-mirror-cache.js";
import { HistoryReader } from "./history-reader.js";
import { HubHistoryClock } from "./history-clock.js";
import { workspaceHistoryStamp } from "./workspace-history.js";
import { CacheError } from "./history-mirror.js";
export type { HistoryReadStatus } from "./history-reader.js";

export type RevisionClientFailure =
  | "local-only"
  | "unreachable"
  | "not-downloaded"
  | "downloading"
  | "sign-in-required"
  | "forbidden"
  | "deleted"
  | "decision-no-history"
  | "revision-not-found"
  | "unsupported"
  | "stale-state"
  | "invalid-name"
  | "already-named"
  | "archived"
  | "naming-outcome-unknown"
  | "restore-outcome-unknown";

const failureMessages: Record<RevisionClientFailure, string> = {
  "local-only": "Automatic revisions are unavailable in a local-only workspace.",
  unreachable: "The hub could not serve document revisions within the allowed wait.",
  "not-downloaded": "This history is not downloaded. Connect once to download history.",
  downloading: "History is still downloading. Read it again shortly.",
  "sign-in-required": "Sign in to read document revisions.",
  forbidden: "The hub refused access to document revisions.",
  deleted: "The document was permanently deleted.",
  "decision-no-history": "Decision records have no history; the topic's record timeline is their history.",
  "revision-not-found": "The revision does not belong to this document or does not exist.",
  unsupported: "This hub does not serve automatic document revisions.",
  "stale-state": "The displayed document differs from the hub or has changes awaiting synchronization. Nothing was changed.",
  "invalid-name": "A revision name must contain 1 to 100 characters on one line.",
  "already-named": "This document state already has a name.",
  archived: "Archived documents are read-only; restore the archived document before changing its revisions.",
  "naming-outcome-unknown": "The hub did not acknowledge the naming request; its outcome is unknown.",
  "restore-outcome-unknown": "The hub did not acknowledge the revision restore request; its outcome is unknown.",
};

export class RevisionClientError extends Error {
  constructor(readonly code: RevisionClientFailure, readonly details: Record<string, unknown> = {}) {
    super(failureMessages[code]);
    this.name = "RevisionClientError";
  }
}

export interface RevisionReadOptions {
  /** One bound covering room admission and the revision reply. Defaults to 5 seconds. */
  timeoutMs?: number;
  includeNames?: boolean;
  includeTitles?: boolean;
  /** Explicitly revalidate the cached catalog, including after an unknown mutation outcome. */
  refresh?: true;
}

const readers = new WeakMap<Replicas, { reader: HistoryReader; clock: HubHistoryClock }>();

function historyReader(replicas: Replicas): HistoryReader {
  const existing = readers.get(replicas);
  if (existing !== undefined) return existing.reader;
  const { config, store, sync } = replicas;
  const clock = new HubHistoryClock(config.hubUrl);
  const cache = new HistoryMirrorCache(store.databasePath, config.workspaceId, config.deviceLogin?.env ?? config.authEnv ?? process.env);
  const reader = new HistoryReader({
    stamp: () => workspaceHistoryStamp(replicas),
    connected: () => sync.state().status === "connected",
    requireHistory: uuid => { roomGuard(replicas, uuid); },
    request: async (uuid, operation) => {
      const stamp = workspaceHistoryStamp(replicas);
      if (stamp === null) throw new RevisionClientError("sign-in-required");
      const attached = room(replicas, uuid);
      try { await clock.ensure(); }
      catch (error) {
        clock.reset();
        throw error;
      }
      const admitted = sync.historyAccount(attached);
      if (JSON.stringify(workspaceHistoryStamp(replicas)) !== JSON.stringify(stamp) ||
        (admitted !== null && admitted !== stamp.account)) throw new RevisionClientError("sign-in-required");
      const response = await sync.requestRevisions(attached, operation, 30_000);
      requireDocumentHistory(replicas, uuid);
      if (JSON.stringify(workspaceHistoryStamp(replicas)) !== JSON.stringify(stamp) || sync.historyAccount(attached) !== stamp.account) {
        throw new RevisionClientError("sign-in-required");
      }
      return response;
    },
    now: () => clock.now(),
    retention: () => store.readHistoryRetention(),
  }, cache);
  readers.set(replicas, { reader, clock });
  return reader;
}

export async function closeDocumentHistory(replicas: Replicas): Promise<void> {
  const current = readers.get(replicas);
  if (current === undefined) return;
  current.clock.close();
  await current.reader.close();
}

/** Refuse history before hydration, writable-state checks or hub requests. */
export function requireDocumentHistory(replicas: Replicas, uuid: string): void {
  if (replicas.isDeleted(uuid)) throw new RevisionClientError("deleted", { uuid });
  const stub = getDirectoryEntry(replicas.directory().doc, uuid);
  const meta = replicas.hydrated(uuid) ? getMeta(replicas.replica(uuid).doc) : undefined;
  if (stub?.kind === "decision" || meta?.kind === "decision") {
    throw new RevisionClientError("decision-no-history", { uuid, topic: meta?.topic ?? stub?.topic ?? uuid });
  }
}

function roomGuard(replicas: Replicas, uuid: string): void {
  if (!isDocId(uuid)) throw new TypeError("A canonical document UUID is required.");
  requireDocumentHistory(replicas, uuid);
  if (replicas.config.localWorkspace === true) throw new RevisionClientError("local-only");
}

function room(replicas: Replicas, uuid: string): string {
  roomGuard(replicas, uuid);
  return replicas.replica(uuid).room;
}

async function requestRevisions(
  replicas: Replicas,
  uuid: string,
  operation: Omit<RevisionRequest, "requestId">,
  options: RevisionReadOptions,
) {
  try {
    return await replicas.sync.requestRevisions(room(replicas, uuid), operation, options.timeoutMs);
  } catch (error) {
    if (error instanceof RevisionClientError && error.code === "deleted") {
      throw new RevisionClientError("deleted", { ...error.details, uuid });
    }
    throw error;
  }
}

export async function readDocumentHistory(replicas: Replicas, uuid: string, options: RevisionReadOptions = {}) {
  roomGuard(replicas, uuid);
  try { return await historyReader(replicas).list(uuid, options); }
  catch (error) { throw historyReadError(error, uuid); }
}

function historyReadError(error: unknown, uuid: string): unknown {
  if (error instanceof CacheError) return new RevisionClientError(
    error.status === "update-required" ? "unsupported" : "unreachable", { uuid, reason: `cache-${error.status}` });
  return error instanceof RevisionClientError ? new RevisionClientError(error.code, { ...error.details, uuid }) : error;
}

/** Hub-owned naming leaves the local document and its update log unchanged. */
export async function mutateDocumentRevision(
  replicas: Replicas,
  uuid: string,
  mutation: Omit<RevisionRequest, "requestId">,
  options: RevisionReadOptions = {},
): Promise<RevisionEntry> {
  const response = await requestRevisions(replicas, uuid, mutation, options);
  if (!response.ok) {
    if (response.error === "unavailable") {
      throw new RevisionClientError("naming-outcome-unknown", { applied: null, reason: "unreachable" });
    }
    throw new RevisionClientError(response.error,
      { ...(response.error === "deleted" ? { uuid } : {}), ...("name" in response ? { existingName: response.name } : {}) });
  }
  if (!("revision" in response) || response.revision.name === undefined) {
    throw new RevisionClientError("naming-outcome-unknown", { applied: null, reason: "unsupported" });
  }
  try { await historyReader(replicas).writeThrough(uuid, response.revision); }
  catch { /* Hub acknowledgement remains authoritative; the name notice retries the cache refresh. */ }
  return response.revision;
}

/** Restore is hub-owned; normal synchronization delivers the restored content. */
export async function restoreDocumentRevision(
  replicas: Replicas,
  uuid: string,
  mutation: { operation: "restore"; revisionId: string; checksum: string; surface: { kind: string; name: string } },
  options: RevisionReadOptions = {},
): Promise<{ revision: RevisionEntry; applied: boolean }> {
  const response = await requestRevisions(replicas, uuid, mutation, options);
  if (!response.ok) {
    if (response.error === "unavailable") {
      throw new RevisionClientError("restore-outcome-unknown", { applied: null, reason: "unreachable" });
    }
    throw new RevisionClientError(response.error, response.error === "deleted" ? { uuid } : {});
  }
  if (!("revision" in response) || !("applied" in response) || typeof response.applied !== "boolean") {
    throw new RevisionClientError("restore-outcome-unknown", { applied: null, reason: "unsupported" });
  }
  return { revision: response.revision, applied: response.applied };
}

/** The checksum covers exactly the title, visible blocks and data shown to this client. */
export function documentRevisionChecksum(doc: Y.Doc): string {
  return createHash("sha256").update(snapshotRevision(doc).checksum).digest("hex");
}

export async function readDocumentRevision(replicas: Replicas, uuid: string, revisionId: string, options: RevisionReadOptions = {}) {
  roomGuard(replicas, uuid);
  try { return await historyReader(replicas).get(uuid, revisionId, options); }
  catch (error) { throw historyReadError(error, uuid); }
}
