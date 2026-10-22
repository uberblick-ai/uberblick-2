import * as Y from "yjs";
import { isDocId, type RevisionEntry } from "@uberblick/schema";
import type { Replicas } from "./replica.js";

export type RevisionClientFailure =
  | "local-only"
  | "unreachable"
  | "sign-in-required"
  | "forbidden"
  | "deleted"
  | "revision-not-found"
  | "unsupported";

const failureMessages: Record<RevisionClientFailure, string> = {
  "local-only": "Automatic revisions are unavailable in a local-only workspace.",
  unreachable: "The hub could not serve document revisions within the allowed wait.",
  "sign-in-required": "Sign in to read document revisions.",
  forbidden: "The hub refused access to document revisions.",
  deleted: "The document was permanently deleted.",
  "revision-not-found": "The revision does not belong to this document or does not exist.",
  unsupported: "This hub does not serve automatic document revisions.",
};

export class RevisionClientError extends Error {
  constructor(readonly code: RevisionClientFailure) {
    super(failureMessages[code]);
    this.name = "RevisionClientError";
  }
}

export interface RevisionReadOptions {
  /** One bound covering room admission and the revision reply. Defaults to 5 seconds. */
  timeoutMs?: number;
}

function room(replicas: Replicas, uuid: string): string {
  if (!isDocId(uuid)) throw new TypeError("A canonical document UUID is required.");
  if (replicas.config.localWorkspace === true) throw new RevisionClientError("local-only");
  if (replicas.isDeleted(uuid)) throw new RevisionClientError("deleted");
  return replicas.replica(uuid).room;
}

/** Read the hub's history, including archived documents, without using local snapshots. */
export async function listDocumentRevisions(
  replicas: Replicas,
  uuid: string,
  options: RevisionReadOptions = {},
): Promise<RevisionEntry[]> {
  const response = await replicas.sync.requestRevisions(room(replicas, uuid), { operation: "list" }, options.timeoutMs);
  if (!response.ok) throw new RevisionClientError(response.error === "unavailable" ? "unreachable" : response.error);
  if (!("revisions" in response)) throw new RevisionClientError("unsupported");
  return response.revisions;
}

/** A detached read-only view: it has no provider or write-back route to the document. */
export async function getDocumentRevision(
  replicas: Replicas,
  uuid: string,
  revisionId: string,
  options: RevisionReadOptions = {},
): Promise<Y.Doc> {
  const response = await replicas.sync.requestRevisions(room(replicas, uuid), { operation: "get", revisionId }, options.timeoutMs);
  if (!response.ok) throw new RevisionClientError(response.error === "unavailable" ? "unreachable" : response.error);
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
