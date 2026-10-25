import { Document } from "@hocuspocus/server";
import { createHash } from "node:crypto";
import {
  compareRevisions,
  appendBlock,
  createAnnotation,
  editBlock,
  findBlockElement,
  getAnnotation,
  getBlock,
  getBlocks,
  getDocDataEntries,
  deleteDirectoryEntry,
  directoryRoom,
  encodeOriginUpdate,
  getMeta,
  getMetaMap,
  moveBlocks,
  resolveAnnotationRange,
  restoreDirectoryEntry,
  roomForDoc,
  settingsRoom,
  sidebarRoom,
  tombstoneDirectoryEntry,
  snapshotRevision,
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

function checksum(doc: Y.Doc): string {
  return createHash("sha256").update(snapshotRevision(doc).checksum).digest("hex");
}

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
  for (const db of databases.splice(0)) db.close();
  removeTempDatabases();
  clock = 0;
});

describe("automatic hub revisions", () => {
  it("restores title, blocks and data as an isolated closed revision, preserving comments and excluded metadata", async () => {
    const db = database();
    const doc = await load(db);
    let unchanged = "";
    let changed = "";
    let moved = "";
    doc.transact(() => {
      title(doc, "Past title");
      unchanged = appendBlock(doc, { type: "paragraph", text: "Keep this text" });
      appendBlock(doc, { type: "paragraph", text: "Also retained" });
      changed = appendBlock(doc, { type: "paragraph", text: "Past text" });
      moved = appendBlock(doc, { type: "paragraph", text: "Moved text" });
      doc.getMap("data").set("collection", { records: [1, 2] });
    }, { attribution: { author: browser } });
    const past = db.revisions.list(ROOM)[0]!.id;
    db.revisions.name(ROOM, doc, checksum(doc), "Past", browser);
    clock = MINUTE;
    doc.transact(() => {
      title(doc, "Present title");
      editBlock(doc, changed, "Past text", "Present text");
      appendBlock(doc, { type: "paragraph", text: "Remove this block" });
      moveBlocks(doc, [moved]);
      doc.getMap("data").set("collection", { records: [3] });
      doc.getMap("data").set("new collection", 7);
    }, { attribution: { author: browser } });
    const before = db.revisions.list(ROOM)[0]!.id;
    const beforeSnapshot = revision(db, before);
    const thread = createAnnotation(doc, unchanged, 0, 4, "reviewer", "Keep anchor");
    const replacedThread = createAnnotation(doc, changed, 0, 7, "reviewer", "Loses anchor");
    const movedThread = createAnnotation(doc, moved, 0, 5, "reviewer", "Moves with text");
    const metadata = { description: "Current description", tldr: "Current TLDR", tags: ["current"], pinned: true,
      code_check: [{ result: "matches" }] };
    doc.transact(() => {
      for (const [key, value] of Object.entries(metadata)) getMetaMap(doc).set(key, value);
    });
    const keptElement = findBlockElement(doc, unchanged);
    const keptBlock = getBlock(doc, unchanged);
    const movedBlock = getBlock(doc, moved);
    const threadBefore = getAnnotation(doc, thread.id);
    const replacedThreadBefore = getAnnotation(doc, replacedThread.id);
    const oldBytes = db.revisions.get(ROOM, past);
    clock = 2 * MINUTE;
    const restored = db.restoreRevision(ROOM, doc, checksum(doc), past, claude);
    expect(restored).toMatchObject({ ok: true, applied: true });
    if (!restored.ok) throw new Error("restore refused");
    expect(getMeta(doc).title).toBe("Past title");
    expect(getBlocks(doc).map(block => block.text)).toEqual(["Keep this text", "Also retained", "Past text", "Moved text"]);
    expect(getDocDataEntries(doc)).toEqual([["collection", { records: [1, 2] }]]);
    expect(findBlockElement(doc, unchanged)).toBe(keptElement);
    expect(getBlock(doc, unchanged)).toEqual(keptBlock);
    expect(getBlock(doc, moved)).toEqual(movedBlock);
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ start: 0, end: 4, collapsed: false });
    expect(resolveAnnotationRange(doc, movedThread.id)).toEqual({ start: 0, end: 5, collapsed: false });
    expect(resolveAnnotationRange(doc, replacedThread.id)).toBeNull();
    expect(getAnnotation(doc, thread.id)).toEqual(threadBefore);
    expect(getAnnotation(doc, replacedThread.id)).toEqual(replacedThreadBefore);
    for (const [key, value] of Object.entries(metadata)) expect(getMetaMap(doc).get(key)).toEqual(value);
    expect(db.revisions.list(ROOM).slice(0, 3)).toEqual([
      { id: restored.id, author: claude, startedAt: 2 * MINUTE, endedAt: 2 * MINUTE, checksum: checksum(doc), final: true },
      { id: before, author: browser, startedAt: MINUTE, endedAt: 2 * MINUTE, checksum: checksum(beforeSnapshot), final: true },
      { id: past, author: browser, startedAt: 0, endedAt: 0, checksum: checksum(doc), final: true },
    ]);
    expect(db.revisions.get(ROOM, past)).toEqual(oldBytes);
    const saved = await load(db);
    expect(compareRevisions(saved, doc).changed).toBe(false);
    expect(resolveAnnotationRange(saved, thread.id)).not.toBeNull();
    const undone = db.restoreRevision(ROOM, doc, checksum(doc), before, browser);
    expect(undone).toMatchObject({ ok: true, applied: true });
    expect(compareRevisions(beforeSnapshot, doc).changed).toBe(false);
    expect(resolveAnnotationRange(doc, replacedThread.id)).toBeNull();
    clock = 3 * MINUTE;
    title(doc, "Later edit", browser);
    expect(db.revisions.list(ROOM)[0]).toMatchObject({ author: browser, endedAt: null });
    expect(db.revisions.list(ROOM)[1]).toMatchObject({ id: undone.ok ? undone.id : "", endedAt: 2 * MINUTE });
  });

  it("refuses stale or foreign revisions and leaves a no-op's bytes and open boundary untouched", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "Current");
    const current = db.revisions.list(ROOM)[0]!;
    const bytes = Y.encodeStateAsUpdate(doc);
    const rows = db.revisions.list(ROOM);
    expect(db.restoreRevision(ROOM, doc, checksum(doc), current.id, claude)).toEqual({ ok: true, id: current.id, applied: false });
    expect(db.restoreRevision(ROOM, doc, "0".repeat(64), current.id, claude)).toEqual({ ok: false, error: "stale-state" });
    const foreign = await load(db, roomForDoc(WORKSPACE, TOPIC));
    title(foreign, "Foreign");
    const foreignId = db.revisions.list(roomForDoc(WORKSPACE, TOPIC))[0]!.id;
    expect(db.restoreRevision(ROOM, doc, checksum(doc), foreignId, claude)).toEqual({ ok: false, error: "revision-not-found" });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(db.revisions.list(ROOM)).toEqual(rows);
    expect(db.connection.prepare("SELECT name FROM documents WHERE name = ?").get(ROOM)).toBeUndefined();
  });

  it.each(["documents", "document_revisions"])("rolls back room state and history before broadcasting when %s cannot store", async (table) => {
    const failures: unknown[] = [];
    const db = database(true, error => failures.push(error));
    const doc = await load(db);
    title(doc, "Past");
    const past = db.revisions.list(ROOM)[0]!.id;
    db.revisions.name(ROOM, doc, checksum(doc), "Past", browser);
    title(doc, "Current");
    await db.onStoreDocument({ document: doc, documentName: ROOM });
    const persisted = db.connection.prepare("SELECT data FROM documents WHERE name = ?").get(ROOM)!.data;
    const bytes = Y.encodeStateAsUpdate(doc);
    const history = db.revisions.list(ROOM);
    let updates = 0;
    doc.on("update", () => { updates++; });
    db.connection.exec(`CREATE TRIGGER fail_restore BEFORE ${table === "documents" ? "UPDATE" : "INSERT"} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'restore failed'); END`);
    expect(() => db.restoreRevision(ROOM, doc, checksum(doc), past, claude)).toThrow("restore failed");
    expect(failures).toHaveLength(1);
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(db.revisions.list(ROOM)).toEqual(history);
    expect(db.connection.prepare("SELECT data FROM documents WHERE name = ?").get(ROOM)!.data).toEqual(persisted);
    db.connection.exec("DROP TRIGGER fail_restore");
    expect(db.restoreRevision(ROOM, doc, checksum(doc), past, claude)).toMatchObject({ ok: true, applied: true });
    expect(updates).toBe(1);
  });

  it("drops delayed edits in replaced blocks while keeping concurrent edits in untouched blocks", async () => {
    const db = database();
    const doc = await load(db);
    let replaced = "";
    let retained = "";
    doc.transact(() => {
      replaced = appendBlock(doc, { type: "paragraph", text: "Past" });
      retained = appendBlock(doc, { type: "paragraph", text: "Keep" });
    }, { attribution: { author: browser } });
    const past = db.revisions.list(ROOM)[0]!.id;
    db.revisions.name(ROOM, doc, checksum(doc), "Past", browser);
    editBlock(doc, replaced, "Past", "Present");
    const offline = new Y.Doc();
    documents.push(offline);
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(doc);
    editBlock(offline, replaced, "Present", "Offline present");
    editBlock(offline, retained, "Keep", "Keep offline edit");
    const delayed = Y.encodeStateAsUpdate(offline, vector);
    expect(db.restoreRevision(ROOM, doc, checksum(doc), past, browser)).toMatchObject({ ok: true, applied: true });
    Y.applyUpdate(doc, delayed, { attribution: { author: claude } });
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(doc));
    expect(getBlocks(doc).map(block => block.text)).toEqual(["Past", "Keep offline edit"]);
    expect(getBlocks(offline)).toEqual(getBlocks(doc));
    expect(db.revisions.list(ROOM)[0]).toMatchObject({ author: claude, endedAt: null });
  });

  it("names and freezes another surface's open stretch, independently of naming attribution", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "Reviewed", claude);
    const id = db.revisions.list(ROOM)[0]!.id;
    const content = db.revisions.get(ROOM, id);
    clock = MINUTE;
    expect(db.revisions.name(ROOM, doc, checksum(doc), "Reviewed after auth rewrite", browser)).toEqual({ ok: true, id });
    expect(db.revisions.list(ROOM)[0]).toEqual({
      id, author: claude, startedAt: 0, endedAt: MINUTE, checksum: checksum(doc), final: true,
    });
    expect(db.revisions.names(ROOM).get(id)).toEqual({ text: "Reviewed after auth rewrite", namer: browser, namedAt: MINUTE });
    clock = 2 * MINUTE;
    title(doc, "Later", claude);
    expect(db.revisions.list(ROOM)).toHaveLength(2);
    expect(db.revisions.list(ROOM)[0]!.id).not.toBe(id);
    expect(db.revisions.get(ROOM, id)).toEqual(content);
  });

  it("materializes history predating revisions once and preserves reverted stretches when named", async () => {
    const db = database();
    const existing = new Y.Doc();
    documents.push(existing);
    title(existing, "Before recording");
    db.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(ROOM, Y.encodeStateAsUpdate(existing));
    const doc = await load(db);
    expect(db.revisions.name(ROOM, doc, checksum(doc), "Original", browser).ok).toBe(true);
    const original = db.revisions.list(ROOM)[0]!;
    expect(original).toMatchObject({ author: null, startedAt: null, endedAt: 0 });
    title(doc, "Temporary", claude);
    title(doc, "Before recording", claude);
    expect(db.revisions.list(ROOM)).toHaveLength(1);
    const reverted = db.connection.prepare("SELECT id FROM document_revision_heads WHERE room = ?").get(ROOM)!.id;
    clock = 1;
    expect(db.revisions.name(ROOM, doc, checksum(doc), "Reviewed revert", browser)).toEqual({ ok: true, id: reverted });
    expect(db.revisions.list(ROOM)).toEqual([
      { id: reverted, author: claude, startedAt: 0, endedAt: 1, checksum: checksum(doc), final: true }, original,
    ]);
    expect(db.revisions.removeName(ROOM, reverted as string).ok).toBe(true);
    title(doc, "Next", claude);
    expect(db.revisions.list(ROOM)).toHaveLength(3);
    expect(db.revisions.get(ROOM, reverted as string)).not.toBeNull();
  });

  it("refuses stale state and duplicate names, and records the account, surface and time that rename text", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "Seen");
    const seen = checksum(doc);
    title(doc, "Unseen");
    expect(db.revisions.name(ROOM, doc, seen, "Stale", browser)).toEqual({ ok: false, error: "stale-state" });
    expect(db.revisions.names(ROOM).size).toBe(0);
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBeNull();
    clock = 50;
    const named = db.revisions.name(ROOM, doc, checksum(doc), "Accepted", browser);
    if (!named.ok) throw new Error("name refused");
    const original = db.revisions.list(ROOM)[0];
    const bytes = db.revisions.get(ROOM, named.id);
    expect(db.revisions.name(ROOM, doc, checksum(doc), "Duplicate", claude)).toMatchObject({ ok: false, error: "already-named",
      name: { text: "Accepted", namer: browser, namedAt: 50 } });
    const other = { principalId: "someone-else", surface: { kind: "mcp", name: "Other client" } };
    clock = 100;
    expect(db.revisions.rename(ROOM, named.id, "Renamed", other)).toEqual({ ok: true, id: named.id });
    expect(db.revisions.names(ROOM).get(named.id)).toEqual({ text: "Renamed", namer: other, namedAt: 100 });
    expect(db.revisions.list(ROOM)[0]).toEqual(original);
    expect(db.revisions.get(ROOM, named.id)).toEqual(bytes);
    expect(db.revisions.removeName(ROOM, named.id)).toEqual({ ok: true, id: named.id });
    expect(db.revisions.names(ROOM).size).toBe(0);
    expect(db.revisions.list(ROOM)[0]).toEqual(original);
    expect(db.revisions.get(ROOM, named.id)).toEqual(bytes);
    clock = 150;
    title(doc, "After removal");
    expect(db.revisions.list(ROOM)).toHaveLength(2);
  });

  it("enforces one-line Unicode names and rolls back the stretch boundary if name storage fails", async () => {
    const failures: unknown[] = [];
    const db = database(true, error => failures.push(error));
    const doc = await load(db);
    title(doc, "One");
    for (const name of ["", "x".repeat(101), "line\nline", "line\rline", "line\u2028line", "line\u2029line"]) {
      expect(db.revisions.name(ROOM, doc, checksum(doc), name, browser)).toEqual({ ok: false, error: "invalid-name" });
    }
    db.connection.exec(`CREATE TRIGGER fail_revision_name BEFORE INSERT ON document_revision_names
      BEGIN SELECT RAISE(ABORT, 'name failed'); END`);
    clock = 10 * MINUTE;
    expect(() => db.revisions.name(ROOM, doc, checksum(doc), "A name", browser)).toThrow("name failed");
    expect(failures).toHaveLength(1);
    expect(db.revisions.names(ROOM).size).toBe(0);
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBeNull();
    expect(db.revisions.list(ROOM)[0]!.deadlineAt).toBe(15 * MINUTE);
    expect(db.connection.prepare("SELECT id FROM document_revisions WHERE room = ?").all(ROOM)).toEqual([]);
    db.connection.exec("DROP TRIGGER fail_revision_name");
    expect(db.revisions.name(ROOM, doc, checksum(doc), "🦊".repeat(100), browser).ok).toBe(true);
  });

  it("preserves name text and attribution when rename storage fails", async () => {
    const failures: unknown[] = [];
    const db = database(true, error => failures.push(error));
    const doc = await load(db);
    title(doc, "Named content");
    clock = 50;
    const named = db.revisions.name(ROOM, doc, checksum(doc), "Accepted", browser);
    if (!named.ok) throw new Error("name refused");
    db.connection.exec(`CREATE TRIGGER fail_revision_rename BEFORE UPDATE ON document_revision_names
      BEGIN SELECT RAISE(ABORT, 'rename failed'); END`);
    const other = { principalId: "someone-else", surface: { kind: "mcp", name: "Other client" } };
    clock = 100;
    expect(() => db.revisions.rename(ROOM, named.id, "Renamed", other)).toThrow("rename failed");
    expect(failures).toHaveLength(1);
    expect(db.revisions.names(ROOM).get(named.id)).toEqual({ text: "Accepted", namer: browser, namedAt: 50 });
    db.connection.exec("DROP TRIGGER fail_revision_rename");
    expect(db.revisions.rename(ROOM, named.id, "Renamed", other)).toEqual({ ok: true, id: named.id });
    expect(db.revisions.names(ROOM).get(named.id)).toEqual({ text: "Renamed", namer: other, namedAt: 100 });
  });

  it("records exactly the three example stretches and freezes the preceding author's bytes", async () => {
    const db = database();
    const doc = await load(db);
    clock = 9 * 60 * MINUTE;
    title(doc, "Created");
    clock += 5 * MINUTE;
    title(doc, "Browser edit");
    const firstId = db.revisions.list(ROOM)[0]!.id;
    const firstBytes = db.revisions.get(ROOM, firstId);
    const firstChecksum = checksum(doc);
    clock += MINUTE;
    title(doc, "Claude edit", claude);
    clock += 6 * MINUTE;
    title(doc, "Last Claude edit", claude);
    const claudeChecksum = checksum(doc);
    clock = (9 * 60 + 40) * MINUTE;
    title(doc, "Browser returns");

    expect(db.revisions.list(ROOM)).toEqual([
      { id: expect.any(String), author: browser, startedAt: (9 * 60 + 40) * MINUTE, endedAt: null,
        checksum: checksum(doc), final: false, deadlineAt: (9 * 60 + 55) * MINUTE },
      { id: expect.any(String), author: claude, startedAt: (9 * 60 + 6) * MINUTE, endedAt: (9 * 60 + 12) * MINUTE,
        checksum: claudeChecksum, final: true },
      { id: firstId, author: browser, startedAt: 9 * 60 * MINUTE, endedAt: (9 * 60 + 6) * MINUTE,
        checksum: firstChecksum, final: true },
    ]);
    expect(db.revisions.get(ROOM, firstId)).toEqual(firstBytes);
    expect(getMeta(revision(db, firstId)).title).toBe("Browser edit");
    expect(compareRevisions(revision(db, db.revisions.list(ROOM)[0]!.id), doc).changed).toBe(false);
  });

  it("keeps one continuous session open until fifteen minutes after its last edit", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "Minute 0");
    const id = db.revisions.list(ROOM)[0]!.id;
    for (const minute of [10, 20, 34]) {
      clock = minute * MINUTE;
      title(doc, `Minute ${minute}`);
      expect(db.revisions.list(ROOM)).toEqual([{
        id, author: browser, startedAt: 0, endedAt: null, checksum: checksum(doc),
        final: false, deadlineAt: (minute + 15) * MINUTE,
      }]);
    }
    clock = 49 * MINUTE - 1;
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBeNull();
    clock++;
    const expired = db.revisions.list(ROOM)[0]!;
    expect(expired).toMatchObject({ id, startedAt: 0, endedAt: 34 * MINUTE, final: true });
    expect(expired).not.toHaveProperty("deadlineAt");
    const bytes = db.revisions.get(ROOM, id);
    clock = 50 * MINUTE;
    title(doc, "New session");
    expect(db.revisions.list(ROOM)).toEqual([
      { id: expect.any(String), author: browser, startedAt: clock, endedAt: null,
        checksum: checksum(doc), final: false, deadlineAt: 65 * MINUTE }, expired,
    ]);
    expect(db.revisions.list(ROOM)[0]!.id).not.toBe(id);
    expect(db.revisions.get(ROOM, id)).toEqual(bytes);
  });

  it.each(["author", "name", "archive", "unarchive", "restore"] as const)(
    "closes a long session at the %s event time or preserves its expired end", async event => {
      for (const expired of [false, true]) {
        clock = 0;
        const db = database();
        const doc = await load(db);
        const directory = await load(db, directoryRoom(WORKSPACE));
        directory.getMap("docs").set(UUID, { title: "Page", tags: [] });
        title(doc, "Baseline");
        const baseline = db.revisions.list(ROOM)[0]!.id;
        db.revisions.name(ROOM, doc, checksum(doc), "Baseline", browser);
        if (event === "unarchive") tombstoneDirectoryEntry(directory, UUID);
        for (const minute of [1, 11, 21]) {
          clock = minute * MINUTE;
          title(doc, `Minute ${minute}`);
        }
        const head = db.revisions.list(ROOM)[0]!;
        const bytes = db.revisions.get(ROOM, head.id);
        clock = (expired ? 36 : 22) * MINUTE;
        if (event === "author") title(doc, "Another author", claude);
        if (event === "name") expect(db.revisions.name(ROOM, doc, checksum(doc), "Named", claude).ok).toBe(true);
        if (event === "archive") tombstoneDirectoryEntry(directory, UUID);
        if (event === "unarchive") restoreDirectoryEntry(directory, UUID);
        if (event === "restore") expect(db.restoreRevision(ROOM, doc, checksum(doc), baseline, claude).ok).toBe(true);
        const closed = { ...head, endedAt: (expired ? 21 : 22) * MINUTE, final: true };
        delete closed.deadlineAt;
        expect(db.revisions.list(ROOM).find(row => row.id === head.id)).toEqual(closed);
        expect(db.connection.prepare("SELECT ended_at FROM document_revisions WHERE id = ?").get(head.id))
          .toEqual({ ended_at: closed.endedAt });
        expect(db.revisions.get(ROOM, head.id)).toEqual(bytes);
      }
    },
  );

  it("expires without a timer and excludes ignored changes from stretch boundaries", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "First");
    clock = 10 * MINUTE;
    title(doc, "Last content edit");
    const id = db.revisions.list(ROOM)[0]!.id;
    const bytes = db.revisions.get(ROOM, id);
    clock = 20 * MINUTE;
    doc.transact(() => {
      const meta = doc.getMap("meta");
      meta.set("description", "Other author");
      meta.set("tldr", "Summary");
      meta.set("tag-assigned:tag", true);
      meta.set("code-check:repo", { result: "matches" });
      doc.getMap("annotations").set("thread", "A comment");
    }, { attribution: { author: claude } });
    expect(db.revisions.list(ROOM)).toEqual([{
      id, author: browser, startedAt: 0, endedAt: null, checksum: checksum(doc), final: false, deadlineAt: 25 * MINUTE,
    }]);
    expect(db.revisions.get(ROOM, id)).toEqual(bytes);
    clock = 25 * MINUTE;
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBe(10 * MINUTE);
    doc.transact(() => doc.getMap("meta").set("description", "After expiry"), { attribution: { author: claude } });
    expect(db.connection.prepare("SELECT ended_at FROM document_revisions WHERE room = ?").all(ROOM)).toEqual([]);
    const expired = db.revisions.list(ROOM)[0];
    expect(expired).toEqual({ id, author: browser, startedAt: 0, endedAt: 10 * MINUTE, checksum: checksum(doc), final: true });
    title(doc, "Second");
    expect(db.revisions.list(ROOM)).toHaveLength(2);
    expect(db.revisions.list(ROOM)[1]).toEqual(expired);
    expect(db.revisions.get(ROOM, id)).toEqual(bytes);
  });

  it("reads canonical checksums with open and closed snapshot bytes, including corrupt bytes", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "First");
    const first = db.revisions.list(ROOM)[0]!;
    const snapshot = db.revisions.getSnapshot(ROOM, first.id);
    expect(snapshot).toEqual({ state: db.revisions.get(ROOM, first.id), checksum: checksum(doc) });
    title(doc, "Second");
    const second = db.revisions.list(ROOM)[0]!;
    expect(second.id).toBe(first.id);
    expect(second.checksum).toBe(checksum(doc));
    expect(second.checksum).not.toBe(first.checksum);
    expect(db.revisions.getSnapshot(ROOM, first.id)).toEqual({ state: db.revisions.get(ROOM, first.id), checksum: second.checksum });
    expect(snapshot!.checksum).toBe(first.checksum);
    const corrupt = Uint8Array.of(255);
    db.connection.prepare("UPDATE document_revision_heads SET data = ? WHERE room = ?").run(corrupt, ROOM);
    expect(db.revisions.getSnapshot(ROOM, first.id)).toEqual({ state: corrupt, checksum: second.checksum });
    expect(db.revisions.list(ROOM)[0]!.checksum).toBe(second.checksum);
    clock = 15 * MINUTE;
    title(doc, "Third");
    expect(db.revisions.getSnapshot(ROOM, first.id)).toEqual({ state: corrupt, checksum: second.checksum });
    expect(db.revisions.list(ROOM)[1]!.checksum).toBe(second.checksum);
    const differentCorrupt = Uint8Array.of(254);
    db.connection.prepare("UPDATE document_revisions SET data = ? WHERE room = ? AND id = ?")
      .run(differentCorrupt, ROOM, first.id);
    expect(db.revisions.getSnapshot(ROOM, first.id)).toEqual({ state: differentCorrupt, checksum: second.checksum });
    expect(db.revisions.getSnapshot(roomForDoc(WORKSPACE, TOPIC), first.id)).toBeNull();
    expect(db.revisions.getSnapshot(ROOM, "missing")).toBeNull();
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
      { id: expect.any(String), author: browser, startedAt: 50, endedAt: null,
        checksum: checksum(doc), final: false, deadlineAt: 50 + 15 * MINUTE },
      { id: expect.any(String), author: null, startedAt: null, endedAt: 50, checksum: checksum(existing), final: true },
    ]);
    expect(getMeta(revision(db, rows[1]!.id)).title).toBe("Before revisions");
  });

  it("keeps an equal stretch's start for later edits, including after reloading the room", async () => {
    const db = database();
    const doc = await load(db);
    title(doc, "X");
    const firstChecksum = checksum(doc);
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
      { id: expect.any(String), author: claude, startedAt: 100, endedAt: null,
        checksum: checksum(reloaded), final: false, deadlineAt: 300 + 15 * MINUTE },
      { id: expect.any(String), author: browser, startedAt: 0, endedAt: 100, checksum: firstChecksum, final: true },
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

  it.each(["open", "decided", "rejected", "withdrawn"] as const)("records no first content or later title, blocks or data for %s decisions", async status => {
    const db = database();
    const doc = await load(db);
    doc.transact(() => {
      getMetaMap(doc).set("kind", "decision");
      getMetaMap(doc).set("status", status);
      title(doc, "First answer");
      appendBlock(doc, { type: "paragraph", text: "First content" });
      doc.getMap("data").set("collection", { records: [1] });
    }, { attribution: { author: browser } });
    expect(db.revisions.list(ROOM)).toEqual([]);
    const directory = await load(db, directoryRoom(WORKSPACE));
    directory.getMap("docs").set(UUID, { title: "Record", tags: [], kind: "decision", topic: UUID, status });
    for (const archived of [false, true]) {
      if (archived) tombstoneDirectoryEntry(directory, UUID);
      title(doc, `Changed title, archived: ${archived}`);
      doc.transact(() => appendBlock(doc, { type: "paragraph", text: `Changed blocks, archived: ${archived}` }),
        { attribution: { author: claude } });
      doc.transact(() => doc.getMap("data").set("collection", { archived }), { attribution: { author: browser } });
      expect(db.revisions.list(ROOM)).toEqual([]);
      expect(db.connection.prepare("SELECT room FROM document_revision_heads WHERE room = ?").all(ROOM)).toEqual([]);
      expect(db.connection.prepare("SELECT room FROM document_revisions WHERE room = ?").all(ROOM)).toEqual([]);
    }
  });

  it("retains a converted page's earlier revisions and names without recording decision changes, then purges them on deletion", async () => {
    const db = database();
    const doc = await load(db);
    const directory = await load(db, directoryRoom(WORKSPACE));
    title(doc, "Named regular page");
    expect(db.revisions.name(ROOM, doc, checksum(doc), "Before conversion", browser).ok).toBe(true);
    clock = 10;
    title(doc, "Regular page's latest edit");
    const rows = db.revisions.list(ROOM);
    const content = rows.map(row => db.revisions.get(ROOM, row.id));
    const names = db.revisions.names(ROOM);
    doc.transact(() => {
      getMetaMap(doc).set("kind", "decision");
      getMetaMap(doc).set("status", "open");
      title(doc, "Converted decision");
      appendBlock(doc, { type: "paragraph", text: "Decision answer" });
      doc.getMap("data").set("collection", { records: [1] });
    }, { attribution: { author: claude } });
    directory.getMap("docs").set(UUID, { title: "Converted decision", tags: [], kind: "decision", topic: UUID, status: "open" });
    await db.onStoreDocument({ document: doc, documentName: ROOM });
    const reloaded = await load(db);
    title(reloaded, "Later decision title", claude);
    expect(db.revisions.list(ROOM)).toEqual(rows);
    expect(rows.map(row => db.revisions.get(ROOM, row.id))).toEqual(content);
    expect(db.revisions.names(ROOM)).toEqual(names);
    tombstoneDirectoryEntry(directory, UUID);
    expect(db.revisions.list(ROOM).map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(rows.map(row => db.revisions.get(ROOM, row.id))).toEqual(content);
    expect(db.revisions.names(ROOM)).toEqual(names);
    deleteDirectoryEntry(directory, UUID);
    expect(db.revisions.list(ROOM)).toEqual([]);
    expect(db.revisions.names(ROOM).size).toBe(0);
    expect(db.connection.prepare("SELECT room FROM document_revision_heads WHERE room = ?").all(ROOM)).toEqual([]);
    expect(db.connection.prepare("SELECT name FROM documents WHERE name = ?").get(ROOM)).toBeUndefined();
  });

  it("closes regular-page heads for archive and restore without losing names", async () => {
    const db = database();
    const doc = await load(db);
    const directory = await load(db, directoryRoom(WORKSPACE));
    directory.getMap("docs").set(UUID, { title: "Regular page", tags: [] });
    title(doc, "Named state");
    expect(db.revisions.name(ROOM, doc, checksum(doc), "Before archive", browser).ok).toBe(true);
    const names = db.revisions.names(ROOM);
    clock = 5;
    title(doc, "One");
    clock = 10;
    tombstoneDirectoryEntry(directory, UUID);
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBe(10);
    expect(db.revisions.names(ROOM)).toEqual(names);
    clock = 20;
    title(doc, "Two");
    clock = 30;
    restoreDirectoryEntry(directory, UUID);
    expect(db.revisions.list(ROOM)[0]!.endedAt).toBe(30);
    clock = 40;
    title(doc, "Three");
    expect(db.revisions.list(ROOM)).toHaveLength(4);
    expect(db.revisions.list(ROOM)[0]!.startedAt).toBe(40);
  });

  it("purges history atomically with deletion, rolls back failure, and fences subsequent updates", async () => {
    const failures: unknown[] = [];
    const db = database(true, error => failures.push(error));
    const doc = await load(db);
    const directory = await load(db, directoryRoom(WORKSPACE));
    title(doc, "Stored");
    expect(db.revisions.name(ROOM, doc, checksum(doc), "Before deletion", browser).ok).toBe(true);
    db.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(ROOM, Y.encodeStateAsUpdate(doc));
    tombstoneDirectoryEntry(directory, UUID);
    db.connection.exec(`CREATE TRIGGER fail_revision_purge BEFORE DELETE ON document_revisions
      BEGIN SELECT RAISE(ABORT, 'purge failed'); END`);
    expect(() => deleteDirectoryEntry(directory, UUID)).toThrow("purge failed");
    expect(db.connection.prepare("SELECT name FROM documents WHERE name = ?").get(ROOM)).toBeDefined();
    expect(db.revisions.list(ROOM)).toHaveLength(1);
    expect(db.revisions.names(ROOM).size).toBe(1);
    expect(failures).toHaveLength(1);
    db.connection.exec("DROP TRIGGER fail_revision_purge");
    directory.getMap("docs").set(TOPIC, { title: "Retry", tags: [] });
    expect(db.revisions.list(ROOM)).toEqual([]);
    expect(db.revisions.names(ROOM).size).toBe(0);
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
    clock = 5 * MINUTE;
    expect(() => title(doc, "Unrecorded edit")).toThrow("capture failed");
    expect(db.revisions.list(ROOM)[0]!.deadlineAt).toBe(15 * MINUTE);
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
    expect(rows).toEqual([{
      id: expect.any(String), author: null, startedAt: 0, endedAt: null,
      checksum: checksum(hub), final: false, deadlineAt: 15 * MINUTE,
    }]);
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
    expect(db.revisions.name(ROOM, doc, checksum(doc), "Backed up", browser).ok).toBe(true);
    clock = 100;
    title(doc, "Second", claude);
    clock = 10 * MINUTE + 100;
    title(doc, "Last edit before backup", claude);
    await db.onStoreDocument({ document: doc, documentName: ROOM });
    const expected = db.revisions.list(ROOM);
    const names = db.revisions.names(ROOM);
    const snapshots = expected.map(row => db.revisions.getSnapshot(ROOM, row.id));
    const loop = setInterval(() => {}, 10);
    try {
      const backup = await backupDatabase(db.connection, databasePath);
      clock = 20 * MINUTE + 100;
      title(doc, "After backup");
      await db.onStoreDocument({ document: doc, documentName: ROOM });
      db.close();
      await restoreDatabase(databasePath, backup, { yes: true, writeLine: () => {} });
      const restored = new HubDatabase(databasePath, () => {}, { revisions: true, now: () => clock });
      restored.open();
      databases.push(restored);
      expect(restored.revisions.list(ROOM)).toEqual(expected);
      expect(restored.revisions.names(ROOM)).toEqual(names);
      expect(expected.map(row => restored.revisions.getSnapshot(ROOM, row.id))).toEqual(snapshots);
      expect(getMeta(await load(restored)).title).toBe("Last edit before backup");
      clock = 25 * MINUTE + 100;
      expect(restored.revisions.list(ROOM)[0]).toMatchObject({
        id: expected[0]!.id, startedAt: 100, endedAt: 10 * MINUTE + 100, final: true,
      });
    } finally {
      clearInterval(loop);
    }
  });
});
