import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { ensureHostDiskCapacity } from "../src/host-capacity.js";
import { HistoryHoldSession, historyHoldPath } from "../src/history-holds.js";
import { createMcpRuntime } from "../src/server.js";
import { MirrorStore, readStoredSyncStatus } from "../src/store.js";
import { removeTempDirs, tempDir, testConfig, TEST_SECRET, waitUntil, WORKSPACE } from "./shared.js";

afterEach(removeTempDirs);

function mirror(root: string, grant: string, lastUsed: number, pending = false): string {
  const directory = join(root, createHash("sha256").update(grant).digest("hex"));
  const databasePath = join(directory, `${WORKSPACE}.sqlite`);
  const store = new MirrorStore(databasePath, WORKSPACE);
  try {
    if (pending) {
      const document = new Y.Doc();
      try {
        document.getText("text").insert(0, "not acknowledged");
        store.appendUpdate(`${WORKSPACE}/pending`, Y.encodeStateAsUpdate(document), "local");
      } finally { document.destroy(); }
    }
  } finally { store.close(); }
  utimesSync(directory, lastUsed, lastUsed);
  return directory;
}

it("opens with enough free space without inspecting or deleting a closed mirror", async () => {
  const root = tempDir();
  const directory = mirror(root, "retained", 1);
  const freeSpace = vi.fn(() => 100);
  expect(await ensureHostDiskCapacity({ databaseDirectory: root, minFreeBytes: 100, excludedDirectories: new Set(), freeSpace })).toBe(true);
  expect(existsSync(directory)).toBe(true);
  expect(freeSpace).toHaveBeenCalledOnce();
});

it("reclaims clean closed mirrors in least recently used order and stops once sufficient", async () => {
  const root = tempDir();
  const recent = mirror(root, "recent", 20);
  const oldest = mirror(root, "oldest", 1);
  const middle = mirror(root, "middle", 10);
  const removed: string[][] = [];
  const freeSpace = () => {
    const gone = [oldest, middle, recent].filter(directory => !existsSync(directory));
    removed.push(gone);
    return gone.length * 50;
  };
  expect(await ensureHostDiskCapacity({ databaseDirectory: root, minFreeBytes: 100, excludedDirectories: new Set(), freeSpace })).toBe(true);
  expect(removed).toEqual([[], [oldest], [oldest, middle]]);
  expect(existsSync(recent)).toBe(true);
});

it("retains pending, active, unreadable and unrecognized mirrors while reclaiming clean data", async () => {
  const root = tempDir();
  const pending = mirror(root, "pending", 1, true);
  expect(readStoredSyncStatus(join(pending, `${WORKSPACE}.sqlite`), WORKSPACE).pendingRooms).toHaveLength(1);
  const active = mirror(root, "active", 2);
  const corrupt = mirror(root, "corrupt", 3);
  writeFileSync(join(corrupt, `${WORKSPACE}.sqlite`), "not sqlite");
  const unknown = join(root, "a".repeat(64));
  mkdirSync(unknown);
  const unrelatedDatabase = new DatabaseSync(join(unknown, `${WORKSPACE}.sqlite`));
  unrelatedDatabase.exec("CREATE TABLE user_content (body TEXT)");
  unrelatedDatabase.close();
  const clean = mirror(root, "clean", 4);
  const excludedDirectories = new Set<string>();
  const freeSpace = () => {
    excludedDirectories.add(active);
    return existsSync(clean) ? 0 : 100;
  };
  expect(await ensureHostDiskCapacity({ databaseDirectory: root, minFreeBytes: 100, excludedDirectories, freeSpace })).toBe(true);
  expect([pending, active, corrupt, unknown].every(existsSync)).toBe(true);
  expect(existsSync(clean)).toBe(false);
});

it("refuses when reclaiming every clean closed mirror leaves too little free space", async () => {
  const root = tempDir();
  const clean = mirror(root, "clean", 1);
  expect(await ensureHostDiskCapacity({
    databaseDirectory: root, minFreeBytes: 100, excludedDirectories: new Set(), freeSpace: () => 0,
  })).toBe(false);
  expect(existsSync(clean)).toBe(false);
});

it.each(["empty", "abandoned"] as const)("reclaims a closed runtime's real mirror, history refresher sidecar and %s history holds", async holds => {
  const root = tempDir();
  const directory = join(root, createHash("sha256").update("runtime").digest("hex"));
  const databasePath = join(directory, `${WORKSPACE}.sqlite`);
  const runtime = createMcpRuntime(testConfig({ databasePath, authSecret: TEST_SECRET }));
  try {
    await waitUntil("runtime history lock", () => existsSync(`${databasePath}.history-refresher-lock`));
  } finally { await runtime.close(); }
  const hold = new HistoryHoldSession(databasePath);
  hold.close();
  if (holds === "abandoned") {
    const path = historyHoldPath(databasePath, hold.id);
    writeFileSync(path, "");
    writeFileSync(`${path}-journal`, "");
    writeFileSync(`${path}-wal`, "");
    writeFileSync(`${path}-shm`, "");
  }
  expect(readStoredSyncStatus(databasePath, WORKSPACE).pendingRooms).toEqual([]);
  expect(await ensureHostDiskCapacity({
    databaseDirectory: root, minFreeBytes: 100, excludedDirectories: new Set(), freeSpace: () => existsSync(directory) ? 0 : 100,
  })).toBe(true);
  expect(existsSync(directory)).toBe(false);
});

it("retains mirrors with unknown files or symlinks in history hold directories", async () => {
  const root = tempDir();
  const unknown = mirror(root, "unknown-hold", 1);
  const linked = mirror(root, "linked-hold", 2);
  const unknownHolds = join(unknown, `${WORKSPACE}.sqlite.history-holds`);
  const linkedHolds = join(linked, `${WORKSPACE}.sqlite.history-holds`);
  mkdirSync(unknownHolds);
  mkdirSync(linkedHolds);
  const unrelated = join(unknownHolds, "unrelated");
  writeFileSync(unrelated, "preserve");
  symlinkSync(unrelated, join(linkedHolds, `${WORKSPACE}.sqlite`));
  expect(await ensureHostDiskCapacity({
    databaseDirectory: root, minFreeBytes: 100, excludedDirectories: new Set(), freeSpace: () => 0,
  })).toBe(false);
  expect(existsSync(unrelated)).toBe(true);
  expect(existsSync(linked)).toBe(true);
});
