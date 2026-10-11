import { MAX_TOKEN_LENGTH } from "./token.js";

/**
 * Shared by hub/clients; exact equality before sign-in and connect, no negotiation.
 * Bump for incompatible Yjs encoding, room keys, auth messages, document shapes,
 * or /auth/github/{start,collect,cancel} and /auth/claim-state semantics; not for
 * compatible tools, UI, ignored claims or fixes. Every bump requires all peers to update.
 * Keep the empty-token /auth/credential/renew probe stable across versions:
 * configured sign-in hubs check version first without state changes, returning
 * 409 protocol-mismatch with reason protocol-mismatch:<hubVersion> on skew,
 * or 401 sign-in-required on equality.
 */
// Structured table cells cannot synchronize with protocol-2 clients.
export const SYNC_PROTOCOL_VERSION = 3;

/** Room for the JSON around the token — `{"protocolVersion":1,"token":""}` is 32 characters. */
const ENVELOPE_ALLOWANCE = 128;

/** Bound envelope parsing first; token inspection still applies MAX_TOKEN_LENGTH. */
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

/** Refuse malformed envelopes and bare tokens as null; bound before parsing, never throw. */
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

/** Parse only a bounded version integer; never render server-chosen refusal text. */
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

/** Public refusal discloses only the hub's protocol integer to any connecting client. */
export function protocolMismatchReason(
  hubVersion: number = SYNC_PROTOCOL_VERSION,
): string {
  return `protocol-mismatch:${hubVersion}`;
}

/** Treat our own version as ordinary rejection, so a hub cannot demand a needless update. */
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
 * Shared local wording, never hub text: older hubs reject envelopes just like
 * wrong secrets. Name both causes without a second auth attempt to distinguish them.
 */
export const AUTH_REJECTED =
  "the hub rejected this client's token: the secret is wrong, or this hub is " +
  "older than this client — update the hub";
