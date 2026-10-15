import { builtWorker } from "./process-helpers.js";
/**
 * Serving mode at its two real boundaries: awareness on the wire and a
 * process-held SQLite lock that the OS releases after ordinary exit or SIGKILL.
 */

/**
 * Serving mode at its two real boundaries: awareness on the wire and a
 * process-held SQLite lock that the OS releases after ordinary exit or SIGKILL.
 */
import type { Hub } from "@uberblick/hub";
import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpEngine, type UberblickMcpEngine, } from "../src/engine.js";
import { acquireServingReplicaRole, ServingReplicaHeldError, type ServingReplicaHolder, } from "../src/serving-role.js";
import type { PeerClient, Rig } from "./helpers.js";
import { cleanupTestResources, closeChild, tempDatabasePath, testConfig, trackChild } from "./helpers.js";

const WORKER = builtWorker("serving-engine");
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
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(trackChild(child));
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
  await cleanupTestResources({
    clients: [
      ...rigs.splice(0).map((rig) => () => rig.close()),
      ...engines.splice(0).map((engine) => () => engine.close()),
      ...children.splice(0).map((child) => () => closeChild(child)),
    ],
    peers: peers.splice(0).map((peer) => () => peer.destroy()),
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
  });
});

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
