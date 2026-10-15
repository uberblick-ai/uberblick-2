import { afterEach, expect, it, vi } from "vitest";

import { MirrorStore } from "../src/store.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import { removeTempDirs, testConfig } from "./core-helpers.js";

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
