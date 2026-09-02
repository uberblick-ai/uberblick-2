/**
 * Proof 1, case 3 — the index sequencing race.
 *
 * The v2 Codex review claims today's wholesale index replace can leave the
 * derived rows stale: two processes index one document from different log cuts,
 * and the one that derived the older state commits last. This drives exactly
 * that interleaving, twice — once on the store as it ships, once on the
 * `indexed_through_seq` prototype — and then measures what the check costs.
 *
 * Run: node --import tsx spike/proof1/case3.ts [outputDir]
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getMeta } from "@uberblick/schema";
import { Replicas } from "../../src/replica.js";
import {
  TimedStore,
  config,
  createDoc,
  fmt,
  openEngine,
  sleep,
  stats,
} from "./common.js";
import { SequencedStore } from "./sequenced-store.js";

const WORKER = fileURLToPath(new URL("./case3-worker.ts", import.meta.url));
const OUT = process.argv[2] ?? tmpdir();

const SEED = "stateAlpha is what the document says at the first cut.";
const SECOND = "stateBravo is what the document says at the second cut.";
const THIRD = "stateCharlie is what the document says at the third cut.";
/** How long the slow indexer stalls between deriving and committing. */
const STALL_MS = 2_500;
/** Cost benchmark size. */
const COST_ITERATIONS = 2_000;

interface Ack {
  type: "ack";
  id: string;
  cmd: string;
  text?: string;
  skipped?: number | null;
  written?: number | null;
}

interface Peer {
  id: string;
  child: ChildProcess;
  ready: Promise<void>;
  ask(command: Record<string, unknown>): Promise<Ack>;
}

function spawn(id: string, params: Record<string, unknown>): Peer {
  const errorLog = openSync(join(OUT, `case3-${id}.stderr.log`), "w");
  const child = fork(WORKER, [JSON.stringify({ ...params, id })], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", errorLog, "ipc"],
  });
  let markReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const waiting: ((ack: Ack) => void)[] = [];
  child.on("message", (message) => {
    const payload = message as { type: string };
    if (payload.type === "ready") markReady();
    if (payload.type === "ack") waiting.shift()?.(message as Ack);
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`case3: child ${id} exited ${code}\n`);
      process.exit(1);
    }
    markReady();
  });
  return {
    id,
    child,
    ready,
    ask: (command) =>
      new Promise<Ack>((resolve) => {
        waiting.push(resolve);
        child.send({ type: "cmd", ...command });
      }),
  };
}

/** The derived rows as they stand, read from a connection of our own. */
function indexRows(
  databasePath: string,
  uuid: string,
): { body: string; title: string; matchesBravo: number; matchesCharlie: number } {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000");
  const fts = db
    .prepare("SELECT title, body FROM docs_fts WHERE uuid = ?")
    .get(uuid) as { title: string; body: string } | undefined;
  const count = (term: string): number =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM docs_fts WHERE docs_fts MATCH ?")
        .get(`"${term}"`) as { n: number }
    ).n;
  const result = {
    title: fts?.title ?? "",
    body: fts?.body ?? "",
    matchesBravo: count("stateBravo"),
    matchesCharlie: count("stateCharlie"),
  };
  db.close();
  return result;
}

async function race(mode: "today" | "sequenced"): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), `proof1-case3-${mode}-`));
  const databasePath = join(dir, "mirror.sqlite");

  const seeding = openEngine({ databasePath });
  const doc = createDoc(seeding.replicas, "Proof 1 index race", [SEED]);
  await seeding.replicas.settle();
  seeding.destroy();

  const params = { mode, databasePath, docUuid: doc.uuid, blockId: doc.blockIds[0] };
  // Staggered on purpose: opening the store concurrently can throw
  // "database is locked" from the constructor's `PRAGMA journal_mode = WAL`,
  // which runs before the busy timeout is set. See case1c.
  const a = spawn("slow", params);
  await a.ready;
  const b = spawn("fast", params);
  await b.ready;

  // 1. B writes the second cut and indexes it at once.
  await b.ask({ cmd: "write", text: SECOND });
  await sleep(100);
  const afterSecond = indexRows(databasePath, doc.uuid);

  // 2. A settles: it replays the second cut, derives its rows from it, and
  //    stalls before committing them.
  a.child.send({ type: "cmd", cmd: "slow", ms: STALL_MS });
  await sleep(50);
  const aSettling = a.ask({ cmd: "settle" });
  await sleep(400);

  // 3. While A is stalled, B writes the third cut and indexes it immediately.
  await b.ask({ cmd: "write", text: THIRD });
  await sleep(150);
  const afterThird = indexRows(databasePath, doc.uuid);

  // 4. A wakes and commits the derivation it took from the SECOND cut.
  await aSettling;
  await sleep(150);
  const afterStaleCommit = indexRows(databasePath, doc.uuid);

  const bState = await b.ask({ cmd: "read" });
  const aState = await a.ask({ cmd: "read" });

  a.child.send({ type: "cmd", cmd: "quit" });
  b.child.send({ type: "cmd", cmd: "quit" });
  await sleep(300);

  return {
    mode,
    databasePath,
    documentTextInBothReplicas: { fast: bState.text, slow: aState.text },
    indexAfterSecondCut: afterSecond,
    indexAfterThirdCut: afterThird,
    indexAfterSlowCommit: afterStaleCommit,
    stale:
      afterStaleCommit.matchesCharlie === 0 && afterStaleCommit.matchesBravo === 1,
    sequencedSkips: aState.skipped ?? null,
    sequencedWrites: aState.written ?? null,
  };
}

/**
 * What the check costs: the same document indexed `COST_ITERATIONS` times
 * through the shipping path and through the gated one, alone, no contention.
 */
async function cost(): Promise<Record<string, unknown>> {
  const measure = async (
    mode: "today" | "sequenced",
  ): Promise<{ ms: number[]; label: string }> => {
    const dir = mkdtempSync(join(tmpdir(), `proof1-case3-cost-${mode}-`));
    const databasePath = join(dir, "mirror.sqlite");
    const cfg = config({ databasePath });
    const store =
      mode === "sequenced"
        ? new SequencedStore(cfg.databasePath, cfg.workspaceId)
        : new TimedStore(cfg.databasePath, cfg.workspaceId);
    const replicas = new Replicas(cfg, store);
    if (store instanceof SequencedStore) store.replicas = replicas;
    const doc = createDoc(replicas, "Cost", [SEED]);
    await replicas.settle();

    const replica = replicas.replica(doc.uuid);
    const meta = getMeta(replica.doc);
    const samples: number[] = [];
    for (let i = 0; i < COST_ITERATIONS; i += 1) {
      // A fresh derivation each time, so the gate cannot short-circuit on an
      // identical sequence: bump the row the check compares against.
      const seq = i + 1;
      if (store instanceof SequencedStore) {
        (store as unknown as { cut: (uuid: string) => number }).cut = () => seq;
      }
      const started = performance.now();
      store.indexDoc({
        uuid: meta.uuid,
        title: meta.title,
        tags: meta.tags,
        description: meta.description ?? "",
        links: meta.links,
        body: `${SEED} iteration ${i}`,
      });
      samples.push(performance.now() - started);
    }
    replicas.destroy();
    store.close();
    return { ms: samples, label: mode };
  };

  const today = await measure("today");
  const sequenced = await measure("sequenced");
  return {
    iterations: COST_ITERATIONS,
    today: fmt(stats(today.ms)),
    sequenced: fmt(stats(sequenced.ms)),
  };
}

async function main(): Promise<void> {
  process.stdout.write("case3: race on the store as it ships\n");
  const shipping = await race("today");
  process.stdout.write(`case3:   stale index = ${String(shipping.stale)}\n`);

  process.stdout.write("case3: race on the indexed_through_seq prototype\n");
  const fixed = await race("sequenced");
  process.stdout.write(`case3:   stale index = ${String(fixed.stale)}\n`);

  process.stdout.write("case3: cost of the check\n");
  const costs = await cost();

  const path = join(OUT, "case3.json");
  writeFileSync(
    path,
    JSON.stringify({ shipping, fixed, cost: costs }, null, 2),
  );
  process.stdout.write(`case3: wrote ${path}\n`);
  process.exit(0);
}

void main();
