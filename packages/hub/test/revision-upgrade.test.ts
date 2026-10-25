import { Document } from "@hocuspocus/server";
import { getMeta, roomForDoc } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { backupDatabase, restoreDatabase } from "../src/operator-database.js";
import { HubDatabase } from "../src/persistence.js";
import type { UpdateAuthor } from "../src/update-attribution.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

const ROOM = roomForDoc("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const AUTHOR: UpdateAuthor = { principalId: "ben", surface: { kind: "browser", name: "browser" } };
const MINUTE = 60_000;
const documents: Document[] = [];
const databases: HubDatabase[] = [];
let clock = 0;

function open(path: string): HubDatabase {
  const db = new HubDatabase(path, error => { throw error; }, { revisions: true, now: () => clock });
  db.open();
  databases.push(db);
  return db;
}

async function load(db: HubDatabase): Promise<Document> {
  const doc = new Document(ROOM);
  documents.push(doc);
  await db.onLoadDocument({ document: doc, documentName: ROOM });
  return doc;
}

function title(doc: Y.Doc, value: string): void {
  doc.transact(() => doc.getMap("meta").set("title", value), { attribution: { author: AUTHOR } });
}

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
  for (const db of databases.splice(0)) db.close();
  removeTempDatabases();
  clock = 0;
});

describe("revision head upgrades", () => {
  it("preserves closed history and expired legacy heads through startup, materialization and an old backup restore", async () => {
    const path = tempDatabasePath();
    const original = open(path);
    const doc = await load(original);
    title(doc, "Closed state");
    clock = MINUTE;
    expect(original.revisions.name(ROOM, doc, original.revisions.list(ROOM)[0]!.checksum, "Named", AUTHOR).ok).toBe(true);
    const closed = original.revisions.list(ROOM)[0]!;
    clock = 2 * MINUTE;
    title(doc, "Legacy head");
    clock = 3 * MINUTE;
    title(doc, "Last legacy edit");
    await original.onStoreDocument({ document: doc, documentName: ROOM });
    const head = original.revisions.list(ROOM)[0]!;
    const snapshots = [head, closed].map(row => original.revisions.getSnapshot(ROOM, row.id));
    const names = original.revisions.names(ROOM);
    const closedRows = original.connection.prepare("SELECT * FROM document_revisions").all();
    original.connection.exec("ALTER TABLE document_revision_heads DROP COLUMN last_edited_at");
    expect(original.connection.prepare("PRAGMA table_info(document_revision_heads)").all()
      .some(column => column.name === "last_edited_at")).toBe(false);
    const headRow = original.connection.prepare("SELECT * FROM document_revision_heads WHERE room = ?").get(ROOM);
    const loop = setInterval(() => {}, 10);
    try {
      const backup = await backupDatabase(original.connection, path);
      original.close();
      clock = 20 * MINUTE;
      const expected = [{ ...head, endedAt: 17 * MINUTE, final: true }, closed];
      delete expected[0]!.deadlineAt;
      const upgraded = open(path);
      expect(upgraded.connection.prepare("PRAGMA table_info(document_revision_heads)").all()
        .find(column => column.name === "last_edited_at"))
        .toMatchObject({ type: "INTEGER", notnull: 0, dflt_value: null });
      expect(upgraded.connection.prepare("SELECT * FROM document_revision_heads WHERE room = ?").get(ROOM))
        .toEqual({ ...headRow, last_edited_at: null });
      expect(upgraded.connection.prepare("SELECT * FROM document_revisions").all()).toEqual(closedRows);
      expect(upgraded.revisions.list(ROOM)).toEqual(expected);
      expect(expected.map(row => upgraded.revisions.getSnapshot(ROOM, row.id))).toEqual(snapshots);
      expect(upgraded.revisions.names(ROOM)).toEqual(names);
      upgraded.close();

      const reopened = open(path);
      expect(reopened.revisions.list(ROOM)).toEqual(expected);
      expect(reopened.connection.prepare("SELECT last_edited_at FROM document_revision_heads WHERE room = ?").get(ROOM))
        .toEqual({ last_edited_at: null });
      const loaded = await load(reopened);
      expect(getMeta(loaded).title).toBe("Last legacy edit");
      expect(reopened.revisions.name(ROOM, loaded, head.checksum, "Materialized later", AUTHOR))
        .toEqual({ ok: true, id: head.id });
      expect(reopened.revisions.list(ROOM)).toEqual(expected);
      expect(reopened.connection.prepare("SELECT room FROM document_revision_heads WHERE room = ?").get(ROOM)).toBeUndefined();
      expect(reopened.connection.prepare("SELECT ended_at FROM document_revisions WHERE id = ?").get(head.id))
        .toEqual({ ended_at: 17 * MINUTE });
      reopened.close();

      await restoreDatabase(path, backup, { yes: true, writeLine() {} });
      const restored = open(path);
      expect(restored.revisions.list(ROOM)).toEqual(expected);
      expect(restored.revisions.names(ROOM)).toEqual(names);
      expect(expected.map(row => restored.revisions.getSnapshot(ROOM, row.id))).toEqual(snapshots);
      expect(restored.connection.prepare("SELECT last_edited_at FROM document_revision_heads WHERE room = ?").get(ROOM))
        .toEqual({ last_edited_at: null });
      expect(getMeta(await load(restored)).title).toBe("Last legacy edit");
    } finally {
      clearInterval(loop);
    }
  });

  it("extends an unexpired legacy head from its next edit without losing the edits it contains", async () => {
    const path = tempDatabasePath();
    const original = open(path);
    const doc = await load(original);
    title(doc, "Started before upgrade");
    clock = 10 * MINUTE;
    title(doc, "Edited before upgrade");
    const id = original.revisions.list(ROOM)[0]!.id;
    await original.onStoreDocument({ document: doc, documentName: ROOM });
    original.connection.exec("ALTER TABLE document_revision_heads DROP COLUMN last_edited_at");
    original.close();

    clock = 12 * MINUTE;
    const upgraded = open(path);
    expect(upgraded.revisions.list(ROOM)[0]).toMatchObject({ id, startedAt: 0, endedAt: null, deadlineAt: 15 * MINUTE });
    const loaded = await load(upgraded);
    title(loaded, "First edit after upgrade");
    clock = 20 * MINUTE;
    title(loaded, "Continued after the old deadline");
    expect(upgraded.revisions.list(ROOM)).toEqual([{
      id, author: AUTHOR, startedAt: 0, endedAt: null, checksum: upgraded.revisions.list(ROOM)[0]!.checksum,
      final: false, deadlineAt: 35 * MINUTE,
    }]);
    await upgraded.onStoreDocument({ document: loaded, documentName: ROOM });
    upgraded.close();

    clock = 35 * MINUTE;
    const reopened = open(path);
    const expired = reopened.revisions.list(ROOM)[0]!;
    expect(expired).toMatchObject({ id, startedAt: 0, endedAt: 20 * MINUTE, final: true });
    expect(expired).not.toHaveProperty("deadlineAt");
    const reloaded = await load(reopened);
    expect(getMeta(reloaded).title).toBe("Continued after the old deadline");
    title(reloaded, "Next session");
    expect(reopened.revisions.list(ROOM)).toHaveLength(2);
    expect(reopened.revisions.list(ROOM)[1]).toEqual(expired);
  });
});
