/**
 * Proof 1b extras: facts the cases left as "possible", measured.
 *   node --no-warnings --import tsx spike/proof1b/extras.ts
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { appendBlock, editBlock, initDoc, roomForDoc } from "@uberblick/schema";
import * as Y from "yjs";
import type { McpConfig } from "../../src/config.js";
import { Replicas } from "../../src/replica.js";
import { MirrorStore } from "../../src/store.js";
import * as H from "./harness.js";
import { REFUSED_REASON, startOpen } from "./open-standin.js";

function mcpProcess(storePath: string, hubUrl: string): Replicas {
  const config: McpConfig = {
    workspaceId: H.WORKSPACE,
    hubUrl,
    authSecret: H.SECRET,
    databasePath: storePath,
    sessionId: `agent-${randomUUID()}`,
    color: "#2f9e8f",
    connectTimeoutMs: 1_500,
    syncTimeoutMs: 3_000,
    reconnectMaxDelayMs: 250,
    cursorTtlMs: 30_000,
    compactAfter: 500,
    reconcileRetryMs: 0,
    updatedAtCoarsenessMs: 5 * 60_000,
  };
  return new Replicas(config, new MirrorStore(storePath, H.WORKSPACE));
}

const out: Record<string, unknown> = {};

// E1 — today's two-process path: does the receiver log the hub's echo as a second row?
async function e1(): Promise<void> {
  const dir = H.tempDir();
  const hub = await H.startHub({ databasePath: join(dir, "hub.sqlite") });
  const storePath = join(dir, "store.sqlite");
  const hubUrl = `ws://127.0.0.1:${hub.port}`;
  const p1 = mcpProcess(storePath, hubUrl);
  const p2 = mcpProcess(storePath, hubUrl);
  try {
    const uuid = randomUUID();
    const room = roomForDoc(H.WORKSPACE, uuid);
    const d1 = p1.replica(uuid).doc;
    initDoc(d1, { uuid, title: "echo", description: "" });
    const blockId = appendBlock(d1, { type: "paragraph", text: "hello" });
    await p1.settle();
    await p2.settle();
    const d2 = p2.replica(uuid).doc;
    await H.waitUntil("p2 hydrated and both synced", () => H.textOf(d2, blockId) === "hello" && p1.isRoomQuiet(room) && p2.isRoomQuiet(room));
    const rows0 = H.storeView(storePath, room);
    editBlock(d1, blockId, "hello", "hello!");
    await H.waitUntil("p2 to receive the write through the hub (it never settles)", () => H.textOf(d2, blockId) === "hello!");
    await H.sleep(100);
    const rows1 = H.storeView(storePath, room);
    await p2.settle();
    const rows2 = H.storeView(storePath, room);
    out.e1_twoProcessHubEcho = {
      rowsAddedByOneWrite_beforeReceiverSettles: rows1.updates - rows0.updates,
      ofWhichRemote: rows1.remote - rows0.remote,
      rowsAfterReceiverSettles: rows2.updates - rows0.updates,
      verdict:
        rows1.updates - rows0.updates === 2
          ? "today's code logs the same update twice on one store: once local by the writer, once remote by the receiver via the hub echo (harmless: replay is idempotent)"
          : "one row: the receiver did not log the echo",
    };
  } finally {
    p1.destroy();
    p1.store.close();
    p2.destroy();
    p2.store.close();
    await hub.stop().catch(() => {});
  }
}

// E2 — a refusal closes the room, not the socket: the tab's other room keeps working.
async function e2(): Promise<void> {
  const dir = H.tempDir();
  const hub = await H.startHub({ databasePath: join(dir, "hub.sqlite") });
  const storePath = join(dir, "store.sqlite");
  const open = await startOpen({ workspaceId: H.WORKSPACE, databasePath: storePath, hubUrl: `ws://127.0.0.1:${hub.port}`, authSecret: H.SECRET });
  const socket = new HocuspocusProviderWebsocket({ url: open.url, delay: 100, minDelay: 50, maxDelay: 400 });
  const providers: HocuspocusProvider[] = [];
  try {
    const make = (title: string) => {
      const uuid = randomUUID();
      const doc = open.replicas.replica(uuid).doc;
      initDoc(doc, { uuid, title, description: "" });
      const blockId = appendBlock(doc, { type: "paragraph", text: "hello" });
      return { uuid, room: roomForDoc(H.WORKSPACE, uuid), blockId };
    };
    const one = make("one");
    const two = make("two");
    await open.tick();
    const docOne = new Y.Doc();
    const docTwo = new Y.Doc();
    const closes: { room: string; reason?: string }[] = [];
    const attach = (room: string, doc: Y.Doc) => {
      const provider = new HocuspocusProvider({
        name: room,
        document: doc,
        token: "rw",
        websocketProvider: socket,
        onClose: ({ event }: { event?: { reason?: string } }) => closes.push({ room, reason: event?.reason }),
      } as ConstructorParameters<typeof HocuspocusProvider>[0]);
      provider.attach();
      providers.push(provider);
      return provider;
    };
    const pOne = attach(one.room, docOne);
    const pTwo = attach(two.room, docTwo);
    await H.waitUntil("both rooms synced on one socket", () => pOne.isSynced && pTwo.isSynced && pOne.unsyncedChanges === 0 && pTwo.unsyncedChanges === 0);
    const serverOne = open.served.get(one.room)?.document;
    open.store.failNext = 1;
    H.typeInto(docOne, one.blockId, "X");
    await H.waitUntil("room one to be closed", () => closes.length > 0, 5_000);
    await H.sleep(100);
    const t0 = performance.now();
    H.typeInto(docTwo, two.blockId, "Y");
    await H.waitUntil("room two's write to be acknowledged on the same socket", () => pTwo.unsyncedChanges === 0, 5_000);
    out.e2_refusalClosesRoomNotSocket = {
      closes,
      socketStatusAfterRefusal: socket.status,
      roomOne: { isSynced: pOne.isSynced, unsynced: pOne.unsyncedChanges, serverConnections: serverOne?.getConnectionsCount() ?? null },
      roomTwo: { acknowledgedAfterMs: Math.round(performance.now() - t0), serverText: H.textOf(open.served.get(two.room)?.document ?? new Y.Doc(), two.blockId) },
    };
  } finally {
    for (const provider of providers) provider.destroy();
    socket.destroy();
    await open.close();
    await hub.stop().catch(() => {});
  }
}

// E3 — bridge latency: an MCP-style write to the browser's update frame.
async function e3(): Promise<void> {
  const dir = H.tempDir();
  const hub = await H.startHub({ databasePath: join(dir, "hub.sqlite") });
  const storePath = join(dir, "store.sqlite");
  const hubUrl = `ws://127.0.0.1:${hub.port}`;
  const open = await startOpen({ workspaceId: H.WORKSPACE, databasePath: storePath, hubUrl, authSecret: H.SECRET });
  const other = mcpProcess(storePath, hubUrl);
  let A: H.Client | null = null;
  try {
    const uuid = randomUUID();
    const room = roomForDoc(H.WORKSPACE, uuid);
    const own = open.replicas.replica(uuid).doc;
    initDoc(own, { uuid, title: "latency", description: "" });
    const blockId = appendBlock(own, { type: "paragraph", text: "" });
    await open.tick();
    A = H.connect({ name: "A", url: open.url, room, token: "rw" });
    await A.settled();
    const otherDoc = other.replica(uuid).doc;
    await H.waitUntil("other hydrated", () => H.blocksOf(otherDoc).length === 1);
    const measure = async (label: string, write: (i: number) => void) => {
      const samples: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const before = A!.frames.updates;
        const t0 = performance.now();
        write(i);
        await H.waitUntil(`${label} update ${i} to reach the browser`, () => A!.frames.updates > before, 5_000);
        samples.push(performance.now() - t0);
        await H.sleep(40);
      }
      return H.summarize(samples);
    };
    const ownStats = await measure("own-replica", (i) => {
      const text = H.textOf(own, blockId);
      editBlock(own, blockId, text, `${text}o`);
    });
    const otherStats = await measure("other-process", (i) => {
      const text = H.textOf(otherDoc, blockId);
      editBlock(otherDoc, blockId, text, `${text}p`);
    });
    out.e3_bridgeLatencyMs = { settleIntervalMs: 25, ownReplicaWriteToBrowserFrame: ownStats, otherProcessWriteToBrowserFrame: otherStats };
  } finally {
    A?.destroy();
    other.destroy();
    other.store.close();
    await open.close();
    await hub.stop().catch(() => {});
  }
}

// E4 — the settle loop's idle tick cost as the attached corpus grows.
async function e4(): Promise<void> {
  const dir = H.tempDir();
  const hub = await H.startHub({ databasePath: join(dir, "hub.sqlite") });
  const storePath = join(dir, "store.sqlite");
  const open = await startOpen({ workspaceId: H.WORKSPACE, databasePath: storePath, hubUrl: `ws://127.0.0.1:${hub.port}`, authSecret: H.SECRET });
  try {
    const timeTicks = async (n: number) => {
      const samples: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const t0 = performance.now();
        await open.tick();
        samples.push(performance.now() - t0);
      }
      return H.summarize(samples);
    };
    await open.tick();
    const baseline = { rooms: open.replicas.attachedReplicas().length, idleTickMs: await timeTicks(20) };
    const created: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const uuid = randomUUID();
      const doc = open.replicas.replica(uuid).doc;
      initDoc(doc, { uuid, title: `doc ${i}`, description: "" });
      appendBlock(doc, { type: "paragraph", text: "lorem ipsum ".repeat(10) });
      created.push(uuid);
    }
    await open.tick();
    await H.waitUntil("the corpus to be pushed to the hub", () => created.every((uuid) => open.replicas.isRoomQuiet(roomForDoc(H.WORKSPACE, uuid))), 60_000);
    await timeTicks(5);
    const grown = { rooms: open.replicas.attachedReplicas().length, idleTickMs: await timeTicks(20) };
    out.e4_idleTickCostVsRooms = { baseline, grown, note: "a forced tick = Replicas.settle() (readSince per attached room) + bridge replay for served rooms; nothing pending" };
  } finally {
    await open.close();
    await hub.stop().catch(() => {});
  }
}

for (const [name, run] of Object.entries({ e1, e2, e3, e4 })) {
  console.error(`=== ${name} ===`);
  try {
    await H.withTimeout(run(), 180_000, name);
  } catch (error) {
    out[`${name}_error`] = String(error);
    console.error(`${name} failed: ${String(error)}`);
  }
}
writeFileSync(join(H.SCRATCH, "extras.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
