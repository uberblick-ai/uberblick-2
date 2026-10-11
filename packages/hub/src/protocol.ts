import { MAX_TOKEN_LENGTH } from "./token.js";

/**
 * One shared version, compared for exact equality before sign-in and at connect.
 * Bump with incompatible Yjs encoding, room keys, auth meaning, document shapes,
 * or GitHub start/collect/cancel and claim-state APIs; compatible additions need no bump.
 * Keep the empty-token renewal probe stable across versions: check version first,
 * return 409 status:protocol-mismatch with reason:protocol-mismatch:<hubVersion>
 * on skew or 401 status:sign-in-required on equality, with no state change.
 * Exact comparison requires all peers to update.
 */
export const SYNC_PROTOCOL_VERSION = 3;

/** Room for the JSON around the token — `{"protocolVersion":1,"token":""}` is 32 characters. */
const ENVELOPE_ALLOWANCE = 128;

/** Bound before parsing; the wrapped token still has its own MAX_TOKEN_LENGTH ceiling. */
export const MAX_AUTH_MESSAGE_LENGTH = MAX_TOKEN_LENGTH + ENVELOPE_ALLOWANCE;

/** What a client puts in the auth message: its protocol version and its token. */
export interface AuthEnvelope {
  protocolVersion: number;
  token: string;
}

/** Wrap a freshly minted token for the wire. The token inside is unchanged. */
export function wrapToken(
  token: string,
  protocolVersion: number = SYNC_PROTOCOL_VERSION,
): string {
  return JSON.stringify({ protocolVersion, token } satisfies AuthEnvelope);
}

/** Never throws; bound before JSON.parse and refuse malformed envelopes or bare tokens alike. */
export function readAuthEnvelope(raw: string): AuthEnvelope | null {
  if (raw.length > MAX_AUTH_MESSAGE_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { protocolVersion, token } = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(protocolVersion) ||
    (protocolVersion as number) < 1 ||
    typeof token !== "string"
  ) {
    return null;
  }
  return { protocolVersion: protocolVersion as number, token };
}

/** Parse only a canonical 1..999999 sentinel; never render arbitrary hub refusal text. */
const MISMATCH = /^protocol-mismatch:([1-9]\d{0,5})$/;

/** The largest version the wire can carry, which is what the sentinel bounds. */
const MAX_PROTOCOL_VERSION = 999_999;

/** Whether a value is a protocol version this wire can carry: an integer 1..999999. */
export function isProtocolVersion(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_PROTOCOL_VERSION
  );
}

/** Public refusal exposes only the hub's protocol integer. */
export function protocolMismatchReason(
  hubVersion: number = SYNC_PROTOCOL_VERSION,
): string {
  return `protocol-mismatch:${hubVersion}`;
}

/** Treat malformed or same-version sentinels as ordinary rejections, avoiding a false update. */
export function readProtocolMismatch(
  reason: string,
  ourVersion: number = SYNC_PROTOCOL_VERSION,
): number | null {
  const matched = MISMATCH.exec(reason);
  if (matched === null) {
    return null;
  }
  const hubVersion = Number(matched[1]);
  return hubVersion === ourVersion ? null : hubVersion;
}

/** Which side has to be updated, composed from two integers we already hold. */
export function protocolSkew(hubVersion: number, ourVersion: number): string {
  return `this client speaks sync protocol ${ourVersion} and the hub speaks ${hubVersion} — update ${
    hubVersion > ourVersion ? "this client" : "the hub"
  }`;
}

/**
 * Shared locally composed status text: a wrong secret and an older hub's
 * invalid-token reply are indistinguishable. Do not retry bare tokens to detect
 * the cause or let arbitrary hub text reach a status surface.
 */
export const AUTH_REJECTED =
  "the hub rejected this client's token: the secret is wrong, or this hub is " +
  "older than this client — update the hub";
