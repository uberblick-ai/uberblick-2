import { isCanonicalRoom, isRoomNameWithinBounds, parseRoom } from "@uberblick/schema";
import { readAuthEnvelope } from "@uberblick/schema/protocol";

/** A retired room: clients only drain updates they queued for it before it was retired. */
const LEGACY_ROOM_SUFFIX = "/_feedback";

/**
 * Only canonical rooms become stored rows: an uppercase alias of a deleted uuid
 * would escape its fence, and free-form names give members unbounded storage.
 */
export function isAdmissibleRoom(room: string): boolean {
  if (!isRoomNameWithinBounds(room)) return false;
  return isCanonicalRoom(room) || (room.endsWith(LEGACY_ROOM_SUFFIX) &&
    isCanonicalRoom(`${room.slice(0, -LEGACY_ROOM_SUFFIX.length)}/_directory`));
}

/**
 * Schema owns two-segment room names with a bare workspace UUID.
 * Reject malformed names before they can become authenticated rooms or SQLite keys.
 */
export function roomWorkspace(room: string): string | null {
  try {
    return parseRoom(room).workspaceId;
  } catch {
    return null;
  }
}

/** Reject even empty token query parameters: URLs reach access logs and proxy traces. */
export const TOKEN_QUERY_PARAMS = ["token", "access_token", "auth", "authToken"];

export type AdmissionPrelude =
  | { token: string }
  | { cause: "room-name-invalid" }
  | { cause: "token-in-query"; parameter: string }
  | { cause: "protocol-mismatch"; clientProtocol: number | null };

/**
 * What every room authenticator refuses before inspecting a token, in this
 * order: room bounds, a token in the URL, then the envelope's protocol.
 */
export function readAdmission(
  payload: { documentName: string; requestParameters: URLSearchParams; token: string },
  protocolVersion: number,
): AdmissionPrelude {
  if (!isAdmissibleRoom(payload.documentName)) return { cause: "room-name-invalid" };
  const parameter = TOKEN_QUERY_PARAMS.find((name) => payload.requestParameters.has(name));
  if (parameter !== undefined) return { cause: "token-in-query", parameter };
  // Bound the envelope before parsing; reject skew and bare tokens before trusting claims.
  const envelope = readAuthEnvelope(payload.token);
  return envelope?.protocolVersion === protocolVersion ? { token: envelope.token }
    : { cause: "protocol-mismatch", clientProtocol: envelope?.protocolVersion ?? null };
}
