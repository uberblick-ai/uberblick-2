/**
 * Hub auth tokens.
 *
 * A token is claims-shaped, not an opaque shared string:
 *
 *     base64url(payloadJson) "." base64url(hmacSha256(secret, payloadPart))
 *
 * with payload `{sub, workspace, scope, iat}`. The signature covers the
 * base64url payload *string* (not the raw JSON), so verification never has to
 * re-serialise and canonicalisation questions never arise.
 *
 * Why claims and not a shared secret compare: the hub is headed for a hosted
 * life with several workspaces and several accounts, and the room key already
 * carries the workspace (`<workspaceId>/<docUuid>`). A token that says *who*
 * and *which workspace* lets the hub scope a connection to its workspace from
 * day one, so nothing has to be migrated later. `HUB_AUTH_TOKEN` is the HMAC
 * secret — it is never itself a valid token.
 *
 * Why WebCrypto and not `node:crypto`: the same module runs in the browser
 * client and in Node (hub, MCP server), so it must not import a Node builtin.
 * `globalThis.crypto.subtle` exists in both.
 *
 * Known limits (spike): no `exp`, so tokens do not expire and there is no
 * revocation; the secret is a single dev secret shared by every client. Both
 * are fine while the hub is local-only and neither survives contact with the
 * hosted future.
 */

import { parseWorkspaceId } from "@uberblick/schema";

/** What a token is allowed to do. Read-only connections can sync down only. */
export type TokenScope = "read-write" | "read-only";

export const TOKEN_SCOPES: readonly TokenScope[] = ["read-write", "read-only"];

export interface TokenClaims {
  /** Who the token was issued to — a user or agent session identifier. */
  sub: string;
  /** The workspace whose rooms this token may open. */
  workspace: string;
  scope: TokenScope;
  /** Issued at, whole seconds since the epoch. */
  iat: number;
}

/** Claims to mint. `iat` defaults to now. */
export type TokenRequest = Omit<TokenClaims, "iat"> & { iat?: number };

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

/** @throws when `value` is not base64url. Callers treat that as "not a token". */
function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  // atob implements WHATWG forgiving-base64, which accepts the unpadded form.
  const binary = globalThis.atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function importSecret(secret: string) {
  return globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function assertClaims(claims: TokenRequest): void {
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
  if (claims.iat !== undefined && !isIssuedAt(claims.iat)) {
    throw new Error("mintToken: iat must be a non-negative integer");
  }
}

/** Who the token is for. Any non-empty string, on both sides of a token. */
function isSubject(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Whole seconds since the epoch. The same rule on both sides of a token. */
function isIssuedAt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
 * Mint a signed token. The only writer is a dev/ops path (mise task, test, or
 * a future account service) — clients receive tokens, they never mint them.
 */
export async function mintToken(
  secret: string,
  claims: TokenRequest,
): Promise<string> {
  if (secret === "") {
    throw new Error("mintToken: secret must not be empty");
  }
  assertClaims(claims);

  const payload: TokenClaims = {
    sub: claims.sub,
    workspace: claims.workspace,
    scope: claims.scope,
    iat: claims.iat ?? Math.floor(Date.now() / 1000),
  };
  const payloadPart = base64urlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    await importSecret(secret),
    textEncoder.encode(payloadPart),
  );

  return `${payloadPart}${SEPARATOR}${base64urlEncode(new Uint8Array(signature))}`;
}

function parseClaims(payloadJson: string): TokenClaims | null {
  const parsed: unknown = JSON.parse(payloadJson);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { sub, workspace, scope, iat } = parsed as Record<string, unknown>;
  if (!isSubject(sub)) {
    return null;
  }
  if (!isWorkspace(workspace)) {
    return null;
  }
  if (!isTokenScope(scope)) {
    return null;
  }
  if (!isIssuedAt(iat)) {
    return null;
  }
  return { sub, workspace, scope, iat };
}

/**
 * Verify a token and return its claims, or `null` for anything that is not a
 * well-formed, correctly signed token whose claims {@link mintToken} could have
 * produced — the two apply the same rules, so a signed payload with a
 * slug-decorated workspace or a fractional `iat` is not a token. Never throws:
 * every rejection reason collapses to `null` so callers cannot accidentally
 * distinguish "bad signature" from "bad shape".
 */
export async function verifyToken(
  secret: string,
  token: string,
): Promise<TokenClaims | null> {
  if (secret === "" || token === "") {
    return null;
  }
  const parts = token.split(SEPARATOR);
  if (parts.length !== 2) {
    return null;
  }
  const [payloadPart, signaturePart] = parts;
  if (!payloadPart || !signaturePart) {
    return null;
  }

  try {
    const valid = await globalThis.crypto.subtle.verify(
      "HMAC",
      await importSecret(secret),
      base64urlDecode(signaturePart),
      textEncoder.encode(payloadPart),
    );
    if (!valid) {
      return null;
    }
    return parseClaims(textDecoder.decode(base64urlDecode(payloadPart)));
  } catch {
    return null;
  }
}
