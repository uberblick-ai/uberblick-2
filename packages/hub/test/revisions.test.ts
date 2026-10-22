import { Document } from "@hocuspocus/server";
import {
  compareRevisions,
  deleteDirectoryEntry,
  directoryRoom,
  encodeOriginUpdate,
  getMeta,
  restoreDirectoryEntry,
  roomForDoc,
  settingsRoom,
  sidebarRoom,
  tombstoneDirectoryEntry,
  tombstoneDecisionRecord,
} from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HubDatabase } from "../src/persistence.js";
import { backupDatabase, restoreDatabase } from "../src/operator-database.js";
import { OriginUpdates, type UpdateAuthor } from "../src/update-attribution.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOPIC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROOM = roomForDoc(WORKSPACE, UUID);
const browser: UpdateAuthor = { principalId: "ben", surface: { kind: "browser", name: "browser" } };
const claude: UpdateAuthor = { principalId: "ben", surface: { kind: "mcp", name: "Claude Code" } };
const MINUTE = 60_000;
const documents: Y.Doc[] = [];
const databases: HubDatabase[] = [];
let clock = 0;

function database(enabled = true, failure: (error: unknown) => void = () => {}): HubDatabase {
  const created = new HubDatabase(":memory:", failure, { revisions: enabled, now: () => clock });
  created.open();
  databases.push(created);
  return created;
}

async function load(db: HubDatabase, room = ROOM): Promise<Document> {
  const document = new Document(room);
  documents.push(document);
  await db.onLoadDocument({ document, documentName: room });
  return document;
}

function title(doc: Y.Doc, value: string, author: UpdateAuthor | null = browser): void {
  doc.transact(() => doc.getMap("meta").set("title", value), { attribution: { author } });
}

function revision(db: HubDatabase, id: string, room = ROOM): Y.Doc {
  const result = new Y.Doc();
  documents.push(result);
  Y.applyUpdate(result, db.revisions.get(room, id)!);
  return result;
}

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
  for (const db of databases.splice(0)) db.close();
  removeTempDatabases();
  clock = 0;
});

describe("automatic hub revisions", () => {
  it("records exactly the three example stretches and freezes the preceding author's bytes", async () => {
    const db = database();
    const doc = await load(db);
    clock = 9 * 60 * MINUTE;
    title(doc, "Created");
    clock += 5 * MINUTE;
    title(doc, "Browser edit");
    const firstId = db.revisions.list(ROOM)[0]!.id;
    const firstBytes = db.revisions.get(ROOM, firstId);
    clock += MINUTE;
    title(doc, "Claude edit", claude);
    clock += 6 * MINUTE;
    title(doc, "Last Claude edit", claude);
    clock = (9 * 60 + 40) * MINUTE;
    title(doc, "Browser returns");

    expect(db.revisions.list(ROOM)).toEqual([
      { id: expect.any(String), author: browser, startedAt: (9 * 60 + 40) * MINUTE, endedAt: null },
      { id: expect.any(String), author: claude, startedAt: (9 * 60 + 6) * MINUTE, endedAt: (9 * 60 + 21) * MINUTE },
      { id: firstId, author: browser, startedAt: 9 * 60 * MINUTE, endedAt: (9 * 60 + 6) * MINUTE },
    ]);
    expect(db.revisions.get(ROOM, firstId)).toEqual(firstBytes);
    expect(getMeta(revision(db, firstId)).title).toBe("Browser edit");
    expect(compareRevisions(revision(db, db.revisions.list(ROOM)[0]!.id), doc).changed).toBe(false);
  });

  it("expires without a timer and excludes ignored changes from stretch boundaries", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "First");
    const id = db.revisions.list(ROOM)[0]!.id;
    const bytes = db.revisions.get(ROOM, id);
    clock = 2 * MINUTE;
    doc.transact(() => {
      const meta = doc.getMap("meta");
      meta.set("description", "Other author");
      meta.set("tldr", "Summary");
      meta.set("tag-assigned:tag", true);
      meta.set("code-check:repo", { result: "matches" });
      doc.getMap("annotations").set("thread", "A comment");
    }, { attribution: { author: claude } });
    expect(db.revisions.list(ROOM)).toEqual([{ id, author: browser, startedAt: 0, endedAt: null }]);
    expect(db.revisions.get(ROOM, id)).toEqual(bytes);
    clock = 15 * MINUTE;
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBe(15 * MINUTE);
    doc.transact(() => doc.getMap("meta").set("description", "After expiry"), { attribution: { author: claude } });
    expect(db.connection.prepare("SELECT ended_at FROM document_revisions WHERE room = ?").all(ROOM)).toEqual([]);
    expect(db.revisions.list(ROOM)).toEqual([{ id, author: browser, startedAt: 0, endedAt: 15 * MINUTE }]);
    title(doc, "Second");
    expect(db.revisions.list(ROOM)).toHaveLength(2);
    expect(db.revisions.get(ROOM, id)).toEqual(bytes);
  });

  it("preserves earlier content with unknown author and start before the first recorded edit", async () => {
    const db = database();
    const existing = new Y.Doc();
    documents.push(existing);
    title(existing, "Before revisions");
    db.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(ROOM, Y.encodeStateAsUpdate(existing));
    const doc = await load(db);
    expect(db.revisions.list(ROOM)).toEqual([]);
    clock = 50;
    title(doc, "Known editor");
    const rows = db.revisions.list(ROOM);
    expect(rows).toEqual([
      { id: expect.any(String), author: browser, startedAt: 50, endedAt: null },
      { id: expect.any(String), author: null, startedAt: null, endedAt: 50 },
    ]);
    expect(getMeta(revision(db, rows[1]!.id)).title).toBe("Before revisions");
  });

  it("keeps an equal stretch's start for later edits, including after reloading the room", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "X");
    clock = 100;
    title(doc, "Y", claude);
    clock = 200;
    title(doc, "X", claude);
    expect(db.revisions.list(ROOM)).toHaveLength(1);
    expect(db.connection.prepare("SELECT data FROM document_revision_heads WHERE room = ?").get(ROOM)!.data).toBeNull();
    db.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(ROOM, Y.encodeStateAsUpdate(doc));
    const reloaded = await load(db);
    clock = 300;
    title(reloaded, "Z", claude);
    expect(db.revisions.list(ROOM)).toEqual([
      { id: expect.any(String), author: claude, startedAt: 100, endedAt: null },
      { id: expect.any(String), author: browser, startedAt: 0, endedAt: 100 },
    ]);
  });

  it("groups unknown authors together and bounds surface labels without merging their identities", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "Unknown one", null);
    clock = 1;
    title(doc, "Unknown two", null);
    expect(db.revisions.list(ROOM)).toHaveLength(1);
    const long = "🦊".repeat(300);
    clock = 2;
    title(doc, "Long one", { ...browser, surface: { kind: "mcp", name: `${long}A` } });
    clock = 3;
    title(doc, "Long two", { ...browser, surface: { kind: "mcp", name: `${long}B` } });
    const rows = db.revisions.list(ROOM);
    expect(rows).toHaveLength(3);
    expect([...rows[0]!.author!.surface.name]).toHaveLength(256);
    expect(rows[0]!.author!.surface.name.endsWith("…")).toBe(true);
    expect(rows[2]!.author).toBeNull();
  });

  it("closes for archive and restore through a decision topic and an individual record", async () => {
    const db = database();
    const doc = await load(db);
    const directory = await load(db, directoryRoom(WORKSPACE));
    directory.getMap("docs").set(TOPIC, { title: "Topic", tags: [], kind: "decision", topic: TOPIC, status: "open" });
    directory.getMap("docs").set(UUID, { title: "Record", tags: [], kind: "decision", topic: TOPIC, status: "rejected" });
    title(doc, "One");
    clock = 10;
    tombstoneDirectoryEntry(directory, TOPIC);
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBe(10);
    clock = 20;
    restoreDirectoryEntry(directory, TOPIC);
    title(doc, "Two");
    clock = 30;
    expect(tombstoneDecisionRecord(directory, UUID)).toBe(true);
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBe(30);
    clock = 40;
    restoreDirectoryEntry(directory, UUID);
    title(doc, "Three");
    expect(db.revisions.list(ROOM)).toHaveLength(3);
    expect(db.revisions.list(ROOM)[0]!.startedAt).toBe(40);
  });

  it("purges history atomically with deletion, rolls back failure, and fences subsequent updates", async () => {
    const failures: unknown[] = [];
    const db = database(true, error => failures.push(error));
    const doc = await load(db);
    const directory = await load(db, directoryRoom(WORKSPACE));
    title(doc, "Stored");
    db.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(ROOM, Y.encodeStateAsUpdate(doc));
    tombstoneDirectoryEntry(directory, UUID);
    db.connection.exec(`CREATE TRIGGER fail_revision_purge BEFORE DELETE ON document_revisions
      BEGIN SELECT RAISE(ABORT, 'purge failed'); END`);
    expect(() => deleteDirectoryEntry(directory, UUID)).toThrow("purge failed");
    expect(db.connection.prepare("SELECT name FROM documents WHERE name = ?").get(ROOM)).toBeDefined();
    expect(db.revisions.list(ROOM)).toHaveLength(1);
    expect(failures).toHaveLength(1);
    db.connection.exec("DROP TRIGGER fail_revision_purge");
    directory.getMap("docs").set(TOPIC, { title: "Retry", tags: [] });
    expect(db.revisions.list(ROOM)).toEqual([]);
    expect(db.connection.prepare("SELECT name FROM documents WHERE name = ?").get(ROOM)).toBeUndefined();
    title(doc, "Must not return");
    await db.onStoreDocument({ document: doc, documentName: ROOM });
    expect(db.revisions.list(ROOM)).toEqual([]);
    expect(db.connection.prepare("SELECT name FROM documents WHERE name = ?").get(ROOM)).toBeUndefined();
  });

  it("records neither local revisions nor workspace system rooms", async () => {
    const local = database(false);
    title(await load(local), "Local");
    expect(local.revisions.list(ROOM)).toEqual([]);
    const team = database();
    for (const room of [directoryRoom(WORKSPACE), settingsRoom(WORKSPACE), sidebarRoom(WORKSPACE)]) {
      title(await load(team, room), "System metadata");
      expect(team.revisions.list(room)).toEqual([]);
    }
  });

  it("never assigns a failed capture's combined changes to the next author", async () => {
    const failures: unknown[] = [];
    const db = database(true, error => failures.push(error));
    const doc = await load(db);
    title(doc, "One");
    db.connection.exec(`CREATE TRIGGER fail_head_update BEFORE UPDATE ON document_revision_heads
      BEGIN SELECT RAISE(ABORT, 'capture failed'); END`);
    expect(() => title(doc, "Unrecorded edit")).toThrow("capture failed");
    db.connection.exec("DROP TRIGGER fail_head_update");
    title(doc, "Another author's edit", claude);
    expect(failures).toHaveLength(1);
    const rows = db.revisions.list(ROOM);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.author).toBeNull();
    expect(getMeta(revision(db, rows[0]!.id)).title).toBe("Another author's edit");
    expect(getMeta(revision(db, rows[1]!.id)).title).toBe("One");
  });

  it("records integrated out-of-order changes from several authors as unknown", async () => {
    const db = database();
    const hub = await load(db);
    const base = new Y.Doc();
    const fork = new Y.Doc();
    documents.push(base, fork);
    title(base, "Browser's original title");
    const predecessor = Y.encodeStateAsUpdate(base);
    Y.applyUpdate(fork, predecessor);
    const before = Y.encodeStateVector(fork);
    title(fork, "Claude's edited title", claude);
    const successor = Y.encodeStateAsUpdate(fork, before);
    const extension = new OriginUpdates({
      requireMetadata: true,
      assertCurrent() {},
      resolveAuthor(context, origin) {
        return origin?.surface === null || origin?.surface === undefined ? null : {
          principalId: context.principalId, surface: origin.surface,
        };
      },
    });
    const connection = {
      context: { principalId: "ben", credentialId: "credential", deviceId: "computer" },
      readOnly: false,
      sendStateless() {},
    };
    const deliver = async (update: Uint8Array, id: string, author: UpdateAuthor): Promise<void> => {
      await extension.onStateless({
        connection, document: hub, documentName: ROOM,
        payload: encodeOriginUpdate(id, update, { updateId: id, credentialId: "credential", surface: author.surface }),
      } as unknown as Parameters<OriginUpdates["onStateless"]>[0]);
    };

    await deliver(successor, "successor-first", claude);
    expect(getMeta(hub).title).toBe("");
    expect(db.revisions.list(ROOM)).toEqual([]);
    await deliver(predecessor, "predecessor-later", browser);
    const rows = db.revisions.list(ROOM);
    expect(rows).toEqual([{ id: expect.any(String), author: null, startedAt: 0, endedAt: null }]);
    expect(getMeta(hub).title).toBe("Claude's edited title");
    expect(getMeta(revision(db, rows[0]!.id)).title).toBe("Claude's edited title");
  });

  it("carries closed revisions, open heads and document state through backup and restore", async () => {
    const databasePath = tempDatabasePath();
    const db = new HubDatabase(databasePath, () => {}, { revisions: true, now: () => clock });
    db.open();
    databases.push(db);
    const doc = await load(db);
    title(doc, "First");
    clock = 100;
    title(doc, "Second", claude);
    await db.onStoreDocument({ document: doc, documentName: ROOM });
    const expected = db.revisions.list(ROOM);
    const bytes = expected.map(row => db.revisions.get(ROOM, row.id));
    const loop = setInterval(() => {}, 10);
    try {
      const backup = await backupDatabase(db.connection, databasePath);
      clock = 200;
      title(doc, "After backup");
      await db.onStoreDocument({ document: doc, documentName: ROOM });
      db.close();
      await restoreDatabase(databasePath, backup, { yes: true, writeLine: () => {} });
      const restored = new HubDatabase(databasePath, () => {}, { revisions: true, now: () => clock });
      restored.open();
      databases.push(restored);
      expect(restored.revisions.list(ROOM)).toEqual(expected);
      expect(expected.map(row => restored.revisions.get(ROOM, row.id))).toEqual(bytes);
      expect(getMeta(await load(restored)).title).toBe("Second");
    } finally {
      clearInterval(loop);
    }
  });
});
