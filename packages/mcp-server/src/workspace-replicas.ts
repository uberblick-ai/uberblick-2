import { DEFAULT_HUB_URL, type McpConfig } from "./config.js";
import { Replicas } from "./replica.js";
import {
  acquireServingReplicaRole,
  type ServingReplicaRole,
} from "./serving-role.js";
import { MirrorStore } from "./store.js";

export interface WorkspaceReplicaOptions {
  /** Adopt and close this store; omitted opens `config.databasePath`. */
  store?: MirrorStore;
  /** Publish this process's directory presence; defaults to true. */
  publishOwnPresence?: boolean;
  /** Disable hub and device-login work, allowing synchronous release. */
  hubFree?: boolean;
  /** Hold the serving role before attaching replicas until device work ends. */
  serving?: boolean;
}

export interface WorkspaceReplicaSet {
  readonly store: MirrorStore;
  readonly replicas: Replicas;
  /** Idempotent; hub-free sets close synchronously. */
  close(): void | Promise<void>;
}

/** Open a workspace's store and replicas without seeding or starting a transport. */
export function openWorkspaceReplicas(
  config: McpConfig,
  options: WorkspaceReplicaOptions = {},
): WorkspaceReplicaSet {
  const hubFree = options.hubFree === true;
  if (hubFree) {
    config = { ...config, hubUrl: DEFAULT_HUB_URL, authSecret: null };
    delete config.deviceLogin;
  }

  const store = options.store ?? new MirrorStore(config.databasePath, config.workspaceId);
  let servingRole: ServingReplicaRole | null = null;
  let replicas: Replicas;
  try {
    if (options.serving === true) {
      servingRole = acquireServingReplicaRole(store.databasePath, {
        pid: process.pid,
        sessionId: config.sessionId,
      });
    }
    replicas = new Replicas(config, store, {
      publishOwnPresence: options.publishOwnPresence ?? true,
    });
  } catch (error) {
    servingRole?.close();
    store.close();
    throw error;
  }

  let closed = false;
  let closing: Promise<void> | null = null;
  return {
    store,
    replicas,
    close() {
      if (closing !== null) return closing;
      if (closed) return;
      closed = true;
      if (hubFree) {
        replicas.destroy();
        servingRole?.close();
        store.close();
        return;
      }
      closing = Promise.resolve().then(async () => {
        replicas.destroy();
        await replicas.sync.waitForDeviceWork();
        servingRole?.close();
        store.close();
      });
      return closing;
    },
  };
}
