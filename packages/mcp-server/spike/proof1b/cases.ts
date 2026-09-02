/**
 * Proof 1b cases. Run from packages/mcp-server:
 *   node --no-warnings --import tsx spike/proof1b/cases.ts [--case=1,2,...]
 * Expected outcomes are declared in each case before anything runs.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Server as HocuspocusServer } from "@hocuspocus/server";
import type { Hub } from "@uberblick/hub";
import { appendBlock, editBlock, initDoc, roomForDoc } from "@uberblick/schema";
import * as Y from "yjs";
import type { McpConfig } from "../../src/config.js";
import { Replicas } from "../../src/replica.js";
import { MirrorStore } from "../../src/store.js";
import * as H from "./harness.js";
import { MALFORMED_REASON, REFUSED_REASON, startOpen } from "./open-standin.js";
import type { OpenHandle } from "./open-standin.js";

interface Check {
  name: string;
  pass: boolean;
  detail?: unknown;
}

class Checks {
  readonly list: Check[] = [];
  expect(name: string, condition: boolean, detail?: unknown): void {
    this.list.push({ name, pass: condition, ...(detail === undefined ? {} : { detail }) });
    console.error(`  ${condition ? "ok  " : "FAIL"} ${name}${detail === undefined || condition ? "" : ` ${JSON.stringify(detail)}`}`);
  }
  get pass(): boolean {
    return this.list.every((check) => check.pass);
  }
}

interface CaseResult {
  case: number;
  title: string;
  expected: Record<string, string>;
  checks: Check[];
  observed: Record<string, unknown>;
  pass: boolean;
  error?: string;
  durationMs: number;
}

interface Rig {
  dir: string;
  hub: Hub;
  hubDbPath: string;
  storePath: string;
  open: OpenHandle;
  uuid: string;
  room: string;
  blockId: string;
  clients: H.Client[];
  client(name: string, options?: { token?: string; doc?: Y.Doc; delayMs?: number; url?: string }): H.Client;
  hubPeer(name: string, doc?: Y.Doc): Promise<H.Client>;
  close(): Promise<void>;
}

function mcpConfig(storePath: string, hubUrl: string): McpConfig {
  return {
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
}

/** Another MCP process: its own store connection, its own hub socket. */
function mcpProcess(storePath: string, hubUrl: string): Replicas {
  return new Replicas(mcpConfig(storePath, hubUrl), new MirrorStore(storePath, H.WORKSPACE));
}

async function rig(): Promise<Rig> {
  const dir = H.tempDir();
  const hubDbPath = join(dir, "hub.sqlite");
  const storePath = join(dir, "store.sqlite");
  const hub = await H.startHub({ databasePath: hubDbPath });
  const open = await startOpen({
    workspaceId: H.WORKSPACE,
    databasePath: storePath,
    hubUrl: `ws://127.0.0.1:${hub.port}`,
    authSecret: H.SECRET,
  });
  const uuid = randomUUID();
  const room = roomForDoc(H.WORKSPACE, uuid);
  const replica = open.replicas.replica(uuid);
  initDoc(replica.doc, { uuid, title: "Proof 1b", description: "gate and bridge" });
  const blockId = appendBlock(replica.doc, { type: "paragraph", text: "hello" });
  await open.tick();
  await H.waitUntil(
    "the hub to hold the seed document",
    () => H.textOf(H.hubDoc(hub, room) ?? new Y.Doc(), blockId) === "hello",
  );
  const clients: H.Client[] = [];
  const state = { hub };
  return {
    dir,
    get hub() {
      return state.hub;
    },
    set hub(value: Hub) {
      state.hub = value;
    },
    hubDbPath,
    storePath,
    open,
    uuid,
    room,
    blockId,
    clients,
    client(name, options = {}) {
      const client = H.connect({
        name,
        url: options.url ?? open.url,
        room,
        token: options.token ?? "rw",
        ...(options.doc === undefined ? {} : { doc: options.doc }),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      });
      clients.push(client);
      return client;
    },
    async hubPeer(name, doc) {
      const client = H.connect({
        name,
        url: `ws://127.0.0.1:${state.hub.port}`,
        room,
        token: await H.hubToken(name),
        ...(doc === undefined ? {} : { doc }),
      });
      clients.push(client);
      return client;
    },
    async close() {
      for (const client of clients.splice(0)) client.destroy();
      await open.close();
      await state.hub.stop().catch(() => {});
    },
  };
}

function snapshotHook(open: OpenHandle): Record<number, number> {
  return { ...open.stats.hookByType };
}

// ---------------------------------------------------------------------------
// Case 1 — refusal on the update path and on the reconnect-diff path
// ---------------------------------------------------------------------------
async function case1(): Promise<Omit<CaseResult, "case" | "title" | "durationMs">> {
  const expected = {
    updatePath:
      "A's refused update: never acknowledged (unsyncedChanges stays >0, isSynced false), no store row, server Document / other tab / hub unchanged, A's connection closed with reason uberblick:store-refused",
    step2Path: "the same for a reconnect diff carried in SyncStep2 (client C connecting with an unsent edit)",
    afterwards: "a later legitimate write from B is applied, acknowledged, broadcast to a fresh client and forwarded to the hub",
    closeReason: "the client sees the gate's reason string in the in-band CLOSE; report which code the library forwards",
  };
  const r = await rig();
  const c = new Checks();
  const observed: Record<string, unknown> = {};
  try {
    const A = r.client("A");
    const B = r.client("B");
    await A.settled();
    await B.settled();
    const hubPeer = await r.hubPeer("H");
    await hubPeer.settled();
    const served = r.open.served.get(r.room);
    if (served === undefined) throw new Error("room not served");

    // --- update path ---
    const before = H.storeView(r.storePath, r.room);
    const appendsBefore = r.open.store.appends.length;
    r.open.store.failNext = 1;
    H.typeInto(A.doc, r.blockId, "X");
    await H.waitUntil("A to be closed", () => A.closes.length > 0, 5_000);
    await H.sleep(300);
    const afterA = H.storeView(r.storePath, r.room);
    c.expect("update path: A never acknowledged", A.provider.unsyncedChanges > 0 && !A.provider.isSynced, {
      unsynced: A.provider.unsyncedChanges,
      isSynced: A.provider.isSynced,
      acks: A.frames.acks,
    });
    c.expect("update path: A closed with the gate's reason", A.closes[0]?.reason === REFUSED_REASON, A.closes[0]);
    c.expect("update path: no store row", afterA.updates === before.updates && r.open.store.appends.length === appendsBefore, {
      before: before.updates,
      after: afterA.updates,
    });
    c.expect("update path: server Document unchanged", H.textOf(served.document, r.blockId) === "hello");
    c.expect("update path: other tab unchanged", H.textOf(B.doc, r.blockId) === "hello");
    c.expect(
      "update path: hub unchanged",
      H.textOf(H.hubDoc(r.hub, r.room) ?? new Y.Doc(), r.blockId) === "hello" && H.textOf(hubPeer.doc, r.blockId) === "hello",
    );
    c.expect("update path: replica half unchanged", H.textOf(r.open.replicas.replica(r.uuid).doc, r.blockId) === "hello");
    c.expect("update path: refusal recorded as type 2", r.open.stats.refusals.at(-1)?.type === 2, r.open.stats.refusals.at(-1));
    observed.updatePath = {
      A: { unsynced: A.provider.unsyncedChanges, isSynced: A.provider.isSynced, close: A.closes[0], frames: A.frames },
      rowsBefore: before.updates,
      rowsAfter: afterA.updates,
    };

    // --- later legitimate write from B ---
    const latency = await H.typeAcked(B, r.blockId, "Y");
    await H.waitUntil("the hub peer to see Y", () => H.textOf(hubPeer.doc, r.blockId) === "helloY");
    const afterB = H.storeView(r.storePath, r.room);
    c.expect("afterwards: B's write acknowledged, stored once, at server and hub", afterB.updates === afterA.updates + 1 &&
      H.textOf(served.document, r.blockId) === "helloY" &&
      H.textOf(H.hubDoc(r.hub, r.room) ?? new Y.Doc(), r.blockId) === "helloY", { latencyMs: latency, rows: afterB.updates });
    c.expect("afterwards: the closed client A received nothing (its room is closed)", H.textOf(A.doc, r.blockId) === "helloX", H.textOf(A.doc, r.blockId));

    // --- reconnect-diff path: C connects holding state B has plus an unsent edit ---
    const cDoc = new Y.Doc();
    Y.applyUpdate(cDoc, Y.encodeStateAsUpdate(B.doc));
    H.typeInto(cDoc, r.blockId, "Z");
    const beforeC = H.storeView(r.storePath, r.room);
    const hookBeforeC = snapshotHook(r.open);
    r.open.store.failNext = 1;
    const C = r.client("C", { doc: cDoc });
    await H.waitUntil("C to be closed", () => C.closes.length > 0, 5_000);
    await H.sleep(300);
    const afterC = H.storeView(r.storePath, r.room);
    c.expect("step2 path: C never acknowledged", C.provider.unsyncedChanges > 0 && !C.provider.isSynced, {
      unsynced: C.provider.unsyncedChanges,
      isSynced: C.provider.isSynced,
    });
    c.expect("step2 path: C closed with the gate's reason", C.closes[0]?.reason === REFUSED_REASON, C.closes[0]);
    c.expect("step2 path: refusal seen as SyncStep2 (type 1)", r.open.stats.refusals.at(-1)?.type === 1, r.open.stats.refusals.at(-1));
    c.expect("step2 path: no store row", afterC.updates === beforeC.updates);
    c.expect("step2 path: server / B / hub without Z", H.textOf(served.document, r.blockId) === "helloY" &&
      H.textOf(B.doc, r.blockId) === "helloY" && H.textOf(hubPeer.doc, r.blockId) === "helloY");
    observed.step2Path = {
      C: { unsynced: C.provider.unsyncedChanges, isSynced: C.provider.isSynced, close: C.closes[0], frames: C.frames },
      hookCallsDuringC: Object.fromEntries(
        Object.entries(snapshotHook(r.open)).map(([k, v]) => [k, v - (hookBeforeC[Number(k)] ?? 0)]),
      ),
    };

    // --- afterwards: a fresh client and one more write ---
    const D = r.client("D");
    await D.settled();
    c.expect("afterwards: a fresh client hydrates helloY", H.textOf(D.doc, r.blockId) === "helloY", H.textOf(D.doc, r.blockId));
    await H.typeAcked(B, r.blockId, "W");
    await H.waitUntil("D to see W", () => H.textOf(D.doc, r.blockId) === "helloYW");
    await H.waitUntil("hub to see W", () => H.textOf(hubPeer.doc, r.blockId) === "helloYW");
    c.expect("afterwards: later writes flow to a fresh client and the hub", true);
    observed.refusals = r.open.stats.refusals;
    observed.hookByType = r.open.stats.hookByType;
  } catch (error) {
    c.expect(`case threw: ${String(error)}`, false);
  } finally {
    await r.close();
  }
  return { expected, checks: c.list, observed, pass: c.pass };
}

// ---------------------------------------------------------------------------
// Case 2 — malformed frame
// ---------------------------------------------------------------------------
async function case2(): Promise<Omit<CaseResult, "case" | "title" | "durationMs">> {
  const expected = {
    garbage: "a frame whose update bytes are not a Yjs update is refused before anything is stored: no new row, connection closed with uberblick:malformed-update",
    truncated: "a real keystroke update cut in half is refused the same way",
    hydration: "hydrating the room from the store afterwards succeeds and equals the server Document",
    scratchCoverage: "documented: an update with missing dependencies applies to an empty scratch doc without throwing (it lands in pendingStructs), so the scratch validates decoding, not integration",
    control: "without a gate the pinned server acknowledges a malformed update (y-protocols swallows the decode error, sync.js:82-89) — recorded, not asserted",
  };
  const r = await rig();
  const c = new Checks();
  const observed: Record<string, unknown> = {};
  try {
    const A = r.client("A");
    await A.settled();
    const served = r.open.served.get(r.room);
    if (served === undefined) throw new Error("room not served");
    const before = H.storeView(r.storePath, r.room);

    H.sendRawUpdate(A, r.room, new Uint8Array([0xff, 0x00, 0x01]));
    await H.waitUntil("A to be closed", () => A.closes.length > 0, 5_000);
    await H.sleep(200);
    c.expect("garbage: closed with the malformed reason", A.closes[0]?.reason === MALFORMED_REASON, A.closes[0]);
    c.expect("garbage: no store row", H.storeView(r.storePath, r.room).updates === before.updates);
    c.expect("garbage: no ack", A.frames.acks === 1 /* the handshake's own */, A.frames);
    observed.garbageRefusal = r.open.stats.refusals.at(-1);

    // A real keystroke update, truncated.
    const captured: Uint8Array[] = [];
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(served.document));
    scratch.on("update", (update: Uint8Array) => captured.push(update));
    H.typeInto(scratch, r.blockId, "q");
    const keystroke = captured[0];
    if (keystroke === undefined) throw new Error("no keystroke update captured");
    const truncated = keystroke.subarray(0, Math.floor(keystroke.length / 2));
    const B = r.client("B");
    await B.settled();
    H.sendRawUpdate(B, r.room, truncated);
    await H.waitUntil("B to be closed", () => B.closes.length > 0, 5_000);
    await H.sleep(200);
    c.expect("truncated: closed with the malformed reason", B.closes[0]?.reason === MALFORMED_REASON, B.closes[0]);
    c.expect("truncated: no store row", H.storeView(r.storePath, r.room).updates === before.updates);
    observed.truncatedRefusal = r.open.stats.refusals.at(-1);
    observed.keystrokeBytes = keystroke.length;

    // Hydration from the store still works and matches the server.
    const hydrated = H.hydrateFromStore(r.storePath, r.room);
    c.expect("hydration: store hydrates and equals the server Document", H.sameBlocks(H.blocksOf(hydrated), H.blocksOf(served.document)), H.blocksOf(hydrated));

    // What the empty scratch validates: a dependent update on an empty doc does not throw.
    let dependentThrew = false;
    const empty = new Y.Doc();
    try {
      Y.applyUpdate(empty, keystroke);
    } catch {
      dependentThrew = true;
    }
    observed.scratchCoverage = {
      dependentUpdateThrewOnEmptyDoc: dependentThrew,
      landedInPending: empty.store.pendingStructs !== null,
    };
    c.expect("scratch coverage: a well-formed dependent update is accepted by an empty scratch (pending), i.e. the scratch validates decoding only", !dependentThrew && empty.store.pendingStructs !== null);

    // A fresh client can still open and write.
    const C = r.client("C");
    await C.settled();
    const latency = await H.typeAcked(C, r.blockId, "k");
    c.expect("afterwards: a fresh client opens the room and writes", H.textOf(C.doc, r.blockId) === "hellok", { latencyMs: latency });

    // Control: the pinned server with no gate.
    const bare = new HocuspocusServer({ port: 0, address: "127.0.0.1", quiet: true, stopOnSignals: false });
    await bare.listen();
    const P = H.connect({ name: "P", url: `ws://127.0.0.1:${bare.address.port}`, room: "control", token: "x" });
    await P.settled();
    const acksBefore = P.frames.acks;
    H.sendRawUpdate(P, "control", new Uint8Array([0xff, 0x00, 0x01]));
    await H.sleep(400);
    observed.controlWithoutGate = {
      acksAfterMalformed: P.frames.acks - acksBefore,
      nacks: P.frames.nacks,
      closes: P.closes.length,
      stillSynced: P.provider.isSynced,
    };
    P.destroy();
    await Promise.race([bare.destroy(), H.sleep(2_000)]);
  } catch (error) {
    c.expect(`case threw: ${String(error)}`, false);
  } finally {
    await r.close();
  }
  return { expected, checks: c.list, observed, pass: c.pass };
}

// ---------------------------------------------------------------------------
// Case 3 — read-only and awareness frames
// ---------------------------------------------------------------------------
async function case3(): Promise<Omit<CaseResult, "case" | "title" | "durationMs">> {
  const expected = {
    readOnlyWrite: "the hook sees the read-only connection's update (it runs before Hocuspocus's readOnly check) and stores nothing; Hocuspocus answers SyncStatus(false); server unchanged",
    awareness: "awareness frames never enter beforeSync (hook call counts do not move while an awareness frame is handled); the read-only client's awareness still reaches the server Document, the replica, and the hub",
  };
  const r = await rig();
  const c = new Checks();
  const observed: Record<string, unknown> = {};
  try {
    const RO = r.client("RO", { token: "ro" });
    await RO.settled();
    const served = r.open.served.get(r.room);
    if (served === undefined) throw new Error("room not served");
    const before = H.storeView(r.storePath, r.room);
    const skippedBefore = r.open.stats.readOnlySkipped;
    const nacksBefore = RO.frames.nacks;

    H.typeInto(RO.doc, r.blockId, "S");
    await H.waitUntil("Hocuspocus to answer SyncStatus(false)", () => RO.frames.nacks > nacksBefore, 5_000);
    c.expect("read-only: hook saw the frame and skipped it", r.open.stats.readOnlySkipped === skippedBefore + 1, r.open.stats.readOnlySkipped);
    c.expect("read-only: no store row", H.storeView(r.storePath, r.room).updates === before.updates);
    c.expect("read-only: server Document unchanged", H.textOf(served.document, r.blockId) === "hello");
    c.expect("read-only: client left unacknowledged, not closed", RO.provider.unsyncedChanges === 1 && RO.closes.length === 0, {
      unsynced: RO.provider.unsyncedChanges,
      closes: RO.closes.length,
    });

    const hookBefore = snapshotHook(r.open);
    RO.provider.setAwarenessField("name", "read-only tab");
    const hubDocument = H.hubDoc(r.hub, r.room);
    await H.waitUntil("the server Document to hold the read-only tab's awareness", () =>
      [...served.document.awareness.getStates().values()].some((s) => (s as { name?: string }).name === "read-only tab"),
    );
    await H.waitUntil("the replica awareness to hold it", () =>
      [...served.replica.awareness.getStates().values()].some((s) => (s as { name?: string }).name === "read-only tab"),
    );
    await H.waitUntil("the hub to hold it", () =>
      [...(hubDocument?.awareness.getStates().values() ?? [])].some((s) => (s as { name?: string }).name === "read-only tab"),
    );
    const hookAfter = snapshotHook(r.open);
    c.expect("awareness: hook counts unchanged while an awareness frame was handled", JSON.stringify(hookBefore) === JSON.stringify(hookAfter), { hookBefore, hookAfter });
    c.expect("awareness: only y-sync types 0/1/2 ever reached the hook", Object.keys(hookAfter).every((k) => ["0", "1", "2"].includes(k)), hookAfter);
    c.expect("awareness: read-only tab's presence reached server, replica and hub", true);
    observed.hookByType = hookAfter;
    observed.readOnlySkipped = r.open.stats.readOnlySkipped;
    observed.RO = { unsynced: RO.provider.unsyncedChanges, frames: RO.frames };
  } catch (error) {
    c.expect(`case threw: ${String(error)}`, false);
  } finally {
    await r.close();
  }
  return { expected, checks: c.list, observed, pass: c.pass };
}

// ---------------------------------------------------------------------------
// Case 4 — exactly-once logging in both directions
// ---------------------------------------------------------------------------
async function case4(): Promise<Omit<CaseResult, "case" | "title" | "durationMs">> {
  const expected = {
    browserWrite: "one browser keystroke = exactly one store row (by the gate), one connection-origin update on the server Document, zero bridge-origin updates (the tail replay is a no-op), one update frame at the other tab, and the hub sees it",
    ownReplicaWrite: "an edit_block-equivalent on the stand-in's own replica = exactly one row (by the replica observer), one bridge-origin update on the server Document, one update frame at each tab",
    otherProcessWrite: "an edit_block-equivalent from a second Replicas on the same store = one row by that process; the stand-in logs nothing for it through the bridge; one frame at each tab. Whether the stand-in ALSO logs the hub's echo of it as a remote row (today's two-process behaviour) is measured and reported",
  };
  const r = await rig();
  const c = new Checks();
  const observed: Record<string, unknown> = {};
  let other: Replicas | null = null;
  try {
    const A = r.client("A");
    const B = r.client("B");
    await A.settled();
    await B.settled();
    const hubPeer = await r.hubPeer("H");
    await hubPeer.settled();
    const served = r.open.served.get(r.room);
    if (served === undefined) throw new Error("room not served");
    const counts = () => ({
      rows: H.storeView(r.storePath, r.room).updates,
      gateAppends: r.open.store.appends.filter((a) => a.room === r.room && a.by === "gate").length,
      replicaAppends: r.open.store.appends.filter((a) => a.room === r.room && a.by === "replica").length,
      remoteAppends: r.open.store.appends.filter((a) => a.room === r.room && a.origin === "remote").length,
      docConnection: r.open.stats.documentUpdates.filter((u) => u.room === r.room && u.origin === "connection").length,
      docBridge: r.open.stats.documentUpdates.filter((u) => u.room === r.room && u.origin === "bridge").length,
      framesA: A.frames.updates,
      framesB: B.frames.updates,
    });
    const delta = (a: ReturnType<typeof counts>, b: ReturnType<typeof counts>) =>
      Object.fromEntries(Object.keys(a).map((k) => [k, (b as Record<string, number>)[k]! - (a as Record<string, number>)[k]!]));

    // 1. browser write
    const c0 = counts();
    await H.typeAcked(A, r.blockId, "1");
    await H.waitUntil("B to see 1", () => H.textOf(B.doc, r.blockId) === "hello1");
    await H.waitUntil("hub to see 1", () => H.textOf(hubPeer.doc, r.blockId) === "hello1");
    await r.open.tick();
    await H.sleep(150);
    const d1 = delta(c0, counts());
    observed.browserWrite = d1;
    c.expect("browser write: exactly one row, by the gate", d1.rows === 1 && d1.gateAppends === 1 && d1.replicaAppends === 0, d1);
    c.expect("browser write: server Document saw one connection update and no bridge update", d1.docConnection === 1 && d1.docBridge === 0, d1);
    c.expect("browser write: other tab received exactly one update frame", d1.framesB === 1, d1);
    c.expect("browser write: replica half converged", H.textOf(r.open.replicas.replica(r.uuid).doc, r.blockId) === "hello1");

    // 2. write through the stand-in's own replica (edit_block-equivalent)
    const c1 = counts();
    editBlock(r.open.replicas.replica(r.uuid).doc, r.blockId, "hello1", "hello1 own");
    await H.waitUntil("A to see the replica write", () => H.textOf(A.doc, r.blockId) === "hello1 own");
    await H.waitUntil("B to see the replica write", () => H.textOf(B.doc, r.blockId) === "hello1 own");
    await H.waitUntil("hub to see the replica write", () => H.textOf(hubPeer.doc, r.blockId) === "hello1 own");
    await r.open.tick();
    await H.sleep(150);
    const d2 = delta(c1, counts());
    observed.ownReplicaWrite = d2;
    c.expect("own replica write: exactly one row, by the replica observer", d2.rows === 1 && d2.replicaAppends === 1 && d2.gateAppends === 0, d2);
    c.expect("own replica write: server Document saw one bridge update", d2.docBridge === 1 && d2.docConnection === 0, d2);
    c.expect("own replica write: each tab received exactly one update frame", d2.framesA === 1 && d2.framesB === 1, d2);

    // 3. write from another process on the same store
    other = mcpProcess(r.storePath, `ws://127.0.0.1:${r.hub.port}`);
    const otherDoc = other.replica(r.uuid).doc;
    await H.waitUntil("the other process to hydrate from the log", () => H.textOf(otherDoc, r.blockId) === "hello1 own");
    const c2 = counts();
    const otherRowsBefore = H.storeView(r.storePath, r.room).updates;
    editBlock(otherDoc, r.blockId, "hello1 own", "hello1 own other");
    await H.waitUntil("A to see the other process's write", () => H.textOf(A.doc, r.blockId) === "hello1 own other");
    await H.waitUntil("B to see it", () => H.textOf(B.doc, r.blockId) === "hello1 own other");
    await H.waitUntil("hub to see it", () => H.textOf(hubPeer.doc, r.blockId) === "hello1 own other");
    await r.open.tick();
    await H.sleep(300);
    const d3 = delta(c2, counts());
    observed.otherProcessWrite = { ...d3, storeRowsFromOtherProcess: H.storeView(r.storePath, r.room).updates - otherRowsBefore };
    c.expect("other process write: the stand-in appended nothing through the bridge", d3.gateAppends === 0 && d3.replicaAppends === d3.remoteAppends, d3);
    c.expect("other process write: server Document saw exactly one bridge update", d3.docBridge === 1 && d3.docConnection === 0, d3);
    c.expect("other process write: each tab received exactly one update frame", d3.framesA === 1 && d3.framesB === 1, d3);
    // Reported, not asserted: today's two-process path can log the hub's echo as a second (remote) row.
    observed.otherProcessWriteRowsNote =
      d3.rows === 1
        ? "one row total: the stand-in's tail poll won the race against the hub's echo"
        : `${d3.rows} rows total: the hub's echo reached the stand-in's replica before the tail poll and was logged as a remote row (harmless, idempotent; today's two-process behaviour, not a bridge artefact)`;
    observed.totals = counts();
  } catch (error) {
    c.expect(`case threw: ${String(error)}`, false);
  } finally {
    if (other !== null) {
      other.destroy();
      other.store.close();
    }
    await r.close();
  }
  return { expected, checks: c.list, observed, pass: c.pass };
}

// ---------------------------------------------------------------------------
// Case 5 — awareness bridge
// ---------------------------------------------------------------------------
async function case5(): Promise<Omit<CaseResult, "case" | "title" | "durationMs">> {
  const expected = {
    browserToHub: "a browser's awareness state reaches the upstream hub's Document and a hub-side peer",
    hubToBrowser: "a hub-side peer's awareness state reaches the browser",
    noStorm: "at rest the awareness traffic per second is at most the y-protocols heartbeat (one renewal per client per 15s); a burst of 20 field changes produces no more than ~20 frames per observer",
  };
  const r = await rig();
  const c = new Checks();
  const observed: Record<string, unknown> = {};
  try {
    const A = r.client("A");
    await A.settled();
    const hubPeer = await r.hubPeer("H");
    await hubPeer.settled();
    const hubDocument = H.hubDoc(r.hub, r.room);
    if (hubDocument === undefined) throw new Error("hub document not loaded");
    const has = (states: Map<number, unknown>, name: string) =>
      [...states.values()].some((s) => (s as { name?: string }).name === name);

    A.provider.setAwarenessField("name", "browser-a");
    await H.waitUntil("the hub Document to hold browser-a", () => has(hubDocument.awareness.getStates(), "browser-a"));
    await H.waitUntil("the hub peer to hold browser-a", () => has(hubPeer.provider.awareness!.getStates(), "browser-a"));
    c.expect("browser → hub: awareness reached the hub and a hub-side peer", true);

    hubPeer.provider.setAwarenessField("name", "hub-agent");
    await H.waitUntil("the browser to hold hub-agent", () => has(A.provider.awareness!.getStates(), "hub-agent"));
    c.expect("hub → browser: hub-side awareness reached the browser", true);

    // Burst: 20 quick changes from the browser.
    let hubAwarenessUpdates = 0;
    const countHub = () => {
      hubAwarenessUpdates += 1;
    };
    hubDocument.awareness.on("update", countHub);
    const peerFramesBefore = hubPeer.frames.awareness;
    const aFramesBefore = A.frames.awareness;
    for (let i = 0; i < 20; i += 1) {
      A.provider.setAwarenessField("cursor", { i });
    }
    await H.sleep(1_000);
    const burst = {
      hubAwarenessUpdates,
      hubPeerFrames: hubPeer.frames.awareness - peerFramesBefore,
      browserFramesBack: A.frames.awareness - aFramesBefore,
    };
    observed.burst = burst;
    c.expect("burst: no amplification (hub updates and peer frames <= ~20 + heartbeat)", burst.hubAwarenessUpdates <= 22 && burst.hubPeerFrames <= 22, burst);

    // At rest.
    hubAwarenessUpdates = 0;
    const restStartA = A.frames.awareness;
    const restStartPeer = hubPeer.frames.awareness;
    const windowMs = 6_000;
    await H.sleep(windowMs);
    const rest = {
      windowMs,
      browserFrames: A.frames.awareness - restStartA,
      hubPeerFrames: hubPeer.frames.awareness - restStartPeer,
      hubAwarenessUpdates,
      browserFramesPerSecond: (A.frames.awareness - restStartA) / (windowMs / 1000),
      hubUpdatesPerSecond: hubAwarenessUpdates / (windowMs / 1000),
    };
    hubDocument.awareness.off("update", countHub);
    observed.rest = rest;
    c.expect("rest: no echo storm (< 1 awareness frame per second at every observer)", rest.browserFramesPerSecond < 1 && rest.hubUpdatesPerSecond < 1, rest);
  } catch (error) {
    c.expect(`case threw: ${String(error)}`, false);
  } finally {
    await r.close();
  }
  return { expected, checks: c.list, observed, pass: c.pass };
}

// ---------------------------------------------------------------------------
// Case 6 — upstream outage while typing
// ---------------------------------------------------------------------------
async function case6(): Promise<Omit<CaseResult, "case" | "title" | "durationMs">> {
  const expected = {
    outage: "with the hub stopped, every browser keystroke is stored, acknowledged locally and the room stays pending (unsynced upstream); an MCP-style write from another process also lands and reaches the browser",
    recovery: "after the hub restarts on the same port every write converges at the hub (in memory and for a fresh peer) with no loss and no duplicated blocks; pending_rooms clears only after the hub acknowledged",
  };
  const r = await rig();
  const c = new Checks();
  const observed: Record<string, unknown> = {};
  let other: Replicas | null = null;
  try {
    const A = r.client("A");
    await A.settled();
    const hubPeer = await r.hubPeer("H");
    await hubPeer.settled();
    const port = r.hub.port;
    await r.hub.stop();
    await H.waitUntil("the stand-in to report hub-down", () => r.open.replicas.sync.state().status === "hub-down", 10_000);

    const latencies: number[] = [];
    for (const ch of "abc") latencies.push(await H.typeAcked(A, r.blockId, ch));
    const during = H.storeView(r.storePath, r.room);
    c.expect("outage: keystrokes acknowledged locally", A.provider.unsyncedChanges === 0 && latencies.length === 3, latencies);
    c.expect("outage: keystrokes stored", during.updates >= 3 && during.local >= 3, during);
    c.expect("outage: room pending, upstream reads unsynced", during.pending.some((p) => p.room === r.room) && !r.open.replicas.isRoomQuiet(r.room), during.pending);
    c.expect("outage: sync state is hub-down", r.open.replicas.sync.state().status === "hub-down", r.open.replicas.sync.state());

    other = mcpProcess(r.storePath, `ws://127.0.0.1:${port}`);
    const otherDoc = other.replica(r.uuid).doc;
    await H.waitUntil("the other process to hydrate", () => H.textOf(otherDoc, r.blockId) === "helloabc");
    editBlock(otherDoc, r.blockId, "helloabc", "helloabc+mcp");
    await H.waitUntil("the browser to see the MCP write during the outage", () => H.textOf(A.doc, r.blockId) === "helloabc+mcp");
    c.expect("outage: MCP-style write landed and reached the browser", true);
    observed.duringOutage = { latencies, store: during, pendingAfterMcp: H.storeView(r.storePath, r.room).pending };

    // Pending must not clear while the hub is down.
    await r.open.tick();
    c.expect("outage: pending not cleared while the hub is down", H.storeView(r.storePath, r.room).pending.some((p) => p.room === r.room));

    r.hub = await H.startHub({ port, databasePath: r.hubDbPath });
    await H.waitUntil("the stand-in to reconnect", () => r.open.replicas.sync.state().status === "connected", 15_000);
    await H.waitUntil("the room to be acknowledged upstream", () => r.open.replicas.isRoomQuiet(r.room), 15_000);
    const ackedAt = Date.now();
    await r.open.tick();
    await H.waitUntil("pending_rooms to clear", () => !H.storeView(r.storePath, r.room).pending.some((p) => p.room === r.room), 10_000);
    c.expect("recovery: pending cleared after acknowledgement", true, { clearedWithinMs: Date.now() - ackedAt });

    const peer2 = await r.hubPeer("H2");
    await peer2.settled();
    await H.waitUntil("the old hub peer to reconnect and converge", () => H.textOf(hubPeer.doc, r.blockId) === "helloabc+mcp", 15_000);
    await H.waitUntil("the hub's in-memory document to converge", () => H.textOf(H.hubDoc(r.hub, r.room) ?? new Y.Doc(), r.blockId) === "helloabc+mcp", 15_000);
    const served = r.open.served.get(r.room);
    const lists = {
      browser: H.blocksOf(A.doc),
      replica: H.blocksOf(r.open.replicas.replica(r.uuid).doc),
      serverDocument: served === undefined ? [] : H.blocksOf(served.document),
      hubMemory: H.blocksOf(H.hubDoc(r.hub, r.room) ?? new Y.Doc()),
      freshHubPeer: H.blocksOf(peer2.doc),
      oldHubPeer: H.blocksOf(hubPeer.doc),
      storeHydrated: H.blocksOf(H.hydrateFromStore(r.storePath, r.room)),
      otherProcess: H.blocksOf(otherDoc),
    };
    const reference = lists.browser;
    const allEqual = Object.values(lists).every((l) => H.sameBlocks(l, reference));
    const dupes = Object.values(lists).flatMap((l) => H.duplicateIds(l));
    observed.lists = lists;
    c.expect("recovery: every copy holds the same single block list", allEqual && reference.length === 1 && reference[0]?.text === "helloabc+mcp", lists);
    c.expect("recovery: no duplicated blocks", dupes.length === 0, dupes);
  } catch (error) {
    c.expect(`case threw: ${String(error)}`, false);
  } finally {
    if (other !== null) {
      other.destroy();
      other.store.close();
    }
    await r.close();
  }
  return { expected, checks: c.list, observed, pass: c.pass };
}

// ---------------------------------------------------------------------------
// Case 7 — serving-process death
// ---------------------------------------------------------------------------
async function case7(): Promise<Omit<CaseResult, "case" | "title" | "durationMs">> {
  const expected = {
    durability: "after SIGKILL mid-typing the store holds every acknowledged keystroke (stored >= acked)",
    reconnect: "the browser reconnects to the restarted stand-in and converges with no loss: its un-acknowledged keystrokes are re-sent in the reconnect diff and gated; the hub converges too",
    lossWindow: "reported: keystrokes sent but not stored at death = what a tab that also died would lose; measured at typing speed and in a burst",
  };
  const c = new Checks();
  const observed: Record<string, unknown> = {};
  const dir = H.tempDir();
  const hubDbPath = join(dir, "hub.sqlite");
  const storePath = join(dir, "store.sqlite");
  const hub = await H.startHub({ databasePath: hubDbPath });
  const hubUrl = `ws://127.0.0.1:${hub.port}`;
  const mcp = mcpProcess(storePath, hubUrl);
  const uuid = randomUUID();
  const room = roomForDoc(H.WORKSPACE, uuid);
  const seed = mcp.replica(uuid);
  initDoc(seed.doc, { uuid, title: "Proof 1b death", description: "kill" });
  const blockId = appendBlock(seed.doc, { type: "paragraph", text: "" });
  await mcp.settle();
  const port = await H.freePort();
  const logPath = join(H.SCRATCH, "case7-child.log");
  let child: H.ChildStandin | null = null;
  let A: H.Client | null = null;
  try {
    child = await H.spawnStandin({ port, databasePath: storePath, hubUrl, logPath });
    A = H.connect({ name: "A", url: `ws://127.0.0.1:${port}`, room, token: "rw", delayMs: 150 });
    await A.settled();
    const hubPeer = H.connect({ name: "H", url: hubUrl, room, token: await H.hubToken("peer") });
    await hubPeer.settled();

    const runKill = async (label: string, typing: () => Promise<number>) => {
      if (child === null || A === null) throw new Error("no child");
      const acksStart = A.frames.acks;
      const textStart = H.textOf(A.doc, blockId).length;
      const sent = await typing();
      const acked = A.frames.acks - acksStart;
      const killAt = performance.now();
      child.kill();
      await child.exited;
      const storedAtDeath = H.textOf(H.hydrateFromStore(storePath, room), blockId).length - textStart;
      await H.waitUntil(`${label}: the browser to notice the death`, () => !A!.provider.isSynced, 10_000);
      const step2Before = A.frames.step2;
      child = await H.spawnStandin({ port, databasePath: storePath, hubUrl, logPath });
      const restartedAfterMs = Math.round(performance.now() - killAt);
      await H.waitUntil(`${label}: the browser to reconnect and settle`, () => A!.frames.step2 > step2Before && A!.provider.isSynced && A!.provider.unsyncedChanges === 0, 30_000);
      const expectedText = H.textOf(A.doc, blockId);
      await H.waitUntil(`${label}: the store to converge on the browser's text`, () => H.textOf(H.hydrateFromStore(storePath, room), blockId) === expectedText, 15_000);
      await H.waitUntil(`${label}: the hub to converge`, () => H.textOf(hubPeer.doc, blockId) === expectedText, 30_000);
      const result = {
        sent,
        ackedAtKill: acked,
        storedAtDeath,
        inFlightAtKill: sent - acked,
        sentButNotStoredAtDeath: sent - storedAtDeath,
        restartedAfterMs,
        textLengthAfterRecovery: expectedText.length - textStart,
      };
      c.expect(`${label}: store held every acknowledged keystroke (stored >= acked)`, storedAtDeath >= acked, result);
      c.expect(`${label}: store never held more than was sent`, storedAtDeath <= sent, result);
      c.expect(`${label}: browser reconnected and converged with no loss (tab alive)`, expectedText.length - textStart === sent, result);
      c.expect(`${label}: hub converged`, H.textOf(hubPeer.doc, blockId) === expectedText, result);
      return result;
    };

    observed.typingSpeed = await runKill("typing", async () => {
      let sent = 0;
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          H.typeInto(A!.doc, blockId, String.fromCharCode(97 + (sent % 26)));
          sent += 1;
          if (sent >= 40) {
            clearInterval(timer);
            resolve();
          }
        }, 15);
      });
      return sent;
    });

    observed.burst = await runKill("burst", async () => {
      for (let i = 0; i < 300; i += 1) H.typeInto(A!.doc, blockId, String.fromCharCode(65 + (i % 26)));
      return 300;
    });

    // What a tab that died in the window would get: the store at death, which the
    // reconnect diff then extends. Reported from the two runs above.
    observed.lossWindowNote =
      "sentButNotStoredAtDeath is the declared window (v3 §5.4): keystrokes a dead tab would lose. A live tab loses nothing: the reconnect diff re-sends them.";
    hubPeer.destroy();
  } catch (error) {
    c.expect(`case threw: ${String(error)}`, false);
  } finally {
    A?.destroy();
    if (child !== null) await child.stop().catch(() => {});
    mcp.destroy();
    mcp.store.close();
    await hub.stop().catch(() => {});
  }
  return { expected, checks: c.list, observed, pass: c.pass };
}

// ---------------------------------------------------------------------------
// Case 8 — cost
// ---------------------------------------------------------------------------
async function case8(): Promise<Omit<CaseResult, "case" | "title" | "durationMs">> {
  const expected = {
    perUpdate: "gate cost per keystroke (scratch validate + append) is well under a millisecond p50 and a few ms p95 on this machine; end-to-end ack latency a few ms",
    lockStall: "a write lock held by another process for 1.5s stalls the append (and the whole event loop, node:sqlite is synchronous) for up to that long; a lock held beyond busy_timeout (5s) turns into SQLITE_BUSY, i.e. a refusal of that connection",
  };
  const r = await rig();
  const c = new Checks();
  const observed: Record<string, unknown> = {};
  let loopGapTimer: NodeJS.Timeout | null = null;
  try {
    const A = r.client("A");
    const B = r.client("B");
    await A.settled();
    await B.settled();

    // Typing speed: 150 keystrokes, each acknowledged, ~30ms apart.
    const ackLatencies: number[] = [];
    const gateStart = r.open.stats.gate.length;
    for (let i = 0; i < 150; i += 1) {
      const t0 = performance.now();
      ackLatencies.push(await H.typeAcked(A, r.blockId, "x"));
      const spent = performance.now() - t0;
      if (spent < 30) await H.sleep(30 - spent);
    }
    const samples = r.open.stats.gate.slice(gateStart).filter((s) => s.type === 2);
    observed.typing = {
      keystrokes: samples.length,
      bytesPerUpdate: H.summarize(samples.map((s) => s.bytes)),
      validateMs: H.summarize(samples.map((s) => s.validateMs)),
      appendMs: H.summarize(samples.map((s) => s.appendMs)),
      gateTotalMs: H.summarize(samples.map((s) => s.totalMs)),
      ackLatencyMs: H.summarize(ackLatencies),
    };
    c.expect("typing: gate p95 under 5 ms", H.percentile(samples.map((s) => s.totalMs), 95) < 5, observed.typing);

    // Microbench: decode-only vs scratch apply, small and large updates.
    const keystroke = new Y.Doc();
    Y.applyUpdate(keystroke, Y.encodeStateAsUpdate(A.doc));
    const small: Uint8Array[] = [];
    keystroke.on("update", (u: Uint8Array) => small.push(u));
    H.typeInto(keystroke, r.blockId, "y");
    const big = new Y.Doc();
    initDoc(big, { uuid: randomUUID(), title: "big", description: "" });
    for (let i = 0; i < 200; i += 1) appendBlock(big, { type: "paragraph", text: "lorem ipsum ".repeat(20) });
    const bigUpdate = Y.encodeStateAsUpdate(big);
    const bench = (label: string, update: Uint8Array, iterations: number) => {
      let t = performance.now();
      for (let i = 0; i < iterations; i += 1) {
        const d = new Y.Doc();
        Y.applyUpdate(d, update);
        d.destroy();
      }
      const applyMs = (performance.now() - t) / iterations;
      t = performance.now();
      for (let i = 0; i < iterations; i += 1) Y.decodeUpdate(update);
      const decodeMs = (performance.now() - t) / iterations;
      return { label, bytes: update.length, scratchApplyMs: Math.round(applyMs * 1000) / 1000, decodeOnlyMs: Math.round(decodeMs * 1000) / 1000 };
    };
    observed.microbench = [bench("keystroke", small[0]!, 2_000), bench("50KB-ish document as one update", bigUpdate, 50)];

    // Event-loop stall meter.
    let lastTick = performance.now();
    let maxGap = 0;
    loopGapTimer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastTick);
      lastTick = now;
    }, 5);

    // Lock held 1.5s by another process.
    const lock = H.holdLock(r.storePath, 1_500);
    await H.withTimeout(lock.acquired, 5_000, "lock acquired");
    maxGap = 0;
    lastTick = performance.now();
    const gateBefore = r.open.stats.gate.length;
    const stallA = H.typeAcked(A, r.blockId, "L", 10_000);
    await H.sleep(200);
    const stallB = H.typeAcked(B, r.blockId, "M", 10_000);
    const [aMs, bMs] = await Promise.all([stallA, stallB]);
    await lock.released;
    const stalled = r.open.stats.gate.slice(gateBefore);
    observed.lockStall = {
      lockHeldMs: 1_500,
      aAckLatencyMs: Math.round(aMs),
      bAckLatencyMs_sentAt200ms: Math.round(bMs),
      maxAppendMs: Math.round(Math.max(0, ...stalled.map((s) => s.appendMs))),
      eventLoopMaxGapMs: Math.round(maxGap),
    };
    c.expect("lock 1.5s: the append waited out the lock instead of failing (max append >= 1000ms, both acked)", Math.max(0, ...stalled.map((s) => s.appendMs)) >= 1_000 && A.closes.length === 0, observed.lockStall);

    // Lock held beyond busy_timeout.
    const lock2 = H.holdLock(r.storePath, 6_500);
    await H.withTimeout(lock2.acquired, 5_000, "lock2 acquired");
    const t0 = performance.now();
    H.typeInto(A.doc, r.blockId, "N");
    await H.waitUntil("A to be refused after busy_timeout", () => A.closes.length > 0, 9_000);
    const refusedAfterMs = Math.round(performance.now() - t0);
    await lock2.released;
    observed.lockBeyondBusyTimeout = {
      lockHeldMs: 6_500,
      refusedAfterMs,
      close: A.closes[0],
      cause: r.open.stats.refusals.at(-1)?.cause,
    };
    c.expect("lock 6.5s: SQLITE_BUSY became a refusal of that connection after ~busy_timeout", A.closes[0]?.reason === REFUSED_REASON && refusedAfterMs >= 4_500 && refusedAfterMs < 8_000, observed.lockBeyondBusyTimeout);
    const bAfter = await H.typeAcked(B, r.blockId, "O");
    c.expect("lock 6.5s: the process serves other connections afterwards", H.textOf(B.doc, r.blockId).endsWith("O"), { latencyMs: Math.round(bAfter) });
  } catch (error) {
    c.expect(`case threw: ${String(error)}`, false);
  } finally {
    if (loopGapTimer !== null) clearInterval(loopGapTimer);
    await r.close();
  }
  return { expected, checks: c.list, observed, pass: c.pass };
}

// ---------------------------------------------------------------------------

const CASES: { n: number; title: string; run: () => Promise<Omit<CaseResult, "case" | "title" | "durationMs">> }[] = [
  { n: 1, title: "refusal on the update path and the reconnect-diff path", run: case1 },
  { n: 2, title: "malformed frame", run: case2 },
  { n: 3, title: "read-only and awareness frames", run: case3 },
  { n: 4, title: "exactly-once logging", run: case4 },
  { n: 5, title: "awareness bridge", run: case5 },
  { n: 6, title: "upstream outage while typing", run: case6 },
  { n: 7, title: "serving-process death", run: case7 },
  { n: 8, title: "cost", run: case8 },
];

async function main(): Promise<void> {
  const selected = process.argv
    .find((a) => a.startsWith("--case="))
    ?.slice("--case=".length)
    .split(",")
    .map(Number);
  const results: CaseResult[] = [];
  for (const entry of CASES) {
    if (selected !== undefined && !selected.includes(entry.n)) continue;
    console.error(`\n=== case ${entry.n}: ${entry.title} ===`);
    const started = Date.now();
    let result: CaseResult;
    try {
      const outcome = await H.withTimeout(entry.run(), 240_000, `case ${entry.n}`);
      result = { case: entry.n, title: entry.title, ...outcome, durationMs: Date.now() - started };
    } catch (error) {
      result = {
        case: entry.n,
        title: entry.title,
        expected: {},
        checks: [],
        observed: {},
        pass: false,
        error: String(error),
        durationMs: Date.now() - started,
      };
    }
    results.push(result);
    console.error(`=== case ${entry.n}: ${result.pass ? "PASS" : "FAIL"} (${result.durationMs}ms)${result.error ? ` ${result.error}` : ""}`);
    writeFileSync(join(H.SCRATCH, `case${entry.n}.json`), JSON.stringify(result, null, 2));
  }
  writeFileSync(join(H.SCRATCH, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map((r) => ({ case: r.case, title: r.title, pass: r.pass, failed: r.checks.filter((c) => !c.pass).map((c) => c.name), error: r.error, durationMs: r.durationMs })), null, 2));
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

await main();
