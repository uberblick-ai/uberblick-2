/**
 * Serving mode at its two real boundaries: awareness on the wire and a
 * process-held SQLite lock that the OS releases after ordinary exit or SIGKILL.
 */

/**
 * Serving mode at its two real boundaries: awareness on the wire and a
 * process-held SQLite lock that the OS releases after ordinary exit or SIGKILL.
 */
import type { Hub } from "@uberblick/hub";
import { appendBlock, getBlocks, initDoc, roomForDoc } from "@uberblick/schema";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createMcpEngine, type UberblickMcpEngine, } from "../src/engine.js";
import { acquireServingReplicaRole, ServingReplicaHeldError } from "../src/serving-role.js";
import { MirrorStore } from "../src/store.js";
import * as tagCatalog from "../src/tag-catalog.js";
import type { PeerClient, Rig } from "./helpers.js";
import { cleanupTestResources, hubUrl, peerClient, startHub, startServer, tempDatabasePath, TEST_SECRET, testConfig, waitUntil, WORKSPACE } from "./helpers.js";
const engines: UberblickMcpEngine[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];
const rigs: Rig[] = [];

afterEach(async () => {
  await cleanupTestResources({
    clients: [
      ...rigs.splice(0).map((rig) => () => rig.close()),
      ...engines.splice(0).map((engine) => () => engine.close()),
    ],
    peers: peers.splice(0).map((peer) => () => peer.destroy()),
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
  });
});

function encodedDoc(uuid: string, text: string): Uint8Array {
  const doc = new Y.Doc();
  initDoc(doc, { uuid, title: "Serving replica test" });
  appendBlock(doc, { type: "paragraph", text });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

describe("serving MCP engine", () => {
  it("publishes no state of its own while its rooms still sync, without changing MCP presence", async () => {
    const running = await startHub();
    hubs.push(running);
    const databasePath = tempDatabasePath();
    const serving = await createMcpEngine(
      testConfig({
        databasePath,
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(running.port),
      }),
      { serving: true, refreshIntervalMs: 10 },
    );
    engines.push(serving);

    expect(
      serving.replicas
        .attachedReplicas()
        .map((replica) => replica.awareness.getLocalState()),
    ).toEqual([null, null, null]);

    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    serving.store.appendUpdate(room, encodedDoc(uuid, "synced silently"), "local");
    const peer = await peerClient(running.port, room);
    peers.push(peer);
    await waitUntil(
      "the silent serving replica to sync its document room",
      () => getBlocks(peer.doc)[0]?.text === "synced silently",
    );
    const documentReplica = serving.replicas
      .attachedReplicas()
      .find((replica) => replica.room === room);
    if (documentReplica === undefined) throw new Error("document room not attached");
    serving.replicas.touch(documentReplica);
    const blockId = getBlocks(documentReplica.doc)[0]?.id;
    if (blockId === undefined) throw new Error("synced block missing");
    serving.replicas.publishCursor(documentReplica, blockId, 0);
    expect(documentReplica.awareness.getLocalState()).toBeNull();

    const mcp = await startServer(testConfig());
    rigs.push(mcp);
    expect(mcp.instance.replicas.directory().awareness.getLocalState()).toMatchObject(
      {
        client: "agent",
        session: mcp.config.sessionId,
        user: { name: mcp.clientName, color: mcp.config.color },
      },
    );
  });

  it("holds its serving role through device work and releases it before closing the injected store", async () => {
    const config = testConfig();
    const store = new MirrorStore(config.databasePath, WORKSPACE);
    const engine = await createMcpEngine(config, { store, serving: true });
    engines.push(engine);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const waitForDeviceWork = engine.replicas.sync.waitForDeviceWork.bind(engine.replicas.sync);
    const deviceWork = vi.spyOn(engine.replicas.sync, "waitForDeviceWork").mockImplementation(async () => {
      entered();
      await released;
      await waitForDeviceWork();
    });
    let roleAvailableAtStoreClose = false;
    const closeStore = store.close.bind(store);
    const storeClose = vi.spyOn(store, "close").mockImplementation(() => {
      try {
        const replacement = acquireServingReplicaRole(store.databasePath, {
          pid: process.pid,
          sessionId: "store-close replacement",
        });
        roleAvailableAtStoreClose = true;
        replacement.close();
      } catch {
        roleAvailableAtStoreClose = false;
      }
      closeStore();
    });
    const closing = engine.close();
    try {
      await waiting;
      expect(() => {
        const premature = acquireServingReplicaRole(store.databasePath, {
          pid: process.pid,
          sessionId: "device-work contender",
        });
        premature.close();
      }).toThrow(ServingReplicaHeldError);
      expect(storeClose).not.toHaveBeenCalled();
      release();
      await closing;
      expect(roleAvailableAtStoreClose).toBe(true);
      expect(storeClose).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await closing;
      deviceWork.mockRestore();
      storeClose.mockRestore();
      store.close();
    }
  });

  it("closes the injected store and releases its role when initial catalog work rejects", async () => {
    const config = testConfig();
    const store = new MirrorStore(config.databasePath, WORKSPACE);
    const storeClose = vi.spyOn(store, "close");
    const seed = vi.spyOn(tagCatalog, "seedTagCatalogOnce").mockRejectedValue(new Error("catalog initialization failed"));
    let unexpectedEngine: UberblickMcpEngine | undefined;
    const opening = createMcpEngine(config, { store, serving: true }).then((engine) => {
      unexpectedEngine = engine;
      return engine;
    });
    try {
      await expect(opening).rejects.toThrow("catalog initialization failed");
      expect(storeClose).toHaveBeenCalledTimes(1);
      expect(() => store.dataVersion()).toThrow();
      const replacement = acquireServingReplicaRole(config.databasePath, {
        pid: process.pid,
        sessionId: "replacement after failed seed",
      });
      replacement.close();
    } finally {
      await unexpectedEngine?.close();
      seed.mockRestore();
      storeClose.mockRestore();
      store.close();
    }
  });
});
