/**
 * Proof 1, case 5 — offline create, restart, push. The single-process sanity
 * baseline for case 4.
 *
 * A document is created with no hub reachable, the process is SIGKILLed (no
 * clean shutdown, so only what the log holds survives), the hub comes up, and a
 * fresh process on the same store pushes it.
 *
 * Run: node --import tsx spike/proof1/case5.ts [outputDir]
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHub, silentLogger } from "@uberblick/hub";
import { getBlock } from "@uberblick/schema";
import * as Y from "yjs";
import { WORKSPACE, sleep } from "./common.js";

const WORKER = fileURLToPath(new URL("./case4-worker.ts", import.meta.url));
const OUT = process.argv[2] ?? tmpdir();
const SECRET = "proof1-hmac-secret-not-a-real-one";
/** A port nothing listens on: genuinely offline, not merely slow. */
const DEAD_HUB = "ws://127.0.0.1:1";

interface Ack {
  type: "ack";
  id: string;
  cmd: string;
  uuid?: string;
  blockIds?: string[];
  text?: string;
  hub?: { status: string };
  pending?: { room: string; seq: number }[];
  rooms?: { room: string; lastSeq: number; quiet: boolean }[];
}

interface Peer {
  child: ChildProcess;
  ready: Promise<Ack>;
  ask(command: Record<string, unknown>): Promise<Ack>;
}

function spawn(id: string, params: Record<string, unknown>): Peer {
  const errorLog = openSync(join(OUT, `case5-${id}.stderr.log`), "w");
  const child = fork(WORKER, [JSON.stringify({ ...params, id })], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", errorLog, "ipc"],
  });
  let markReady = (_: Ack): void => {};
  const ready = new Promise<Ack>((resolve) => {
    markReady = resolve;
  });
  const waiting: ((ack: Ack) => void)[] = [];
  child.on("message", (message) => {
    const payload = message as { type: string };
    if (payload.type === "ready") markReady(message as Ack);
    if (payload.type === "ack") waiting.shift()?.(message as Ack);
  });
  return {
    child,
    ready,
    ask: (command) =>
      new Promise<Ack>((resolve) => {
        waiting.push(resolve);
        child.send(command);
      }),
  };
}

function pendingFor(db: string, room: string): number | null {
  const handle = new DatabaseSync(db);
  const row = handle
    .prepare("SELECT seq FROM pending_rooms WHERE room = ?")
    .get(room) as { seq: number } | undefined;
  handle.close();
  return row?.seq ?? null;
}

function hubText(path: string, room: string, blockId: string): string | null {
  const db = new DatabaseSync(path);
  const row = db
    .prepare('SELECT data FROM "documents" WHERE name = ? ORDER BY rowid DESC')
    .get(room) as { data: Uint8Array } | undefined;
  db.close();
  if (row === undefined) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.data);
  return getBlock(doc, blockId)?.text ?? null;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "proof1-case5-"));
  const databasePath = join(dir, "mirror.sqlite");
  const hubDatabasePath = join(dir, "hub.sqlite");

  // 1. One process, no hub anywhere. Create a document, then SIGKILL it.
  const offline = spawn("offline", {
    databasePath,
    hubUrl: DEAD_HUB,
    authSecret: SECRET,
  });
  await offline.ready;
  const created = await offline.ask({
    cmd: "create",
    title: "Case 5 offline document",
    text: "created with no hub in the world",
  });
  const uuid = created.uuid as string;
  const blockId = (created.blockIds as string[])[0] as string;
  const room = `${WORKSPACE}/${uuid}`;
  const pendingBeforeKill = pendingFor(databasePath, room);
  offline.child.kill("SIGKILL");
  await sleep(500);
  const pendingAfterKill = pendingFor(databasePath, room);

  // 2. A hub appears.
  const hub = await createHub({
    authSecret: SECRET,
    port: 0,
    databasePath: hubDatabasePath,
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  const hubUrl = `ws://127.0.0.1:${hub.port}`;

  // 3. A fresh process on the same store, with the hub configured.
  const online = spawn("online", { databasePath, hubUrl, authSecret: SECRET });
  const onlineReady = await online.ready;

  let pushed: string | null = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    await online.ask({ cmd: "settle" });
    await hub.flush();
    pushed = hubText(hubDatabasePath, room, blockId);
    if (pushed !== null) break;
  }
  const pendingAfterPush = pendingFor(databasePath, room);
  const finalState = await online.ask({ cmd: "state" });

  online.child.send({ cmd: "quit" });
  await sleep(300);
  await hub.stop();

  const report = {
    parameters: { databasePath, hubDatabasePath, room },
    pendingBeforeKill,
    pendingAfterKill,
    knewRoomAtBoot: onlineReady.rooms?.some((r) => r.room === room) ?? false,
    hubTextAfterRestart: pushed,
    pendingAfterPush,
    hubStatus: finalState.hub?.status,
    verdict: {
      survivedKill: pendingAfterKill !== null,
      pushedAfterHubAppeared: pushed === "created with no hub in the world",
      pendingCleared: pendingAfterPush === null,
    },
  };
  const path = join(OUT, "case5.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  process.stdout.write(`case5: ${JSON.stringify(report.verdict)}\ncase5: wrote ${path}\n`);
  process.exit(0);
}

void main();
