/**
 * Proof 1b extras, part 3: is the stuck admission state HubSync's own (bare Replicas,
 * no stand-in), and does attaching without writes keep the bound intact?
 *   node --no-warnings --import tsx spike/proof1b/extras3.ts
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHub } from "@uberblick/hub";
import { appendBlock, initDoc, roomForDoc } from "@uberblick/schema";
import type { McpConfig } from "../../src/config.js";
import { Replicas } from "../../src/replica.js";
import { MirrorStore } from "../../src/store.js";
import * as H from "./harness.js";

const out: Record<string, unknown> = {};

function config(storePath: string, hubUrl: string): McpConfig {
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

function internals(replicas: Replicas): Record<string, unknown> {
  const sync = replicas.sync as unknown as { waiting: Map<string, unknown>; attaching: Set<string>; socketGeneration: number; rebuilds: number };
  return {
    status: replicas.sync.state().status,
    isDraining: replicas.sync.isDraining(),
    unsyncedChanges: replicas.sync.unsyncedChanges(),
    waiting: sync.waiting.size,
    attaching: sync.attaching.size,
    socketGeneration: sync.socketGeneration,
    rebuilds: sync.rebuilds,
    settleNeeded: (replicas as unknown as { settleNeeded: boolean }).settleNeeded,
  };
}

async function timeSettles(replicas: Replicas, n: number) {
  const samples: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    await replicas.settle();
    samples.push(performance.now() - t0);
  }
  return H.summarize(samples);
}

async function e6(): Promise<void> {
  const dir = H.tempDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const hub = await createHub({ authSecret: H.SECRET, port: 0, databasePath: join(dir, "hub.sqlite"), log: () => {}, debounce: 20, maxDebounce: 200, shutdownTimeoutMs: 5_000 });
  const hubUrl = `ws://127.0.0.1:${hub.port}`;
  const storePath = join(dir, "store.sqlite");
  const writer = new Replicas(config(storePath, hubUrl), new MirrorStore(storePath, H.WORKSPACE));
  let reader: Replicas | null = null;
  try {
    await writer.settle();
    // (a) attach-then-write burst on a bare Replicas: today's create_doc path, 300 times.
    const created: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const uuid = randomUUID();
      const doc = writer.replica(uuid).doc;
      initDoc(doc, { uuid, title: `doc ${i}`, description: "" });
      appendBlock(doc, { type: "paragraph", text: "lorem ipsum ".repeat(10) });
      created.push(uuid);
    }
    const afterBurst = internals(writer);
    await writer.settle();
    await H.waitUntil("the burst to be pushed", () => created.every((uuid) => writer.isRoomQuiet(roomForDoc(H.WORKSPACE, uuid))), 90_000);
    const afterPush = internals(writer);
    const settleMs = await timeSettles(writer, 3);
    out.e6a_bareReplicas_attachThenWriteBurst = {
      socketTerminatedByHub: warnings.some((w) => w.includes("too many pending unauthenticated documents")),
      hubWarnings: warnings.length,
      afterBurst,
      afterPush,
      settleMsAfterwards: settleMs,
      verdict: afterPush.attaching === 32 && settleMs.p50 > 2_500 ? "HubSync's own: 32 admission slots stay held after the hub-terminated socket; every settle() then waits syncTimeoutMs" : "no stuck slots on this run",
    };
    warnings.length = 0;
    // (b) a second replica attaching the same 300 rooms WITHOUT writes (hydrate from the log, adopt from the directory).
    reader = new Replicas(config(storePath, hubUrl), new MirrorStore(storePath, H.WORKSPACE));
    await reader.settle();
    await H.waitUntil("the reader to adopt the corpus", () => reader!.attachedReplicas().length >= 303, 30_000);
    await H.waitUntil("the reader's rooms to sync", () => created.every((uuid) => reader!.isRoomQuiet(roomForDoc(H.WORKSPACE, uuid))), 90_000);
    const readerInternals = internals(reader);
    out.e6b_bareReplicas_attachWithoutWrites = {
      rooms: reader.attachedReplicas().length,
      socketTerminatedByHub: warnings.some((w) => w.includes("too many pending unauthenticated documents")),
      hubWarnings: warnings.length,
      internals: readerInternals,
      settleMsAfterwards: await timeSettles(reader, 3),
    };
  } finally {
    console.warn = originalWarn;
    writer.destroy();
    writer.store.close();
    if (reader !== null) {
      reader.destroy();
      reader.store.close();
    }
    await hub.stop().catch(() => {});
  }
}

console.error("=== e6 ===");
try {
  await H.withTimeout(e6(), 300_000, "e6");
} catch (error) {
  out.e6_error = String(error);
}
writeFileSync(join(H.SCRATCH, "extras3.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
