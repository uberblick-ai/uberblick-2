import { afterEach, expect, it, vi } from "vitest";
import { getWorkspaceName, setWorkspaceName } from "@uberblick/schema";
import { acquireServingReplicaRole, ServingReplicaHeldError } from "../src/serving-role.js";
import { MirrorStore } from "../src/store.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import { removeTempDirs, tempDatabasePath, tempDir, testConfig, TEST_SECRET, WORKSPACE } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
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
