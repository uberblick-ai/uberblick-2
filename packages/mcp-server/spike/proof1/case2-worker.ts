/**
 * Proof 1, case 2 — the child. One writer appends a monotone counter to one
 * block; readers replay through `readSince` while every process compacts at the
 * production threshold.
 *
 * The invariant a reader checks on every single read: the block's text is
 * exactly `0 1 2 … k` for some k. A dropped update leaves a hole; a torn read
 * leaves a suffix belonging to no k. Either is a STOP.
 */

import { editBlock } from "@uberblick/schema";
import { blockText, now, onMessage, openEngine, send, sleep } from "./common.js";

interface Params {
  role: "writer" | "reader";
  id: string;
  databasePath: string;
  docUuid: string;
  counterBlockId: string;
  witnessBlockId: string;
  witnessText: string;
  writes: number;
  compactAfter: number;
  /** The writer's own threshold, so a run can leave compaction to the readers. */
  writerCompactAfter: number;
  readerPauseMs: number;
  /** Applied to this process only when `id` matches `staleCompactor`. */
  compactDelayMs: number;
  staleCompactor: string;
}

const params = JSON.parse(process.argv[2] as string) as Params;

const engine = openEngine({
  databasePath: params.databasePath,
  compactAfter:
    params.role === "writer" ? params.writerCompactAfter : params.compactAfter,
});
if (params.id === params.staleCompactor) {
  engine.store.compactDelayMs = params.compactDelayMs;
}

const violations: { kind: string; detail: string; at: number }[] = [];
const failures: { op: string; error: string }[] = [];
let readCount = 0;
let maxK = -1;
let lastK = -1;

/** `0 1 2 … expectedK`, grown on demand, and the length of each prefix. */
let expectedFull = "0";
let expectedK = 0;
const ends: number[] = [1];

function extendTo(k: number): void {
  while (expectedK < k) {
    expectedK += 1;
    expectedFull += ` ${expectedK}`;
    ends.push(expectedFull.length);
  }
}

function check(text: string): void {
  let spaces = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 32) spaces += 1;
  }
  const k = spaces;
  if (k > params.writes) {
    violations.push({ kind: "impossible-k", detail: `k=${k}`, at: now() });
    return;
  }
  extendTo(k);
  // A prefix of `expectedFull` whose length is exactly `ends[k]` IS `0 1 … k`.
  if (text.length !== ends[k] || !expectedFull.startsWith(text)) {
    violations.push({
      kind: "torn-or-gap",
      detail: `k=${k} len=${text.length} expectedLen=${ends[k]} tail="${text.slice(-60)}"`,
      at: now(),
    });
    return;
  }
  if (k < lastK) {
    violations.push({ kind: "went-backwards", detail: `${k} after ${lastK}`, at: now() });
  }
  lastK = k;
  if (k > maxK) maxK = k;
}

function checkWitness(): void {
  const text = blockText(engine.replicas, params.docUuid, params.witnessBlockId);
  if (text !== params.witnessText) {
    violations.push({
      kind: "witness-block-changed",
      detail: `"${text.slice(0, 60)}"`,
      at: now(),
    });
  }
}

async function runWriter(): Promise<void> {
  for (let n = 1; n <= params.writes; n += 1) {
    await engine.replicas.settle();
    const current = blockText(engine.replicas, params.docUuid, params.counterBlockId);
    try {
      editBlock(
        engine.replicas.replica(params.docUuid).doc,
        params.counterBlockId,
        current,
        `${current} ${n}`,
      );
    } catch (error) {
      failures.push({ op: "write", error: String(error) });
    }
    if (n % 500 === 0) send({ type: "progress", id: params.id, n });
  }
}

let stop = false;
onMessage<{ type: string }>((message) => {
  if (message.type === "stop") stop = true;
});

async function runReader(): Promise<void> {
  const deadline = now() + 240_000;
  while (!stop && now() < deadline) {
    try {
      await engine.replicas.settle();
      check(blockText(engine.replicas, params.docUuid, params.counterBlockId));
      checkWitness();
      readCount += 1;
    } catch (error) {
      failures.push({ op: "read", error: String(error) });
    }
    // A real macrotask: awaiting only microtasks starves the IPC channel, and
    // the `stop` message would never be delivered. A longer pause makes this
    // reader lag far enough behind to meet the compaction threshold itself.
    await sleep(params.readerPauseMs);
  }
  // One last settle after the writer stopped, so convergence is asserted on a
  // reader that has seen everything the log holds.
  await sleep(300);
  await engine.replicas.settle();
  check(blockText(engine.replicas, params.docUuid, params.counterBlockId));
  checkWitness();
}

async function main(): Promise<void> {
  await engine.replicas.settle();
  send({ type: "ready", id: params.id });
  await new Promise<void>((resolve) => {
    onMessage<{ type: string }>((message) => {
      if (message.type === "go") resolve();
    });
  });

  if (params.role === "writer") await runWriter();
  else await runReader();

  send({
    type: "result",
    id: params.id,
    role: params.role,
    reads: readCount,
    maxK,
    finalLength: blockText(engine.replicas, params.docUuid, params.counterBlockId).length,
    violations,
    failures,
    compactCalls: engine.store.compactCalls,
    compactWrites: engine.store.compactWrites,
    compactions: engine.store.compactions.slice(-20),
    storeErrors: engine.store.errors,
  });
  engine.destroy();
  setTimeout(() => process.exit(0), 50).unref();
}

void main();
