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
 *
 * So is the storage layout — `@uberblick/hub/storage` — which the cli and the
 * MCP server import to resolve the same config and data roots this hub does.
 * It lives here because the hub is the lowest of the three in the dependency
 * graph, not because the layout is the hub's.
 */

export { createHub } from "./server.js";
export type { Hub, HubContext } from "./server.js";
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultDatabasePath,
  hubDatabasePath,
  resolveHubConfig,
  storageWarnings,
} from "./config.js";
export type { HubConfig } from "./config.js";
export {
  AmbiguousStorageError,
  createDataDirectory,
  MAC_ROOT_DISPLAY,
  resolveStorage,
  WORKSPACE_DATABASE_FILE,
} from "./storage.js";
export type { StorageLayout, StorageOptions, StoragePaths } from "./storage.js";
export { silentLogger, stderrLogger } from "./log.js";
export type { HubLogger, HubLogRecord } from "./log.js";
// The credential half of the token module is deliberately absent here: nothing
// outside the hub issues or derives one, and the entry point is the surface the
// other packages import.
export {
  importRootSecret,
  isTokenScope,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
  TOKEN_SCOPES,
  verifyToken,
} from "./token.js";
export type {
  TokenClaims,
  TokenRequest,
  TokenScope,
  TokenType,
} from "./token.js";
