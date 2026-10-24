import { createHash } from "node:crypto";
import * as Y from "yjs";
import { isDocId, snapshotRevision, type RevisionEntry, type RevisionRequest } from "@uberblick/schema";
import type { Replicas } from "./replica.js";

export type RevisionClientFailure =
  | "local-only"
  | "unreachable"
  | "sign-in-required"
  | "forbidden"
  | "deleted"
  | "revision-not-found"
  | "unsupported"
  | "stale-state"
  | "invalid-name"
  | "already-named"
  | "not-namer"
  | "archived"
  | "naming-outcome-unknown";

const failureMessages: Record<RevisionClientFailure, string> = {
  "local-only": "Automatic revisions are unavailable in a local-only workspace.",
  unreachable: "The hub could not serve document revisions within the allowed wait.",
  "sign-in-required": "Sign in to read document revisions.",
  forbidden: "The hub refused access to document revisions.",
  deleted: "The document was permanently deleted.",
  "revision-not-found": "The revision does not belong to this document or does not exist.",
  unsupported: "This hub does not serve automatic document revisions.",
  "stale-state": "The displayed document differs from the hub or has changes awaiting synchronization. Nothing was named.",
  "invalid-name": "A revision name must contain 1 to 100 characters on one line.",
  "already-named": "This document state already has a name.",
  "not-namer": "Only the account that named this revision may change or remove its name.",
  archived: "Archived documents are read-only and cannot be named.",
  "naming-outcome-unknown": "The hub did not acknowledge the naming request; its outcome is unknown.",
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

function room(replicas: Replicas, uuid: string): string {
  if (!isDocId(uuid)) throw new TypeError("A canonical document UUID is required.");
  if (replicas.config.localWorkspace === true) throw new RevisionClientError("local-only");
  if (replicas.isDeleted(uuid)) throw new RevisionClientError("deleted", { uuid });
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
