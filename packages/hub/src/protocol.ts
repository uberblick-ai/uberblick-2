/**
 * The sync protocol version, and the envelope that carries it.
 *
 * One integer, exchanged at connect and compared for **exact equality**. It is
 * not a build identity and not a capability negotiation: it answers the single
 * question "do these two processes speak the same sync language", so a client
 * that has not been updated is refused with a message that says so instead of
 * silently diverging from the hub it is talking to.
 *
 * It lives in `packages/hub` rather than in `packages/schema` because the wire
 * it rides on is the hub's — the Hocuspocus auth message, whose contents are
 * defined by `./token.ts` — and because the hub is the lowest of the packages
 * in the dependency graph, so the web client, the MCP server and the cli all
 * reach it on a leaf subpath (`@uberblick/hub/protocol`) without pulling the
 * server in. There is exactly one definition of the number; a client with a
 * local copy is the failure this module exists to prevent.
 */

import { MAX_TOKEN_LENGTH } from "./token.js";

/**
 * The sync language this build speaks. One positive integer, no ranges.
 *
 * **Bump policy.** Increment it, in the same PR as the change, when a client of
 * the previous version can no longer sync *correctly* against this hub: a
 * different Yjs update encoding, a changed room key, a change in what the auth
 * message means, a document shape one side would apply wrongly. Do **not** bump
 * for anything a mismatched pair survives — a new MCP tool, a UI change, a new
 * claim the far side ignores, a bug fix.
 *
 * Every bump is a flag day. The comparison is exact equality and nothing
 * negotiates, so a bump nobody needed costs a hand update of every machine, and
 * one that was needed and skipped costs the silent divergence this replaces.
 */
export const SYNC_PROTOCOL_VERSION = 1;

/**
 * How much room the envelope itself may take on top of the token it wraps.
 *
 * `{"protocolVersion":1,"token":""}` is 32 characters; 128 leaves the version
 * room to grow and the JSON room to escape a token that never needs escaping,
 * without letting the bound drift into "some large number".
 */
const ENVELOPE_ALLOWANCE = 128;

/**
 * The longest auth string the hub will look at — **checked before any parse.**
 *
 * {@link MAX_TOKEN_LENGTH} exists so an unauthenticated caller cannot choose how
 * much work the hub does, and `inspectToken` enforces it before it decodes
 * anything. Wrapping the token in JSON would hand `JSON.parse` an unbounded
 * string ahead of that check and give the property away, so the raw string is
 * bounded here first and the token inside it is still held to
 * {@link MAX_TOKEN_LENGTH} afterwards: wrapping does not shrink the effective
 * ceiling, and it does not widen it either.
 */
export const MAX_AUTH_MESSAGE_LENGTH = MAX_TOKEN_LENGTH + ENVELOPE_ALLOWANCE;

/** What a client puts in the auth message: its protocol version and its token. */
export interface AuthEnvelope {
  protocolVersion: number;
  token: string;
}

/**
 * Wrap a freshly minted token for the wire. The single call every client makes.
 *
 * The signed token is byte-identical inside — no claim, room key or Yjs
 * encoding changes — so this is purely the version travelling beside it.
 */
export function wrapToken(
  token: string,
  protocolVersion: number = SYNC_PROTOCOL_VERSION,
): string {
  return JSON.stringify({ protocolVersion, token } satisfies AuthEnvelope);
}

/**
 * Read an auth string as an envelope, or `null` when it is not one.
 *
 * `null` covers every unreadable case at once — over-long, not JSON, not an
 * object, no usable version or token — because the hub's answer to all of them
 * is the same refusal, and a bare pre-envelope token is one of them by design:
 * the flag day's first deploy refuses every client that has not been updated.
 *
 * Never throws, and the length bound is applied *before* `JSON.parse` ever sees
 * the string. See {@link MAX_AUTH_MESSAGE_LENGTH}.
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

/** The sentinel prefix. Its shape is the contract — see {@link MISMATCH}. */
const MISMATCH_PREFIX = "protocol-mismatch:";

/**
 * The one string a refused client is allowed to learn from, exactly as the hub
 * writes it and exactly as a client reads it back.
 *
 * Hocuspocus forwards a single server-chosen string to the refused client, and
 * the standing rule is that a client never *renders* the hub's text — it is
 * remote text about a token we just sent. Strict matching is what satisfies
 * both: a reason matching this yields one small validated integer and nothing
 * else; anything else is today's token rejection, handled exactly as today.
 *
 * No zero and no leading zeros, at most six digits, so what a client extracts
 * is bounded before it is believed.
 */
const MISMATCH = /^protocol-mismatch:([1-9]\d{0,5})$/;

/**
 * What the hub sends a client whose protocol version is not this hub's.
 *
 * Accepted and recorded: this is an unauthenticated statement of the hub's
 * protocol version to anyone who connects. It discloses one small integer and
 * nothing else — no workspace, no claim, no token.
 */
export function protocolMismatchReason(
  hubVersion: number = SYNC_PROTOCOL_VERSION,
): string {
  return `${MISMATCH_PREFIX}${hubVersion}`;
}

/**
 * The hub's protocol version, when an authentication-failed reason is the
 * mismatch sentinel and names a version other than ours; `null` otherwise.
 *
 * `null` is the instruction to fall through to the existing token-rejection
 * path, and a sentinel carrying *our own* integer takes it: no honest hub sends
 * that — it would be refusing a version it accepts — so believing it would let
 * an endpoint talk this client into an update it does not need.
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

/**
 * Which side has to be updated, in words, for every surface that reports a
 * skew — the MCP server's `hub.reason`, the web status line, `ub status`,
 * `ub remote join` and `ub doctor`.
 *
 * Composed locally from two integers this process either holds or has validated,
 * so no remote text reaches a reader.
 */
export function protocolSkew(hubVersion: number, ourVersion: number): string {
  return hubVersion > ourVersion
    ? `this client speaks sync protocol ${ourVersion} and the hub speaks ${hubVersion} — update this client`
    : `this client speaks sync protocol ${ourVersion} and the hub speaks ${hubVersion} — update the hub`;
}
