/**
 * Serving mode at its two real boundaries: awareness on the wire and a
 * process-held SQLite lock that the OS releases after ordinary exit or SIGKILL.
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { appendBlock, getBlocks, initDoc, roomForDoc } from "@uberblick/schema";
import * as Y from "yjs";
import {
  createMcpEngine,
  type UberblickMcpEngine,
} from "../src/engine.js";
import {
  acquireServingReplicaRole,
  ServingReplicaHeldError,
  type ServingReplicaHolder,
} from "../src/serving-role.js";
import {
  hubUrl,
  peerClient,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { Hub } from "@uberblick/hub";
import type { PeerClient, Rig } from "./helpers.js";

const WORKER = fileURLToPath(
  new URL("./serving-engine-worker.ts", import.meta.url),
);
const children: ChildProcess[] = [];
const engines: UberblickMcpEngine[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];
const rigs: Rig[] = [];

type WorkerMessage =
  | { type: "waiting" }
  | { type: "acquired"; pid: number; sessionId: string }
  | { type: "refused"; holder: ServingReplicaHolder; message: string }
  | { type: "closed" }
  | { type: "failed"; message: string };

interface Worker {
  child: ChildProcess;
  next(): Promise<WorkerMessage>;
}

function spawnWorker(databasePath: string, sessionId: string): Worker {
  const child = fork(WORKER, [databasePath, sessionId], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    next: () =>
      new Promise<WorkerMessage>((resolve, reject) => {
        const onMessage = (message: WorkerMessage): void => {
          child.off("exit", onExit);
          resolve(message);
        };
        const onExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          child.off("message", onMessage);
          reject(
            new Error(
              `serving worker exited ${String(code ?? signal)} before replying: ${stderr.trim()}`,
            ),
          );
        };
        child.once("message", onMessage);
        child.once("exit", onExit);
      }),
  };
}

async function startWorker(worker: Worker): Promise<WorkerMessage> {
  expect(await worker.next()).toEqual({ type: "waiting" });
  const reply = worker.next();
  worker.child.send({ type: "start" });
  return reply;
}

async function closeWorker(worker: Worker): Promise<void> {
  const reply = worker.next();
  const exited = once(worker.child, "exit");
  worker.child.send({ type: "close" });
  expect(await reply).toEqual({ type: "closed" });
  await exited;
  children.splice(children.indexOf(worker.child), 1);
}

async function killWorker(worker: Worker): Promise<void> {
  const exited = once(worker.child, "exit");
  worker.child.kill("SIGKILL");
  await exited;
  children.splice(children.indexOf(worker.child), 1);
}

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const engine of engines.splice(0)) await engine.close();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  removeTempDirs();
});

function encodedDoc(uuid: string, text: string): Uint8Array {
  const doc = new Y.Doc();
  initDoc(doc, { uuid, title: "Serving replica test" });
  appendBlock(doc, { type: "paragraph", text });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

async function refusedServingBoot(
  databasePath: string,
  sessionId: string,
): Promise<ServingReplicaHeldError> {
  const config = testConfig({ databasePath });
  config.sessionId = sessionId;
  try {
    await createMcpEngine(config, { serving: true });
  } catch (error) {
    if (error instanceof ServingReplicaHeldError) return error;
    throw error;
  }
  throw new Error("the second serving boot was admitted");
}

describe("serving MCP engine", () => {
  it("publishes no state of its own while its rooms still sync, without changing MCP presence", async () => {
    const running = await startHub();
    hubs.push(running);
    const databasePath = tempDatabasePath();
    const serving = await createMcpEngine(
      testConfig({
        databasePath,
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(running.port),
      }),
      { serving: true, refreshIntervalMs: 10 },
    );
    engines.push(serving);

    expect(
      serving.replicas
        .attachedReplicas()
        .map((replica) => replica.awareness.getLocalState()),
    ).toEqual([null, null, null]);

    const uuid = randomUUID();
    const room = roomForDoc(WORKSPACE, uuid);
    serving.store.appendUpdate(room, encodedDoc(uuid, "synced silently"), "local");
    const peer = await peerClient(running.port, room);
    peers.push(peer);
    await waitUntil(
      "the silent serving replica to sync its document room",
      () => getBlocks(peer.doc)[0]?.text === "synced silently",
    );
    const documentReplica = serving.replicas
      .attachedReplicas()
      .find((replica) => replica.room === room);
    if (documentReplica === undefined) throw new Error("document room not attached");
    serving.replicas.touch(documentReplica);
    const blockId = getBlocks(documentReplica.doc)[0]?.id;
    if (blockId === undefined) throw new Error("synced block missing");
    serving.replicas.publishCursor(documentReplica, blockId, 0);
    expect(documentReplica.awareness.getLocalState()).toBeNull();

    const mcp = await startServer(testConfig());
    rigs.push(mcp);
    expect(mcp.instance.replicas.directory().awareness.getLocalState()).toMatchObject(
      {
        client: "agent",
        session: mcp.config.sessionId,
        user: { name: mcp.clientName, color: mcp.config.color },
      },
    );
  });

  it("refuses live contenders with the unchanged current holder, but permits non-serving engines and graceful replacement", async () => {
    const databasePath = tempDatabasePath();
    const holderSession = "worker-holder";
    const holder = spawnWorker(databasePath, holderSession);
    const acquired = await startWorker(holder);
    expect(acquired).toMatchObject({
      type: "acquired",
      pid: expect.any(Number),
      sessionId: holderSession,
    });
    if (acquired.type !== "acquired") throw new Error("holder did not acquire");
    const expectedHolder = { pid: acquired.pid, sessionId: holderSession };

    const first = await refusedServingBoot(databasePath, "contender-one");
    const second = await refusedServingBoot(databasePath, "contender-two");
    expect(first.holder).toEqual(expectedHolder);
    expect(second.holder).toEqual(expectedHolder);
    expect(second.holder.sessionId).not.toBe("contender-two");
    expect(second.message).toContain(`process ${acquired.pid}`);
    expect(second.message).toContain(holderSession);

    const ordinary = await createMcpEngine(testConfig({ databasePath }));
    engines.push(ordinary);
    await ordinary.close();
    engines.splice(engines.indexOf(ordinary), 1);

    await closeWorker(holder);
    const replacement = await createMcpEngine(testConfig({ databasePath }), {
      serving: true,
    });
    engines.push(replacement);
  });

  it("admits exactly one simultaneous process and makes every loser name that winner", async () => {
    const databasePath = tempDatabasePath();
    const candidates = Array.from({ length: 4 }, (_, index) =>
      spawnWorker(databasePath, `candidate-${index}`),
    );
    expect(await Promise.all(candidates.map((candidate) => candidate.next()))).toEqual(
      Array.from({ length: candidates.length }, () => ({ type: "waiting" })),
    );

    const replies = candidates.map((candidate) => candidate.next());
    for (const candidate of candidates) candidate.child.send({ type: "start" });
    const outcomes = await Promise.all(replies);
    const winners = outcomes.filter(
      (outcome): outcome is Extract<WorkerMessage, { type: "acquired" }> =>
        outcome.type === "acquired",
    );
    const refusals = outcomes.filter(
      (outcome): outcome is Extract<WorkerMessage, { type: "refused" }> =>
        outcome.type === "refused",
    );
    expect(winners).toHaveLength(1);
    expect(refusals).toHaveLength(candidates.length - 1);
    const winner = winners[0];
    if (winner === undefined) throw new Error("no serving winner");
    expect(refusals.map((refusal) => refusal.holder)).toEqual(
      Array.from({ length: refusals.length }, () => ({
        pid: winner.pid,
        sessionId: winner.sessionId,
      })),
    );

    const winnerIndex = outcomes.indexOf(winner);
    const winnerWorker = candidates[winnerIndex];
    if (winnerWorker === undefined) throw new Error("winner worker missing");
    await closeWorker(winnerWorker);
  });

  it("acquires after the holder is SIGKILLed without cleaning its file or record", async () => {
    const databasePath = tempDatabasePath();
    const holder = spawnWorker(databasePath, "killed-holder");
    expect(await startWorker(holder)).toMatchObject({ type: "acquired" });
    await killWorker(holder);

    const recoveredConfig = testConfig({ databasePath });
    recoveredConfig.sessionId = "recovered-holder";
    const recovered = await createMcpEngine(recoveredConfig, {
      serving: true,
    });
    engines.push(recovered);
    expect(recovered.replicas.directory().awareness.getLocalState()).toBeNull();
    expect(
      (await refusedServingBoot(databasePath, "post-crash-contender")).holder,
    ).toEqual({ pid: process.pid, sessionId: "recovered-holder" });
  });

  it("acquires when the holder exits between the first refusal and its recheck", async () => {
    const databasePath = tempDatabasePath();
    const holder = spawnWorker(databasePath, "departing-holder");
    expect(await startWorker(holder)).toMatchObject({ type: "acquired" });

    const originalPrepare = DatabaseSync.prototype.prepare;
    let intercepted = false;
    const exited = once(holder.child, "exit");
    DatabaseSync.prototype.prepare = function prepare(sql) {
      if (!intercepted && sql === "SELECT value FROM meta WHERE key = ?") {
        intercepted = true;
        holder.child.kill("SIGKILL");
        const released = new DatabaseSync(`${databasePath}.serving-lock`);
        try {
          released.exec("PRAGMA busy_timeout = 5000");
          released.exec("BEGIN EXCLUSIVE");
          released.exec("ROLLBACK");
        } finally {
          released.close();
        }
      }
      return originalPrepare.call(this, sql);
    };

    try {
      const contender = acquireServingReplicaRole(databasePath, {
        pid: process.pid,
        sessionId: "surviving-contender",
      });
      contender.close();
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
      await exited;
      children.splice(children.indexOf(holder.child), 1);
    }
    expect(intercepted).toBe(true);
  });
});
