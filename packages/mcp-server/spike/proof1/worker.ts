/**
 * Proof 1 — the child process. One of these per role, each a full replica
 * engine (MirrorStore + Replicas) over the one shared WAL store, exactly the
 * way `ub mcp serve` builds them.
 *
 * Roles:
 *  - `reader`   — get_doc-equivalent reads in a loop (an agent mostly reading)
 *  - `writer`   — edit_block-equivalent writes, at three declared paces
 *  - `serve`    — the `ub open` stand-in: poll `PRAGMA data_version`, replay on change
 *  - `baseline` — writer + reader in one process, alone, for the same-run baseline
 *
 * Every sample is sent to the parent over the fork IPC channel.
 */

import {
  dataVersionProbe,
  fmt,
  now,
  onMessage,
  openEngine,
  readDoc,
  send,
  sleep,
  stats,
  writeBlock,
} from "./common.js";

export interface Phase {
  name: string;
  ms: number;
  intervalMs: number;
}

interface Params {
  role: "reader" | "writer" | "serve" | "baseline";
  id: string;
  databasePath: string;
  probeUuid: string;
  probeBlockId: string;
  corpus: string[];
  phases: Phase[];
  /** Reader pause between reads (ms). */
  readPauseMs: number;
  /** Serving loop `PRAGMA data_version` poll interval (ms). */
  pollMs: number;
  compactAfter: number;
}

const params = JSON.parse(process.argv[2] as string) as Params;
const totalMs = params.phases.reduce((sum, phase) => sum + phase.ms, 0);

const PROBE_TAIL =
  " — the rest of this block is ordinary prose so the diff-and-splice has " +
  "something realistic to walk over, roughly the length of a sentence an " +
  "agent would actually write into a paragraph block.";

function probeText(n: number): string {
  return `Probe update ${n}.${PROBE_TAIL}`;
}

function tokenOf(text: string): number | null {
  const match = /^Probe update (\d+)\./.exec(text);
  return match === null ? null : Number(match[1]);
}

const engine = openEngine({
  databasePath: params.databasePath,
  compactAfter: params.compactAfter,
});

const reads: { ms: number; at: number }[] = [];
const writes: { ms: number; at: number }[] = [];
const seen: { n: number; at: number }[] = [];
const commits: { n: number; at: number }[] = [];
const loopIterations: { ms: number; at: number }[] = [];
const failures: { op: string; error: string }[] = [];

let stop = false;
onMessage<{ type: string }>((message) => {
  if (message.type === "stop") stop = true;
});

function noteSighting(text: string): void {
  const token = tokenOf(text);
  if (token !== null) seen.push({ n: token, at: now() });
}

async function readOnce(index: number): Promise<void> {
  const started = now();
  try {
    await engine.replicas.settle();
    const doc = params.corpus[index % params.corpus.length] as string;
    readDoc(engine.replicas, doc);
    const probe = readDoc(engine.replicas, params.probeUuid);
    const block = probe.blocks.find((b) => b.id === params.probeBlockId);
    reads.push({ ms: now() - started, at: started });
    if (block !== undefined) noteSighting(block.text);
  } catch (error) {
    failures.push({ op: "read", error: String(error) });
  }
}

/** One edit_block-equivalent write of the probe block. */
async function writeOnce(next: number): Promise<void> {
  try {
    await engine.replicas.settle();
    const probe = readDoc(engine.replicas, params.probeUuid);
    const block = probe.blocks.find((b) => b.id === params.probeBlockId);
    if (block === undefined) {
      failures.push({ op: "write", error: "probe block missing" });
      return;
    }
    const started = now();
    writeBlock(
      engine.replicas,
      params.probeUuid,
      params.probeBlockId,
      block.text,
      probeText(next),
      block.rev,
    );
    const at = now();
    writes.push({ ms: at - started, at: started });
    commits.push({ n: next, at });
  } catch (error) {
    failures.push({ op: "write", error: String(error) });
  }
}

async function runWriter(withReads: boolean): Promise<void> {
  let n = 1;
  let index = 0;
  for (const phase of params.phases) {
    send({ type: "phase", id: params.id, name: phase.name, at: now() });
    const deadline = now() + phase.ms;
    while (now() < deadline && !stop) {
      await writeOnce(n);
      n += 1;
      if (withReads) {
        await readOnce(index);
        index += 1;
      }
      if (phase.intervalMs > 0) await sleep(phase.intervalMs);
    }
  }
  send({ type: "phase", id: params.id, name: "end", at: now() });
}

async function runReader(): Promise<void> {
  const deadline = now() + totalMs + 2_000;
  let index = 0;
  while (now() < deadline && !stop) {
    await readOnce(index);
    index += 1;
    await sleep(params.readPauseMs);
  }
}

/**
 * The `ub open` stand-in: no tool calls, so the settle is driven by
 * `PRAGMA data_version` on a second connection to the same file.
 */
async function runServe(): Promise<void> {
  const probe = dataVersionProbe(params.databasePath);
  let last = probe.read();
  const deadline = now() + totalMs + 2_000;
  while (now() < deadline && !stop) {
    await sleep(params.pollMs);
    let version: number;
    try {
      version = probe.read();
    } catch (error) {
      failures.push({ op: "data_version", error: String(error) });
      continue;
    }
    if (version === last) continue;
    last = version;
    const started = now();
    try {
      // Replay every room's tail — what a serving process owes its browser.
      await engine.replicas.settle();
      const text =
        readDoc(engine.replicas, params.probeUuid).blocks.find(
          (b) => b.id === params.probeBlockId,
        )?.text ?? "";
      loopIterations.push({ ms: now() - started, at: started });
      noteSighting(text);
    } catch (error) {
      failures.push({ op: "serve-settle", error: String(error) });
    }
  }
  probe.close();
}

function summariseStore(): Record<string, Record<string, number>> {
  const byOp = new Map<string, number[]>();
  for (const timing of engine.store.timings) {
    const bucket = byOp.get(timing.op) ?? [];
    bucket.push(timing.ms);
    byOp.set(timing.op, bucket);
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [op, values] of byOp) out[op] = fmt(stats(values));
  return out;
}

async function main(): Promise<void> {
  // Hydrate before the clock starts, so the samples measure steady state.
  await engine.replicas.settle();
  send({ type: "ready", id: params.id });
  await new Promise<void>((resolve) => {
    onMessage<{ type: string }>((message) => {
      if (message.type === "go") resolve();
    });
  });

  if (params.role === "reader") await runReader();
  else if (params.role === "writer") await runWriter(false);
  else if (params.role === "serve") await runServe();
  else await runWriter(true);

  send({
    type: "result",
    id: params.id,
    role: params.role,
    readSamples: reads,
    writeSamples: writes,
    loopSamples: loopIterations,
    storeTimings: summariseStore(),
    /** Every write-transaction hold over 25 ms, so a stall can be located. */
    longHolds: engine.store.timings
      .filter((t) => t.op !== "readSince" && t.ms > 25)
      .map((t) => ({ op: t.op, ms: Number(t.ms.toFixed(2)), at: t.at })),
    storeErrors: engine.store.errors,
    failures,
    seen,
    commits,
  });
  engine.destroy();
  setTimeout(() => process.exit(0), 50).unref();
}

void main();
