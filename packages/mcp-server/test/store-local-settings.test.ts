import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseHistoryRetention, type HistoryRetention } from "../src/local-settings.js";
import { MirrorStore } from "../src/store.js";
import { WORKSPACE, removeTempDirs, tempDatabasePath } from "./shared.js";

const stores: MirrorStore[] = [];
function open(path: string): MirrorStore {
  const store = new MirrorStore(path, WORKSPACE);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  removeTempDirs();
});

describe("machine-local history retention", () => {
  it("reads every peer's committed choice immediately and keeps it across restart without collaborative writes", () => {
    const path = tempDatabasePath();
    const browser = open(path);
    const firstMcp = open(path);
    const secondMcp = open(path);
    expect(browser.readHistoryRetention()).toEqual({ mode: "recent", days: 30, keepNamed: true });
    const choices: HistoryRetention[] = [
      { mode: "named" },
      { mode: "recent", days: 7, keepNamed: false },
      { mode: "recent", days: 90, keepNamed: true },
      { mode: "everything" },
    ];
    for (const choice of choices) {
      browser.setHistoryRetention(choice);
      expect(firstMcp.readHistoryRetention()).toEqual(choice);
      expect(secondMcp.readHistoryRetention()).toEqual(choice);
      expect(browser.logSize()).toBe(0);
      expect(browser.pendingRooms()).toEqual([]);
    }
    firstMcp.setHistoryRetention({ mode: "recent", days: 30, keepNamed: false });
    expect(browser.readHistoryRetention()).toEqual({ mode: "recent", days: 30, keepNamed: false });
    browser.close();
    firstMcp.close();
    secondMcp.close();
    expect(open(path).readHistoryRetention()).toEqual({ mode: "recent", days: 30, keepNamed: false });
  });

  it("keeps the choice when document storage is purged and rejects corrupt policy rather than replacing it", () => {
    const path = tempDatabasePath();
    const store = open(path);
    store.setHistoryRetention({ mode: "everything" });
    const room = `${WORKSPACE}/deleted`;
    store.appendUpdate(room, new Uint8Array([1, 2, 3]), "remote");
    store.purgeDoc(room, "deleted");
    expect(store.readHistoryRetention()).toEqual({ mode: "everything" });
    const database = new DatabaseSync(path);
    try {
      database.prepare("UPDATE meta SET value = ? WHERE key = 'history_retention'").run('{"mode":"recent","days":1,"keepNamed":false}');
      expect(() => store.readHistoryRetention()).toThrow("Invalid stored history retention");
    } finally { database.close(); }
  });

  it.each([
    null, {}, { mode: "all" }, { mode: "named", days: 30 }, { mode: "everything", keepNamed: true },
    { mode: "recent", days: 1, keepNamed: true }, { mode: "recent", days: 30 },
    { mode: "recent", days: 30, keepNamed: "true" }, { mode: "recent", days: 30, keepNamed: true, other: 1 },
  ])("refuses an unsupported retention value %j", value => {
    expect(parseHistoryRetention(value)).toBeNull();
  });
});

describe("workspace size", () => {
  it("includes WAL bytes and reports freed pages after permanent removal without shrinking the file", () => {
    const path = tempDatabasePath();
    const store = open(path);
    const room = `${WORKSPACE}/deleted`;
    store.appendUpdate(room, new Uint8Array(2 * 1024 * 1024), "remote");
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA wal_checkpoint(PASSIVE)");
      const fileBytes = statSync(path).size;
      const walBytes = statSync(`${path}-wal`).size;
      expect(walBytes).toBeGreaterThan(0);
      const before = store.workspaceSize()!;
      expect(before.bytes).toBe(fileBytes + walBytes);
      expect(before.usedFraction).toBeGreaterThan(0.9);
      store.purgeDoc(room, "deleted");
      const after = store.workspaceSize()!;
      expect(after.usedFraction).toBeLessThan(before.usedFraction / 2);
      expect(statSync(path).size).toBe(fileBytes);
    } finally { database.close(); }
  });

  it("has no file size for an in-memory store", () => {
    expect(open(":memory:").workspaceSize()).toBeNull();
  });
});
