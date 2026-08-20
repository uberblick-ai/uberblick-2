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
 *     base64url(JSON {sub, workspace, scope, iat}) "." base64url(HMAC-SHA256(secret, payloadPart))
 *
 * `iat` defaults to now, so tokens are not byte-stable across calls.
 *
 * ============================ LOUD WARNING ============================
 * The client mints its own token from a secret compiled into the bundle. That
 * is LOCAL-SPIKE-ONLY: a browser bundle is public, so `HUB_AUTH_TOKEN` is not a
 * secret anywhere but localhost. Hosted, the hub mints per OAuth session and
 * the secret never leaves the server. See vite.config.ts.
 * =====================================================================
 */

export { mintToken } from "@uberblick/hub/token";
export type { TokenClaims, TokenRequest, TokenScope } from "@uberblick/hub/token";
