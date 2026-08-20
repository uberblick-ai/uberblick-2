/**
 * @uberblick/hub package entry.
 *
 * Resolved directly from TypeScript source (see package.json exports); the
 * process entry point is ./main.ts, run with tsx.
 *
 * The token helpers are also published on their own subpath —
 * `@uberblick/hub/token` — because clients (web, MCP server) need to mint and
 * inspect tokens without pulling the server, and that module is deliberately
 * runtime-agnostic (WebCrypto, no Node builtins).
 */

export { createHub } from "./server.js";
export type { Hub, HubContext } from "./server.js";
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultDatabasePath,
  resolveHubConfig,
} from "./config.js";
export type { HubConfig } from "./config.js";
export { silentLogger, stderrLogger } from "./log.js";
export type { HubLogger, HubLogRecord } from "./log.js";
export { isTokenScope, mintToken, TOKEN_SCOPES, verifyToken } from "./token.js";
export type { TokenClaims, TokenRequest, TokenScope } from "./token.js";
