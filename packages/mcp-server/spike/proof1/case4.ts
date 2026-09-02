/**
 * Proof 1, case 4 — two processes, one store, one hub.
 *
 * Part A: both processes edit one room through the hub, the hub goes away, both
 * keep editing, the hub comes back. Convergence and the pending set are the
 * assertions: `pending_rooms` must hold every unacknowledged room while the hub
 * is gone, and must clear only once the hub has acknowledged.
 *
 * Part B (adoption): a document created while the hub is down by a process that
 * is then killed must be pushed by a fresh process that never touched it.
 *
 * Run: node --import tsx spike/proof1/case4.ts [outputDir]
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { getBlock } from "@uberblick/schema";
import * as Y from "yjs";
import { WORKSPACE, sleep } from "./common.js";

const WORKER = fileURLToPath(new URL("./case4-worker.ts", import.meta.url));
const OUT = process.argv[2] ?? tmpdir();
const SECRET = "proof1-hmac-secret-not-a-real-one";

interface Ack {
  type: "ack";
  id: string;
  cmd: string;
  uuid?: string;
  blockIds?: string[];
  text?: string;
  known?: boolean;
  error?: string;
  hub?: { status: string };
  pending?: { room: string; seq: number }[];
  rooms?: { room: string; lastSeq: number; quiet: boolean }[];
}

interface Peer {
  id: string;
  child: ChildProcess;
  ready: Promise<Ack>;
  ask(command: Record<string, unknown>): Promise<Ack>;
  kill(): void;
}

function spawn(id: string, params: Record<string, unknown>): Peer {
  const errorLog = openSync(join(OUT, `case4-${id}.stderr.log`), "w");
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
    id,
    child,
    ready,
    ask: (command) =>
      new Promise<Ack>((resolve) => {
        waiting.push(resolve);
        child.send(command);
      }),
    kill: () => child.kill("SIGKILL"),
  };
}

/** The hub's own copy of one room, after a flush: durability, not memory. */
function hubText(
  hubDatabasePath: string,
  room: string,
  blockId: string,
): string | null {
  const db = new DatabaseSync(hubDatabasePath);
  const row = db
    .prepare('SELECT data FROM "documents" WHERE name = ? ORDER BY rowid DESC')
    .get(room) as { data: Uint8Array } | undefined;
  db.close();
  if (row === undefined) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.data);
  return getBlock(doc, blockId)?.text ?? null;
}

function pendingFor(db: string, room: string): number | null {
  const handle = new DatabaseSync(db);
  const row = handle
    .prepare("SELECT seq FROM pending_rooms WHERE room = ?")
    .get(room) as { seq: number } | undefined;
  handle.close();
  return row?.seq ?? null;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "proof1-case4-"));
  const databasePath = join(dir, "mirror.sqlite");
  const hubDatabasePath = join(dir, "hub.sqlite");
  const timeline: Record<string, unknown>[] = [];

  let hub: Hub = await createHub({
    authSecret: SECRET,
    port: 0,
    databasePath: hubDatabasePath,
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  const port = hub.port;
  const hubUrl = `ws://127.0.0.1:${port}`;
  process.stdout.write(`case4: hub on ${hubUrl}, store ${databasePath}\n`);

  const params = { databasePath, hubUrl, authSecret: SECRET };
  // Staggered: several processes opening one WAL store in the same instant can
  // lose the shared-memory-index race (case 1c).
  const p1 = spawn("p1", params);
  await p1.ready;
  const p2 = spawn("p2", params);
  await p2.ready;

  // --- Part A -------------------------------------------------------------
  const created = await p1.ask({ cmd: "create", title: "Case 4", text: "base" });
  const uuid = created.uuid as string;
  const blockId = (created.blockIds as string[])[0] as string;
  const room = `${WORKSPACE}/${uuid}`;

  await sleep(1_500);
  await p1.ask({ cmd: "settle" });
  await p2.ask({ cmd: "settle" });
  const onlineState = await p1.ask({ cmd: "state" });
  timeline.push({
    step: "created online",
    pendingForRoom: pendingFor(databasePath, room),
    hubStatus: onlineState.hub?.status,
  });

  // Both processes edit the same block while the hub is up.
  await p1.ask({ cmd: "append", uuid, blockId, suffix: " p1-online" });
  await p2.ask({ cmd: "append", uuid, blockId, suffix: " p2-online" });
  await sleep(1_200);
  await p1.ask({ cmd: "settle" });
  await p2.ask({ cmd: "settle" });
  await hub.flush();
  timeline.push({
    step: "both edited online",
    p1: (await p1.ask({ cmd: "read", uuid, blockId })).text,
    p2: (await p2.ask({ cmd: "read", uuid, blockId })).text,
    hub: hubText(hubDatabasePath, room, blockId),
    pendingForRoom: pendingFor(databasePath, room),
  });

  // The hub goes away.
  await hub.stop();
  await sleep(600);
  const p1Offline = await p1.ask({ cmd: "append", uuid, blockId, suffix: " p1-offline" });
  const p2Offline = await p2.ask({ cmd: "append", uuid, blockId, suffix: " p2-offline" });
  await p1.ask({ cmd: "settle" });
  await p2.ask({ cmd: "settle" });
  const offlinePending = pendingFor(databasePath, room);
  timeline.push({
    step: "hub down, both edited",
    pendingForRoom: offlinePending,
    p1HubStatus: p1Offline.hub?.status,
    p2HubStatus: p2Offline.hub?.status,
    p1RoomQuiet: p1Offline.rooms?.find((r) => r.room === room)?.quiet,
    p2RoomQuiet: p2Offline.rooms?.find((r) => r.room === room)?.quiet,
    p1Text: p1Offline.text,
    p2Text: p2Offline.text,
  });

  // --- Part B, first half: a doc created offline by a process that then dies.
  const orphan = await p1.ask({
    cmd: "create",
    title: "Case 4 orphan",
    text: "written while the hub was down",
  });
  const orphanUuid = orphan.uuid as string;
  const orphanBlock = (orphan.blockIds as string[])[0] as string;
  const orphanRoom = `${WORKSPACE}/${orphanUuid}`;
  await sleep(200);
  p1.kill();
  await sleep(500);
  timeline.push({
    step: "orphan created offline, p1 killed",
    pendingForOrphan: pendingFor(databasePath, orphanRoom),
  });

  // A process that has never seen that document.
  const p3 = spawn("p3", params);
  const p3Ready = await p3.ready;
  timeline.push({
    step: "p3 started with the hub still down",
    knowsOrphanAtBoot: p3Ready.rooms?.some((r) => r.room === orphanRoom) ?? false,
  });

  // The hub comes back on the same port with the same database.
  hub = await createHub({
    authSecret: SECRET,
    port,
    databasePath: hubDatabasePath,
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  process.stdout.write("case4: hub restarted\n");

  // Give the providers their reconnect, then settle everyone.
  const deadline = Date.now() + 30_000;
  let converged = false;
  let p2Text = "";
  let p3Text = "";
  let hubMain: string | null = null;
  let hubOrphan: string | null = null;
  while (Date.now() < deadline) {
    await sleep(1_000);
    await p2.ask({ cmd: "settle" });
    await p3.ask({ cmd: "settle" });
    await hub.flush();
    p2Text = (await p2.ask({ cmd: "read", uuid, blockId })).text as string;
    p3Text = (await p3.ask({ cmd: "read", uuid, blockId })).text as string;
    hubMain = hubText(hubDatabasePath, room, blockId);
    hubOrphan = hubText(hubDatabasePath, orphanRoom, orphanBlock);
    if (
      hubMain !== null &&
      hubMain === p2Text &&
      hubMain === p3Text &&
      hubMain.includes("p1-offline") &&
      hubMain.includes("p2-offline") &&
      hubOrphan !== null
    ) {
      converged = true;
      break;
    }
  }

  const finalPending = pendingFor(databasePath, room);
  const finalOrphanPending = pendingFor(databasePath, orphanRoom);
  timeline.push({
    step: "hub restarted",
    converged,
    p2Text,
    p3Text,
    hubText: hubMain,
    hubOrphanText: hubOrphan,
    pendingForRoom: finalPending,
    pendingForOrphan: finalOrphanPending,
  });

  const p2Final = await p2.ask({ cmd: "state" });
  p2.child.send({ cmd: "quit" });
  p3.child.send({ cmd: "quit" });
  await sleep(400);
  await hub.stop();

  const report = {
    parameters: { databasePath, hubDatabasePath, port, room, orphanRoom },
    timeline,
    verdict: {
      convergedAfterOutage: converged,
      pendingHeldWhileHubDown: offlinePending !== null,
      pendingClearedAfterAck: finalPending === null,
      orphanPushedByFreshProcess: hubOrphan !== null,
      orphanPendingCleared: finalOrphanPending === null,
      finalHubStatus: p2Final.hub?.status,
    },
  };
  const path = join(OUT, "case4.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  process.stdout.write(`case4: ${JSON.stringify(report.verdict)}\ncase4: wrote ${path}\n`);
  process.exit(0);
}

void main();
