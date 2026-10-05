/**
 * The sync protocol version, and the envelope that carries it.
 *
 * One integer, exchanged at connect and compared for **exact equality** — not a
 * build identity and not a capability negotiation. It answers only "do these
 * two processes speak the same sync language", so a client that has not been
 * updated is refused with a message saying so instead of silently diverging.
 *
 * It lives in `packages/hub` because the wire it rides on is the hub's (the
 * Hocuspocus auth message, defined by `./token.ts`) and the hub is lowest in the
 * dependency graph: web, MCP server and cli all reach it on the leaf subpath
 * `@uberblick/hub/protocol`. One definition, never a local copy.
 */

import { MAX_TOKEN_LENGTH } from "./token.js";

/**
 * The sync language this build speaks.
 *
 * **Bump policy.** Increment it, in the same PR as the change, when a client of
 * the previous version can no longer sync *correctly* against this hub: a
 * different Yjs update encoding, a changed room key, a change in what the auth
 * message means, a document shape one side would apply wrongly. Do **not** bump
 * for anything a mismatched pair survives — a new MCP tool, a UI change, a new
 * claim the far side ignores, a bug fix.
 *
 * Every bump is a flag day: the comparison is exact and nothing negotiates, so
 * a bump nobody needed costs a hand update of every machine, and one that was
 * needed and skipped costs the silent divergence this replaces.
 */
// Structured table cells are incompatible with the shipped protocol-2 clients.
export const SYNC_PROTOCOL_VERSION = 3;

/** Room for the JSON around the token — `{"protocolVersion":1,"token":""}` is 32 characters. */
const ENVELOPE_ALLOWANCE = 128;

/**
 * The longest auth string the hub will look at — **checked before any parse.**
 *
 * {@link MAX_TOKEN_LENGTH} exists so an unauthenticated caller cannot choose how
 * much work the hub does. Parsing the envelope first would hand `JSON.parse` an
 * unbounded string ahead of that check and give the property away; bounding here
 * keeps it, and the token inside is still held to {@link MAX_TOKEN_LENGTH}, so
 * wrapping neither shrinks nor widens the effective ceiling.
 */
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

/**
 * Read an auth string as an envelope, or `null` when it is not one.
 *
 * One answer for every unreadable case — over-long, not JSON, not an object, no
 * usable version or token — because the hub refuses them all the same way, and
 * a bare pre-envelope token is deliberately one of them: the flag day's first
 * deploy refuses every client that has not been updated.
 *
 * Never throws, and the length bound is applied before `JSON.parse` sees the
 * string. See {@link MAX_AUTH_MESSAGE_LENGTH}.
 */
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

/**
 * The refusal sentinel, and the only shape a client will read one from.
 *
 * Hocuspocus forwards a single server-chosen string to a refused client, and the
 * standing rule is that a client never *renders* the hub's text. Strict matching
 * satisfies both: a match yields one validated integer, anything else is today's
 * token rejection. No zero, no leading zeros, at most six digits — the same
 * range {@link isProtocolVersion} accepts.
 */
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

/**
 * What the hub sends a client whose protocol version is not this hub's.
 *
 * Accepted and recorded: this states the hub's protocol version to anyone who
 * connects. It discloses one small integer and nothing else.
 */
export function protocolMismatchReason(
  hubVersion: number = SYNC_PROTOCOL_VERSION,
): string {
  return `protocol-mismatch:${hubVersion}`;
}

/**
 * The hub's protocol version when a refusal is the sentinel naming a version
 * other than ours; `null` otherwise, meaning "handle as an ordinary rejection".
 *
 * A sentinel carrying *our own* integer takes the `null` path: no honest hub
 * sends one — it would be refusing a version it accepts — so believing it would
 * let an endpoint talk this client into an update it does not need.
 */
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
 * What every surface says when the hub refuses a token — MCP's `hub.reason`,
 * the web status line, `ub status`, `ub workspace join` and `ub doctor`.
 *
 * Composed locally and shared so the surfaces cannot drift, and never the hub's
 * own words: the thing being rejected is a token we just sent, so an endpoint
 * that is hostile or merely careless must not get to put text on a status line.
 *
 * It names two causes because the hub cannot tell them apart: an *older* hub
 * reads this client's envelope as unparseable and answers `invalid-token`,
 * byte-identical to what a wrong secret produces. That direction is surfaced by
 * wording rather than detection — a credential-free bare retry to tell them
 * apart was declined, being a second auth attempt in the sync path.
 */
export const AUTH_REJECTED =
  "the hub rejected this client's token: the secret is wrong, or this hub is " +
  "older than this client — update the hub";
