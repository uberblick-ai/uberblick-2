/** Additive requests use the document's existing authenticated room. */
export interface RevisionEntry {
  id: string;
  author: { githubUsername: string; surface: { kind: string; name: string } } | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface RevisionRequest {
  requestId: string;
  operation: "list" | "get";
  revisionId?: string;
}

export type RevisionResponse = { requestId: string; ok: true; revisions: RevisionEntry[] }
  | { requestId: string; ok: true; state: Uint8Array }
  | { requestId: string; ok: false; error: "unsupported" | "deleted" | "revision-not-found" | "forbidden" | "unavailable" };

const REQUEST = "uberblick:revision-request";
const RESPONSE = "uberblick:revision-response";
const CHUNK = "uberblick:revision-response-chunk";
const CHUNK_LENGTH = 512 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function json(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return object(value) ? value : null;
  } catch { return null; }
}

export function encodeRevisionRequest(request: RevisionRequest): string {
  return JSON.stringify({ type: REQUEST, ...request });
}

export function readRevisionRequest(raw: string): RevisionRequest | null {
  if (raw.length > 1024) return null;
  const value = json(raw);
  if (value?.type !== REQUEST || !identifier(value.requestId)) return null;
  if (value.operation === "list") return { requestId: value.requestId, operation: "list" };
  return value.operation === "get" && identifier(value.revisionId)
    ? { requestId: value.requestId, operation: "get", revisionId: value.revisionId } : null;
}

function encodeBytes(state: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < state.length; offset += 32_768) {
    binary += String.fromCharCode(...state.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export function encodeRevisionResponse(response: RevisionResponse): string {
  return JSON.stringify({ type: RESPONSE, ...response,
    ...("state" in response ? { state: encodeBytes(response.state) } : {}) });
}

/** Chunk the encoded reply so even a long history stays below the per-message ceiling. */
export function encodeRevisionResponseFrames(response: RevisionResponse): string[] {
  const encoded = encodeRevisionResponse(response);
  if (encoded.length <= CHUNK_LENGTH) return [encoded];
  const total = Math.ceil(encoded.length / CHUNK_LENGTH);
  return Array.from({ length: total }, (_, index) => JSON.stringify({ type: CHUNK,
    requestId: response.requestId, index, total, chunk: encoded.slice(index * CHUNK_LENGTH, (index + 1) * CHUNK_LENGTH) }));
}

function timestamp(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function entry(value: unknown): value is RevisionEntry {
  if (!object(value) || !identifier(value.id) || !timestamp(value.startedAt) || !timestamp(value.endedAt)) return false;
  const author = value.author;
  return author === null || (object(author) && typeof author.githubUsername === "string" &&
    object(author.surface) && typeof author.surface.kind === "string" && typeof author.surface.name === "string");
}

export function readRevisionResponse(raw: string): RevisionResponse | null {
  const value = json(raw);
  if (value?.type !== RESPONSE || !identifier(value.requestId)) return null;
  const requestId = value.requestId;
  if (value.ok === false && ["unsupported", "deleted", "revision-not-found", "forbidden", "unavailable"].includes(String(value.error))) {
    return { requestId, ok: false, error: value.error as Extract<RevisionResponse, { ok: false }>["error"] };
  }
  if (value.ok !== true) return null;
  if (Array.isArray(value.revisions) && value.revisions.every(entry)) return { requestId, ok: true, revisions: value.revisions };
  if (typeof value.state !== "string") return null;
  try {
    return { requestId, ok: true, state: Uint8Array.from(atob(value.state), character => character.charCodeAt(0)) };
  } catch { return null; }
}

/** Each request owns its assembly and deadline; unrelated room traffic is ignored. */
export function createRevisionResponseReader(requestId: string): (raw: string) => RevisionResponse | null {
  const chunks = new Map<number, string>();
  let expected: number | undefined;
  return (raw) => {
    const response = readRevisionResponse(raw);
    if (response !== null) return response.requestId === requestId ? response : null;
    if (raw.length > CHUNK_LENGTH * 6 + 1024) return null;
    const value = json(raw);
    if (value?.type !== CHUNK || value.requestId !== requestId ||
      !Number.isSafeInteger(value.index) || !Number.isSafeInteger(value.total) ||
      (value.total as number) < 1 || (value.total as number) > 1_000_000 ||
      (value.index as number) < 0 || (value.index as number) >= (value.total as number) ||
      typeof value.chunk !== "string" || value.chunk.length > CHUNK_LENGTH) return null;
    if (expected !== undefined && expected !== value.total) return null;
    expected = value.total as number;
    chunks.set(value.index as number, value.chunk);
    if (chunks.size !== expected) return null;
    const complete = readRevisionResponse(Array.from({ length: expected }, (_, index) => chunks.get(index) ?? "").join(""));
    chunks.clear();
    return complete?.requestId === requestId ? complete : null;
  };
}
