import { createHash } from "node:crypto";
import * as Y from "yjs";
import { getDirectoryEntry, getMeta, isDocId, snapshotRevision, type RevisionEntry, type RevisionRequest } from "@uberblick/schema";
import type { Replicas } from "./replica.js";

export type RevisionClientFailure =
  | "local-only"
  | "unreachable"
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

function room(replicas: Replicas, uuid: string): string {
  if (!isDocId(uuid)) throw new TypeError("A canonical document UUID is required.");
  requireDocumentHistory(replicas, uuid);
  if (replicas.config.localWorkspace === true) throw new RevisionClientError("local-only");
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

/** Read the hub's history, including archived documents, without using local snapshots. */
export async function listDocumentRevisions(
  replicas: Replicas,
  uuid: string,
  options: RevisionReadOptions = {},
): Promise<RevisionEntry[]> {
  const response = await requestRevisions(replicas, uuid, {
    operation: "list", ...(options.includeNames === true ? { includeNames: true } : {}),
    ...(options.includeTitles === true ? { includeTitles: true } : {}),
  }, options);
  if (!response.ok) throw new RevisionClientError(response.error === "unavailable" ? "unreachable" : response.error,
    response.error === "deleted" ? { uuid } : {});
  if (!("revisions" in response)) throw new RevisionClientError("unsupported");
  return response.revisions;
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

/** A detached read-only view: it has no provider or write-back route to the document. */
export async function getDocumentRevision(
  replicas: Replicas,
  uuid: string,
  revisionId: string,
  options: RevisionReadOptions = {},
): Promise<Y.Doc> {
  const response = await requestRevisions(replicas, uuid, { operation: "get", revisionId }, options);
  if (!response.ok) throw new RevisionClientError(response.error === "unavailable" ? "unreachable" : response.error,
    response.error === "deleted" ? { uuid } : {});
  if (!("state" in response)) throw new RevisionClientError("unsupported");
  const snapshot = new Y.Doc();
  try {
    Y.applyUpdate(snapshot, response.state);
    return snapshot;
  } catch {
    snapshot.destroy();
    throw new RevisionClientError("unsupported");
  }
}
