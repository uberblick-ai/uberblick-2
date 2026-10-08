/**
 * Last sync is a best-effort acknowledgement observation stored by the full
 * replica. SQLite cuts remain real here; controlled provider facts isolate the
 * conjunction from transport timing, and one live hub exercises tool settles.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Hub } from "@uberblick/hub";
import { appendBlock, initDoc, roomForDoc } from "@uberblick/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { log } from "../src/log.js";
import { Replicas } from "../src/replica.js";
import { collectSyncStatus } from "../src/status.js";
import { MirrorStore } from "../src/store.js";
import {
  hubUrl,
  LIVE_HUB_SETTLE,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const T0 = Date.UTC(2031, 0, 1, 0, 0, 0, 987);
const replicasToClose: Replicas[] = [];
const stores: MirrorStore[] = [];
const rigs: Rig[] = [];
const hubs: Hub[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const replicas of replicasToClose.splice(0)) replicas.destroy();
  for (const store of stores.splice(0)) store.close();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDirs();
});

function clock(): { wall: number; elapsed: number } {
  const time = { wall: T0, elapsed: 0 };
  vi.spyOn(Date, "now").mockImplementation(() => time.wall);
  vi.spyOn(performance, "now").mockImplementation(() => time.elapsed);
  return time;
}

function controlledReplicas(): {
  replicas: Replicas;
  store: MirrorStore;
  controls: { connected: boolean; draining: boolean; unacknowledged: string | null };
} {
  const databasePath = tempDatabasePath();
  const store = new MirrorStore(databasePath, WORKSPACE);
  stores.push(store);
  const replicas = new Replicas(testConfig({ databasePath }), store);
  replicasToClose.push(replicas);
  const controls = { connected: true, draining: false, unacknowledged: null as string | null };
  const hub = replicas.sync.state();
  vi.spyOn(replicas.sync, "state").mockImplementation(() => ({
    ...hub,
    status: controls.connected ? "connected" : "hub-down",
  }));
  vi.spyOn(replicas.sync, "isDraining").mockImplementation(() => controls.draining);
  vi.spyOn(replicas.sync, "isRoomQuiet").mockImplementation(
    (room) => room !== controls.unacknowledged,
  );
  return { replicas, store, controls };
}

function docUpdate(uuid: string): Uint8Array {
  const doc = new Y.Doc();
  initDoc(doc, { uuid, title: "A foreign database write" });
  appendBlock(doc, { type: "paragraph", text: "written by another process" });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

describe("last acknowledged sync", () => {
  it("writes its first caught-up observation immediately and throttles on elapsed time", () => {
    const time = clock();
    const { replicas, store, controls } = controlledReplicas();
    const writes = vi.spyOn(store, "recordLastSync");

    controls.connected = false;
    replicas.recordLastSyncIfCaughtUp();
    expect(store.readLastSync()).toBeNull();
    controls.connected = true;
    replicas.recordLastSyncIfCaughtUp();
    expect(store.readLastSync()).toBe(T0);
    expect(replicas.readLastSync()).toBe("2031-01-01T00:00:00Z");

    for (const elapsed of [0, 1, 1_000, 4_999]) {
      // A wall-clock jump must not permit extra writes within five seconds.
      time.wall += 60_000;
      time.elapsed = elapsed;
      replicas.recordLastSyncIfCaughtUp();
    }
    expect(writes).toHaveBeenCalledTimes(1);

    time.elapsed = 5_000;
    replicas.recordLastSyncIfCaughtUp();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(store.readLastSync()).toBe(time.wall);

    // Elapsed time permits another attempt after a backwards clock movement;
    // the atomic database update keeps the acknowledged time forward-only.
    const latest = time.wall;
    time.wall = T0 - 10_000;
    time.elapsed = 10_000;
    replicas.recordLastSyncIfCaughtUp();
    expect(writes).toHaveBeenCalledTimes(3);
    expect(store.readLastSync()).toBe(latest);
  });

  it("leaves the stored time unchanged whenever any acknowledgement condition fails", () => {
    const time = clock();
    const { replicas, store, controls } = controlledReplicas();
    replicas.recordLastSyncIfCaughtUp();
    const writes = vi.spyOn(store, "recordLastSync");
    const checkUnchanged = (): void => {
      time.elapsed += 5_000;
      time.wall += 5_000;
      replicas.recordLastSyncIfCaughtUp();
      expect(store.readLastSync()).toBe(T0);
      expect(writes).not.toHaveBeenCalled();
    };

    controls.connected = false;
    checkUnchanged();
    controls.connected = true;

    controls.draining = true;
    checkUnchanged();
    controls.draining = false;

    controls.unacknowledged = replicas.directory().room;
    checkUnchanged();
    controls.unacknowledged = null;

    // A pending room outside this process's attached set also blocks the
    // workspace-wide observation, even though every attached provider is quiet.
    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    const update = docUpdate(uuid);
    const seq = store.appendUpdate(room, update, "local");
    checkUnchanged();
    store.clearPending(room, seq);

    // A peer can acknowledge and clear the marker before this replica applies
    // the database cut. Compaction must not hide that unapplied state either.
    const replica = replicas.replica(uuid);
    const later = store.appendUpdate(room, docUpdate(uuid), "local");
    store.clearPending(room, later);
    expect(replica.lastSeq).toBeLessThan(later);
    checkUnchanged();
    store.compact(room, update, later);
    checkUnchanged();
  });

  it("reports no timestamp from an older database and isolates metadata read failures", async () => {
    const { replicas, store } = controlledReplicas();
    const warning = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(replicas.readLastSync()).toBeNull();

    vi.spyOn(store, "readLastSync").mockImplementation(() => {
      throw new Error("simulated metadata read failure");
    });
    const status = await collectSyncStatus(replicas);
    expect(status.lastSync).toBeNull();
    expect(status.persistence).toBeNull();
    expect(() => replicas.assertHealthy()).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "simulated metadata read failure" }),
    );
  });

  it("checks ordinary MCP tools after settle and ignores timestamp write failures", async () => {
    const time = clock();
    const rig = await startServer();
    rigs.push(rig);
    const hub = rig.instance.replicas.sync.state();
    vi.spyOn(rig.instance.replicas.sync, "state").mockReturnValue({ ...hub, status: "connected" });
    vi.spyOn(rig.instance.replicas.sync, "isRoomQuiet").mockReturnValue(true);
    vi.spyOn(rig.instance.replicas.sync, "isDraining").mockReturnValue(false);

    await rig.ok("list_docs");
    expect(rig.instance.store.readLastSync()).toBe(T0);

    time.wall += 5_000;
    time.elapsed += 5_000;
    const warning = vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.spyOn(rig.instance.store, "recordLastSync").mockImplementation(() => {
      throw new Error("simulated metadata write failure");
    });
    await rig.ok("list_docs");
    const status = await rig.ok("sync_status");
    expect(status.lastSync).toBe("2031-01-01T00:00:00Z");
    expect(status.persistence).toBeNull();
    expect(() => rig.instance.replicas.assertHealthy()).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "simulated metadata write failure" }),
    );
  });

  it("returns its current caught-up time from a live hub sync_status settle", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const rig = await startServer(testConfig({
      authSecret: TEST_SECRET,
      hubUrl: hubUrl(hub.port),
      ...LIVE_HUB_SETTLE,
    }));
    rigs.push(rig);
    await waitUntil("the real hub to acknowledge all attached rooms", () =>
      rig.instance.replicas.attachedReplicas().every(({ room }) =>
        rig.instance.replicas.isRoomQuiet(room),
      ),
    );

    const time = clock();
    time.elapsed = 1_000_000;
    const status = await rig.ok("sync_status");
    expect(status.hub.status).toBe("connected");
    expect(status.unsyncedChanges).toBe(0);
    expect(status.lastSync).toBe("2031-01-01T00:00:00Z");
    expect(status.lastSync).toBe(rig.instance.replicas.readLastSync());
  });
});
