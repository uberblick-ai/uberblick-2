/**
 * Hub auth token minting.
 *
 * The signing and verification logic lives in `@uberblick/hub`'s `./token`
 * subpath: it is WebCrypto-only (no Node builtins), so the exact same module
 * runs in the browser to mint and in the hub to verify. Re-implementing it here
 * would be a second definition of the wire format, and the two would drift —
 * they already did once during this spike, over whether the HMAC covers the raw
 * claims JSON or the base64url payload string. It covers the payload string.
 *
 * This module exists as the single import site for the whole package, so if the
 * hosted design lands (server mints per OAuth session, client only *receives* a
 * token) the change is confined to this file.
 *
 * Format, for reference — see @uberblick/hub/token for the authority:
 *
 *     base64url(JSON {typ, sub, workspace, scope, kid, iat, exp}) "." base64url(HMAC-SHA256(key, payloadPart))
 *
 * `iat` defaults to now, so tokens are not byte-stable across calls, and every
 * token expires — `mintToken` takes a `CryptoKey`, which is what
 * `importRootSecret` turns the served secret into.
 *
 * The client mints its own token from the shared signing secret, which reaches
 * it in the served configuration document (#426, `src/config.ts`). Anyone who
 * can fetch that document has full read-write: the tailnet is the boundary that
 * makes it acceptable (CLAUDE.md, REMOTE.md), and per-session credentials are
 * the replacement, deferred with #388. Hosted, the hub mints per OAuth session
 * and the secret never leaves the server — which is the change this module
 * exists to confine.
 */

export {
  MAX_TOKEN_LIFETIME_SECONDS,
  importRootSecret,
  mintToken,
} from "@uberblick/hub/token";
export type {
  TokenClaims,
  TokenRequest,
  TokenScope,
  TokenType,
} from "@uberblick/hub/token";
