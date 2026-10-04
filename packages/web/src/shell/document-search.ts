/** The browser-side client for `ub open`'s read-only status endpoint. */

import { mintHubAuthMessage } from "../collab/rooms.js";

export interface DocumentSearchStatus {
  readonly caughtUp: boolean;
  readonly rooms: Readonly<Record<string, { readonly hubAcked: boolean }>>;
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
  if (!response.ok) throw new Error(`ub open answered ${response.status}`);
  const body = object(await response.json());
  if (body === null) throw new Error("ub open returned a malformed JSON answer");
  return body;
}

function searchStatus(body: Record<string, unknown>): DocumentSearchStatus {
  const rooms = object(body.rooms);
  if (
    typeof body.caughtUp !== "boolean" ||
    rooms === null ||
    Array.isArray(body.rooms)
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
  return { caughtUp: body.caughtUp, rooms: parsed };
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
