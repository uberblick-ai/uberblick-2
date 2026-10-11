/**
 * Reuse @uberblick/hub/token's WebCrypto wire format for minting and verification:
 * base64url(JSON {typ, sub, workspace, scope, kid, iat, exp}) + "." +
 * base64url(HMAC-SHA256(key, payloadPart)), signing that string, not raw JSON.
 * iat defaults to now; tokens expire and require an imported CryptoKey.
 * This is the package's single import site. ub open supplies workspace browser
 * keys; development supplies its loopback root secret. Remote pages get neither.
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
