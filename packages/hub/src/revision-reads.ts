import { createHash } from "node:crypto";
import type { Connection, Extension, onStatelessPayload } from "@hocuspocus/server";
import { encodeRevisionCatalogChanged, encodeRevisionResponseFrames, getMeta, parseRoom, readRevisionRequest, type RevisionEntry, type RevisionName,
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

function catalogVersion(request: RevisionRequest, revisions: RevisionEntry[], missingTitles: string[] = []): string {
  // A canonical checksum fixes the title. Only failed title lookups distinguish
  // an incomplete reply from the complete catalog, without decoding to validate it.
  return createHash("sha256").update(JSON.stringify([
    request.includeNames === true, request.includeTitles === true, revisions, missingTitles,
  ])).digest("hex");
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
      } else if (!database.revisions.enabled || parseRoom(documentName).uuid.startsWith("_") || getMeta(document).kind === "decision") {
        response = { requestId: request.requestId, ok: false, error: "unsupported" };
      } else if (request.operation === "list") {
        const names = request.includeNames ? database.revisions.names(documentName) : undefined;
        const canWrite = !connection.readOnly && !database.isArchivedRoom(documentName);
        const entries = database.revisions.list(documentName).map(revision =>
          this.entry(revision, names?.get(revision.id), request.includeNames === true, canWrite));
        const version = catalogVersion(request, entries);
        if (request.ifVersion === version) {
          response = { requestId: request.requestId, ok: true, unchanged: true, version };
        } else {
          const missingTitles: string[] = [];
          const revisions = entries.map(entry => {
            if (!request.includeTitles) return entry;
            const title = this.title(documentName, entry.id);
            if (title.title === undefined) missingTitles.push(entry.id);
            return { ...entry, ...title };
          });
          response = { requestId: request.requestId, ok: true, revisions,
            version: missingTitles.length === 0 ? version : catalogVersion(request, entries, missingTitles) };
        }
      } else if (request.operation === "get") {
        const revisionId = request.revisionId ?? "";
        const snapshot = database.revisions.getSnapshot(documentName, revisionId);
        response = snapshot === null ? { requestId: request.requestId, ok: false, error: "revision-not-found" }
          : { requestId: request.requestId, ok: true, revisionId, ...snapshot };
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
        ? revisions.rename(room, request.revisionId ?? "", request.name ?? "", {
          principalId, surface: request.surface ?? { kind: "unknown", name: "unknown" },
        })
        : revisions.removeName(room, request.revisionId ?? "");
    if (!result.ok) return { requestId: request.requestId, ok: false, error: result.error,
      ...(!("name" in result) || result.name === undefined ? {} : { name: this.name(result.name) }) };
    // Naming has committed, even if constructing the private reply fails below.
    if (request.operation !== "restore") document.broadcastStateless(encodeRevisionCatalogChanged());
    const revision = revisions.list(room).find(entry => entry.id === result.id);
    if (revision === undefined) throw new Error("written revision missing");
    return { requestId: request.requestId, ok: true, revision: this.entry(revision,
      revisions.names(room).get(result.id), true),
      ...("applied" in result && typeof result.applied === "boolean" ? { applied: result.applied } : {}) };
  }

  private author(author: UpdateAuthor | null): RevisionEntry["author"] {
    const username = author === null ? null : this.options.username(author.principalId);
    return username === null || author === null ? null : { githubUsername: username,
      surface: { kind: author.surface.kind, name: author.surface.name } };
  }

  private name(name: StoredRevisionName, canWrite = true): RevisionName {
    return { text: name.text, namer: this.author(name.namer), namedAt: name.namedAt,
      canManage: canWrite };
  }

  private entry(revision: StoredRevision, name: StoredRevisionName | undefined,
    includeNames: boolean, canWrite = true): RevisionEntry {
    return { ...revision, author: this.author(revision.author),
      ...(includeNames ? { name: name === undefined ? null : this.name(name, canWrite) } : {}) };
  }
}
