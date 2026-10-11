/**
 * Export factories from TypeScript source; ./main.ts owns process startup.
 * Access replicas, store and sync through the returned server for diagnostics.
 */

export {
  DEFAULT_HUB_URL,
  defaultDatabasePath,
  resolveMcpConfig,
  usesDeviceLogin,
} from "./config.js";
export type { McpConfig } from "./config.js";
export { createMcpEngine } from "./engine.js";
export type {
  EngineHealth,
  EngineRefreshStatus,
  McpEngineOptions,
  UberblickMcpEngine,
} from "./engine.js";
export { ServingReplicaHeldError } from "./serving-role.js";
export type {
  ServingReplicaHolder,
  ServingReplicaRole,
} from "./serving-role.js";
export {
  BRIDGE_CONNECT_TIMEOUT_MS,
  BRIDGE_SYNC_TIMEOUT_MS,
  bridgeConfig,
  compareCorpus,
  docFingerprint,
  inspectRemote,
  isIdentical,
  liveDocs,
  syncWorkspace,
} from "./remote.js";
export type { Corpus, CorpusDifference, CorpusDoc } from "./remote.js";
export { importSeedDir, readSeedDocs } from "./seed.js";
export type { SeedDoc, SeedImport, StarterSeed } from "./seed.js";
export { storeWorkspaceName } from "./workspace-settings.js";
export { inspectExistingStore, readWorkspaceName } from "./store.js";
export { createMcpServer } from "./server.js";
export type { UberblickMcpServer } from "./server.js";
export type { HubState, HubStatus } from "./sync.js";
export { formatHubFailure } from "./hub-failure.js";
export type { HubFailureCause } from "./hub-failure.js";
export { collectServingSyncStatus, collectSyncStatus } from "./status.js";
export type {
  RoomSyncStatus,
  ServedRoomSyncStatus,
  ServingSyncStatus,
  SyncStatus,
} from "./status.js";
export { log, logAt } from "./log.js";
export type { LogLevel } from "./log.js";
