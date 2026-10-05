import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { settingsRoom, WORKSPACE_SETTINGS_KEY } from "@uberblick/schema";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MirrorStore, readWorkspaceName } from "../src/store.js";
import { WORKSPACE, removeTempDirs, tempDatabasePath, tempDir } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

describe("readWorkspaceName", () => {
  it("replays the settings snapshot and tail without changing the replica", () => {
    const databasePath = tempDatabasePath();
    const store = new MirrorStore(databasePath, WORKSPACE);
    const doc = new Y.Doc();
    const room = settingsRoom(WORKSPACE);
    try {
      const names = doc.getMap<unknown>(WORKSPACE_SETTINGS_KEY);
      names.set("name", "Before");
      const seq = store.appendUpdate(room, Y.encodeStateAsUpdate(doc), "remote");
      store.compact(room, Y.encodeStateAsUpdate(doc), seq);
      const vector = Y.encodeStateVector(doc);
      names.set("name", "  研究 notes  ");
      store.appendUpdate(room, Y.encodeStateAsUpdate(doc, vector), "remote");
      store.appendUpdate(settingsRoom("00000000-0000-4000-8000-000000000001"),
        Y.encodeStateAsUpdate(doc), "remote");
    } finally {
      doc.destroy();
      store.close();
    }

    const before = readFileSync(databasePath);
    expect(readWorkspaceName(databasePath, WORKSPACE)).toBe("研究 notes");
    expect(readFileSync(databasePath)).toEqual(before);
    expect(readWorkspaceName(databasePath, "00000000-0000-4000-8000-000000000002"))
      .toBeNull();
  });

  it.each(["", "unsafe\u001b[31m", "unsafe\u200b", 42, null])(
    "uses name validation for stored value %j", (name) => {
      const databasePath = tempDatabasePath();
      const store = new MirrorStore(databasePath, WORKSPACE);
      const doc = new Y.Doc();
      try {
        doc.getMap<unknown>(WORKSPACE_SETTINGS_KEY).set("name", name);
        store.appendUpdate(settingsRoom(WORKSPACE), Y.encodeStateAsUpdate(doc), "remote");
        expect(readWorkspaceName(databasePath, WORKSPACE)).toBeNull();
      } finally {
        doc.destroy();
        store.close();
      }
    },
  );

  it("keeps one log view while another connection compacts between reads", () => {
    const databasePath = tempDatabasePath();
    const writer = new MirrorStore(databasePath, WORKSPACE);
    const doc = new Y.Doc();
    const room = settingsRoom(WORKSPACE);
    let intercepted = false;
    try {
      doc.getMap<string>(WORKSPACE_SETTINGS_KEY).set("name", "Project notes");
      const state = Y.encodeStateAsUpdate(doc);
      const seq = writer.appendUpdate(room, state, "remote");
      expect(readWorkspaceName(databasePath, WORKSPACE)).toBe("Project notes");

      const originalPrepare = DatabaseSync.prototype.prepare;
      const preparing = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        const statement = originalPrepare.call(this, sql);
        if (sql === "SELECT state, through_seq FROM snapshots WHERE room = ?") {
          const originalGet = statement.get.bind(statement);
          vi.spyOn(statement, "get").mockImplementation((...parameters) => {
            const snapshot = originalGet(...parameters);
            if (!intercepted) {
              intercepted = true;
              writer.compact(room, state, seq);
            }
            return snapshot;
          });
        }
        return statement;
      });
      try {
        expect(readWorkspaceName(databasePath, WORKSPACE)).toBe("Project notes");
        expect(intercepted).toBe(true);
      } finally {
        preparing.mockRestore();
      }
      expect(readWorkspaceName(databasePath, WORKSPACE)).toBe("Project notes");
    } finally {
      doc.destroy();
      writer.close();
    }
  });

  it("returns null for a missing database without creating its parent", () => {
    const parent = join(tempDir(), "absent");
    expect(readWorkspaceName(join(parent, "replica.sqlite"), WORKSPACE)).toBeNull();
    expect(existsSync(parent)).toBe(false);
  });

  it.each(["empty", "older schema", "not SQLite", "invalid Yjs"])(
    "leaves an unreadable %s database unchanged", (kind) => {
      const databasePath = tempDatabasePath();
      if (kind === "empty" || kind === "not SQLite") {
        writeFileSync(databasePath, kind === "empty" ? "" : "not a database");
      } else {
        const db = new DatabaseSync(databasePath);
        try {
          db.exec("CREATE TABLE updates (seq INTEGER PRIMARY KEY, room TEXT, payload BLOB)");
          if (kind === "invalid Yjs") {
            db.exec("CREATE TABLE snapshots (room TEXT PRIMARY KEY, state BLOB, through_seq INTEGER)");
            db.prepare("INSERT INTO updates VALUES (1, ?, ?)")
              .run(settingsRoom(WORKSPACE), new Uint8Array([0xff]));
          }
        } finally {
          db.close();
        }
      }
      const before = readFileSync(databasePath);
      expect(readWorkspaceName(databasePath, WORKSPACE)).toBeNull();
      expect(readFileSync(databasePath)).toEqual(before);
    },
  );
});
