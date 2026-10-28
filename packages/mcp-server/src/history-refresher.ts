import { tryAcquireHistoryRefresherRole, type HistoryRefresherRole } from "./history-refresher-role.js";
import { log } from "./log.js";
import type { Replicas } from "./replica.js";
import { startWorkspaceHistory, workspaceHistoryStamp } from "./workspace-history.js";

const REFRESH_INTERVAL_MS = 250;

/** Only long-lived serving runtimes contend; followers keep their own readers. */
export function startHistoryRefresher(replicas: Replicas): { close(): Promise<void> } {
  const { config, store, sync } = replicas;
  if (config.localWorkspace === true || store.databasePath === ":memory:") {
    return { close: async () => {} };
  }

  let role: HistoryRefresherRole | null = null;
  let history: ReturnType<typeof startWorkspaceHistory> | null = null;
  let stopping: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let closed = false;
  let dirty = true;
  let lastDataVersion: number | null = null;
  let immediate: NodeJS.Immediate | null = null;

  const release = (): Promise<void> => {
    if (stopping !== null) return stopping;
    const previous = history;
    const held = role;
    history = null;
    role = null;
    // Keep exclusion until the old worker has stopped publishing.
    stopping = (async () => {
      try { await previous?.close(); }
      finally { held?.close(); }
    })().finally(() => { stopping = null; });
    return stopping;
  };

  const pass = (): void => {
    immediate = null;
    if (closed || stopping !== null) return;
    try {
      if (store.isRemoved() || replicas.persistenceError() !== null) {
        // Existing sessions stay refused even when another start recreates the path.
        sync.quarantine();
        stop();
        void release().catch(error => log.warn("history refresher close failed", error));
        return;
      }
      if (role !== null && !role.isCurrent()) {
        void release().catch(error => log.warn("history refresher close failed", error));
        return;
      }
      const stamp = workspaceHistoryStamp(replicas);
      const admittedAccount = sync.historyAccount(replicas.directory().room);
      if (stamp !== null && admittedAccount !== null && stamp.account !== admittedAccount) {
        // A newly signed-in contender can progress while this socket reconnects.
        void release().catch(error => log.warn("history refresher close failed", error));
        return;
      }
      if (role === null) {
        role = tryAcquireHistoryRefresherRole(store.databasePath);
        if (role === null) return;
        dirty = true;
      }

      const dataVersion = store.dataVersion();
      const pendingCanAdvance = sync.state().status === "connected" && store.pendingRooms().length > 0;
      if (dirty || dataVersion !== lastDataVersion || pendingCanAdvance) {
        dirty = false;
        lastDataVersion = dataVersion;
        // MCP has no browser engine or calls to discover pages while idle.
        replicas.refresh();
        history ??= startWorkspaceHistory(replicas, () => !closed && role?.isCurrent() === true);
        history.refresh();
      }
      history?.checkRetention();
    } catch (error) {
      void release().catch(failure => log.warn("history refresher close failed", failure));
      log.warn("history refresher pass failed", error);
    }
  };

  const schedule = (): void => {
    if (closed) return;
    dirty = true;
    if (immediate !== null) return;
    immediate = setImmediate(pass);
    immediate.unref();
  };
  const unsubscribeAppend = store.onAppend(schedule);
  const unsubscribeRoomQuiet = sync.onRoomQuiet(schedule);
  const unsubscribeState = sync.onStateChange(schedule);
  const timer = setInterval(pass, REFRESH_INTERVAL_MS);
  timer.unref();
  const stop = (): void => {
    closed = true;
    clearInterval(timer);
    if (immediate !== null) clearImmediate(immediate);
    immediate = null;
    unsubscribeAppend();
    unsubscribeRoomQuiet();
    unsubscribeState();
  };
  schedule();
  return {
    close() {
      if (closing !== null) return closing;
      stop();
      closing = release();
      return closing;
    },
  };
}
