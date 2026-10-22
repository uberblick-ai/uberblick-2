/** Unsigned write provenance travels with exact Yjs update bytes, never awareness. */
export interface UpdateSurface {
  kind: string;
  name: string;
}

export interface UpdateOriginMetadata {
  updateId: string;
  credentialId: string | null;
  surface: UpdateSurface | null;
}

export interface OriginUpdate {
  updateId: string;
  origin: UpdateOriginMetadata | null;
  update: Uint8Array;
}

export interface OriginUpdateAck {
  updateId: string;
  applied: boolean;
}

const UPDATE_TYPE = "uberblick:origin-update";
const ACK_TYPE = "uberblick:origin-ack";
// The sync endpoint already bounds the whole encoded WebSocket message to 16 MiB.
const MAX_MESSAGE_LENGTH = 16 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function updateId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function readJson(raw: string): Record<string, unknown> | null {
  if (raw.length > MAX_MESSAGE_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return object(value) ? value : null;
  } catch {
    return null;
  }
}

function metadata(value: unknown, id: string): UpdateOriginMetadata | null {
  if (!object(value) || value.updateId !== id ||
      (value.credentialId !== null && typeof value.credentialId !== "string")) return null;
  const surface = value.surface;
  if (surface !== null && (!object(surface) ||
      typeof surface.kind !== "string" || surface.kind.trim() === "" ||
      typeof surface.name !== "string" || surface.name.trim() === "")) return null;
  return {
    updateId: id,
    credentialId: value.credentialId as string | null,
    surface: surface === null ? null : {
      kind: surface.kind as string,
      name: surface.name as string,
    },
  };
}

/** Use browser primitives so the shared wire format needs no Node dependency. */
export function encodeOriginUpdate(
  id: string,
  update: Uint8Array,
  origin: UpdateOriginMetadata | null,
): string {
  let binary = "";
  for (let offset = 0; offset < update.length; offset += 32_768) {
    binary += String.fromCharCode(...update.subarray(offset, offset + 32_768));
  }
  return JSON.stringify({ type: UPDATE_TYPE, updateId: id, origin, update: btoa(binary) });
}

/** Invalid provenance only downgrades authorship; invalid update envelopes refuse. */
export function readOriginUpdate(raw: string): OriginUpdate | null {
  const value = readJson(raw);
  if (value?.type !== UPDATE_TYPE || !updateId(value.updateId) || typeof value.update !== "string") return null;
  try {
    const binary = atob(value.update);
    const update = Uint8Array.from(binary, character => character.charCodeAt(0));
    return { updateId: value.updateId, origin: metadata(value.origin, value.updateId), update };
  } catch {
    return null;
  }
}

export function encodeOriginAck(id: string, applied: boolean): string {
  return JSON.stringify({ type: ACK_TYPE, updateId: id, applied });
}

export function readOriginAck(raw: string): OriginUpdateAck | null {
  const value = readJson(raw);
  return value?.type === ACK_TYPE && updateId(value.updateId) && typeof value.applied === "boolean"
    ? { updateId: value.updateId, applied: value.applied } : null;
}
