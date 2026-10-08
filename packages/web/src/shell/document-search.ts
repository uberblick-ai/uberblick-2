/** The browser-side client for `ub open`'s read-only status endpoint. */

import { mintHubAuthMessage } from "../collab/rooms.js";

export interface DocumentSearchStatus {
  readonly caughtUp: boolean;
  readonly rooms: Readonly<Record<string, { readonly hubAcked: boolean }>>;
  /** Why this serving run cannot share local edits, absent on older servers. */
  readonly notSharedReason?: NotSharedReason | null;
  readonly replicaUnavailable?: ReplicaUnavailable | null;
}

export type ReplicaUnavailable = "replica-held" | "replica-quarantined" | "replica-failed";

function isReplicaUnavailable(value: unknown): value is ReplicaUnavailable {
  return value === "replica-held" || value === "replica-quarantined" || value === "replica-failed";
}

export type NotSharedReason =
  | "no-hub-credentials"
  | "sign-in-required"
  | "no-workspace-access"
  | "credential-store"
  | "renewal-unavailable";

function isNotSharedReason(value: unknown): value is NotSharedReason {
  return value === "no-hub-credentials" || value === "sign-in-required" ||
    value === "no-workspace-access" || value === "credential-store" ||
    value === "renewal-unavailable";
}

export interface DocumentSearchClient {
  status(signal: AbortSignal): Promise<DocumentSearchStatus>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body = object(await response.json());
  if (body === null) throw new Error("ub open returned a malformed JSON answer");
  if (response.status === 503 && body.error === "replica_unavailable" && isReplicaUnavailable(body.reason)) {
    return { caughtUp: false, rooms: {}, replicaUnavailable: body.reason };
  }
  if (!response.ok) throw new Error(`ub open answered ${response.status}`);
  return body;
}

function searchStatus(body: Record<string, unknown>): DocumentSearchStatus {
  const rooms = object(body.rooms);
  if (
    typeof body.caughtUp !== "boolean" ||
    rooms === null ||
    Array.isArray(body.rooms) ||
    (body.notSharedReason !== undefined &&
      body.notSharedReason !== null &&
      !isNotSharedReason(body.notSharedReason))
  ) {
    throw new Error("ub open returned a malformed status answer");
  }
  const parsed: Record<string, { hubAcked: boolean }> = {};
  for (const [room, value] of Object.entries(rooms)) {
    const status = object(value);
    if (status === null || typeof status.hubAcked !== "boolean") {
      throw new Error("ub open returned a malformed status answer");
    }
    parsed[room] = { hubAcked: status.hubAcked };
  }
  return {
    caughtUp: body.caughtUp,
    rooms: parsed,
    notSharedReason:
      isNotSharedReason(body.notSharedReason) ? body.notSharedReason : null,
    ...(isReplicaUnavailable(body.replicaUnavailable) ? { replicaUnavailable: body.replicaUnavailable } : {}),
  };
}

/**
 * One client for one rendered workspace.
 *
 * The HTTP seam accepts the same protocol envelope as a room connection. A
 * fresh token is minted for every request, so a list left open past the token
 * lifetime keeps working without keeping a credential in a URL or cache.
 */
export function createDocumentSearchClient(
  workspace: string,
  subject: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): DocumentSearchClient {
  const get = async (path: string, signal: AbortSignal): Promise<Record<string, unknown>> =>
    await json(
      await fetchImpl(path, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${await mintHubAuthMessage(workspace, subject)}`,
        },
        signal,
      }),
    );

  return {
    status: async (signal) => searchStatus(await get("/api/status", signal)),
  };
}
