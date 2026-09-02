/**
 * Proof 1, case 2 — compaction under contention.
 *
 * One writer drives one room far past the production compaction threshold
 * (500 rows) while three readers replay it through `readSince`. Every process
 * compacts, which is today's behaviour and what v3 §3 keeps.
 *
 * Run: node --import tsx spike/proof1/case2.ts [outputDir]
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WORKSPACE, createDoc, openEngine, sleep } from "./common.js";

const WORKER = fileURLToPath(new URL("./case2-worker.ts", import.meta.url));
const OUT = process.argv[2] ?? tmpdir();

const num = (name: string, fallback: number): number =>
  process.env[name] === undefined ? fallback : Number(process.env[name]);

const WRITES = num("P1_C2_WRITES", 3_000);
const READERS = num("P1_C2_READERS", 3);
const READER_PAUSE_MS = num("P1_C2_READER_PAUSE_MS", 0);
const COMPACT_DELAY_MS = num("P1_C2_COMPACT_DELAY_MS", 0);
const STALE_COMPACTOR = process.env.P1_C2_STALE_COMPACTOR ?? "reader-3";
const COMPACT_AFTER = 500;
const WRITER_COMPACT_AFTER = num("P1_C2_WRITER_COMPACT_AFTER", 500);

const WITNESS =
  "A block nobody edits. Compaction must leave it exactly as it is, in every " +
  "process, at every cut.";

interface Result {
  type: "result";
  id: string;
  role: string;
  reads: number;
  maxK: number;
  finalLength: number;
  violations: { kind: string; detail: string; at: number }[];
  failures: { op: string; error: string }[];
  compactCalls: number;
  compactWrites: number;
  compactions: { throughSeq: number; wrote: boolean; at: number }[];
  storeErrors: { op: string; error: string; at: number }[];
}

interface Handle {
  id: string;
  child: ChildProcess;
  ready: Promise<void>;
  done: Promise<Result>;
}

function spawn(id: string, role: string, params: Record<string, unknown>): Handle {
  const errorLog = openSync(join(OUT, `case2-${id}.stderr.log`), "w");
  const child = fork(WORKER, [JSON.stringify({ ...params, id, role })], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", errorLog, "ipc"],
  });
  let markReady = (): void => {};
  let markDone = (_: Result): void => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const done = new Promise<Result>((resolve) => {
    markDone = resolve;
  });
  child.on("message", (message) => {
    const payload = message as { type: string };
    if (payload.type === "ready") markReady();
    if (payload.type === "result") markDone(message as Result);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0) {
      process.stderr.write(`case2: child ${id} exited ${code} ${signal}\n`);
      process.exit(1);
    }
    markReady();
  });
  return { id, child, ready, done };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "proof1-case2-"));
  const databasePath = join(dir, "mirror.sqlite");
  process.stdout.write(`case2: store ${databasePath}\n`);

  const seeding = openEngine({ databasePath, compactAfter: COMPACT_AFTER });
  const doc = createDoc(seeding.replicas, "Proof 1 compaction document", ["0", WITNESS]);
  await seeding.replicas.settle();
  seeding.destroy();

  const params = {
    databasePath,
    docUuid: doc.uuid,
    counterBlockId: doc.blockIds[0] as string,
    witnessBlockId: doc.blockIds[1] as string,
    witnessText: WITNESS,
    writes: WRITES,
    compactAfter: COMPACT_AFTER,
    writerCompactAfter: WRITER_COMPACT_AFTER,
    readerPauseMs: READER_PAUSE_MS,
    compactDelayMs: COMPACT_DELAY_MS,
    staleCompactor: STALE_COMPACTOR,
  };

  const readers = Array.from({ length: READERS }, (_, i) =>
    spawn(`reader-${i + 1}`, "reader", params),
  );
  const writer = spawn("writer", "writer", params);
  const handles = [...readers, writer];
  await Promise.all(handles.map((h) => h.ready));
  for (const handle of handles) handle.child.send({ type: "go" });

  process.stdout.write("case2: running\n");
  const writerResult = await writer.done;
  process.stdout.write("case2: writer finished\n");
  // Let the readers catch up, then stop them; each does one final settle.
  await sleep(1_000);
  for (const reader of readers) reader.child.send({ type: "stop" });
  const readerResults = await Promise.all(readers.map((r) => r.done));
  process.stdout.write("case2: readers finished\n");

  // What the log actually holds now, read from a fresh connection: the tail
  // that survived, and how far the surviving snapshot reaches.
  const room = `${WORKSPACE}/${doc.uuid}`;
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000");
  const tailRows = (
    db.prepare("SELECT COUNT(*) AS n FROM updates WHERE room = ?").get(room) as {
      n: number;
    }
  ).n;
  const snapshotThrough = (
    db.prepare("SELECT through_seq FROM snapshots WHERE room = ?").get(room) as
      | { through_seq: number }
      | undefined
  )?.through_seq;
  const highestSeq = (
    db.prepare("SELECT MAX(seq) AS s FROM updates WHERE room = ?").get(room) as {
      s: number | null;
    }
  ).s;
  db.close();

  const expectedFinalLength = (() => {
    let text = "0";
    for (let n = 1; n <= WRITES; n += 1) text += ` ${n}`;
    return text.length;
  })();

  const report = {
    parameters: {
      writes: WRITES,
      readers: READERS,
      compactAfter: COMPACT_AFTER,
      writerCompactAfter: WRITER_COMPACT_AFTER,
      readerPauseMs: READER_PAUSE_MS,
      compactDelayMs: COMPACT_DELAY_MS,
      staleCompactor: STALE_COMPACTOR,
      databasePath,
      room,
    },
    logAfterRun: { tailRows, snapshotThrough, highestSeq },
    writer: {
      compactCalls: writerResult.compactCalls,
      compactWrites: writerResult.compactWrites,
      finalLength: writerResult.finalLength,
      failures: writerResult.failures,
      storeErrors: writerResult.storeErrors,
    },
    expectedFinalLength,
    readers: readerResults.map((r) => ({
      id: r.id,
      reads: r.reads,
      maxK: r.maxK,
      finalLength: r.finalLength,
      converged: r.finalLength === expectedFinalLength,
      violations: r.violations,
      failures: r.failures,
      compactCalls: r.compactCalls,
      compactWrites: r.compactWrites,
      lastCompactions: r.compactions,
      storeErrors: r.storeErrors,
    })),
    totalViolations: readerResults.reduce((sum, r) => sum + r.violations.length, 0),
    totalCompactionWrites:
      writerResult.compactWrites +
      readerResults.reduce((sum, r) => sum + r.compactWrites, 0),
  };

  const path = join(OUT, process.env.P1_C2_OUT ?? "case2.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  process.stdout.write(
    `case2: violations=${report.totalViolations} compactions=${report.totalCompactionWrites} -> ${path}\n`,
  );
  process.exit(0);
}

void main();
