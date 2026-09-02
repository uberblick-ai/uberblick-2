/**
 * Proof 1, case 1 — contention.
 *
 * One WAL store file. Phase A: one process alone (the same-run baseline).
 * Phase B: four readers, one writer and one `ub open`-shaped serving loop, all
 * separate OS processes on that one file.
 *
 * Three write paces, each measured separately:
 *  - `agent`  — one edit every 250 ms: an agent working through MCP
 *  - `typing` — one edit every 25 ms: the browser typing through `ub open`'s gate
 *  - `burst`  — back to back: the stress ceiling, far above any real client
 *
 * Run: node --import tsx spike/proof1/case1.ts [outputDir]
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDoc, fmt, openEngine, stats } from "./common.js";
import type { Phase } from "./worker.js";

const WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));
const OUT = process.argv[2] ?? tmpdir();

const num = (name: string, fallback: number): number =>
  process.env[name] === undefined ? fallback : Number(process.env[name]);

const CORPUS_DOCS = num("P1_DOCS", 30);
const BLOCKS_PER_DOC = 10;
const READ_PAUSE_MS = 25;
const POLL_MS = 20;
const COMPACT_AFTER = 500;

const PHASES: Phase[] = [
  { name: "agent", ms: num("P1_AGENT_MS", 25_000), intervalMs: 250 },
  { name: "typing", ms: num("P1_TYPING_MS", 20_000), intervalMs: 25 },
  { name: "burst", ms: num("P1_BURST_MS", 15_000), intervalMs: 0 },
];
const TOTAL_MS = PHASES.reduce((sum, phase) => sum + phase.ms, 0);
const PHASE_NAMES = [...PHASES.map((phase) => phase.name), "end"];

const PARAGRAPH =
  "The store is the bus: every process appends to the log and replays the " +
  "tail before it answers, which is the whole of the coordination between " +
  "them. This block is about the length of a paragraph somebody would write.";

const PROBE_TAIL =
  " — the rest of this block is ordinary prose so the diff-and-splice has " +
  "something realistic to walk over, roughly the length of a sentence an " +
  "agent would actually write into a paragraph block.";

interface Sample {
  ms: number;
  at: number;
}

interface WorkerResult {
  type: "result";
  id: string;
  role: string;
  readSamples: Sample[];
  writeSamples: Sample[];
  loopSamples: Sample[];
  storeTimings: Record<string, Record<string, number>>;
  longHolds: { op: string; ms: number; at: number }[];
  storeErrors: { op: string; error: string; at: number }[];
  failures: { op: string; error: string }[];
  seen: { n: number; at: number }[];
  commits: { n: number; at: number }[];
}

interface Handle {
  id: string;
  child: ChildProcess;
  ready: Promise<void>;
  done: Promise<WorkerResult>;
  boundaries: Map<string, number>;
  allPhases: Promise<void>;
}

function spawn(id: string, role: string, params: Record<string, unknown>): Handle {
  const errorLog = openSync(join(OUT, `case1-${id}.stderr.log`), "w");
  const child = fork(WORKER, [JSON.stringify({ ...params, id, role })], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", errorLog, "ipc"],
  });
  const boundaries = new Map<string, number>();
  let markReady = (): void => {};
  let markDone = (_: WorkerResult): void => {};
  let markPhases = (): void => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const done = new Promise<WorkerResult>((resolve) => {
    markDone = resolve;
  });
  const allPhases = new Promise<void>((resolve) => {
    markPhases = resolve;
  });
  child.on("message", (message) => {
    const payload = message as { type: string; name?: string; at?: number };
    if (payload.type === "ready") markReady();
    if (payload.type === "phase") {
      boundaries.set(payload.name as string, payload.at as number);
      if (payload.name === "end") markPhases();
    }
    if (payload.type === "result") markDone(message as WorkerResult);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0) {
      process.stderr.write(`case1: child ${id} exited ${code} ${signal}\n`);
      process.exit(1);
    }
    markReady();
    markPhases();
  });
  return { id, child, ready, done, boundaries, allPhases };
}

function window(boundaries: Map<string, number>, name: string): [number, number] {
  const index = PHASE_NAMES.indexOf(name);
  return [
    boundaries.get(name) ?? Number.POSITIVE_INFINITY,
    boundaries.get(PHASE_NAMES[index + 1] as string) ?? Number.POSITIVE_INFINITY,
  ];
}

function inPhase(
  samples: Sample[],
  boundaries: Map<string, number>,
  name: string,
): number[] {
  const [from, to] = window(boundaries, name);
  return samples.filter((s) => s.at >= from && s.at < to).map((s) => s.ms);
}

function commitsIn(
  commits: { n: number; at: number }[],
  boundaries: Map<string, number>,
  name: string,
): { n: number; at: number }[] {
  const [from, to] = window(boundaries, name);
  return commits.filter((c) => c.at >= from && c.at < to);
}

/**
 * Visibility: for each writer commit, the first sighting of a token at least
 * that new, taken at or after the commit. A skipped token still counts — the
 * reader saw a state no older than the one committed.
 */
function visibility(
  commits: { n: number; at: number }[],
  seen: { n: number; at: number }[],
): number[] {
  const sorted = [...seen].sort((a, b) => a.at - b.at);
  const lags: number[] = [];
  let cursor = 0;
  for (const commit of [...commits].sort((a, b) => a.at - b.at)) {
    while (cursor < sorted.length && (sorted[cursor] as { at: number }).at < commit.at) {
      cursor += 1;
    }
    for (let i = cursor; i < sorted.length; i += 1) {
      const sighting = sorted[i] as { n: number; at: number };
      if (sighting.n >= commit.n) {
        lags.push(sighting.at - commit.at);
        break;
      }
    }
  }
  return lags;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "proof1-case1-"));
  const databasePath = join(dir, "mirror.sqlite");
  process.stdout.write(`case1: store ${databasePath}\n`);

  const seeding = openEngine({ databasePath, compactAfter: COMPACT_AFTER });
  const corpus: string[] = [];
  for (let d = 0; d < CORPUS_DOCS; d += 1) {
    const texts = Array.from(
      { length: BLOCKS_PER_DOC },
      (_, b) => `${PARAGRAPH} (doc ${d}, block ${b})`,
    );
    corpus.push(createDoc(seeding.replicas, `Proof 1 corpus document ${d}`, texts).uuid);
  }
  const probe = createDoc(seeding.replicas, "Proof 1 probe document", [
    `Probe update 0.${PROBE_TAIL}`,
    PARAGRAPH,
  ]);
  await seeding.replicas.settle();
  seeding.destroy();

  const params = {
    databasePath,
    probeUuid: probe.uuid,
    probeBlockId: probe.blockIds[0] as string,
    corpus,
    phases: PHASES,
    readPauseMs: READ_PAUSE_MS,
    pollMs: POLL_MS,
    compactAfter: COMPACT_AFTER,
  };

  process.stdout.write(`case1: baseline (one process alone, ${TOTAL_MS / 1000}s)\n`);
  const baseline = spawn("baseline", "baseline", params);
  await baseline.ready;
  baseline.child.send({ type: "go" });
  const baselineResult = await baseline.done;

  process.stdout.write(
    `case1: contention (4 readers + 1 writer + 1 serving loop, ${TOTAL_MS / 1000}s)\n`,
  );
  const handles: Handle[] = [
    spawn("reader-1", "reader", params),
    spawn("reader-2", "reader", params),
    spawn("reader-3", "reader", params),
    spawn("reader-4", "reader", params),
    spawn("serve", "serve", params),
    spawn("writer", "writer", params),
  ];
  await Promise.all(handles.map((h) => h.ready));
  for (const handle of handles) handle.child.send({ type: "go" });
  const writerHandle = handles.find((h) => h.id === "writer") as Handle;
  await writerHandle.allPhases;
  const results = await Promise.all(handles.map((h) => h.done));

  const writer = results.find((r) => r.role === "writer") as WorkerResult;
  const serve = results.find((r) => r.role === "serve") as WorkerResult;
  const readers = results.filter((r) => r.role === "reader");
  const bounds = writerHandle.boundaries;
  const baseBounds = baseline.boundaries;

  const perPhase = PHASES.map((phase) => ({
    phase: phase.name,
    intervalMs: phase.intervalMs,
    baselineWrites: fmt(stats(inPhase(baselineResult.writeSamples, baseBounds, phase.name))),
    baselineReads: fmt(stats(inPhase(baselineResult.readSamples, baseBounds, phase.name))),
    writerWrites: fmt(stats(inPhase(writer.writeSamples, bounds, phase.name))),
    readerReads: fmt(
      stats(readers.flatMap((r) => inPhase(r.readSamples, bounds, phase.name))),
    ),
    serveLoop: fmt(stats(inPhase(serve.loopSamples, bounds, phase.name))),
    writes: commitsIn(writer.commits, bounds, phase.name).length,
    visibility: results
      .filter((r) => r.role !== "writer")
      .map((r) => ({
        id: r.id,
        lag: fmt(stats(visibility(commitsIn(writer.commits, bounds, phase.name), r.seen))),
      })),
  }));

  const report = {
    parameters: {
      corpusDocs: CORPUS_DOCS,
      blocksPerDoc: BLOCKS_PER_DOC,
      phases: PHASES,
      readPauseMs: READ_PAUSE_MS,
      servePollMs: POLL_MS,
      compactAfter: COMPACT_AFTER,
      databasePath,
    },
    perPhase,
    storeTimings: Object.fromEntries(
      [...results, baselineResult].map((r) => [r.id, r.storeTimings]),
    ),
    longHolds: Object.fromEntries(
      [...results, baselineResult].map((r) => [r.id, r.longHolds.slice(0, 40)]),
    ),
    longestHold: [...results, baselineResult]
      .flatMap((r) =>
        Object.entries(r.storeTimings)
          .filter(([op]) => op !== "readSince")
          .map(([, s]) => s.max as number),
      )
      .reduce((a, b) => (b > a ? b : a), 0),
    busyErrors: [...results, baselineResult].flatMap((r) =>
      r.storeErrors.map((e) => ({ id: r.id, ...e })),
    ),
    callerFailures: [...results, baselineResult].flatMap((r) =>
      r.failures.map((f) => ({ id: r.id, ...f })),
    ),
    writesCommitted: writer.commits.length,
    baselineWritesCommitted: baselineResult.commits.length,
    databaseBytes: statSync(databasePath).size,
  };

  const path = join(OUT, "case1.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  process.stdout.write(`case1: wrote ${path}\n`);
  process.exit(0);
}

void main();
