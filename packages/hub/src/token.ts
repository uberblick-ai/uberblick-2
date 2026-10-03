/**
 * Hub auth tokens, and the credential a client mints them with.
 *
 * A token is claims-shaped, not an opaque shared string:
 *
 *     base64url(payloadJson) "." base64url(hmacSha256(key, payloadPart))
 *
 * with payload `{typ, sub, workspace, scope, kid, iat, exp}`. The signature
 * covers the base64url payload *string* (not the raw JSON), so verification
 * never has to re-serialise and canonicalisation questions never arise.
 *
 * Why claims and not a shared secret compare: the hub is headed for a hosted
 * life with several workspaces and several accounts, and the room key already
 * carries the workspace (`<workspaceId>/<docUuid>`). A token that says *who*,
 * *which workspace*, *under which key* and *for how long* lets the hub scope
 * and bound a connection from day one, so nothing has to be migrated later.
 *
 * **The key type is the contract.** {@link mintToken} and {@link verifyToken}
 * take a `CryptoKey` and nothing else: there is no overload accepting a
 * credential string, a root secret or raw bytes, so no caller can confuse the
 * three. A key reaches them one of two ways:
 *
 *   - {@link importRootSecret} — the hub's root secret, the UTF-8 bytes of the
 *     configured string. Today the hub verifies with it and three clients mint
 *     with it — `mcp-server/src/sync.ts`, `web/src/collab/rooms.ts` and the
 *     web demo script — which is not a boundary but the "Known limits" note
 *     below, stated as code: one dev secret, held by everyone. (`ub` itself
 *     never calls this; it mints through `HubSync`.) The ladder that ends this
 *     replaces those three call sites with credential keys.
 *   - {@link importCredentialKey} — the 32 raw bytes a client parsed out of its
 *     credential with {@link parseCredential}. Credential keys are independent
 *     random bytes issued by the hub's registry; neither the root secret nor
 *     another device's key can derive them.
 *
 * Why WebCrypto and not `node:crypto`: the same module runs in the browser
 * client and in Node (hub, MCP server), so it must not import a Node builtin.
 * `globalThis.crypto.subtle` exists in both.
 *
 * **There is no v1 compatibility branch.** A token without `typ` and `exp` is
 * refused. Every client in the repo mints the v2 shape; a long-running MCP
 * server or a deployed bundle from before this change must be restarted or
 * redeployed.
 *
 * Live admission still uses the root secret shared by every client. The
 * credential registry and its admission path are built separately, pending
 * the coordinated hub and client switch.
 */

import { parseWorkspaceId } from "@uberblick/schema";

/** What a token is allowed to do. Read-only connections can sync down only. */
export type TokenScope = "read-write" | "read-only";

export const TOKEN_SCOPES: readonly TokenScope[] = ["read-write", "read-only"];

/**
 * What the token authorises. `room` is the only type today; the audience-bound
 * `admin` type arrives with the hub's admin HTTP surface, and the field exists
 * now so that surface is a new value rather than a new shape.
 */
export type TokenType = "room";

/**
 * The longest life the hub will honour, whatever the minter claimed.
 *
 * Every MCP server and every `ub` mints locally — offline-first requires it —
 * so without a hub-side ceiling a compromised machine mints a decade-long token
 * and exfiltrates *that* instead of the key, leaving revocation as the only
 * remaining lever. Token lifetime is a hub property, not a minter's courtesy.
 */
export const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;

/**
 * How far ahead of the hub a client's clock may be and still be believed.
 *
 * Applied to `iat` only. Grace at both ends would compound — a token issued 60 s
 * ahead and honoured 60 s past its expiry lives 1020 s against a 900 s ceiling —
 * and it would buy nothing: a room token is minted per connect, so it is
 * seconds old when the hub reads it and needs no slack at the far end. A clock
 * skewed further than this is a configuration fault, and `ub doctor` names it.
 */
export const CLOCK_SKEW_SECONDS = 60;

/**
 * The longest a token may be — 4096 characters, which for a base64url token is
 * 4 KiB. A real one is a few hundred bytes.
 *
 * Both ends hold it. {@link inspectToken} refuses anything longer before it
 * decodes or parses, so an unauthenticated caller cannot choose how much work
 * the hub does; {@link mintToken} refuses to produce one, because the hub must
 * not sign what it will not accept.
 */
export const MAX_TOKEN_LENGTH = 4096;

export interface TokenClaims {
  typ: TokenType;
  /** Who the token was issued to — a user or agent session identifier. */
  sub: string;
  /** The workspace whose rooms this token may open. */
  workspace: string;
  scope: TokenScope;
  /**
   * Which key signed this, as a lookup hint the hub may read *before* it has
   * verified anything — never as authority. `null` means the root secret; a
   * credential id means that credential's independently issued key.
   */
  kid: string | null;
  /** Issued at, whole seconds since the epoch. */
  iat: number;
  /** Expires at, whole seconds since the epoch. */
  exp: number;
}

/**
 * Claims to mint. `iat` defaults to now; everything else is explicit.
 *
 * `lifetimeSeconds` has no default on purpose: a minting site that forgets it
 * fails to compile rather than quietly inheriting somebody else's idea of how
 * long a token should live.
 */
export type TokenRequest = Omit<TokenClaims, "iat" | "exp"> & {
  lifetimeSeconds: number;
  iat?: number;
};

const SEPARATOR = ".";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function isTokenScope(value: unknown): value is TokenScope {
  return TOKEN_SCOPES.includes(value as TokenScope);
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Unpadded base64url and nothing else — no padding, no `+`/`/`, no whitespace. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decode **canonical** unpadded base64url, or throw. Callers treat a throw as
 * "not a token" and "not a credential" respectively.
 *
 * Strict rather than forgiving, in both directions. `atob` implements WHATWG
 * forgiving-base64: it accepts the standard alphabet, padding and interior
 * whitespace, and it silently drops the unused bits of the final character — so
 * several different strings decode to the same bytes. Every one of those
 * spellings would otherwise be accepted as the same token or credential.
 *
 * The alphabet check rejects the first three; re-encoding rejects the fourth,
 * which is the only cheap way to insist on exactly one spelling. The
 * consequence worth naming: **a token string is canonical**, so a replay cache
 * (#242) may key on the string itself rather than on its decoded claims.
 */
function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value)) {
    throw new Error("not canonical base64url");
  }
  const binary = globalThis.atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (base64urlEncode(bytes) !== value) {
    throw new Error("not canonical base64url");
  }
  return bytes;
}

function hmacKey(bytes: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    // Copied into a fresh buffer: `importKey` will not take a view over a
    // `SharedArrayBuffer`, and a caller's `Uint8Array` may be one.
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * The hub's root secret as a signing key: the **UTF-8 bytes of the string**.
 *
 * The encoding is the wire format — change it and every token minted anywhere
 * stops verifying — so it is stated once, here, and reproduced nowhere.
 */
export async function importRootSecret(secret: string): Promise<CryptoKey> {
  if (secret === "") {
    throw new Error("importRootSecret: the root secret must not be empty");
  }
  return hmacKey(textEncoder.encode(secret));
}

// --- the credential contract -------------------------------------------------

/**
 * The credential string's prefix, and the version of everything below it: the
 * base64url key encoding and the checksum. A future
 * format is `ubc2`, never a reinterpretation of this one.
 */
const CREDENTIAL_PREFIX = "ubc1";

/**
 * The credential's field separator. Its own constant even though a token's
 * happens to be the same character: these are two wire formats, and a change to
 * one must not silently change the other.
 */
const CREDENTIAL_SEPARATOR = ".";

/** A credential key's independent random bytes. */
const CREDENTIAL_KEY_BYTES = 32;

/** Those 32 bytes as unpadded base64url: one length, one spelling. */
const CREDENTIAL_KEY_CHARS = 43;

/** A credential id, and the same 8-4-4-4-12 lowercase spelling as a uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The 32 raw bytes of a credential key as a signing key — what a client does
 * with what {@link parseCredential} handed it.
 */
export async function importCredentialKey(
  keyBytes: Uint8Array,
): Promise<CryptoKey> {
  if (keyBytes.length !== CREDENTIAL_KEY_BYTES) {
    throw new Error(
      `importCredentialKey: a credential key is ${CREDENTIAL_KEY_BYTES} bytes, got ${keyBytes.length}`,
    );
  }
  return hmacKey(keyBytes);
}

/**
 * CRC-32 (IEEE 802.3, reflected, init/final `0xffffffff`) over `text`'s UTF-8
 * bytes, as 8 lowercase hex digits.
 *
 * **A typo detector, explicitly not a security control.** It catches a
 * credential that was truncated by a line wrap or mistyped by a hand; it
 * catches nothing an adversary does, since anyone editing the string can
 * recompute it. The security of a credential is entirely in the 32 secret bytes
 * it carries.
 *
 * CRC-32 rather than a hash because it is synchronous and dependency-free,
 * which is what lets {@link parseCredential} diagnose a bad credential on the
 * boot path with no WebCrypto call and no network.
 */
function crc32Hex(text: string): string {
  let crc = 0xffffffff;
  for (const byte of textEncoder.encode(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      // 0xedb88320, the reflection of the CRC-32 polynomial 0x04c11db7 —
      // bit-at-a-time, because a table would be more code than this is worth.
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export interface CredentialParts {
  workspaceUuid: string;
  credId: string;
  /** The 32 raw bytes of `K_c`. */
  keyBytes: Uint8Array;
}

/** Why a string is not a credential. Stable strings: a caller may branch. */
export type CredentialProblem =
  /** Not a `ubc1` credential at all — wrong prefix, or not five segments. */
  | "not-a-credential"
  | "malformed-workspace"
  | "malformed-cred-id"
  | "malformed-key"
  /** It reads as a credential, but one character of it is wrong. */
  | "checksum-mismatch";

export type ParsedCredential = CredentialParts | { invalid: CredentialProblem };

/**
 * Render a credential for its holder:
 * `ubc1.<workspace>.<credId>.<key>.<checksum>`.
 *
 * `<key>` is base64url of the 32 raw `K_c` bytes — the holder imports exactly
 * those bytes. `<workspace>` is a single-workspace boot hint in this format;
 * the hub registry remains the authority for the credential's workspace set.
 * `<checksum>` is {@link crc32Hex} over everything before it.
 *
 * Issued by the hub. There is no other writer.
 */
export function formatCredential({
  workspaceUuid,
  credId,
  keyBytes,
}: CredentialParts): string {
  if (!isWorkspace(workspaceUuid)) {
    throw new Error(
      "formatCredential: workspaceUuid must be a workspace uuid, undecorated",
    );
  }
  if (!UUID.test(credId)) {
    throw new Error("formatCredential: credId must be a uuid");
  }
  if (keyBytes.length !== CREDENTIAL_KEY_BYTES) {
    throw new Error(
      `formatCredential: a credential key is ${CREDENTIAL_KEY_BYTES} bytes, got ${keyBytes.length}`,
    );
  }
  const body = [
    CREDENTIAL_PREFIX,
    workspaceUuid,
    credId,
    base64urlEncode(keyBytes),
  ].join(CREDENTIAL_SEPARATOR);
  return `${body}${CREDENTIAL_SEPARATOR}${crc32Hex(body)}`;
}

/**
 * Read a credential, or say what is wrong with it.
 *
 * **Synchronous, and it touches neither crypto nor the network** — that is the
 * point of it. A client reads its credential on the boot path, where the hub
 * may be unreachable and where refusing to start would break offline-first; a
 * mistyped credential has to be diagnosable there, locally, before anything
 * dials.
 *
 * The cheap syntactic checks run first and the checksum last: a segment count
 * or a key length is free to check and names the fault precisely, while the
 * checksum is the catch-all that turns "this looks right but one character of
 * it is wrong" into a refusal instead of an opaque auth failure later.
 */
export function parseCredential(value: string): ParsedCredential {
  const parts = value.split(CREDENTIAL_SEPARATOR);
  if (parts.length !== 5 || parts[0] !== CREDENTIAL_PREFIX) {
    return { invalid: "not-a-credential" };
  }
  const [, workspaceUuid, credId, key, checksum] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (!isWorkspace(workspaceUuid)) {
    return { invalid: "malformed-workspace" };
  }
  if (!UUID.test(credId)) {
    return { invalid: "malformed-cred-id" };
  }

  // 32 bytes are exactly 43 unpadded base64url characters. Checked before the
  // decode so a padded, standard-alphabet or whitespace-bearing spelling of the
  // right bytes is refused rather than quietly normalised into a credential.
  if (key.length !== CREDENTIAL_KEY_CHARS || !BASE64URL.test(key)) {
    return { invalid: "malformed-key" };
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64urlDecode(key);
  } catch {
    return { invalid: "malformed-key" };
  }
  if (keyBytes.length !== CREDENTIAL_KEY_BYTES) {
    return { invalid: "malformed-key" };
  }

  const body = [CREDENTIAL_PREFIX, workspaceUuid, credId, key].join(
    CREDENTIAL_SEPARATOR,
  );
  if (checksum !== crc32Hex(body)) {
    return { invalid: "checksum-mismatch" };
  }

  return { workspaceUuid, credId, keyBytes };
}

// --- minting and verification ------------------------------------------------

function assertClaims(claims: TokenRequest): void {
  if (claims.typ !== "room") {
    throw new Error(`mintToken: unknown typ ${JSON.stringify(claims.typ)}`);
  }
  if (!isSubject(claims.sub)) {
    throw new Error("mintToken: sub must be a non-empty string");
  }
  if (!isWorkspace(claims.workspace)) {
    throw new Error(
      "mintToken: workspace must be a workspace uuid, undecorated — a " +
        "<slug>-<uuid> spelling is not an identity",
    );
  }
  if (!isTokenScope(claims.scope)) {
    throw new Error(`mintToken: unknown scope ${JSON.stringify(claims.scope)}`);
  }
  if (!isKeyId(claims.kid)) {
    throw new Error("mintToken: kid must be a credential uuid or null");
  }
  if (claims.iat !== undefined && !isEpochSeconds(claims.iat)) {
    throw new Error("mintToken: iat must be a non-negative integer");
  }
  if (
    !Number.isInteger(claims.lifetimeSeconds) ||
    claims.lifetimeSeconds <= 0 ||
    claims.lifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    // The hub must not sign what it will not accept: the ceiling applies to the
    // mint as well as to the clamp, so a caller learns at the call site rather
    // than from a refused connection.
    throw new Error(
      `mintToken: lifetimeSeconds must be a positive integer no greater than ${MAX_TOKEN_LIFETIME_SECONDS}`,
    );
  }
}

/** Who the token is for. Any non-empty string, on both sides of a token. */
function isSubject(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Whole seconds since the epoch. The same rule on both sides of a token.
 *
 * `isSafeInteger`, not `isInteger`: past 2^53 integer arithmetic stops being
 * exact, so `exp - iat` would no longer mean what the clamp reads it as.
 */
function isEpochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A credential id, or `null` for the root secret. Nothing else is a `kid`. */
function isKeyId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID.test(value));
}

/**
 * A workspace claim is the workspace's **bare uuid** — never a decorated
 * `<slug>-<uuid>` spelling of it.
 *
 * `onAuthenticate` compares this claim against the room's workspace segment as
 * a string, and room names carry the bare uuid, so a decorated claim would sign
 * a token the hub then refuses on every room in the workspace it names. Mint
 * and verify apply the same rule: the hub must not sign what it will not
 * accept.
 */
function isWorkspace(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return parseWorkspaceId(value).uuid === value;
  } catch {
    return false;
  }
}

/**
 * Mint a signed token under `key` — a root secret imported with
 * {@link importRootSecret}, or a credential key imported with
 * {@link importCredentialKey}. There is no overload taking either of those in
 * its unimported form: the key type is what keeps a credential string from
 * being mistaken for a secret.
 */
export async function mintToken(
  key: CryptoKey,
  claims: TokenRequest,
): Promise<string> {
  assertClaims(claims);

  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  const exp = iat + claims.lifetimeSeconds;
  if (!isEpochSeconds(exp)) {
    // Reachable only from an `iat` near the end of the safe integers, which
    // passed its own check while their sum does not.
    throw new Error("mintToken: iat + lifetimeSeconds is not a whole second");
  }
  const payload: TokenClaims = {
    typ: claims.typ,
    sub: claims.sub,
    workspace: claims.workspace,
    scope: claims.scope,
    kid: claims.kid,
    iat,
    exp,
  };
  const payloadPart = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(payloadPart),
  );

  const minted = `${payloadPart}${SEPARATOR}${base64urlEncode(new Uint8Array(signature))}`;
  // The hub must not sign what it will not accept: `verifyToken` refuses a
  // token past this length, and `sub` is the one claim long enough to reach it.
  if (minted.length > MAX_TOKEN_LENGTH) {
    throw new Error(
      `mintToken: the token would be ${minted.length} characters, past the ${MAX_TOKEN_LENGTH} a token may be — sub is too long`,
    );
  }
  return minted;
}

function parseClaims(payload: Record<string, unknown>): TokenClaims | null {
  const { typ, sub, workspace, scope, kid, iat, exp } = payload;
  // `typ` and `exp` are also what refuses a v1 token: it carries neither, so it
  // is not a token, whoever signed it. There is no compatibility branch.
  if (typ !== "room") {
    return null;
  }
  if (!isSubject(sub)) {
    return null;
  }
  if (!isWorkspace(workspace)) {
    return null;
  }
  if (!isTokenScope(scope)) {
    return null;
  }
  if (!isKeyId(kid)) {
    return null;
  }
  if (!isEpochSeconds(iat) || !isEpochSeconds(exp) || exp <= iat) {
    return null;
  }
  return { typ, sub, workspace, scope, kid, iat, exp };
}

/**
 * Why a token did not verify. The hub's **log** vocabulary, never a wire
 * reason: whoever presented the token still learns only `invalid-token`, so a
 * forged token and a stale one are the same refusal to their sender.
 */
export type TokenFailure =
  /**
   * Not a token at all: not two segments, not canonical base64url, or a payload
   * that is not a JSON object. Nothing about it can be believed or reported.
   */
  | "unparseable"
  /** A readable payload signed by some key that is not the one presented here. */
  | "bad-signature"
  /**
   * Correctly signed, but no mint could have produced these claims — a pre-v2
   * token carrying no `typ`/`exp`, an unknown scope, a slug-decorated
   * workspace. This is what a client from before the claims-v2 deploy looks
   * like, which is why it is its own cause and not "invalid".
   */
  | "unsupported-claims";

/**
 * What a rejected token says about itself — **unverified, for logs only.**
 *
 * The point is precisely the token that did *not* verify: an operator hunting
 * the machine that keeps presenting a stale token needs a name, and by
 * definition cannot have an authenticated one. Never treat these as facts, and
 * never widen this: the signature and the token string stay out, so that what a
 * log line can carry is decided here rather than at each logging site.
 */
export interface TokenIdentity {
  /** The `typ` claim when the payload carries one as a string; `null` otherwise — a pre-v2 token has none. */
  typ: string | null;
  /** The `sub` claim when the payload carries one as a string; `null` otherwise. */
  sub: string | null;
}

export interface TokenRejection {
  failure: TokenFailure;
  /** `null` exactly when the failure is `"unparseable"` — nothing was readable. */
  identity: TokenIdentity | null;
}

/**
 * A claim value's length in a log line. A rejected token is unauthenticated
 * input from anywhere, and the hub's log is not its megaphone.
 */
const LOG_FIELD_LIMIT = 128;

function logString(value: unknown): string | null {
  return typeof value === "string" && value !== ""
    ? value.slice(0, LOG_FIELD_LIMIT)
    : null;
}

const UNPARSEABLE: TokenRejection = { failure: "unparseable", identity: null };

interface ParsedToken {
  payloadPart: string;
  signature: Uint8Array<ArrayBuffer>;
  payload: Record<string, unknown>;
}

/** The same bounded, canonical parsing before key lookup and verification. */
function parseToken(token: string): ParsedToken | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(SEPARATOR);
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts;
  if (!payloadPart || !signaturePart) return null;
  try {
    const payload: unknown = JSON.parse(
      textDecoder.decode(base64urlDecode(payloadPart)),
    );
    const signature = base64urlDecode(signaturePart);
    if (typeof payload !== "object" || payload === null) return null;
    return { payloadPart, signature, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Read only an unverified key lookup hint. It grants no authority: the caller
 * still verifies the signature and every claim under the selected key.
 */
export function readTokenKeyId(
  token: string,
): { kid: string | null } | TokenRejection {
  const parsed = parseToken(token);
  if (parsed === null) return UNPARSEABLE;
  const { kid } = parsed.payload;
  return isKeyId(kid)
    ? { kid }
    : {
        failure: "unsupported-claims",
        identity: {
          typ: logString(parsed.payload.typ),
          sub: logString(parsed.payload.sub),
        },
      };
}

/**
 * Verify a token, returning its claims or **why it was refused** — the same
 * decision {@link verifyToken} makes, with the reason kept instead of dropped.
 *
 * For diagnostics, and nothing else: an admission decision reads the claims or
 * refuses, and every failure is the same refusal. What the reason is *for* is
 * the hub's rejection log, where "a fleet of pre-v2 clients" and "somebody
 * signing with the wrong secret" have to read differently.
 *
 * Never throws, and the signature is still checked before the claims are
 * believed — an unverified payload is only ever read for {@link TokenIdentity}.
 */
export async function inspectToken(
  key: CryptoKey,
  token: string,
): Promise<TokenClaims | TokenRejection> {
  const parsed = parseToken(token);
  if (parsed === null) return UNPARSEABLE;
  let signed: boolean;
  try {
    signed = await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      parsed.signature,
      textEncoder.encode(parsed.payloadPart),
    );
  } catch {
    return UNPARSEABLE;
  }
  const claims = parsed.payload;
  const identity: TokenIdentity = {
    typ: logString(claims.typ),
    sub: logString(claims.sub),
  };
  if (!signed) {
    return { failure: "bad-signature", identity };
  }
  return parseClaims(claims) ?? { failure: "unsupported-claims", identity };
}

/**
 * Verify a token and return its claims, or `null` for anything that is not a
 * well-formed, correctly signed token whose claims {@link mintToken} could have
 * produced — the two apply the same rules, so a signed payload with a
 * slug-decorated workspace, a fractional `iat` or no `exp` at all is not a
 * token. Never throws: every rejection reason collapses to `null` so callers
 * cannot accidentally distinguish "bad signature" from "bad shape". A caller
 * that wants the distinction has to ask for it by name — {@link inspectToken} —
 * and the only caller that may is a log line.
 *
 * Time is *not* checked here. Whether a well-signed token is fresh enough to
 * admit is the hub's decision against the hub's clock — {@link clampToken} —
 * and a client verifying its own token has no business making it.
 */
export async function verifyToken(
  key: CryptoKey,
  token: string,
): Promise<TokenClaims | null> {
  const inspected = await inspectToken(key, token);
  return "failure" in inspected ? null : inspected;
}

/** Why a correctly signed token is still not admissible. */
export type ClampFailure =
  /** Longer-lived than {@link MAX_TOKEN_LIFETIME_SECONDS}, whatever it claims. */
  | "lifetime-too-long"
  /** Issued further ahead of the hub's clock than {@link CLOCK_SKEW_SECONDS}. */
  | "not-yet-issued"
  | "expired";

/**
 * The hub's ceiling on a verified token, applied **regardless of what the
 * minter claimed**, and the reason a compromised local minter cannot mint
 * itself a decade.
 *
 * Returns `null` when the token is admissible. Signature verification comes
 * first: this decides freshness, not authenticity.
 */
export function clampToken(
  claims: TokenClaims,
  nowSeconds: number,
): ClampFailure | null {
  if (claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) {
    return "lifetime-too-long";
  }
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    return "not-yet-issued";
  }
  if (nowSeconds > claims.exp) {
    return "expired";
  }
  return null;
}
