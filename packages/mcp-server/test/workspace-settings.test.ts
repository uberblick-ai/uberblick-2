import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  getWorkspaceMainRepository,
  getWorkspaceName,
  setWorkspaceMainRepository,
  setWorkspaceName,
  settingsRoom,
  WORKSPACE_SETTINGS_KEY,
} from "@uberblick/schema";
import * as Y from "yjs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PersistenceError } from "../src/replica.js";
import { syncWorkspace } from "../src/remote.js";
import { MirrorStore } from "../src/store.js";
import { fillWorkspaceMainRepository, storeWorkspaceName } from "../src/workspace-settings.js";
import { removeTempDirs, tempDatabasePath, tempDir, testConfig, WORKSPACE } from "./helpers.js";

afterAll(removeTempDirs);

it("reports a refused settings append and leaves the durable name unchanged", () => {
  const config = testConfig({ databasePath: tempDatabasePath() });
  storeWorkspaceName(config, "Before");
  const db = new DatabaseSync(config.databasePath);
  const doc = new Y.Doc();
  try {
    db.exec(`
      CREATE TRIGGER refuse_settings BEFORE INSERT ON updates
      WHEN NEW.room LIKE '%/_settings'
      BEGIN SELECT RAISE(ABORT, 'settings log refused'); END;
    `);
    expect(() => storeWorkspaceName(config, "After")).toThrow(PersistenceError);
    const room = settingsRoom(config.workspaceId);
    for (const row of db.prepare("SELECT payload FROM updates WHERE room = ? ORDER BY seq").all(room)) {
      Y.applyUpdate(doc, new Uint8Array(row.payload as Uint8Array));
    }
    expect(getWorkspaceName(doc)).toBe("Before");
    expect(db.prepare("SELECT DISTINCT room FROM updates").all()).toEqual([{ room }]);
  } finally {
    doc.destroy();
    db.close();
  }
});

function readSettings(db: DatabaseSync): Y.Doc {
  const doc = new Y.Doc();
  const room = settingsRoom(WORKSPACE);
  const snapshot = db.prepare("SELECT state, through_seq FROM snapshots WHERE room = ?").get(room);
  if (snapshot !== undefined) Y.applyUpdate(doc, snapshot.state as Uint8Array);
  for (const update of db.prepare(
    "SELECT payload FROM updates WHERE room = ? AND seq > ? ORDER BY seq",
  ).all(room, snapshot?.through_seq ?? 0)) {
    Y.applyUpdate(doc, update.payload as Uint8Array);
  }
  return doc;
}

describe("fillWorkspaceMainRepository", () => {
  it("uses the UUID file and claim for a decorated workspace id", () => {
    const dataRoot = tempDir();
    const databasePath = join(dataRoot, "uberblick", `${WORKSPACE}.sqlite`);
    storeWorkspaceName(testConfig({ databasePath }), "Notes");
    vi.stubEnv("XDG_DATA_HOME", dataRoot);
    try {
      fillWorkspaceMainRepository(`notes-${WORKSPACE}`, "acme/notes");
    } finally {
      vi.unstubAllEnvs();
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const settings = readSettings(db);
    try {
      expect(getWorkspaceMainRepository(settings)).toBe("acme/notes");
      expect(existsSync(join(dataRoot, "uberblick", `notes-${WORKSPACE}.sqlite`))).toBe(false);
    } finally {
      settings.destroy();
      db.close();
    }
  });

  it("replays the snapshot and tail, changes only the repository, and logs pending local work", () => {
    const databasePath = tempDatabasePath();
    const store = new MirrorStore(databasePath, WORKSPACE);
    const source = new Y.Doc();
    const room = settingsRoom(WORKSPACE);
    setWorkspaceName(source, "Before");
    const snapshot = Y.encodeStateAsUpdate(source);
    const seq = store.appendUpdate(room, snapshot, "remote");
    store.compact(room, snapshot, seq);
    const vector = Y.encodeStateVector(source);
    setWorkspaceName(source, "After");
    source.getMap(WORKSPACE_SETTINGS_KEY).set("mainRepository", 42);
    store.appendUpdate(room, Y.encodeStateAsUpdate(source, vector), "remote");
    const documentRoom = `${WORKSPACE}/a-note`;
    const documentSeq = store.appendUpdate(documentRoom, snapshot, "local");
    store.close();

    fillWorkspaceMainRepository(WORKSPACE, "https://github.com/Acme/notes.git/", databasePath);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const settings = readSettings(db);
    try {
      expect(getWorkspaceName(settings)).toBe("After");
      expect(getWorkspaceMainRepository(settings)).toBe("Acme/notes");
      expect(settings.getMap(WORKSPACE_SETTINGS_KEY).toJSON()).toEqual({ name: "After", mainRepository: "Acme/notes" });
      expect(db.prepare("SELECT state FROM snapshots WHERE room = ?").get(room)?.state).toEqual(snapshot);
      expect(db.prepare("SELECT payload FROM updates WHERE room = ?").get(documentRoom)?.payload).toEqual(snapshot);
      const appended = db.prepare("SELECT seq, origin FROM updates WHERE room = ? ORDER BY seq DESC LIMIT 1").get(room);
      expect(appended?.origin).toBe("local");
      expect(db.prepare("SELECT room, seq FROM pending_rooms ORDER BY room").all()).toEqual([
        { room, seq: appended?.seq },
        { room: documentRoom, seq: documentSeq },
      ]);
    } finally {
      settings.destroy();
      source.destroy();
      db.close();
    }
  });

  it("keeps an existing repository and writes nothing for repeated or invalid fills", () => {
    const databasePath = tempDatabasePath();
    storeWorkspaceName(testConfig({ databasePath }), "Notes");
    fillWorkspaceMainRepository(WORKSPACE, "acme/notes", databasePath);
    const before = readFileSync(databasePath);
    fillWorkspaceMainRepository(WORKSPACE, "other/notes", databasePath);
    fillWorkspaceMainRepository(WORKSPACE, "invalid", databasePath);
    expect(readFileSync(databasePath)).toEqual(before);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const settings = readSettings(db);
    try {
      expect(getWorkspaceMainRepository(settings)).toBe("acme/notes");
    } finally {
      settings.destroy();
      db.close();
    }
  });

  it("keeps a repository from a compacted snapshot when later settings updates exist", () => {
    const databasePath = tempDatabasePath();
    const store = new MirrorStore(databasePath, WORKSPACE);
    const settings = new Y.Doc();
    try {
      setWorkspaceMainRepository(settings, "acme/notes");
      const room = settingsRoom(WORKSPACE);
      const snapshot = Y.encodeStateAsUpdate(settings);
      const seq = store.appendUpdate(room, snapshot, "remote");
      store.compact(room, snapshot, seq);
      const vector = Y.encodeStateVector(settings);
      setWorkspaceName(settings, "After snapshot");
      store.appendUpdate(room, Y.encodeStateAsUpdate(settings, vector), "remote");
    } finally {
      settings.destroy();
      store.close();
    }
    const before = readFileSync(databasePath);
    fillWorkspaceMainRepository(WORKSPACE, "other/notes", databasePath);
    expect(readFileSync(databasePath)).toEqual(before);
  });

  it("does not create an absent file or repair a malformed or unclaimed database", () => {
    const missing = tempDatabasePath();
    expect(() => fillWorkspaceMainRepository(WORKSPACE, "acme/notes", missing)).not.toThrow();
    expect(existsSync(missing)).toBe(false);
    const malformed = tempDatabasePath();
    writeFileSync(malformed, "not a SQLite database");
    const unclaimed = tempDatabasePath();
    new DatabaseSync(unclaimed).close();
    for (const databasePath of [malformed, unclaimed]) {
      const before = readFileSync(databasePath);
      expect(() => fillWorkspaceMainRepository(WORKSPACE, "acme/notes", databasePath)).not.toThrow();
      expect(readFileSync(databasePath)).toEqual(before);
    }
  });

  it.each(["foreign", "corrupt-settings", "locked", "refused-append", "refused-pending"])(
    "leaves the existing replica untouched on %s failure", (failure) => {
      const databasePath = tempDatabasePath();
      storeWorkspaceName(testConfig({ databasePath }), "Notes");
      const db = new DatabaseSync(databasePath);
      try {
        if (failure === "foreign") db.prepare("UPDATE meta SET value = 'another-workspace' WHERE key = 'workspace'").run();
        if (failure === "corrupt-settings") db.prepare("UPDATE updates SET payload = ?").run(new Uint8Array([255]));
        if (failure === "refused-append") db.exec(
          "CREATE TRIGGER refuse_append BEFORE INSERT ON updates BEGIN SELECT RAISE(ABORT, 'refused'); END",
        );
        if (failure === "refused-pending") db.exec(
          "CREATE TRIGGER refuse_pending BEFORE INSERT ON pending_rooms BEGIN SELECT RAISE(ABORT, 'refused'); END",
        );
        if (failure === "locked") db.exec("BEGIN IMMEDIATE");
        const before = db.prepare("SELECT * FROM updates").all();
        const schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
        const pending = db.prepare("SELECT * FROM pending_rooms").all();
        expect(() => fillWorkspaceMainRepository(WORKSPACE, "acme/notes", databasePath)).not.toThrow();
        expect(db.prepare("SELECT * FROM updates").all()).toEqual(before);
        expect(db.prepare("SELECT * FROM pending_rooms").all()).toEqual(pending);
        expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
      } finally {
        if (db.isTransaction) db.exec("ROLLBACK");
        db.close();
      }
    },
  );
});

it("includes the main repository in workspace bridge fingerprints alongside the name", async () => {
  const config = testConfig();
  storeWorkspaceName(config, "Notes");
  const before = await syncWorkspace(config);
  fillWorkspaceMainRepository(WORKSPACE, "acme/notes", config.databasePath);
  const filled = await syncWorkspace(config);
  expect(filled.workspace?.find(entry => entry.uuid === "_settings")?.fingerprint)
    .not.toBe(before.workspace?.find(entry => entry.uuid === "_settings")?.fingerprint);
  const store = new MirrorStore(config.databasePath, WORKSPACE);
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  const settings = readSettings(db);
  try {
    const vector = Y.encodeStateVector(settings);
    setWorkspaceMainRepository(settings, "");
    store.appendUpdate(settingsRoom(WORKSPACE), Y.encodeStateAsUpdate(settings, vector), "local");
  } finally {
    settings.destroy();
    db.close();
    store.close();
  }
  const cleared = await syncWorkspace(config);
  expect(cleared.workspace?.find(entry => entry.uuid === "_settings")?.fingerprint)
    .toBe(before.workspace?.find(entry => entry.uuid === "_settings")?.fingerprint);
});
