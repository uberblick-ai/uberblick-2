/** Embedded hub core; standalone entry points wire team capabilities. */
export { createHub, createRoomAuthenticator, PEER_ADDRESS_HEADER } from "./server.js";
export type { Hub, HubContext } from "./server.js";
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_PENDING_DOCUMENTS,
  resolveCoreHubConfig,
} from "./config.js";
export type { HubConfig } from "./config.js";
export { silentLogger, stderrLogger } from "./log.js";
export type { HubLogger, HubLogRecord } from "./log.js";
export { getUpdateAttribution } from "./update-attribution.js";
export type { UpdateAttribution, UpdateAuthor } from "./update-attribution.js";
export { purgeDetachedDocumentCopies } from "./offline-storage.js";
