/**
 * The MCP server's replica engine without an MCP transport.
 *
 * `ub open` needs the same local store, replicas, hub sync and one-time sidebar
 * seed as an MCP process, but it has no MCP tool call to drive `settle`. This
 * entry replaces those calls with hub-free refresh ticks. Same-process appends
 * wake it directly; commits from another process are found through SQLite's
 * `data_version` on the short periodic poll.
 */

import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { seedSidebarOnce } from "./sidebar-tools.js";
import {
  acquireServingReplicaRole,
  type ServingReplicaRole,
} from "./serving-role.js";
import { MirrorStore } from "./store.js";

const DEFAULT_REFRESH_INTERVAL_MS = 25;

export type EngineHealth =
  | { status: "healthy" }
  | { status: "quarantined"; room: string; message: string };

export type EngineRefreshStatus =
  | { status: "running" }
  | { status: "failed"; message: string };

export interface McpEngineOptions {
  /** Existing store to own and hand back; omitted opens `config.databasePath`. */
  store?: MirrorStore;
  /** Foreign-commit polling interval. Same-process appends wake immediately. */
  refreshIntervalMs?: number;
  /** Own the store's one silent serving-replica role for this engine's life. */
  serving?: boolean;
}

export interface UberblickMcpEngine {
  readonly store: MirrorStore;
  readonly replicas: Replicas;
  /** Sticky replica/log health, readable even after the engine quarantines. */
  readonly health: EngineHealth;
  /** Whether the hub-free refresh loop is still progressing. */
  readonly refreshStatus: EngineRefreshStatus;
  /**
   * Observe completed refreshes. The replica set already includes the tick's
   * log tail when the listener runs.
   */
  onRefresh(listener: () => void): () => void;
  /** Stop the loop, then release replicas and the store. Idempotent. */
  close(): Promise<void>;
}

function engineHealth(replicas: Replicas): EngineHealth {
  const failure = replicas.persistenceError();
  return failure === null
    ? { status: "healthy" }
    : { status: "quarantined", ...failure };
}

/**
 * Boot the full local replica engine and its refresh loop without attaching an
 * MCP transport. Resolves at the same readiness point as `createMcpServer`'s
 * `connect`: after the bounded initial settle and the one-time sidebar seed.
 */
export async function createMcpEngine(
  config: McpConfig,
  options: McpEngineOptions = {},
): Promise<UberblickMcpEngine> {
  const refreshIntervalMs =
    options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  if (!Number.isInteger(refreshIntervalMs) || refreshIntervalMs < 1) {
    throw new Error(
      `createMcpEngine: refreshIntervalMs must be a positive integer, got ${refreshIntervalMs}`,
    );
  }

  const store =
    options.store ?? new MirrorStore(config.databasePath, config.workspaceId);
  let servingRole: ServingReplicaRole | null = null;
  let replicas: Replicas | null = null;
  try {
    if (options.serving === true) {
      servingRole = acquireServingReplicaRole(store.databasePath, {
        pid: process.pid,
        sessionId: config.sessionId,
      });
    }
    replicas = new Replicas(config, store, {
      publishOwnPresence: options.serving !== true,
    });
    await seedSidebarOnce(replicas);
  } catch (error) {
    replicas?.destroy();
    servingRole?.close();
    store.close();
    throw error;
  }

  const listeners = new Set<() => void>();
  let dirty = false;
  let lastDataVersion = store.dataVersion();
  let refreshStatus: EngineRefreshStatus = { status: "running" };
  let closed = false;
  let stopped = false;
  let immediate: NodeJS.Immediate | null = null;
  let closePromise: Promise<void> | null = null;

  const stopLoop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (immediate !== null) {
      clearImmediate(immediate);
      immediate = null;
    }
    unsubscribeAppend();
    unsubscribeRoomQuiet();
  };

  const pass = (): void => {
    immediate = null;
    if (closed || stopped) return;

    try {
      const health = engineHealth(replicas);
      if (health.status === "quarantined") {
        stopLoop();
        return;
      }

      const dataVersion = store.dataVersion();
      const pendingCanAdvance =
        replicas.sync.state().status === "connected" &&
        store.pendingRooms().length > 0;
      if (!dirty && dataVersion === lastDataVersion && !pendingCanAdvance) {
        return;
      }

      // Clear before refreshing: an append made by the refresh itself re-arms
      // the next pass instead of having its wake overwritten on return.
      dirty = false;
      lastDataVersion = dataVersion;
      replicas.refresh();
    } catch (error) {
      if (engineHealth(replicas).status === "quarantined") {
        stopLoop();
        return;
      }
      refreshStatus = {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
      stopLoop();
      log.warn("transport-free engine refresh failed", error);
      return;
    }

    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        // A consumer receives a completed tick; its own exception cannot turn
        // that refresh into an engine failure or starve other consumers.
        log.warn("transport-free engine refresh listener failed", error);
      }
    }
  };

  const schedule = (): void => {
    if (closed || stopped) return;
    dirty = true;
    if (immediate === null) {
      immediate = setImmediate(pass);
    }
  };

  const unsubscribeAppend = store.onAppend(schedule);
  const unsubscribeRoomQuiet = replicas.sync.onRoomQuiet(schedule);
  const timer = setInterval(pass, refreshIntervalMs);

  return {
    store,
    replicas,
    get health() {
      return engineHealth(replicas);
    },
    get refreshStatus() {
      return refreshStatus;
    },
    onRefresh(listener) {
      if (closed || stopped) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closePromise !== null) return closePromise;
      closePromise = Promise.resolve().then(() => {
        closed = true;
        stopLoop();
        listeners.clear();
        replicas.destroy();
        servingRole?.close();
        store.close();
      });
      return closePromise;
    },
  };
}
