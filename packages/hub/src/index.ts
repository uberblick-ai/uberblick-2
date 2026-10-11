// Client imports use the token, storage and protocol subpaths without loading
// the server. Keep the protocol version on its single leaf entry point.

export { createHub } from "./server.js";
export type { Hub, HubContext } from "./server.js";
export {
  createLocalBrowserServer,
  STORE_BUSY_REASON,
  STORE_REFUSED_REASON,
} from "./local-browser-server.js";
export type {
  LocalBrowserServer,
  LocalBrowserServerConfig,
  LocalRoomSlice,
} from "./local-browser-server.js";
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_PENDING_DOCUMENTS,
  defaultDatabasePath,
  hubDatabasePath,
  resolveHubConfig,
} from "./config.js";
export type { HubConfig } from "./config.js";
export {
  createDataDirectory,
  resolveStorage,
  WORKSPACE_DATABASE_FILE,
} from "./storage.js";
export type { StorageOptions, StoragePaths } from "./storage.js";
export { silentLogger, stderrLogger } from "./log.js";
export type { HubLogger, HubLogRecord } from "./log.js";
export { isGithubAccountId, isGithubUsername } from "./github-identity.js";
export { sanitizeDeviceName } from "./device-name.js";
// Only the hub issues device credentials; keep those token helpers internal.
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
