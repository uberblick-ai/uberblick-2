/** The browser-side client for `ub open`'s two read-only API endpoints. */

import { canonicalDocumentUuid } from "@uberblick/schema";
import { mintHubAuthMessage } from "../collab/rooms.js";

export interface DocumentSearchResult {
  readonly hits: readonly string[];
  readonly limit: number;
  readonly capped: boolean;
}

export interface DocumentSearchStatus {
  readonly caughtUp: boolean;
  readonly rooms: Readonly<Record<string, { readonly hubAcked: boolean }>>;
}

export interface DocumentSearchClient {
  search(query: string, signal: AbortSignal): Promise<DocumentSearchResult>;
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

function searchResult(body: Record<string, unknown>): DocumentSearchResult {
  if (
    !Array.isArray(body.hits) ||
    !Number.isInteger(body.limit) ||
    (body.limit as number) < 1 ||
    typeof body.capped !== "boolean"
  ) {
    throw new Error("ub open returned a malformed search answer");
  }
  const hits = body.hits.map((value) => {
    const uuid = canonicalDocumentUuid(object(value)?.uuid);
    if (uuid === null) throw new Error("ub open returned a malformed search hit");
    return uuid;
  });
  return { hits, limit: body.limit as number, capped: body.capped };
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
    search: async (query, signal) =>
      searchResult(await get(`/api/search?${new URLSearchParams({ q: query })}`, signal)),
    status: async (signal) => searchStatus(await get("/api/status", signal)),
  };
}
