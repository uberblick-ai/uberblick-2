/**
 * Wire: base64url(payloadJson) "." base64url(HMAC-SHA256(key, payloadPart)).
 * HMAC covers the encoded payload string, never reserialized JSON. Room claims
 * bind typ, sub, workspace, scope, kid, iat and exp.
 */

import { parseWorkspaceId } from "./workspace.js";
import { isGithubAccountId, isGithubUsername } from "./github-identity.js";

/** What a token is allowed to do. Read-only connections can sync down only. */
export type TokenScope = "read-write" | "read-only";

export const TOKEN_SCOPES: readonly TokenScope[] = ["read-write", "read-only"];

/**
 * What a room token authorises. HTTP request proofs use a separate claims
 * shape and cannot authenticate a room.
 */
export type TokenType = "room";

/**
 * Hub-enforced lifetime ceiling, also checked at minting. Local offline minters
 * cannot extend admission by signing a longer-lived token.
 */
export const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;

/**
 * Future iat grace only; expiry gets none so the lifetime bound cannot compound.
 * Room tokens are minted per connect; larger skew is a clock configuration fault.
 */
export const CLOCK_SKEW_SECONDS = 60;

/** Lifetime of the per-request device sign-in proofs minted by clients. */
export const REQUEST_PROOF_LIFETIME_SECONDS = 60;

/**
 * Bound unauthenticated work before decoding/parsing. Minting uses the same
 * character ceiling so it cannot produce a token readers refuse for length.
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
   * Unverified lookup hint, never authority: null selects the root secret;
   * a credential id selects that credential's independently issued key.
   */
  kid: string | null;
  /** Issued at, whole seconds since the epoch. */
  iat: number;
  /** Expires at, whole seconds since the epoch. */
  exp: number;
}

/**
 * Only iat defaults to now; require an explicit lifetime at every minting site.
 */
export type TokenRequest = Omit<TokenClaims, "iat" | "exp"> & {
  lifetimeSeconds: number;
  iat?: number;
};

/** An HTTP proof binds the operation and every authority-bearing target. */
export type RequestAction =
  | { operation: "renew-credential" }
  | { operation: "promote-workspace"; workspaceId: string; attemptId: string }
  | { operation: "list-devices" }
  | { operation: "own-hub-role" }
  | { operation: "list-hub-admins"; cursor?: string }
  | { operation: "list-hub-workspaces"; cursor?: string }
  | { operation: "remove-hub-admin"; principalId: string }
  | { operation: "revoke-device"; deviceId: string }
  | { operation: "own-role"; workspaceId: string }
  | { operation: "list-members"; workspaceId: string }
  | { operation: "resolve-account"; workspaceId: string; githubUsername: string }
  | { operation: "grant-member"; workspaceId: string; githubAccountId: string; role?: "admin" | "member" }
  | { operation: "change-role"; workspaceId: string; principalId: string; role: "admin" | "member" }
  | { operation: "remove-member"; workspaceId: string; principalId: string };

export type RequestOperation = RequestAction["operation"];

export type RequestProofClaims = RequestAction & {
  typ: "request";
  /** A credential key, never the shared root secret. */
  kid: string;
  iat: number;
  exp: number;
};

export type RequestProofRequest = RequestAction & {
  kid: string;
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
 * Refuse noncanonical tokens/credentials. atob accepts alternate alphabets,
 * padding, whitespace and unused trailing bits; alphabet and round-trip checks
 * enforce one spelling, allowing replay caches to key on the token string.
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

/** Browser and Node share WebCrypto here; importing Node builtins breaks browsers. */
function hmacKey(bytes: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    // Copy caller views: importKey rejects SharedArrayBuffer-backed bytes.
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Loopback uses this shared local secret's UTF-8 bytes; changing the encoding
 * breaks signed tokens. Remote admission uses independent device keys instead.
 */
export async function importRootSecret(secret: string): Promise<CryptoKey> {
  if (secret === "") {
    throw new Error("importRootSecret: the root secret must not be empty");
  }
  return hmacKey(textEncoder.encode(secret));
}

/** A credential key's independent random bytes. */
const CREDENTIAL_KEY_BYTES = 32;

/** A credential id, and the same 8-4-4-4-12 lowercase spelling as a uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Import 32 independent random bytes issued by the hub registry; neither the
 * root secret nor another device's key can derive a credential key.
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
    // Apply the admission ceiling at minting as well as at the hub clamp.
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
 * Both ends require nonnegative safe integer seconds so exp - iat stays exact.
 */
function isEpochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A credential id, or `null` for the root secret. Nothing else is a `kid`. */
function isKeyId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID.test(value));
}

/**
 * Require the canonical bare workspace UUID on mint and verify: admission
 * compares it directly with the room segment, never a decorated display id.
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
 * CryptoKey only: importRootSecret/importCredentialKey must import material
 * first, so raw secrets, credential strings and bytes cannot be confused.
 */
export async function mintToken(
  key: CryptoKey,
  claims: TokenRequest,
): Promise<string> {
  assertClaims(claims);

  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  const exp = iat + claims.lifetimeSeconds;
  if (!isEpochSeconds(exp)) {
    // A valid iat can still overflow safe integer seconds when lifetime is added.
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
  return signClaims(key, payload, "mintToken");
}

/**
 * Bind credential possession to one operation and its targets. Authority still
 * comes from current hub credentials and membership, never signed targets alone.
 */
export async function mintRequestProof(
  key: CryptoKey,
  claims: RequestProofRequest,
): Promise<string> {
  if (typeof claims.kid !== "string" || !UUID.test(claims.kid)) {
    throw new Error("mintRequestProof: kid must be a credential uuid");
  }
  const action = readRequestAction(claims);
  if (action === null) {
    throw new Error("mintRequestProof: unsupported operation or targets");
  }
  if (claims.iat !== undefined && !isEpochSeconds(claims.iat)) {
    throw new Error("mintRequestProof: iat must be a non-negative integer");
  }
  if (
    !Number.isInteger(claims.lifetimeSeconds) ||
    claims.lifetimeSeconds <= 0 ||
    claims.lifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error(
      `mintRequestProof: lifetimeSeconds must be a positive integer no greater than ${MAX_TOKEN_LIFETIME_SECONDS}`,
    );
  }
  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  const exp = iat + claims.lifetimeSeconds;
  if (!isEpochSeconds(exp)) {
    throw new Error("mintRequestProof: iat + lifetimeSeconds is not a whole second");
  }
  return signClaims(
    key,
    { typ: "request", kid: claims.kid, ...action, iat, exp },
    "mintRequestProof",
  );
}

async function signClaims(
  key: CryptoKey,
  payload: TokenClaims | RequestProofClaims,
  source: "mintToken" | "mintRequestProof",
): Promise<string> {
  const payloadPart = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(payloadPart),
  );

  const minted = `${payloadPart}${SEPARATOR}${base64urlEncode(new Uint8Array(signature))}`;
  // Do not mint a token that bounded readers would refuse for length.
  if (minted.length > MAX_TOKEN_LENGTH) {
    throw new Error(
      `${source}: the token would be ${minted.length} characters, past the ${MAX_TOKEN_LENGTH} a token may be`,
    );
  }
  return minted;
}

const REQUEST_TARGET_FIELDS = ["deviceId", "workspaceId", "principalId", "role", "attemptId", "githubUsername", "githubAccountId", "cursor"] as const;

/** Parse target semantics, allowing request/proof metadata but no unrelated targets. */
export function readRequestAction(payload: Record<string, unknown>): RequestAction | null {
  const { operation, deviceId, workspaceId, principalId, role, attemptId, githubUsername, githubAccountId, cursor } = payload;
  let action: RequestAction;
  switch (operation) {
    case "renew-credential":
      // Renewal has no targets and intentionally ignores extra payload fields.
      return { operation };
    case "promote-workspace":
      if (!isWorkspace(workspaceId) || typeof attemptId !== "string" || !UUID.test(attemptId)) return null;
      action = { operation, workspaceId, attemptId };
      break;
    case "list-devices":
    case "own-hub-role":
      action = { operation };
      break;
    case "list-hub-admins":
    case "list-hub-workspaces":
      if (Object.hasOwn(payload, "cursor") && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 160)) return null;
      action = { operation, ...(cursor === undefined ? {} : { cursor: cursor as string }) };
      break;
    case "remove-hub-admin":
      if (!isSubject(principalId)) return null;
      action = { operation, principalId };
      break;
    case "revoke-device":
      if (!isSubject(deviceId)) return null;
      action = { operation, deviceId };
      break;
    case "own-role":
    case "list-members":
      if (!isWorkspace(workspaceId)) return null;
      action = { operation, workspaceId };
      break;
    case "resolve-account":
      if (!isWorkspace(workspaceId) || !isGithubUsername(githubUsername)) return null;
      action = { operation, workspaceId, githubUsername };
      break;
    case "grant-member":
      if (!isWorkspace(workspaceId) || !isGithubAccountId(githubAccountId) ||
        (role !== undefined && role !== "admin" && role !== "member")) return null;
      action = { operation, workspaceId, githubAccountId, role: role ?? "member" };
      break;
    case "change-role":
      if (!isWorkspace(workspaceId) || !isSubject(principalId) || (role !== "admin" && role !== "member")) {
        return null;
      }
      action = { operation, workspaceId, principalId, role };
      break;
    case "remove-member":
      if (!isWorkspace(workspaceId) || !isSubject(principalId)) return null;
      action = { operation, workspaceId, principalId };
      break;
    default:
      return null;
  }
  return REQUEST_TARGET_FIELDS.some((field) => Object.hasOwn(payload, field) && !Object.hasOwn(action, field))
    ? null
    : action;
}

function parseRequestProofClaims(
  payload: Record<string, unknown>,
  expected: RequestAction | "renew-credential",
): RequestProofClaims | null {
  const { typ, kid, iat, exp } = payload;
  const action = readRequestAction(payload);
  const expectedAction = readRequestAction(typeof expected === "string" ? { operation: expected } : expected);
  if (
    typ !== "request" ||
    typeof kid !== "string" ||
    !UUID.test(kid) ||
    action === null ||
    expectedAction === null ||
    Object.keys(action).length !== Object.keys(expectedAction).length ||
    Object.entries(expectedAction).some(([field, value]) => (action as Record<string, unknown>)[field] !== value) ||
    !isEpochSeconds(iat) ||
    !isEpochSeconds(exp) ||
    exp <= iat
  ) {
    return null;
  }
  return { typ, kid, ...action, iat, exp };
}

function parseClaims(payload: Record<string, unknown>): TokenClaims | null {
  const { typ, sub, workspace, scope, kid, iat, exp } = payload;
  // Missing typ/exp remains unsupported even with a valid signature; no fallback.
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
 * Log-only causes; senders always receive invalid-token for forged or stale tokens.
 */
export type TokenFailure =
  /**
   * No bounded canonical two-part JSON-object token; report no identity.
   */
  | "unparseable"
  /** A readable payload signed by some key that is not the one presented here. */
  | "bad-signature"
  /**
   * Valid signature with unsupported claims, such as missing typ/exp, an unknown
   * scope or a decorated workspace id.
   */
  | "unsupported-claims";

/**
 * Unverified, log-only identity: never authority. Keep only bounded typ/sub;
 * signatures and complete tokens must stay out of rejection logs.
 */
export interface TokenIdentity {
  /** Unverified nonempty typ string, bounded for logs; null otherwise. */
  typ: string | null;
  /** Unverified nonempty sub string, bounded for logs; null otherwise. */
  sub: string | null;
}

export interface TokenRejection {
  failure: TokenFailure;
  /** `null` exactly when the failure is `"unparseable"` — nothing was readable. */
  identity: TokenIdentity | null;
}

/**
 * Bound each log field because rejected claims are unauthenticated input.
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
 * Unverified lookup hint only; verify the signature and all claims under that key.
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
 * Same acceptance as verifyToken, with log-only causes. Never throws; verify
 * the signature before trusting claims. Unverified fields serve only TokenIdentity.
 */
export async function inspectToken(
  key: CryptoKey,
  token: string,
): Promise<TokenClaims | TokenRejection> {
  const parsed = parseToken(token);
  if (parsed === null) return UNPARSEABLE;
  const signed = await verifySignature(key, parsed);
  if (signed === null) return UNPARSEABLE;
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

async function verifySignature(
  key: CryptoKey,
  parsed: ParsedToken,
): Promise<boolean | null> {
  try {
    return await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      parsed.signature,
      textEncoder.encode(parsed.payloadPart),
    );
  } catch {
    return null;
  }
}

/**
 * Verify operation and exact targets with the bounded canonical token format.
 * clampToken checks time separately; rejections expose no supplied claims or keys.
 */
export async function inspectRequestProof(
  key: CryptoKey,
  token: string,
  expected: RequestAction | "renew-credential",
): Promise<RequestProofClaims | TokenRejection> {
  const parsed = parseToken(token);
  if (parsed === null) return UNPARSEABLE;
  const signed = await verifySignature(key, parsed);
  if (signed === null) return UNPARSEABLE;
  const identity: TokenIdentity = { typ: null, sub: null };
  if (!signed) return { failure: "bad-signature", identity };
  return (
    parseRequestProofClaims(parsed.payload, expected) ?? {
      failure: "unsupported-claims",
      identity,
    }
  );
}

/**
 * CryptoKey only; require a valid signature and the same claim shape as minting.
 * Never throws: all refusals collapse to null; inspectToken causes are log-only.
 * This verifies authenticity, not time: the hub applies clampToken with its clock.
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
 * Verify signatures first, then enforce hub lifetime/clock bounds regardless
 * of the minter's claims. Null means admissible freshness, never authenticity.
 */
export function clampToken(
  claims: Pick<TokenClaims, "iat" | "exp">,
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
