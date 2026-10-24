import type { Connection, Extension, onStatelessPayload } from "@hocuspocus/server";
import { encodeRevisionResponseFrames, getMeta, parseRoom, readRevisionRequest, type RevisionEntry, type RevisionName,
  type RevisionRequest, type RevisionResponse } from "@uberblick/schema";
import * as Y from "yjs";
import type { HubDatabase } from "./persistence.js";
import type { StoredRevision, StoredRevisionName } from "./revisions.js";
import type { HubContext } from "./server.js";
import type { UpdateAuthor } from "./update-attribution.js";

export interface RevisionReadsOptions {
  database: HubDatabase;
  assertCurrent(connection: Connection<HubContext>, room: string): void;
  username(principalId: string): string | null;
}

/** Replies stay on the admitted document room and are addressed only to its requester. */
export class RevisionReads implements Extension<HubContext> {
  constructor(private readonly options: RevisionReadsOptions) {}

  onStateless = async ({ connection, document, documentName, payload }: onStatelessPayload): Promise<void> => {
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
        const names = request.includeNames ? database.revisions.names(documentName) : undefined;
        const canWrite = !connection.readOnly && !database.isArchivedRoom(documentName);
        response = { requestId: request.requestId, ok: true, revisions: database.revisions.list(documentName).map(revision => ({
          ...this.entry(revision, names?.get(revision.id), connection.context.principalId, request.includeNames === true, canWrite),
          ...(request.includeTitles ? this.title(documentName, revision.id) : {}),
        })) };
      } else if (request.operation === "get") {
        const state = database.revisions.get(documentName, request.revisionId ?? "");
        response = state === null ? { requestId: request.requestId, ok: false, error: "revision-not-found" }
          : { requestId: request.requestId, ok: true, state };
      } else if (connection.readOnly) {
        response = { requestId: request.requestId, ok: false, error: "forbidden" };
      } else if (database.isArchivedRoom(documentName)) {
        response = { requestId: request.requestId, ok: false, error: "archived" };
      } else {
        response = this.write(request, document, documentName, connection.context.principalId);
      }
    } catch {
      response = { requestId: request.requestId, ok: false, error: "unavailable" };
    }
    for (const frame of encodeRevisionResponseFrames(response)) connection.sendStateless(frame);
  };

  private title(room: string, id: string): { title?: string } {
    const document = new Y.Doc();
    try {
      const state = this.options.database.revisions.get(room, id);
      if (state === null) return {};
      Y.applyUpdate(document, state);
      return { title: getMeta(document).title };
    } catch {
      return {};
    } finally {
      document.destroy();
    }
  }

  private write(request: RevisionRequest, document: onStatelessPayload["document"], room: string, principalId: string): RevisionResponse {
    const { revisions } = this.options.database;
    const result = request.operation === "restore"
      ? this.options.database.restoreRevision(room, document, request.checksum ?? "", request.revisionId ?? "", {
        principalId, surface: request.surface ?? { kind: "unknown", name: "unknown" },
      })
      : request.operation === "name"
      ? revisions.name(room, document, request.checksum ?? "", request.name ?? "", {
        principalId, surface: request.surface ?? { kind: "unknown", name: "unknown" },
      })
      : request.operation === "rename"
        ? revisions.rename(room, request.revisionId ?? "", request.name ?? "", principalId)
        : revisions.removeName(room, request.revisionId ?? "", principalId);
    if (!result.ok) return { requestId: request.requestId, ok: false, error: result.error,
      ...(!("name" in result) || result.name === undefined ? {} : { name: this.name(result.name, principalId) }) };
    const revision = revisions.list(room).find(entry => entry.id === result.id);
    if (revision === undefined) throw new Error("written revision missing");
    return { requestId: request.requestId, ok: true, revision: this.entry(revision,
      revisions.names(room).get(result.id), principalId, true),
      ...("applied" in result && typeof result.applied === "boolean" ? { applied: result.applied } : {}) };
  }

  private author(author: UpdateAuthor | null): RevisionEntry["author"] {
    const username = author === null ? null : this.options.username(author.principalId);
    return username === null || author === null ? null : { githubUsername: username, surface: author.surface };
  }

  private name(name: StoredRevisionName, principalId: string, canWrite = true): RevisionName {
    return { text: name.text, namer: this.author(name.namer), namedAt: name.namedAt,
      canManage: canWrite && name.namer.principalId === principalId };
  }

  private entry(revision: StoredRevision, name: StoredRevisionName | undefined, principalId: string,
    includeNames: boolean, canWrite = true): RevisionEntry {
    return { ...revision, author: this.author(revision.author),
      ...(includeNames ? { name: name === undefined ? null : this.name(name, principalId, canWrite) } : {}) };
  }
}
