import * as Y from "yjs";
import { readRevisionResponse } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import { mintHubAuthMessage } from "../collab/rooms.js";
import { localSessionHeaders } from "../collab/local-session.js";

const unavailableMessages = {
  "local-only": "History is unavailable in a local-only workspace.",
  unreachable: "History is unavailable: the hub cannot be reached.",
  "sign-in-required": "History is unavailable: sign in to the hub on this computer.",
  forbidden: "History is unavailable: the hub refused access.",
  deleted: "History is unavailable: this document was deleted.",
  "revision-not-found": "History is unavailable: this revision no longer exists.",
  unsupported: "History is unavailable: this hub does not serve revisions.",
};

export class DocumentHistoryError extends Error {
  constructor(reason?: string) {
    super(reason !== undefined && Object.hasOwn(unavailableMessages, reason)
      ? unavailableMessages[reason as keyof typeof unavailableMessages]
      : "History is unavailable. Try again.");
  }
}

export interface DocumentRevisionsClient {
  list(uuid: string, signal: AbortSignal): Promise<RevisionEntry[]>;
  get(uuid: string, revision: string, signal: AbortSignal): Promise<Y.Doc>;
}

export function createDocumentRevisionsClient(
  workspace: string,
  subject: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): DocumentRevisionsClient {
  const request = async (uuid: string, revision: string | null, signal: AbortSignal) => {
    const path = `/api/revisions?uuid=${encodeURIComponent(uuid)}${revision === null ? "" : `&revision=${encodeURIComponent(revision)}`}`;
    const response = await fetchImpl(path, {
      cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { Accept: "application/json", Authorization: `Bearer ${await mintHubAuthMessage(workspace, subject)}`,
        ...await localSessionHeaders() },
    });
    const body = await response.json();
    if (!response.ok) throw new DocumentHistoryError(typeof body?.reason === "string" ? body.reason : undefined);
    const parsed = readRevisionResponse(JSON.stringify({ ...body, type: "uberblick:revision-response", requestId: "http", ok: true }));
    if (parsed === null || !parsed.ok) throw new DocumentHistoryError();
    return parsed;
  };
  return {
    list: async (uuid, signal) => {
      const response = await request(uuid, null, signal);
      if (!("revisions" in response)) throw new DocumentHistoryError();
      return response.revisions;
    },
    get: async (uuid, revision, signal) => {
      const response = await request(uuid, revision, signal);
      if (!("state" in response)) throw new DocumentHistoryError();
      const doc = new Y.Doc();
      try { Y.applyUpdate(doc, response.state); return doc; }
      catch { doc.destroy(); throw new DocumentHistoryError(); }
    },
  };
}
