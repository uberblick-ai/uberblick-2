import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryHoldSession } from "../src/history-holds.js";
import { closeChild, tempDatabasePath, trackChild } from "./helpers.js";
import { builtWorker } from "./process-helpers.js";

const children: ChildProcess[] = [];
const sessions: HistoryHoldSession[] = [];

function worker(databasePath: string): ChildProcess {
  const child = trackChild(fork(builtWorker("history-holds"), [databasePath], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  children.push(child);
  return child;
}

afterEach(async () => {
  for (const child of children.splice(0)) await closeChild(child);
  for (const session of sessions.splice(0)) session.close();
});

describe("process-held history snapshot holds", () => {
  it("keeps a live process's holds and releases them after SIGKILL", async () => {
    const databasePath = tempDatabasePath();
    const observer = new HistoryHoldSession(databasePath);
    sessions.push(observer);
    const child = worker(databasePath);
    const [ready] = await once(child, "message") as [{ type: string; sessionId: string }];
    expect(ready.type).toBe("ready");
    expect(observer.isAlive(ready.sessionId)).toBe(true);
    expect(observer.isAlive(ready.sessionId)).toBe(true);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect(observer.isAlive(ready.sessionId)).toBe(false);
  });

  it("preserves the OS lock after another session in the same process probes it", async () => {
    const databasePath = tempDatabasePath();
    const first = new HistoryHoldSession(databasePath);
    const second = new HistoryHoldSession(databasePath);
    sessions.push(first, second);
    expect(second.isAlive(first.id)).toBe(true);
    expect(second.isAlive(first.id)).toBe(true);
    const child = worker(databasePath);
    await once(child, "message");
    const reply = once(child, "message");
    child.send({ type: "probe", sessionId: first.id });
    expect((await reply)[0]).toEqual({ type: "probe", alive: true });
  });
});
