import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryHoldSession, historyHoldPath } from "../src/history-holds.js";
import { tempDatabasePath } from "./helpers.js";

const sessions: HistoryHoldSession[] = [];

function hold(databasePath: string): HistoryHoldSession {
  const session = new HistoryHoldSession(databasePath);
  sessions.push(session);
  return session;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});

describe("history snapshot hold liveness", () => {
  it("keeps independent live sessions and releases only the closed session", () => {
    const databasePath = tempDatabasePath();
    const first = hold(databasePath);
    const second = hold(databasePath);
    expect(first.id).not.toBe(second.id);
    expect(first.isAlive(first.id)).toBe(true);
    expect(first.isAlive(second.id)).toBe(true);
    expect(second.isAlive(first.id)).toBe(true);
    first.close();
    first.close();
    expect(first.isAlive(first.id)).toBe(false);
    expect(second.isAlive(first.id)).toBe(false);
    expect(second.isAlive(second.id)).toBe(true);
    expect(existsSync(historyHoldPath(databasePath, first.id))).toBe(false);
  });

  it("reclaims an unlocked abandoned session and treats a missing one as dead", () => {
    const databasePath = tempDatabasePath();
    const observer = hold(databasePath);
    const deadId = randomUUID();
    const path = historyHoldPath(databasePath, deadId);
    writeFileSync(path, "");
    expect(observer.isAlive(deadId)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(observer.isAlive(randomUUID())).toBe(false);
  });

  it("keeps holds when a sidecar cannot be interpreted or its identity is invalid", () => {
    const databasePath = tempDatabasePath();
    const observer = hold(databasePath);
    const damagedId = randomUUID();
    const path = historyHoldPath(databasePath, damagedId);
    mkdirSync(path);
    expect(observer.isAlive(damagedId)).toBe(true);
    expect(observer.isAlive("../other-workspace")).toBe(true);
    rmSync(path, { recursive: true });
    writeFileSync(path, "not sqlite");
    expect(observer.isAlive(damagedId)).toBe(true);
    expect(existsSync(join(`${databasePath}.history-holds`, `${damagedId}.sqlite`))).toBe(true);
  });
});
