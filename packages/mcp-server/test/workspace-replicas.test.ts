import { afterEach, expect, it, vi } from "vitest";
import { getWorkspaceName, setWorkspaceName } from "@uberblick/schema";
import {
  acquireServingReplicaRole,
  ServingReplicaHeldError,
} from "../src/serving-role.js";
import { MirrorStore } from "../src/store.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import {
  removeTempDirs,
  tempDatabasePath,
  tempDir,
  testConfig,
  TEST_SECRET,
  WORKSPACE,
} from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

it("owns an injected store and shares shutdown while device work still needs it", async () => {
  const config = testConfig();
  const store = new MirrorStore(config.databasePath, config.workspaceId);
  const workspace = openWorkspaceReplicas(config, { store });
  expect(workspace.store).toBe(store);
  expect(workspace.replicas.directory().awareness.getLocalState()).toMatchObject({
    client: "agent",
    session: config.sessionId,
  });

  const order: string[] = [];
  const destroy = workspace.replicas.destroy.bind(workspace.replicas);
  vi.spyOn(workspace.replicas, "destroy").mockImplementation(() => {
    order.push("replicas destroyed");
    destroy();
  });
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const waitForDeviceWork = workspace.replicas.sync.waitForDeviceWork.bind(workspace.replicas.sync);
  vi.spyOn(workspace.replicas.sync, "waitForDeviceWork").mockImplementation(async () => {
    entered();
    await released;
    await waitForDeviceWork();
    order.push("device work finished");
  });
  const closeStore = store.close.bind(store);
  const closed = vi.spyOn(store, "close").mockImplementation(() => {
    order.push("store closed");
    closeStore();
  });

  const first = workspace.close();
  try {
    await waiting;
    const second = workspace.close();
    expect(second).toBe(first);
    expect(order).toEqual(["replicas destroyed"]);
    expect(() => store.dataVersion()).not.toThrow();
    expect(closed).not.toHaveBeenCalled();
    expect(() => workspace.replicas.settings()).toThrow("Cannot open a room on destroyed replicas.");
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["replicas destroyed", "device work finished", "store closed"]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(() => store.dataVersion()).toThrow();
  } finally {
    release();
    await workspace.close();
  }
});

it("keeps hub-free settings writes synchronous with a remote URL and device login", () => {
  const config = {
    ...testConfig({ authSecret: TEST_SECRET, hubUrl: "wss://hub.example.invalid" }),
    deviceLogin: { env: { XDG_CONFIG_HOME: tempDir() } },
  };
  const fetch = vi.spyOn(globalThis, "fetch");
  const workspace = openWorkspaceReplicas(config, { hubFree: true, publishOwnPresence: false });
  try {
    expect(workspace.replicas.sync.enabled).toBe(false);
    expect(workspace.replicas.attachedReplicas().map((replica) => replica.awareness.getLocalState()))
      .toEqual([null, null, null]);
    setWorkspaceName(workspace.replicas.settings().doc, "Offline creation");
    workspace.replicas.assertHealthy();
    expect(workspace.close()).toBeUndefined();
    expect(() => workspace.store.dataVersion()).toThrow();
    expect(fetch).not.toHaveBeenCalled();

    const reopened = openWorkspaceReplicas(config, { hubFree: true, publishOwnPresence: false });
    try {
      expect(getWorkspaceName(reopened.replicas.settings().doc)).toBe("Offline creation");
    } finally {
      reopened.close();
    }
  } finally {
    workspace.close();
  }
});

it("closes an injected store when acquiring the serving role is refused", async () => {
  const databasePath = tempDatabasePath();
  const holder = openWorkspaceReplicas(testConfig({ databasePath }), { serving: true });
  const contenderStore = new MirrorStore(databasePath, WORKSPACE);
  const closeStore = vi.spyOn(contenderStore, "close");
  try {
    expect(() => openWorkspaceReplicas(testConfig({ databasePath }), {
      store: contenderStore,
      serving: true,
    })).toThrow(ServingReplicaHeldError);
    expect(closeStore).toHaveBeenCalledTimes(1);
    expect(() => contenderStore.dataVersion()).toThrow();
    expect(() => acquireServingReplicaRole(databasePath, {
      pid: process.pid,
      sessionId: "another refused contender",
    })).toThrow(ServingReplicaHeldError);
  } finally {
    contenderStore.close();
    await holder.close();
  }
});
