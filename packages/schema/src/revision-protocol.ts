/** Additive requests use the document's existing authenticated room. */
export interface RevisionEntry {
  id: string;
  author: { githubUsername: string; surface: { kind: string; name: string } } | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Only sent in response to a list request that opts in to names. */
  name?: RevisionName | null;
  /** Only sent when requested in a list and the stored snapshot title can be read. */
  title?: string;
}

export interface RevisionName {
  text: string;
  namer: RevisionEntry["author"];
  namedAt: number;
  canManage: boolean;
}

export interface RevisionRequest {
  requestId: string;
  operation: "list" | "get" | "name" | "rename" | "remove-name" | "restore";
  revisionId?: string;
  includeNames?: true;
  includeTitles?: true;
  name?: string;
  checksum?: string;
  surface?: { kind: string; name: string };
}

export type RevisionResponse = { requestId: string; ok: true; revisions: RevisionEntry[] }
  | { requestId: string; ok: true; state: Uint8Array }
  | { requestId: string; ok: true; revision: RevisionEntry; applied?: boolean }
  | { requestId: string; ok: false; error: "unsupported" | "deleted" | "revision-not-found" | "forbidden" | "unavailable"
    | "stale-state" | "invalid-name" | "already-named" | "archived"; name?: RevisionName };

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
  if (raw.length > 4096) return null;
  const value = json(raw);
  if (value?.type !== REQUEST || !identifier(value.requestId)) return null;
  const requestId = value.requestId;
  if (value.operation === "list") return { requestId, operation: "list",
    ...(value.includeNames === true ? { includeNames: true } : {}),
    ...(value.includeTitles === true ? { includeTitles: true } : {}) };
  if ((value.operation === "get" || value.operation === "remove-name") && identifier(value.revisionId)) {
    return { requestId, operation: value.operation, revisionId: value.revisionId };
  }
  if (value.operation === "rename" && identifier(value.revisionId)) {
    let surface: RevisionRequest["surface"];
    if (value.surface !== undefined) {
      if (!object(value.surface) || !identifier(value.surface.kind) || !identifier(value.surface.name)) return null;
      surface = { kind: value.surface.kind, name: value.surface.name };
    }
    return { requestId, operation: "rename", revisionId: value.revisionId,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(surface === undefined ? {} : { surface }) };
  }
  return (value.operation === "name" || (value.operation === "restore" && identifier(value.revisionId))) && typeof value.checksum === "string" &&
    /^[a-f0-9]{64}$/.test(value.checksum) && object(value.surface) &&
    identifier(value.surface.kind) && identifier(value.surface.name)
    ? { requestId, operation: value.operation, ...(value.operation === "restore" ? { revisionId: value.revisionId as string }
      : typeof value.name === "string" ? { name: value.name } : {}), checksum: value.checksum,
      surface: { kind: value.surface.kind, name: value.surface.name } } : null;
}

export function validRevisionName(value: string): boolean {
  const length = [...value].length;
  return length >= 1 && length <= 100 && !/[\r\n\u2028\u2029]/u.test(value);
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
  return author(value.author) && (value.name === undefined || value.name === null || revisionName(value.name)) &&
    (value.title === undefined || typeof value.title === "string");
}

function author(value: unknown): boolean {
  return value === null || (object(value) && typeof value.githubUsername === "string" &&
    object(value.surface) && typeof value.surface.kind === "string" && typeof value.surface.name === "string");
}

function revisionName(value: unknown): value is RevisionName {
  return object(value) && typeof value.text === "string" && validRevisionName(value.text) && author(value.namer) &&
    typeof value.namedAt === "number" && Number.isFinite(value.namedAt) && typeof value.canManage === "boolean";
}

export function readRevisionResponse(raw: string): RevisionResponse | null {
  const value = json(raw);
  if (value?.type !== RESPONSE || !identifier(value.requestId)) return null;
  const requestId = value.requestId;
  if (value.ok === false && ["unsupported", "deleted", "revision-not-found", "forbidden", "unavailable",
    "stale-state", "invalid-name", "already-named", "archived"].includes(String(value.error))) {
    if (value.name !== undefined && !revisionName(value.name)) return null;
    return { requestId, ok: false, error: value.error as Extract<RevisionResponse, { ok: false }>["error"],
      ...(value.name === undefined ? {} : { name: value.name as RevisionName }) };
  }
  if (value.ok !== true) return null;
  if (Array.isArray(value.revisions) && value.revisions.every(entry)) return { requestId, ok: true, revisions: value.revisions };
  if (entry(value.revision)) {
    if (value.applied !== undefined && typeof value.applied !== "boolean") return null;
    return { requestId, ok: true, revision: value.revision,
      ...(value.applied === undefined ? {} : { applied: value.applied }) };
  }
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
