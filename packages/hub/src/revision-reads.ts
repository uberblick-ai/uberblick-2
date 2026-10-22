import type { Connection, Extension, onStatelessPayload } from "@hocuspocus/server";
import { encodeRevisionResponseFrames, parseRoom, readRevisionRequest, type RevisionResponse } from "@uberblick/schema";
import type { HubDatabase } from "./persistence.js";
import type { HubContext } from "./server.js";

export interface RevisionReadsOptions {
  database: HubDatabase;
  assertCurrent(connection: Connection<HubContext>, room: string): void;
  username(principalId: string): string | null;
}

/** Replies stay on the admitted document room and are addressed only to its requester. */
export class RevisionReads implements Extension<HubContext> {
  constructor(private readonly options: RevisionReadsOptions) {}

  onStateless = async ({ connection, documentName, payload }: onStatelessPayload): Promise<void> => {
    const request = readRevisionRequest(payload);
    if (request === null) return;
    const { database } = this.options;
    let response: RevisionResponse;
    // Hocuspocus does not await this hook. Authority and disclosure stay in one
    // synchronous turn so a suspended workspace or revoked device cannot interleave.
    try {
      this.options.assertCurrent(connection, documentName);
    } catch {
      const refusal: RevisionResponse = { requestId: request.requestId, ok: false,
        error: database.isDeletedRoom(documentName) ? "deleted" : "forbidden" };
      for (const frame of encodeRevisionResponseFrames(refusal)) connection.sendStateless(frame);
      return;
    }
    try {
      if (database.isDeletedRoom(documentName)) {
        response = { requestId: request.requestId, ok: false, error: "deleted" };
      } else if (!("principalId" in connection.context)) {
        response = { requestId: request.requestId, ok: false, error: "forbidden" };
      } else if (!database.revisions.enabled || parseRoom(documentName).uuid.startsWith("_")) {
        response = { requestId: request.requestId, ok: false, error: "unsupported" };
      } else if (request.operation === "list") {
        response = { requestId: request.requestId, ok: true, revisions: database.revisions.list(documentName).map(revision => {
          const username = revision.author === null ? null : this.options.username(revision.author.principalId);
          return { ...revision, author: username === null || revision.author === null ? null : {
            githubUsername: username, surface: revision.author.surface,
          } };
        }) };
      } else {
        const state = database.revisions.get(documentName, request.revisionId ?? "");
        response = state === null ? { requestId: request.requestId, ok: false, error: "revision-not-found" }
          : { requestId: request.requestId, ok: true, state };
      }
    } catch {
      response = { requestId: request.requestId, ok: false, error: "unavailable" };
    }
    for (const frame of encodeRevisionResponseFrames(response)) connection.sendStateless(frame);
  };
}
