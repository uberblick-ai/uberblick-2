import { getMeta, isDirectoryEntryArchived, listDirectory } from "@uberblick/schema";
import { readHubLogins } from "./auth-store.js";
import { HubHistoryClock } from "./history-clock.js";
import { HistoryMirror } from "./history-mirror.js";
import { HistoryMirrorCache } from "./history-mirror-cache.js";
import type { Replicas } from "./replica.js";
import { authenticationOrigin } from "./remote-url.js";
import { requireDocumentHistory, RevisionClientError } from "./revision-client.js";

export function workspaceHistoryStamp(replicas: Replicas) {
  const { config } = replicas;
  const env = config.deviceLogin?.env ?? config.authEnv ?? process.env;
  const logins = readHubLogins(env);
  const origin = authenticationOrigin(config.hubUrl);
  if (logins.state !== "usable" || logins.unreadableHubs.includes(origin)) return null;
  const account = logins.logins[origin]?.identity.githubAccountId;
  return account === undefined ? null : { hub: config.hubUrl, workspace: config.workspaceId, account };
}

/** The caller holds the history role until close has stopped its worker. */
export function startWorkspaceHistory(replicas: Replicas, isCurrent: () => boolean): {
  refresh(): void;
  checkRetention(): void;
  close(): Promise<void>;
} {
  const { config, store, sync } = replicas;
  const env = config.deviceLogin?.env ?? config.authEnv ?? process.env;
  const clock = new HubHistoryClock(config.hubUrl);
  const cache = new HistoryMirrorCache(store.databasePath, config.workspaceId, env);
  const stamp = () => workspaceHistoryStamp(replicas);
  const requireAccount = (room: string): void => {
    const current = stamp();
    if (current === null || sync.historyAccount(room) !== current.account) {
      throw new RevisionClientError("sign-in-required");
    }
  };
  const mirror = new HistoryMirror({
    pages: () => {
      const directory = replicas.directory().doc;
      const held = new Map(replicas.attachedReplicas().map(replica => [replica.id, replica]));
      return listDirectory(directory, { includeDeleted: true }).flatMap(entry => {
        const replica = held.get(entry.uuid);
        if (replica === undefined || replicas.isDeleted(entry.uuid) ||
          entry.kind === "decision" || getMeta(replica.doc).kind === "decision") return [];
        return [{ uuid: entry.uuid, room: replica.room, sequence: replica.lastSeq,
          archived: isDirectoryEntryArchived(directory, entry.uuid) }];
      });
    },
    retention: () => store.readHistoryRetention(),
    stamp,
    ready: () => isCurrent() && sync.isQuiet() && store.pendingRooms().length === 0 &&
      replicas.persistenceError() === null && !store.isRemoved(),
    request: async (room, operation) => {
      await clock.ensure();
      requireAccount(room);
      requireDocumentHistory(replicas, room.slice(config.workspaceId.length + 1));
      const response = await sync.requestRevisions(room, operation, 5_000, { background: true });
      requireAccount(room);
      return response;
    },
    now: () => clock.now(),
    deadlineDelay: deadlineAt => clock.delay(deadlineAt),
  }, cache);
  let connected = false;
  const connectionChanged = () => {
    const next = sync.state().status === "connected";
    if (next !== connected) { connected = next; clock.reset(); }
    mirror.connectionChanged(next);
  };
  const unsubscribeState = sync.onStateChange(connectionChanged);
  const unsubscribeNotice = sync.onRevisionCatalogChanged(room => mirror.notice(room));
  mirror.refresh();
  connectionChanged();
  return {
    refresh: () => mirror.refresh(),
    checkRetention: () => mirror.checkRetention(),
    async close() {
      unsubscribeState();
      unsubscribeNotice();
      clock.close();
      await mirror.close();
    },
  };
}
