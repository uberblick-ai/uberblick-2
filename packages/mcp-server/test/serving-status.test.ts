/**
 * The hub acknowledgement exposed by `ub open` is a conjunction, not a
 * provider flag: the shared store marker and this replica's applied cut both
 * have to agree, and a corpus still draining attachment is not caught up.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { UberblickMcpEngine } from "../src/engine.js";
import type { Replica, Replicas } from "../src/replica.js";
import { collectServingSyncStatus } from "../src/status.js";
import { MirrorStore } from "../src/store.js";
import {
  removeTempDirs,
  tempDatabasePath,
  WORKSPACE,
} from "./helpers.js";

const stores: MirrorStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  removeTempDirs();
});

interface Controls {
  connected: boolean;
  draining: boolean;
  quiet: boolean;
  refreshRunning: boolean;
  refreshes: number;
}

function fakeEngine(
  store: MirrorStore,
  replicas: Array<Pick<Replica, "room" | "lastSeq">>,
): { engine: UberblickMcpEngine; controls: Controls } {
  const controls: Controls = {
    connected: true,
    draining: false,
    quiet: true,
    refreshRunning: true,
    refreshes: 0,
  };
  const replicaSet = {
    store,
    refresh: () => {
      controls.refreshes += 1;
    },
    attachedReplicas: () => replicas,
    isRoomQuiet: () => controls.quiet,
    sync: {
      state: () => ({
        status: controls.connected ? "connected" : "hub-down",
      }),
      isDraining: () => controls.draining,
    },
  } as unknown as Replicas;
  const engine = {
    store,
    replicas: replicaSet,
    get refreshStatus() {
      return controls.refreshRunning
        ? { status: "running" as const }
        : { status: "failed" as const, message: "simulated refresh failure" };
    },
  } as unknown as UberblickMcpEngine;
  return { engine, controls };
}

describe("serving sync status", () => {
  it("reads engine state without refreshing replicas", () => {
    const store = new MirrorStore(tempDatabasePath(), WORKSPACE);
    stores.push(store);
    const room = `${WORKSPACE}/${randomUUID()}`;
    const { engine, controls } = fakeEngine(store, [{ room, lastSeq: 0 }]);

    expect(collectServingSyncStatus(engine, [room])).toEqual({
      notSharedReason: null,
      caughtUp: true,
      rooms: { [room]: { hubAcked: true } },
    });
    expect(controls.refreshes).toBe(0);
  });

  it("requires both the shared pending marker and this replica's store cut", () => {
    const store = new MirrorStore(tempDatabasePath(), WORKSPACE);
    stores.push(store);
    const room = `${WORKSPACE}/${randomUUID()}`;
    const replica = { room, lastSeq: 0 };
    const { engine } = fakeEngine(store, [replica]);
    const seq = store.appendUpdate(room, new Uint8Array([1]), "local");

    replica.lastSeq = seq;
    expect(collectServingSyncStatus(engine, [room])).toEqual({
      notSharedReason: null,
      caughtUp: false,
      rooms: { [room]: { hubAcked: false } },
    });

    // A peer may release the one shared marker. This replica is still behind,
    // so the provider's quiet flag alone must not turn the reading true.
    store.clearPending(room, seq);
    replica.lastSeq = 0;
    expect(collectServingSyncStatus(engine, [room]).rooms[room]).toEqual({
      hubAcked: false,
    });

    replica.lastSeq = seq;
    expect(collectServingSyncStatus(engine, [room])).toEqual({
      notSharedReason: null,
      caughtUp: true,
      rooms: { [room]: { hubAcked: true } },
    });

    // Compaction cannot hide an unapplied cut by pruning its update row.
    store.compact(room, new Uint8Array([2]), seq);
    replica.lastSeq = 0;
    expect(collectServingSyncStatus(engine, [room]).rooms[room]).toEqual({
      hubAcked: false,
    });
  });

  it("keeps the corpus false through attach drain, hub loss and a stopped refresh", () => {
    const store = new MirrorStore(tempDatabasePath(), WORKSPACE);
    stores.push(store);
    const room = `${WORKSPACE}/${randomUUID()}`;
    const { engine, controls } = fakeEngine(store, [{ room, lastSeq: 0 }]);

    controls.draining = true;
    expect(collectServingSyncStatus(engine, [room])).toEqual({
      notSharedReason: null,
      caughtUp: false,
      rooms: { [room]: { hubAcked: true } },
    });

    controls.draining = false;
    controls.connected = false;
    expect(collectServingSyncStatus(engine, [room])).toEqual({
      notSharedReason: null,
      caughtUp: false,
      rooms: { [room]: { hubAcked: false } },
    });

    controls.connected = true;
    controls.refreshRunning = false;
    expect(collectServingSyncStatus(engine, [room])).toEqual({
      notSharedReason: null,
      caughtUp: false,
      rooms: { [room]: { hubAcked: false } },
    });
  });
});
