import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Document } from "@hocuspocus/server";
import {
  deleteDirectoryEntry,
  directoryRoom,
  isDirectoryEntryDeleted,
  parseRoom,
  settingsRoom,
  sidebarRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { purgeDetachedDocumentCopies } from "../src/index.js";
import { HubDatabase } from "../src/persistence.js";
import { OTHER_WORKSPACE, removeTempDatabases, tempDatabasePath, testRoom, WORKSPACE } from "./helpers.js";

afterEach(removeTempDatabases);

function document(text: string): Document {
  const doc = new Document(testRoom());
  doc.getText("body").insert(0, text);
  return doc;
}

function storedRows(path: string): Record<string, unknown>[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("SELECT rowid, name, data FROM documents ORDER BY rowid").all();
  } finally { database.close(); }
}

function revisionRows(path: string): Record<string, unknown>[][] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return ["document_revision_names", "document_revisions", "document_revision_heads", "document_revision_documents"]
      .map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  } finally { database.close(); }
}

function seedRevisions(path: string, rooms: readonly string[]): void {
  const database = new DatabaseSync(path);
  try {
    for (const room of rooms) {
      database.prepare("INSERT INTO document_revisions (id, room, author, started_at, ended_at, checksum, data) VALUES (?, ?, NULL, NULL, 1, 'checksum', ?)")
        .run(`revision-${room}`, room, new Uint8Array([1, 2]));
      database.prepare("INSERT INTO document_revision_heads (room, id, author, author_key, started_at, checksum, previous_checksum, data) VALUES (?, ?, NULL, 'unknown', 1, 'checksum', 'before', ?)")
        .run(room, `head-${room}`, new Uint8Array([3, 4]));
      database.prepare("INSERT INTO document_revision_documents (room) VALUES (?)").run(room);
      database.prepare("INSERT INTO document_revision_names (revision_id, room, text, principal_id, surface, named_at) VALUES (?, ?, 'Name', 'person', 'surface', 1)")
        .run(`revision-${room}`, room);
    }
  } finally { database.close(); }
}

describe("offline document-copy purge", () => {
  it("removes only marked workspace documents and their revisions, then accepts their permanent marks", async () => {
    const path = tempDatabasePath();
    const deletedRoom = testRoom();
    const deletedUuid = parseRoom(deletedRoom).uuid;
    const survivorRoom = testRoom();
    const survivorUuid = parseRoom(survivorRoom).uuid;
    const otherRoom = `${OTHER_WORKSPACE}/${deletedUuid}`;
    const directory = new Document(directoryRoom(WORKSPACE));
    upsertDirectoryEntry(directory, { uuid: deletedUuid, title: "Deleted on the remote hub" });
    upsertDirectoryEntry(directory, { uuid: survivorUuid, title: "Only in this hub" });
    const replicaDirectory = new Y.Doc();
    Y.applyUpdate(replicaDirectory, Y.encodeStateAsUpdate(directory));
    tombstoneDirectoryEntry(replicaDirectory, deletedUuid);
    deleteDirectoryEntry(replicaDirectory, deletedUuid);
    const held = new Map([
      [directoryRoom(WORKSPACE), directory],
      [deletedRoom, document("Old live copy")],
      [survivorRoom, document("A hub-only edit")],
      [otherRoom, document("The other workspace keeps this UUID")],
      [settingsRoom(WORKSPACE), document("Workspace settings")],
      [sidebarRoom(WORKSPACE), document("Workspace sidebar")],
    ]);
    const initial = new HubDatabase(path, error => { throw error; });
    initial.open();
    try {
      for (const [documentName, doc] of held) await initial.onStoreDocument({ documentName, document: doc });
    } finally { initial.close(); }
    seedRevisions(path, [deletedRoom, survivorRoom, otherRoom]);
    const before = storedRows(path);
    const historyBefore = revisionRows(path);

    try {
      purgeDetachedDocumentCopies(path, WORKSPACE, [deletedUuid]);
      expect(storedRows(path)).toEqual(before.filter(row => row.name !== deletedRoom));
      expect(revisionRows(path)).toEqual(historyBefore.map(rows => rows.filter(row => row.room !== deletedRoom)));

      const reopened = new HubDatabase(path, error => { throw error; });
      const hubDirectory = new Document(directoryRoom(WORKSPACE));
      const survivor = new Document(survivorRoom);
      reopened.open();
      try {
        await reopened.onLoadDocument({ documentName: directoryRoom(WORKSPACE), document: hubDirectory });
        Y.applyUpdate(hubDirectory, Y.encodeStateAsUpdate(replicaDirectory, Y.encodeStateVector(hubDirectory)));
        expect(isDirectoryEntryDeleted(hubDirectory, deletedUuid)).toBe(true);
        expect(reopened.isDeletedRoom(deletedRoom)).toBe(true);
        expect(() => reopened.requireRoom(deletedRoom)).toThrow();
        await reopened.onLoadDocument({ documentName: survivorRoom, document: survivor });
        expect(survivor.getText("body").toString()).toBe("A hub-only edit");
      } finally {
        reopened.close();
        hubDirectory.destroy();
        survivor.destroy();
      }
    } finally {
      for (const doc of held.values()) doc.destroy();
      replicaDirectory.destroy();
    }
  });

  it("rolls every room and revision deletion back if a storage operation fails", async () => {
    const path = tempDatabasePath();
    const room = testRoom();
    const uuid = parseRoom(room).uuid;
    const original = document("Retained on failure");
    const initial = new HubDatabase(path, error => { throw error; });
    initial.open();
    try {
      await initial.onStoreDocument({ documentName: room, document: original });
    } finally {
      initial.close();
      original.destroy();
    }
    seedRevisions(path, [room]);
    const before = storedRows(path);
    const historyBefore = revisionRows(path);
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON document_revision_heads BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END");
    } finally { database.close(); }

    expect(() => purgeDetachedDocumentCopies(path, WORKSPACE, [uuid])).toThrow("injected purge failure");
    expect(storedRows(path)).toEqual(before);
    expect(revisionRows(path)).toEqual(historyBefore);
  });

  it("handles a legacy documents-only database without adding or changing its schema", () => {
    const path = tempDatabasePath();
    const room = testRoom();
    const retainedRoom = testRoom();
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE documents (name TEXT UNIQUE NOT NULL, data BLOB NOT NULL)");
      database.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(room, new Uint8Array([1]));
      database.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(retainedRoom, new Uint8Array([2]));
    } finally { database.close(); }
    const before = storedRows(path);

    purgeDetachedDocumentCopies(path, WORKSPACE, [parseRoom(room).uuid]);

    expect(storedRows(path)).toEqual(before.filter(row => row.name !== room));
    const read = new DatabaseSync(path, { readOnly: true });
    try {
      expect(read.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([{ name: "documents" }]);
    } finally { read.close(); }
  });

  it("creates no database when absent and refuses reserved roots before touching storage", () => {
    const path = tempDatabasePath();
    purgeDetachedDocumentCopies(path, WORKSPACE, [parseRoom(testRoom()).uuid]);
    expect(existsSync(path)).toBe(false);
    expect(() => purgeDetachedDocumentCopies(path, WORKSPACE, ["_directory"])).toThrow(/document UUIDs/);
    expect(existsSync(path)).toBe(false);
  });
});
