/**
 * Proof 1b extras, part 2: separate the settle loop's hub wait from the store cost (E4b),
 * and test whether a local write on a freshly attached room bypasses the attach bound (E5).
 *   node --no-warnings --import tsx spike/proof1b/extras2.ts
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHub } from "@uberblick/hub";
import type { HubLogRecord } from "@uberblick/hub";
import { appendBlock, initDoc, roomForDoc } from "@uberblick/schema";
import type { McpConfig } from "../../src/config.js";
import { Replicas } from "../../src/replica.js";
import { MirrorStore } from "../../src/store.js";
import * as H from "./harness.js";
import { startOpen } from "./open-standin.js";

const out: Record<string, unknown> = {};

function syncInternals(replicas: Replicas): Record<string, unknown> {
  const sync = replicas.sync as unknown as {
    waiting: Map<string, unknown>;
    attaching: Set<string>;
    socketGeneration: number;
    rebuilds: number;
  };
  return {
    state: replicas.sync.state(),
    isDraining: replicas.sync.isDraining(),
    unsyncedChanges: replicas.sync.unsyncedChanges(),
    waiting: sync.waiting.size,
    attaching: sync.attaching.size,
    socketGeneration: sync.socketGeneration,
    rebuilds: sync.rebuilds,
    settleNeeded: (replicas as unknown as { settleNeeded: boolean }).settleNeeded,
  };
}

async function e4b(): Promise<void> {
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
    const timeReadSince = () => {
      const t0 = performance.now();
      let rooms = 0;
      for (const replica of open.replicas.attachedReplicas()) {
        open.store.readSince(replica.room, replica.lastSeq);
        rooms += 1;
      }
      return { rooms, ms: Math.round((performance.now() - t0) * 1000) / 1000 };
    };
    await open.tick();
    const baseline = { rooms: open.replicas.attachedReplicas().length, idleTickMs: await timeTicks(10), readSinceAllRooms: timeReadSince(), sync: syncInternals(open.replicas) };
    // Create 300 documents the way a tool call does: attach, then write.
    const created: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const uuid = randomUUID();
      const doc = open.replicas.replica(uuid).doc;
      initDoc(doc, { uuid, title: `doc ${i}`, description: "" });
      appendBlock(doc, { type: "paragraph", text: "lorem ipsum ".repeat(10) });
      created.push(uuid);
    }
    const afterBurst = syncInternals(open.replicas);
    await open.tick();
    await H.waitUntil("the corpus to be pushed to the hub", () => created.every((uuid) => open.replicas.isRoomQuiet(roomForDoc(H.WORKSPACE, uuid))), 90_000);
    const afterPush = syncInternals(open.replicas);
    const grownTicks = await timeTicks(5);
    const grownInternals = syncInternals(open.replicas);
    const readSinceGrown = timeReadSince();
    // Isolate: with the hub wait switched off, what does a tick cost?
    (open.replicas as unknown as { settleNeeded: boolean }).settleNeeded = false;
    const grownTicksNoHubWait = await timeTicks(10);
    out.e4b = {
      baseline,
      afterBurst,
      afterPush,
      grown: { rooms: open.replicas.attachedReplicas().length, idleTickMs: grownTicks, syncAfterTicks: grownInternals, readSinceAllRooms: readSinceGrown, idleTickMsWithSettleNeededCleared: grownTicksNoHubWait },
    };
  } finally {
    await open.close();
    await hub.stop().catch(() => {});
  }
}

// E5 — does a local write on a freshly attached room reach the hub ahead of its token?
async function e5(): Promise<void> {
  const dir = H.tempDir();
  const records: HubLogRecord[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const hub = await createHub({
    authSecret: H.SECRET,
    port: 0,
    databasePath: join(dir, "hub.sqlite"),
    log: (record) => {
      records.push(record);
    },
    maxPendingDocuments: 5,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  const config: McpConfig = {
    workspaceId: H.WORKSPACE,
    hubUrl: `ws://127.0.0.1:${hub.port}`,
    authSecret: H.SECRET,
    databasePath: join(dir, "store.sqlite"),
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
  const replicas = new Replicas(config, new MirrorStore(config.databasePath, H.WORKSPACE));
  try {
    await replicas.settle();
    const before = syncInternals(replicas);
    // Ten creations in one burst, each attach-then-write, against a hub that
    // allows 5 unauthenticated documents per socket and a client bound of 32.
    const created: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const uuid = randomUUID();
      const doc = replicas.replica(uuid).doc;
      initDoc(doc, { uuid, title: `burst ${i}`, description: "" });
      created.push(uuid);
    }
    await H.sleep(1_500);
    const after = syncInternals(replicas);
    await replicas.settle();
    await H.waitUntil("the burst to reach the hub eventually", () => created.every((uuid) => replicas.isRoomQuiet(roomForDoc(H.WORKSPACE, uuid))), 30_000).catch((error) => {
      out.e5_wait = String(error);
    });
    out.e5_writeBeforeToken = {
      hubMaxPendingDocuments: 5,
      before,
      after,
      socketTerminatedByHub: warnings.some((w) => w.includes("too many pending unauthenticated documents")),
      hubWarnings: warnings,
      roomsClosedByHub: records.filter((r) => r.event === "hub.room.closed").length,
      roomsConnected: records.filter((r) => r.event === "hub.room.connected").length,
      eventuallyQuiet: created.every((uuid) => replicas.isRoomQuiet(roomForDoc(H.WORKSPACE, uuid))),
      finalInternals: syncInternals(replicas),
    };
  } finally {
    console.warn = originalWarn;
    replicas.destroy();
    replicas.store.close();
    await hub.stop().catch(() => {});
  }
}

for (const [name, run] of Object.entries({ e4b, e5 })) {
  console.error(`=== ${name} ===`);
  try {
    await H.withTimeout(run(), 240_000, name);
  } catch (error) {
    out[`${name}_error`] = String(error);
    console.error(`${name} failed: ${String(error)}`);
  }
}
writeFileSync(join(H.SCRATCH, "extras2.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
