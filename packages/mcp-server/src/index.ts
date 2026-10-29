/**
 * Export factories from TypeScript source; ./main.ts owns process startup.
 * Servers, engines and one-shot diagnostics share the workspace replica factory.
 */

export {
  DEFAULT_HUB_URL,
  defaultWorkspaceDatabasePath,
  resolveMcpConfig,
  usesDeviceLogin,
} from "./config.js";
export type { McpConfig } from "./config.js";
export { openWorkspaceReplicas } from "./workspace-replicas.js";
export type { WorkspaceReplicaOptions, WorkspaceReplicaSet } from "./workspace-replicas.js";
export { readWorkspaceData, updateWorkspaceData, WorkspaceDataWriteError } from "./workspace-data.js";
export { createMcpEngine } from "./engine.js";
export type {
  EngineHealth,
  EngineRefreshStatus,
  McpEngineOptions,
  UberblickMcpEngine,
} from "./engine.js";
export { acquireWorkspaceRemovalRole, ServingReplicaHeldError } from "./serving-role.js";
export type {
  ServingReplicaHolder,
  ServingReplicaRole,
} from "./serving-role.js";
export { bridgeConfig, compareCorpus, inspectRemote, isIdentical, syncWorkspace } from "./remote.js";
export type { Corpus, CorpusDifference, CorpusDoc } from "./remote.js";
export { importSeedDir, readSeedDocs } from "./seed.js";
export type { SeedDoc, SeedImport, StarterSeed } from "./seed.js";
export { fillWorkspaceMainRepository, storeWorkspaceName } from "./workspace-settings.js";
export { readWorkspaceFork, writeWorkspaceFork } from "./workspace-fork.js";
export type { WorkspaceForkSnapshot } from "./workspace-fork.js";
export { readDocumentHistory, readDocumentRevision, requireDocumentHistory, mutateDocumentRevision, restoreDocumentRevision, documentRevisionChecksum, RevisionClientError } from "./revision-client.js";
export type { HistoryReadStatus } from "./revision-client.js";
export type { RevisionClientFailure, RevisionReadOptions } from "./revision-client.js";
export { detachWorkspaceCopy, inspectExistingStore, readStoredSyncStatus, readWorkspaceName, WorkspaceDetachedError, WorkspaceRemovedError } from "./store.js";
export { captureWorkspaceDetachGeneration } from "./workspace-generation.js";
export { parseHistoryRetention } from "./local-settings.js";
export type { HistoryRetention, WorkspaceSize } from "./local-settings.js";
export { createMcpRuntime, createMcpServer } from "./server.js";
export type { McpRuntimeOptions, UberblickMcpRuntime, UberblickMcpServer, UberblickMcpSession } from "./server.js";
export { createLocalCredentialProvider } from "./credential-provider.js";
export type { CredentialEnsureOptions, CredentialProvider } from "./credential-provider.js";
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
export { withLoggingDisabled } from "./log.js";
export type { LogLevel } from "./log.js";
