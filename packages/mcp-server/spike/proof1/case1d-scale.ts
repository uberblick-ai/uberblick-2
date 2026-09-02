/**
 * Proof 1, case 1d — what eager attachment costs per process, by corpus size.
 *
 * v3 §5.2 keeps today's behaviour: every process attaches every room and every
 * settle replays every room's tail. That makes a settle O(rooms) and a process
 * O(corpus) in memory. This measures both at three corpus sizes, in one process
 * with nothing to replay — the floor every tool call pays.
 *
 * Run: P1_D_DOCS=<n> node --import tsx spike/proof1/case1d-scale.ts [outputDir]
 */

import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDoc, fmt, now, openEngine, stats } from "./common.js";

const OUT = process.argv[2] ?? tmpdir();
const DOCS = Number(process.env.P1_D_DOCS ?? 30);
const BLOCKS = 10;
const IDLE_SETTLES = 300;

const PARAGRAPH =
  "The store is the bus: every process appends to the log and replays the " +
  "tail before it answers. This block is about the length of a paragraph.";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `proof1-scale-${DOCS}-`));
  const databasePath = join(dir, "mirror.sqlite");

  const seedStart = now();
  const seeding = openEngine({ databasePath });
  for (let d = 0; d < DOCS; d += 1) {
    createDoc(
      seeding.replicas,
      `Scale document ${d}`,
      Array.from({ length: BLOCKS }, (_, b) => `${PARAGRAPH} (${d}/${b})`),
    );
  }
  await seeding.replicas.settle();
  seeding.destroy();
  const seedMs = now() - seedStart;

  // A fresh process would do exactly this: open the store, hydrate every room
  // from the log, then settle before the first tool call answers.
  if (global.gc) global.gc();
  const beforeHeap = process.memoryUsage();
  const bootStart = now();
  const engine = openEngine({ databasePath });
  await engine.replicas.settle();
  const bootMs = now() - bootStart;
  const afterHeap = process.memoryUsage();

  const idle: number[] = [];
  for (let i = 0; i < IDLE_SETTLES; i += 1) {
    const started = now();
    await engine.replicas.settle();
    idle.push(now() - started);
  }

  const record = {
    docs: DOCS,
    blocksPerDoc: BLOCKS,
    roomsAttached: engine.replicas.attachedReplicas().length,
    seedMs: Math.round(seedMs),
    bootAndFirstSettleMs: Math.round(bootMs),
    idleSettleMs: fmt(stats(idle)),
    rssMb: Math.round(afterHeap.rss / 1e6),
    heapUsedMbBefore: Math.round(beforeHeap.heapUsed / 1e6),
    heapUsedMbAfter: Math.round(afterHeap.heapUsed / 1e6),
  };
  engine.destroy();
  appendFileSync(join(OUT, "case1d.jsonl"), `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exit(0);
}

void main();
