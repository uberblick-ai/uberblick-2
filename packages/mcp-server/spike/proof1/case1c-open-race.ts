/**
 * Proof 1, case 1c — several processes opening the shared store at once.
 *
 * Found while running case 3: `MirrorStore`'s constructor issues
 *
 *     PRAGMA journal_mode = WAL      <- needs a lock; can return SQLITE_BUSY
 *     PRAGMA busy_timeout = 5000     <- installs the busy handler, one line late
 *
 * so the one statement that can block runs with no busy handler installed. The
 * first connection to open a WAL database builds the shared-memory index; when
 * several processes do that in the same instant, the losers get
 * SQLITE_BUSY_RECOVERY (261) and, with no busy handler, the constructor throws
 * and the process dies before it serves anything.
 *
 * This releases N openers at a barrier, R times, and counts the failures — once
 * with the shipping order, once with the two pragmas swapped.
 *
 * Run: node --import tsx spike/proof1/case1c-open-race.ts [outputDir]
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDoc, openEngine, percentile, sleep } from "./common.js";

const WORKER = fileURLToPath(new URL("./open-race-worker.ts", import.meta.url));
const OUT = process.argv[2] ?? tmpdir();

const num = (name: string, fallback: number): number =>
  process.env[name] === undefined ? fallback : Number(process.env[name]);

const OPENERS = num("P1_OPENERS", 8);
const ROUNDS = num("P1_OPEN_ROUNDS", 60);

interface Opened {
  type: "opened";
  id: string;
  ms: number | null;
  error: string | null;
  code?: number | null;
}

interface Opener {
  id: string;
  child: ChildProcess;
  ready: Promise<void>;
  next(): Promise<Opened>;
}

function spawn(id: string, params: Record<string, unknown>): Opener {
  const errorLog = openSync(join(OUT, `case1c-${id}.stderr.log`), "w");
  const child = fork(WORKER, [JSON.stringify({ ...params, id })], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", errorLog, "ipc"],
  });
  let markReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const waiting: ((opened: Opened) => void)[] = [];
  child.on("message", (message) => {
    const payload = message as { type: string };
    if (payload.type === "ready") markReady();
    if (payload.type === "opened") waiting.shift()?.(message as Opened);
  });
  return {
    id,
    child,
    ready,
    next: () =>
      new Promise<Opened>((resolve) => {
        waiting.push(resolve);
      }),
  };
}

async function run(order: "shipping" | "swapped"): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), `proof1-openrace-${order}-`));
  const databasePath = join(dir, "mirror.sqlite");

  const seeding = openEngine({ databasePath });
  createDoc(seeding.replicas, "Open race", ["seed"]);
  await seeding.replicas.settle();
  seeding.destroy();

  const openers = Array.from({ length: OPENERS }, (_, i) =>
    spawn(`opener-${order}-${i + 1}`, { databasePath, order }),
  );
  await Promise.all(openers.map((o) => o.ready));

  const failures: { id: string; error: string; code: unknown; round: number }[] = [];
  const durations: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const results = openers.map((o) => o.next());
    for (const opener of openers) opener.child.send({ type: "go" });
    for (const opened of await Promise.all(results)) {
      if (opened.error !== null) {
        failures.push({
          id: opened.id,
          error: opened.error,
          code: opened.code ?? null,
          round,
        });
      } else if (opened.ms !== null) {
        durations.push(opened.ms);
      }
    }
    await sleep(30);
  }

  for (const opener of openers) opener.child.send({ type: "quit" });
  await sleep(200);

  return {
    order,
    openers: OPENERS,
    rounds: ROUNDS,
    totalOpens: OPENERS * ROUNDS,
    failureCount: failures.length,
    failures: failures.slice(0, 8),
    openMs: {
      p50: Number(percentile(durations, 50).toFixed(3)),
      p95: Number(percentile(durations, 95).toFixed(3)),
      max: durations.reduce((a, b) => (b > a ? b : a), 0),
    },
  };
}

async function main(): Promise<void> {
  process.stdout.write("case1c: shipping pragma order\n");
  const shipping = await run("shipping");
  process.stdout.write(
    `case1c:   ${shipping.failureCount} failures in ${shipping.totalOpens} opens\n`,
  );
  process.stdout.write("case1c: busy_timeout set first\n");
  const swapped = await run("swapped");
  process.stdout.write(
    `case1c:   ${swapped.failureCount} failures in ${swapped.totalOpens} opens\n`,
  );

  const path = join(OUT, "case1c.json");
  writeFileSync(path, JSON.stringify({ shipping, swapped }, null, 2));
  process.stdout.write(`case1c: wrote ${path}\n`);
  process.exit(0);
}

void main();
