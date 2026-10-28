import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryAcquireHistoryRefresherRole, type HistoryRefresherRole } from "../src/history-refresher-role.js";
import { closeChild, removeTempDirs, tempDatabasePath, trackChild } from "./helpers.js";
import { builtWorker } from "./process-helpers.js";

const children: ChildProcess[] = [];
const roles: HistoryRefresherRole[] = [];

function cachePath(): string {
  const path = tempDatabasePath();
  writeFileSync(path, "");
  return path;
}

function worker(databasePath: string): ChildProcess {
  const child = trackChild(fork(builtWorker("history-refresher-role"), [databasePath], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  children.push(child);
  return child;
}

async function request(child: ChildProcess, type: string): Promise<unknown> {
  const reply = once(child, "message");
  child.send({ type });
  return (await reply)[0];
}

function acquire(databasePath: string): HistoryRefresherRole {
  const role = tryAcquireHistoryRefresherRole(databasePath);
  expect(role).not.toBeNull();
  if (role === null) throw new Error("history role was refused");
  roles.push(role);
  return role;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const role of roles.splice(0)) role.close();
  for (const child of children.splice(0)) await closeChild(child);
  removeTempDirs();
});

describe("process-held history refresher role", () => {
  it("admits one simultaneous contender and lets a running loser take over after exit", async () => {
    const path = cachePath();
    const contenders = Array.from({ length: 4 }, () => worker(path));
    await Promise.all(contenders.map(child => once(child, "message")));
    const replies = await Promise.all(contenders.map(child => request(child, "start")));
    expect(replies.filter(reply => (reply as { type: string }).type === "acquired")).toHaveLength(1);
    expect(replies.filter(reply => (reply as { type: string }).type === "refused")).toHaveLength(3);
    const winnerIndex = replies.findIndex(reply => (reply as { type: string }).type === "acquired");
    const winner = contenders[winnerIndex]!;
    const successor = contenders.find(child => child !== winner)!;
    const exited = once(winner, "exit");
    winner.send({ type: "close" });
    await exited;
    expect(await request(successor, "start")).toEqual({ type: "acquired" });
  });

  it("releases a killed holder's lock without deleting any sidecar", async () => {
    const path = cachePath();
    const holder = worker(path);
    const successor = worker(path);
    await Promise.all([once(holder, "message"), once(successor, "message")]);
    expect(await request(holder, "start")).toEqual({ type: "acquired" });
    expect(await request(successor, "start")).toEqual({ type: "refused" });
    const exited = once(holder, "exit");
    holder.kill("SIGKILL");
    await exited;
    expect(existsSync(`${path}.history-refresher-lock`)).toBe(true);
    expect(await request(successor, "start")).toEqual({ type: "acquired" });
  });

  it("keeps exclusion after same-process contenders inspect the held inode", async () => {
    const path = cachePath();
    const role = acquire(path);
    expect(tryAcquireHistoryRefresherRole(path)).toBeNull();
    expect(tryAcquireHistoryRefresherRole(path)).toBeNull();
    const contender = worker(path);
    await once(contender, "message");
    expect(await request(contender, "start")).toEqual({ type: "refused" });
    expect(role.isCurrent()).toBe(true);
    role.close();
    role.close();
    expect(await request(contender, "start")).toEqual({ type: "acquired" });
    expect(role.isCurrent()).toBe(false);
  });

  it("fences a removed copy and admits a new copy while its former process remains alive", async () => {
    const path = cachePath();
    const old = worker(path);
    await once(old, "message");
    expect(await request(old, "start")).toEqual({ type: "acquired" });
    unlinkSync(path);
    unlinkSync(`${path}.history-refresher-lock`);
    writeFileSync(path, "new workspace copy");
    const replacement = acquire(path);
    expect(await request(old, "current")).toEqual({ type: "current", current: false });
    expect(replacement.isCurrent()).toBe(true);
    await closeChild(old);
    const contender = worker(path);
    await once(contender, "message");
    expect(await request(contender, "start")).toEqual({ type: "refused" });
  });

  it.each(["database", "sidecar"])("refuses a %s replaced during acquisition", target => {
    const path = cachePath();
    const replaced = target === "database" ? path : `${path}.history-refresher-lock`;
    const originalExec = DatabaseSync.prototype.exec;
    let replacedOnce = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (!replacedOnce && sql === "BEGIN EXCLUSIVE") {
        replacedOnce = true;
        renameSync(replaced, `${replaced}.former`);
        writeFileSync(replaced, "");
      }
      originalExec.call(this, sql);
    });
    expect(tryAcquireHistoryRefresherRole(path)).toBeNull();
    expect(replacedOnce).toBe(true);
    acquire(path);
  });

  it("does not create a sidecar for a missing workspace copy", () => {
    const path = tempDatabasePath();
    expect(tryAcquireHistoryRefresherRole(path)).toBeNull();
    expect(existsSync(`${path}.history-refresher-lock`)).toBe(false);
    expect(() => tryAcquireHistoryRefresherRole(":memory:")).toThrow(/file-backed/);
  });
});
