/**
 * Scale probe — orchestrator.
 *
 * Usage:
 *   tsx run.ts --docs 500 --steps 10,30,60,100 --processes 3 \
 *     --scratch /path/to/scratch --restart-at 10,100 [--out results.json]
 *
 * Everything it starts is a child process so that memory is attributable:
 * the hub, N load workers hosting the simulated MCP processes, and two real
 * replicas (a long-lived writer and a fresh watcher per step).
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  corpusUuids,
  DIRECTORY_ROOM,
  FEEDBACK_ROOM,
  roomOf,
  SECRET,
  SIDEBAR_ROOM,
} from "./common.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const DOCS = Number(arg("docs", "500"));
const STEPS = arg("steps", "10,30,60,100").split(",").map(Number);
const PROCESSES_PER_IDENTITY = Number(arg("processes", "3"));
const SCRATCH = arg("scratch", "/tmp/uberblick-scale");
const RESTART_AT = new Set(arg("restart-at", "").split(",").filter(Boolean).map(Number));
const WORKERS = Number(arg("workers", "6"));
const OUT = arg("out", join(SCRATCH, `results-d${DOCS}.json`));
const HUB_HEAP = arg("hub-heap", "12288");

mkdirSync(SCRATCH, { recursive: true });

const env = { ...process.env, PROBE_SECRET: SECRET };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fork a tsx child and resolve on its first `ready`-ish message. */
function forkChild(
  script: string,
  args: string[],
  extraExec: string[] = [],
): ChildProcess {
  const child = fork(join(HERE, script), args, {
    execArgv: ["--import", "tsx", ...extraExec],
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("error", (error) =>
    console.error(`[probe] child ${script} error: ${String(error)}`),
  );
  child.on("exit", (code, signal) => {
    if (code !== 0) {
      console.error(`[probe] child ${script} exited code=${code} signal=${signal}`);
    }
  });
  return child;
}

function once<T>(child: ChildProcess, type: string, timeoutMs = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", listener);
      reject(new Error(`timed out waiting for "${type}"`));
    }, timeoutMs);
    const listener = (message: Record<string, unknown>): void => {
      if (message.type !== type) return;
      clearTimeout(timer);
      child.off("message", listener);
      resolve(message as T);
    };
    child.on("message", listener);
  });
}

function ask<T>(
  child: ChildProcess,
  request: Record<string, unknown>,
  replyType: string,
  timeoutMs = 120_000,
): Promise<T> {
  const answer = once<T>(child, replyType, timeoutMs);
  child.send(request);
  return answer;
}

// ---------------------------------------------------------------- corpus

const hubDatabase = join(SCRATCH, `hub-d${DOCS}.sqlite`);
if (!existsSync(hubDatabase)) {
  console.error(`[probe] seeding ${DOCS} documents into ${hubDatabase}`);
  const seeder = fork(join(HERE, "seed.ts"), [hubDatabase, String(DOCS)], {
    execArgv: ["--import", "tsx"],
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    seeder.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`seed exited ${code}`)),
    );
  });
}

const uuids = corpusUuids(DOCS);
const rooms = [DIRECTORY_ROOM, SIDEBAR_ROOM, FEEDBACK_ROOM, ...uuids.map(roomOf)];

// ---------------------------------------------------------------- hub

let hub: ChildProcess;
let hubPort = 0;

async function startHub(port: number): Promise<void> {
  hub = forkChild("hub-proc.ts", [hubDatabase, String(port)], [
    `--max-old-space-size=${HUB_HEAP}`,
  ]);
  const ready = await once<{ port: number }>(hub, "ready", 60_000);
  hubPort = ready.port;
}

async function stopHub(): Promise<void> {
  // The child is captured, never read from the module binding: a stray timer
  // that resolves `hub` late would SIGKILL whichever hub is current by then,
  // which is exactly how the first run of this probe killed its own restart.
  const child = hub;
  const stopped = once(child, "stopped", 120_000).catch(() => undefined);
  child.send({ type: "stop" });
  await stopped;
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 15_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface HubStats {
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  cpuPercent: number;
  documents: number;
  connections: number;
  roomSubscriptions: number;
  storeWrites: number;
  storeMaxMs: number;
  storeMeanMs: number;
  pendingCeilingHits: number;
  loopDelayMaxMs: number;
  loopDelayP99Ms: number;
}

const hubStats = (): Promise<HubStats> =>
  ask<HubStats>(hub, { type: "stats" }, "stats", 60_000);

await startHub(0);
console.error(`[probe] hub on ws://127.0.0.1:${hubPort}, corpus ${DOCS} docs`);
const hubUrl = `ws://127.0.0.1:${hubPort}`;

// ---------------------------------------------------------------- writer

const writerDb = join(SCRATCH, `writer-d${DOCS}-${Date.now()}.sqlite`);
const writer = forkChild("replica-probe.ts", [writerDb, hubUrl, String(DOCS), "writer"]);
await once(writer, "ready", 60_000);
console.error("[probe] writer replica hydrating (no load yet)");
const writerHydration = await ask<{ hydratedMs: number; ok: boolean; hydrated: number }>(
  writer,
  { type: "hydrate", timeoutMs: 600_000 },
  "hydrated",
  660_000,
);
console.error(
  `[probe] writer hydrated ${writerHydration.hydrated}/${DOCS} in ${writerHydration.hydratedMs} ms (baseline, unloaded)`,
);

// ---------------------------------------------------------------- workers

const workers: ChildProcess[] = [];
for (let index = 0; index < WORKERS; index += 1) {
  const worker = forkChild("load-worker.ts", []);
  workers.push(worker);
  await ask(worker, { type: "configure", url: hubUrl, rooms }, "configured", 60_000);
}

interface WorkerStats {
  sockets: number;
  authenticated: number;
  synced: number;
  fullySynced: number;
  denied: number;
  resetClosures: number;
  closes: number;
  bytesInMb: number;
  rssMb: number;
}

async function workerStats(): Promise<WorkerStats> {
  const all = await Promise.all(
    workers.map((worker) => ask<WorkerStats>(worker, { type: "stats" }, "stats", 60_000)),
  );
  return all.reduce<WorkerStats>(
    (total, one) => ({
      sockets: total.sockets + one.sockets,
      authenticated: total.authenticated + one.authenticated,
      synced: total.synced + one.synced,
      fullySynced: total.fullySynced + one.fullySynced,
      denied: total.denied + one.denied,
      resetClosures: total.resetClosures + one.resetClosures,
      closes: total.closes + one.closes,
      bytesInMb: total.bytesInMb + one.bytesInMb,
      rssMb: total.rssMb + one.rssMb,
    }),
    {
      sockets: 0,
      authenticated: 0,
      synced: 0,
      fullySynced: 0,
      denied: 0,
      resetClosures: 0,
      closes: 0,
      bytesInMb: 0,
      rssMb: 0,
    },
  );
}

let socketsRunning = 0;

async function scaleTo(targetSockets: number): Promise<void> {
  const toAdd = targetSockets - socketsRunning;
  if (toAdd <= 0) return;
  const per = Math.ceil(toAdd / workers.length);
  let remaining = toAdd;
  for (const [index, worker] of workers.entries()) {
    const count = Math.min(per, remaining);
    if (count <= 0) break;
    remaining -= count;
    await ask(worker, { type: "spawn", count, prefix: `w${index}` }, "spawned", 60_000);
  }
  socketsRunning = targetSockets;
}

/** Wait until every socket has every room synced, or give up. */
async function waitSteady(timeoutMs: number): Promise<{ ms: number; steady: boolean; stats: WorkerStats }> {
  const started = Date.now();
  let stats = await workerStats();
  for (;;) {
    if (stats.fullySynced >= socketsRunning) {
      return { ms: Date.now() - started, steady: true, stats };
    }
    if (Date.now() - started > timeoutMs) {
      return { ms: Date.now() - started, steady: false, stats };
    }
    await sleep(1_000);
    stats = await workerStats();
  }
}

// ---------------------------------------------------------------- steps

interface StepResult extends Record<string, unknown> {
  identities: number;
  sockets: number;
}

const results: StepResult[] = [];

for (const identities of STEPS) {
  const sockets = identities * PROCESSES_PER_IDENTITY;
  console.error(`\n[probe] === step: ${identities} identities × ${PROCESSES_PER_IDENTITY} = ${sockets} sockets ===`);
  const attachStarted = Date.now();
  await scaleTo(sockets);
  const steady = await waitSteady(600_000);
  console.error(
    `[probe] attach: ${steady.stats.fullySynced}/${sockets} sockets fully synced in ${steady.ms} ms` +
      `${steady.steady ? "" : " (TIMED OUT)"}`,
  );

  // Let it idle so the sample is steady state, not the tail of the storm.
  await sleep(8_000);
  await hubStats(); // discard: resets the CPU/loop-delay window
  await sleep(5_000);
  const idle = await hubStats();
  const loadStats = await workerStats();
  console.error(
    `[probe] hub RSS ${idle.rssMb.toFixed(0)} MB, cpu ${idle.cpuPercent.toFixed(1)}%, ` +
      `docs ${idle.documents}, sockets ${idle.connections}, subscriptions ${idle.roomSubscriptions}`,
  );

  // --- a brand-new full replica hydrating while everyone else is attached ---
  const watcherDb = join(SCRATCH, `watcher-d${DOCS}-${identities}-${Date.now()}.sqlite`);
  const watcher = forkChild("replica-probe.ts", [watcherDb, hubUrl, String(DOCS), "watcher"]);
  await once(watcher, "ready", 60_000);
  const hydration = await ask<{ ok: boolean; hydratedMs: number; directoryMs: number | null; hydrated: number }>(
    watcher,
    { type: "hydrate", timeoutMs: 900_000 },
    "hydrated",
    960_000,
  );
  console.error(
    `[probe] fresh replica hydrated ${hydration.hydrated}/${DOCS} in ${hydration.hydratedMs} ms` +
      `${hydration.ok ? "" : " (TIMED OUT)"}`,
  );
  const watcherStats = await ask<{ rssMb: number; attached: number; hydrated: number }>(
    watcher,
    { type: "stats" },
    "stats",
    120_000,
  );
  const writerStats = await ask<{ rssMb: number; attached: number; hydrated: number }>(
    writer,
    { type: "stats" },
    "stats",
    120_000,
  );

  // --- edit propagation, writer process → watcher process, under load ---
  const latencies: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const uuid = uuids[Math.floor((round * DOCS) / 5)] ?? uuids[0];
    const armed = await ask<{ ok: boolean }>(watcher, { type: "watch", uuid }, "watching", 60_000);
    if (!armed.ok) continue;
    const stamp = `${Date.now()}-${round}`;
    const observed = once<{ atMs: number; text: string }>(watcher, "observed", 60_000).catch(
      () => null,
    );
    const edited = await ask<{ ok: boolean; atMs: number }>(
      writer,
      { type: "edit", uuid, stamp },
      "edited",
      60_000,
    );
    const landing = await observed;
    if (edited.ok && landing !== null) latencies.push(landing.atMs - edited.atMs);
    await sleep(500);
  }
  latencies.sort((a, b) => a - b);
  console.error(`[probe] propagation ms: ${latencies.join(", ")}`);

  // --- hub persistence behaviour for the writes just made ---
  await sleep(3_000);
  const afterEdits = await hubStats();

  // --- the restart handshake storm ---
  let restart: Record<string, unknown> | null = null;
  if (RESTART_AT.has(identities)) {
    console.error("[probe] restarting the hub …");
    const before = await workerStats();
    const stopStarted = Date.now();
    await stopHub();
    const stopMs = Date.now() - stopStarted;
    // Every socket must have seen its close before the resync clock starts —
    // otherwise the first sample still shows the pre-outage counters and the
    // storm measures as instantaneous.
    const dropDeadline = Date.now() + 60_000;
    for (;;) {
      const dropped = await workerStats();
      if (dropped.fullySynced === 0 || Date.now() > dropDeadline) break;
      await sleep(200);
    }
    const restartStarted = Date.now();
    await startHub(hubPort);
    const listeningMs = Date.now() - restartStarted;
    const resync = await waitSteady(600_000);
    const afterRestart = await hubStats();
    restart = {
      stopMs,
      listeningMs,
      resyncMs: Date.now() - restartStarted,
      resyncSteady: resync.steady,
      fullySynced: resync.stats.fullySynced,
      resetClosuresBefore: before.resetClosures,
      resetClosuresAfter: resync.stats.resetClosures,
      deniedAfter: resync.stats.denied,
      pendingCeilingHits: afterRestart.pendingCeilingHits,
      hubRssMb: afterRestart.rssMb,
      hubStoreMaxMs: afterRestart.storeMaxMs,
      loopDelayMaxMs: afterRestart.loopDelayMaxMs,
    };
    console.error(
      `[probe] restart: resync ${restart.resyncMs} ms, ${resync.stats.fullySynced}/${socketsRunning} sockets, ` +
        `4205 closures ${before.resetClosures} → ${resync.stats.resetClosures}, ceiling hits ${afterRestart.pendingCeilingHits}`,
    );
  }

  results.push({
    identities,
    sockets,
    processesPerIdentity: PROCESSES_PER_IDENTITY,
    documents: DOCS,
    attachMs: steady.ms,
    attachSteady: steady.steady,
    hub: idle,
    hubAfterEdits: afterEdits,
    load: loadStats,
    freshReplica: { ...hydration, rssMb: watcherStats.rssMb, attached: watcherStats.attached },
    writerReplica: writerStats,
    propagationMs: latencies,
    restart,
  });
  writeFileSync(OUT, JSON.stringify({ documents: DOCS, writerHydration, steps: results }, null, 2));

  watcher.send({ type: "stop" });
  await once(watcher, "stopped", 60_000).catch(() => undefined);
  rmSync(watcherDb, { force: true });
  rmSync(`${watcherDb}-wal`, { force: true });
  rmSync(`${watcherDb}-shm`, { force: true });
}

console.error(`\n[probe] done — ${OUT}`);
for (const worker of workers) worker.send({ type: "stop" });
writer.send({ type: "stop" });
await sleep(1_500);
for (const worker of workers) worker.kill("SIGKILL");
writer.kill("SIGKILL");
await stopHub().catch(() => undefined);
rmSync(writerDb, { force: true });
rmSync(`${writerDb}-wal`, { force: true });
rmSync(`${writerDb}-shm`, { force: true });
process.exit(0);
