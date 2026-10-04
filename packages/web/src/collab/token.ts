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
 * Loopback pages mint from their local signing key in the served configuration.
 * ub open supplies a separate workspace browser key; development supplies the
 * loopback hub's signing secret. Remote pages receive neither and do not mint.
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
