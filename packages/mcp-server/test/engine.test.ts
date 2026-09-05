/**
 * The transport-free engine at its real boundaries: same-process and foreign
 * SQLite commits, hub recovery, boot readiness, fatal replica persistence and
 * shutdown. No MCP call drives these tests — that absence is the contract.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "@uberblick/hub";
import {
  appendBlock,
  getBlocks,
  initDoc,
  isSidebarSeeded,
  readSidebar,
  roomForDoc,
} from "@uberblick/schema";
import * as Y from "yjs";
import {
  createMcpEngine,
  type UberblickMcpEngine,
} from "../src/engine.js";
import { collectServingSyncStatus } from "../src/status.js";
import { MirrorStore } from "../src/store.js";
import {
  FailingStore,
  hubUrl,
  LIVE_HUB_SETTLE,
  peerClient,
  removeTempDirs,
  sleep,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { PeerClient, Rig } from "./helpers.js";

const engines: UberblickMcpEngine[] = [];
const stores: MirrorStore[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];
const rigs: Rig[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const engine of engines.splice(0)) await engine.close();
  for (const store of stores.splice(0)) store.close();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  removeTempDirs();
});

function encodedDoc(uuid: string, text: string, tags: string[] = []): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    initDoc(doc, {
      uuid,
      title: `Engine ${text}`,
      description: "A transport-free engine test document.",
      tags,
    });
    appendBlock(doc, { type: "paragraph", text });
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function tickAfter(engine: UberblickMcpEngine, action: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("the same-process append did not wake a refresh"));
    }, 2_000);
    unsubscribe = engine.onRefresh(() => {
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
    action();
  });
}

describe("transport-free MCP engine", () => {
  it("wakes on a caller append and delivers the tick after its hub-free refresh", async () => {
    const config = testConfig({
      authSecret: TEST_SECRET,
      connectTimeoutMs: 100,
    });
    const engine = await createMcpEngine(config, {
      // A periodic pass this far away cannot be mistaken for the append wake.
      refreshIntervalMs: 30_000,
    });
    engines.push(engine);
    // If the steady-state pass accidentally calls settle, the unreachable hub
    // makes the mistake visible without a tight wall-clock assertion.
    config.connectTimeoutMs = 30_000;

    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    await tickAfter(engine, () => {
      engine.store.appendUpdate(room, encodedDoc(uuid, "caller append"), "local");
    });

    const replica = engine.replicas
      .attachedReplicas()
      .find((entry) => entry.room === room);
    if (replica === undefined) throw new Error("the caller's room was not attached");
    expect(getBlocks(replica.doc).map((block) => block.text)).toEqual(["caller append"]);
  });

  it("polls a foreign commit without putting the hub wait in front of it", async () => {
    const databasePath = tempDatabasePath();
    const config = testConfig({
      databasePath,
      authSecret: TEST_SECRET,
      connectTimeoutMs: 100,
    });
    const engine = await createMcpEngine(config, { refreshIntervalMs: 10 });
    engines.push(engine);
    config.connectTimeoutMs = 30_000;

    const outside = new MirrorStore(databasePath, WORKSPACE);
    stores.push(outside);
    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    outside.appendUpdate(room, encodedDoc(uuid, "foreign append"), "local");

    await waitUntil(
      "the engine to apply the foreign commit",
      () => {
        const replica = engine.replicas
          .attachedReplicas()
          .find((entry) => entry.room === room);
        return (
          replica !== undefined && getBlocks(replica.doc)[0]?.text === "foreign append"
        );
      },
      2_000,
    );
  });

  it("pushes pending state after hub recovery and releases its marker without a tool call", async () => {
    const hubDatabase = tempDatabasePath();
    const first = await startHub({ databasePath: hubDatabase });
    const port = first.port;
    await first.stop();

    const databasePath = tempDatabasePath();
    const engine = await createMcpEngine(
      testConfig({
        databasePath,
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(port),
        connectTimeoutMs: 100,
      }),
      { refreshIntervalMs: 10 },
    );
    engines.push(engine);

    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    engine.store.appendUpdate(room, encodedDoc(uuid, "survives recovery"), "local");
    await waitUntil("the offline append to enter the engine replica", () =>
      engine.replicas.attachedReplicas().some(
        (entry) =>
          entry.room === room && getBlocks(entry.doc)[0]?.text === "survives recovery",
      ),
    );

    const running = await startHub({ port, databasePath: hubDatabase });
    hubs.push(running);
    const peer = await peerClient(port, room);
    peers.push(peer);
    await waitUntil(
      "the loop-driven replica to reach the recovered hub",
      () => getBlocks(peer.doc)[0]?.text === "survives recovery",
    );
    await waitUntil(
      "the acknowledged pending marker to be released by a refresh",
      () => engine.store.pendingRooms().every((entry) => entry.room !== room),
    );
    expect(getBlocks(peer.doc).map((block) => block.text)).toEqual([
      "survives recovery",
    ]);
  });

  it("releases acknowledged browser writes without waiting for the periodic tick", async () => {
    const running = await startHub();
    hubs.push(running);
    const databasePath = tempDatabasePath();
    const source = new Y.Doc();
    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    initDoc(source, { uuid, title: "Acknowledged browser writes" });
    appendBlock(source, { type: "paragraph", text: "initial" });
    const store = new MirrorStore(databasePath, WORKSPACE);
    store.appendUpdate(room, Y.encodeStateAsUpdate(source), "local");

    const engine = await createMcpEngine(
      testConfig({
        databasePath,
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(running.port),
        ...LIVE_HUB_SETTLE,
      }),
      {
        store,
        // Any true reading in this test comes from an explicit wake, not time.
        refreshIntervalMs: 30_000,
      },
    );
    engines.push(engine);
    const status = () => collectServingSyncStatus(engine, [room]);
    await waitUntil("the seeded serving room to be acknowledged", () =>
      status().rooms[room]?.hubAcked === true,
    );

    for (const text of ["one", "two", "three"]) {
      let update: Uint8Array | null = null;
      const capture = (next: Uint8Array): void => {
        update = next;
      };
      source.on("update", capture);
      appendBlock(source, { type: "paragraph", text });
      source.off("update", capture);
      if (update === null) throw new Error("the browser edit produced no update");

      await tickAfter(engine, () => {
        engine.store.appendUpdate(room, update as Uint8Array, "local");
      });
      expect(status()).toMatchObject({
        caughtUp: false,
        rooms: { [room]: { hubAcked: false } },
      });
      await waitUntil("the provider acknowledgement to release its marker", () =>
        status().caughtUp,
      );
    }

    source.destroy();
  });

  it("reports ready after the one-time sidebar seed and closes without later ticks", async () => {
    const databasePath = tempDatabasePath();
    const author = await startServer(testConfig({ databasePath }));
    rigs.push(author);
    await author.ok("create_doc", {
      title: "Legacy start page",
      description: "A document for the boot seed.",
      tags: ["start-here"],
    });
    await author.close();
    rigs.splice(rigs.indexOf(author), 1);

    const engine = await createMcpEngine(testConfig({ databasePath }), {
      refreshIntervalMs: 10,
    });
    engines.push(engine);
    expect(isSidebarSeeded(engine.replicas.sidebar().doc)).toBe(true);
    expect(readSidebar(engine.replicas.sidebar().doc)).toHaveLength(1);

    let ticks = 0;
    engine.onRefresh(() => {
      ticks += 1;
    });
    const firstClose = engine.close();
    const secondClose = engine.close();
    await Promise.all([firstClose, secondClose]);
    engines.splice(engines.indexOf(engine), 1);

    const outside = new MirrorStore(databasePath, WORKSPACE);
    stores.push(outside);
    const uuid = randomUUID();
    outside.appendUpdate(
      roomForDoc(WORKSPACE, uuid),
      encodedDoc(uuid, "after close"),
      "local",
    );
    await sleep(50);
    expect(ticks).toBe(0);
  });

  it("stops and reports a polling failure without letting it escape the loop", async () => {
    class PollingFailStore extends MirrorStore {
      failing = false;

      override dataVersion(): number {
        if (this.failing) throw new Error("simulated PRAGMA read failure");
        return super.dataVersion();
      }
    }

    const databasePath = tempDatabasePath();
    const store = new PollingFailStore(databasePath, WORKSPACE);
    const engine = await createMcpEngine(testConfig({ databasePath }), {
      store,
      refreshIntervalMs: 10,
    });
    engines.push(engine);

    store.failing = true;
    await waitUntil(
      "the refresh failure to become observable",
      () => engine.refreshStatus.status === "failed",
    );
    expect(engine.refreshStatus).toEqual({
      status: "failed",
      message: "simulated PRAGMA read failure",
    });
    expect(engine.health).toEqual({ status: "healthy" });
  });

  it("quarantines only when an engine replica gets ahead of the log", async () => {
    const databasePath = tempDatabasePath();
    const store = new FailingStore(databasePath, WORKSPACE);
    const engine = await createMcpEngine(testConfig({ databasePath }), {
      store,
      refreshIntervalMs: 10,
    });
    engines.push(engine);

    // A caller's own failed append advanced no replica and is its own error.
    const callerUuid = randomUUID();
    store.failing = true;
    expect(() =>
      store.appendUpdate(
        roomForDoc(WORKSPACE, callerUuid),
        encodedDoc(callerUuid, "refused caller append"),
        "local",
      ),
    ).toThrow("simulated disk failure");
    expect(engine.health).toEqual({ status: "healthy" });

    // An engine replica has already changed when its Yjs observer sees the
    // refusal. That is the sticky ahead-of-log boundary.
    const replica = engine.replicas.replica(randomUUID());
    replica.doc.transact(() => {
      initDoc(replica.doc, {
        uuid: replica.id,
        title: "Unlogged engine state",
      });
      appendBlock(replica.doc, { type: "paragraph", text: "not durable" });
    });
    expect(engine.health).toMatchObject({
      status: "quarantined",
      room: replica.room,
    });

    let ticks = 0;
    engine.onRefresh(() => {
      ticks += 1;
    });
    await sleep(50);
    store.failing = false;
    const laterUuid = randomUUID();
    store.appendUpdate(
      roomForDoc(WORKSPACE, laterUuid),
      encodedDoc(laterUuid, "after quarantine"),
      "local",
    );
    await sleep(50);
    expect(ticks).toBe(0);
  });
});
