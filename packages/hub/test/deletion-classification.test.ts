import { DatabaseSync } from "node:sqlite";
import { Document } from "@hocuspocus/server";
import {
  deleteDecisionTopic,
  deleteDecisionRecord,
  deleteDirectoryEntry,
  DIRECTORY_DELETED_DECISION_RECORDS_KEY,
  directoryRoom,
  enforceDeletedDirectoryEntries,
  getDirectoryEntry,
  initDoc,
  isDirectoryEntryDeleted,
  parseRoom,
  roomForDoc,
  resolveDecisionTopics,
  setKind,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { DOC_DELETED_REASON } from "@uberblick/schema/protocol";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HubDatabase } from "../src/persistence.js";
import { removeTempDatabases, tempDatabasePath, testRoom, WORKSPACE } from "./helpers.js";

const documents: Y.Doc[] = [];
const databases: HubDatabase[] = [];
const author = { principalId: "writer", surface: { kind: "browser" as const, name: "browser" } };

function open(path = ":memory:"): HubDatabase {
  const database = new HubDatabase(path, error => { throw error; }, { revisions: true, now: () => 0 });
  database.open();
  databases.push(database);
  return database;
}

async function load(database: HubDatabase, room: string): Promise<Document> {
  const document = new Document(room);
  documents.push(document);
  await database.onLoadDocument({ document, documentName: room });
  return document;
}

function initialize(document: Y.Doc, uuid: string, topic?: string): void {
  document.transact(() => {
    initDoc(document, { uuid, title: "Original content", ...(topic === undefined ? {} : {
      topic, ...(uuid === topic ? {} : { supersedes: topic }),
    }) });
    if (topic !== undefined) setKind(document, "decision");
    document.getText("body").insert(0, "Retained room content");
  }, { attribution: { author } });
}

async function create(database: HubDatabase, topic?: string): Promise<Document> {
  const room = testRoom();
  const document = await load(database, room);
  initialize(document, parseRoom(room).uuid, topic === "self" ? parseRoom(room).uuid : topic);
  await database.onStoreDocument({ document, documentName: room });
  return document;
}

function publish(directory: Y.Doc, document: Document, topic?: string): void {
  upsertDirectoryEntry(directory, {
    uuid: parseRoom(document.name).uuid,
    title: "Original content",
    ...(topic === undefined ? {} : { kind: "decision", topic, status: "open" }),
  });
}

function persisted(database: HubDatabase, room: string): Uint8Array | undefined {
  return database.connection.prepare("SELECT data FROM documents WHERE name = ?").get(room)?.data as Uint8Array | undefined;
}

function retained(database: HubDatabase, document: Document, archiveClosesRevision = false): () => void {
  const state = persisted(database, document.name);
  const history = database.revisions.list(document.name);
  expect(history.length).toBeGreaterThan(0);
  const snapshots = history.map(revision => database.revisions.getSnapshot(document.name, revision.id));
  return () => {
    expect(database.isDeletedRoom(document.name)).toBe(false);
    expect(() => database.requireRoom(document.name)).not.toThrow();
    expect(persisted(database, document.name)).toEqual(state);
    const current = database.revisions.list(document.name);
    if (archiveClosesRevision) {
      const stable = (revisions: typeof history) => revisions.map(({ final: _final, endedAt: _endedAt, deadlineAt: _deadlineAt, ...revision }) => revision);
      expect(stable(current)).toEqual(stable(history));
    } else expect(current).toEqual(history);
    expect(history.map(revision => database.revisions.getSnapshot(document.name, revision.id))).toEqual(snapshots);
  };
}

function converged(directory: Y.Doc, uuid: string): void {
  expect(isDirectoryEntryDeleted(directory, uuid)).toBe(false);
  enforceDeletedDirectoryEntries(directory);
  expect(isDirectoryEntryDeleted(directory, uuid)).toBe(false);
  const replica = new Y.Doc();
  try {
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(directory));
    enforceDeletedDirectoryEntries(replica);
    expect(isDirectoryEntryDeleted(replica, uuid)).toBe(false);
  } finally { replica.destroy(); }
}

afterEach(() => {
  for (const document of documents.splice(0)) document.destroy();
  for (const database of databases.splice(0)) database.close();
  removeTempDatabases();
});

describe("hub-owned deletion classification", () => {
  it.each(["page", "another topic", "removed entry"])(
    "retains a record and its history after metadata becomes %s, including across restart", async shape => {
      const path = tempDatabasePath();
      const first = open(path);
      const topic = await create(first, "self");
      const topicUuid = parseRoom(topic.name).uuid;
      const record = await create(first, topicUuid);
      const uuid = parseRoom(record.name).uuid;
      const directory = await load(first, directoryRoom(WORKSPACE));
      publish(directory, topic, topicUuid);
      publish(directory, record, topicUuid);
      const foreign = parseRoom(testRoom()).uuid;
      if (shape === "another topic") {
        upsertDirectoryEntry(directory, { uuid: foreign, title: "Archived unrelated topic", kind: "decision", topic: foreign, status: "open" });
        tombstoneDirectoryEntry(directory, foreign);
      }
      record.transact(() => {
        record.getMap("meta").set("kind", shape === "page" ? "" : "decision");
        record.getMap("meta").set("topic", foreign);
      });
      if (shape === "removed entry") directory.getMap("docs").delete(uuid);
      else directory.getMap("docs").set(uuid, {
        title: "Rewritten", tags: [], deleted: true,
        ...(shape === "page" ? {} : { kind: "decision", topic: foreign }),
      });
      await first.onStoreDocument({ document: record, documentName: record.name });
      await first.onStoreDocument({ document: directory, documentName: directory.name });
      first.close();

      const restarted = open(path);
      const held = await load(restarted, record.name);
      const reloadedDirectory = await load(restarted, directory.name);
      const assertRetained = retained(restarted, held);
      deleteDirectoryEntry(reloadedDirectory, uuid);
      assertRetained();
      converged(reloadedDirectory, uuid);
      expect(restarted.isDeletedRoom(topic.name)).toBe(false);
    },
  );

  it.each(["before", "after"])("purges only a record archived %s its mark and fences it across restart while retaining the topic and its other record", async when => {
    const path = tempDatabasePath();
    const database = open(path);
    const topic = await create(database, "self");
    const topicUuid = parseRoom(topic.name).uuid;
    const record = await create(database, topicUuid);
    const uuid = parseRoom(record.name).uuid;
    const other = await create(database, topicUuid);
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, topic, topicUuid);
    publish(directory, record, topicUuid);
    publish(directory, other, topicUuid);
    if (when === "before") tombstoneDirectoryEntry(directory, topicUuid);
    const topicRetained = retained(database, topic, when === "after");
    const otherRetained = retained(database, other, when === "after");
    expect(database.revisions.list(record.name).length).toBeGreaterThan(0);

    if (when === "before") expect(deleteDecisionRecord(directory, uuid)).toBe(true);
    else directory.transact(() => {
      tombstoneDirectoryEntry(directory, topicUuid);
      directory.getMap("deleted-docs").set(uuid, true);
    });

    expect(database.isDeletedRoom(record.name)).toBe(true);
    expect(() => database.requireRoom(record.name)).toThrow();
    expect(persisted(database, record.name)).toBeUndefined();
    expect(database.revisions.list(record.name)).toEqual([]);
    expect(isDirectoryEntryDeleted(directory, uuid)).toBe(true);
    expect(directory.getMap("docs").has(uuid)).toBe(false);
    topicRetained();
    otherRetained();
    database.close();

    const restarted = open(path);
    expect(restarted.isDeletedRoom(record.name)).toBe(true);
    expect(() => restarted.requireRoom(record.name)).toThrow();
    expect(persisted(restarted, record.name)).toBeUndefined();
    expect(restarted.revisions.list(record.name)).toEqual([]);
    const reloadedDirectory = await load(restarted, directory.name);
    expect(isDirectoryEntryDeleted(reloadedDirectory, uuid)).toBe(true);
    expect(restarted.isDeletedRoom(topic.name)).toBe(false);
    expect(restarted.isDeletedRoom(other.name)).toBe(false);
    expect(persisted(restarted, topic.name)).toBeDefined();
    expect(persisted(restarted, other.name)).toBeDefined();
    expect(restarted.revisions.list(topic.name).length).toBeGreaterThan(0);
    expect(restarted.revisions.list(other.name).length).toBeGreaterThan(0);
  });

  it.each(["live topic", "late record"])("reverses a record mark on a %s and ignores its remaining deletion references", async kind => {
    const database = open();
    const topic = await create(database, "self");
    const topicUuid = parseRoom(topic.name).uuid;
    const record = await create(database, topicUuid);
    const uuid = parseRoom(record.name).uuid;
    const successor = await create(database, topicUuid);
    const successorUuid = parseRoom(successor.name).uuid;
    const directory = await load(database, directoryRoom(WORKSPACE));
    upsertDirectoryEntry(directory, { uuid: topicUuid, title: "Question", kind: "decision", topic: topicUuid, status: "decided" });
    if (kind === "late record") tombstoneDirectoryEntry(directory, topicUuid);
    upsertDirectoryEntry(directory, { uuid, title: "Middle answer", kind: "decision", topic: topicUuid, supersedes: topicUuid, status: "decided" });
    upsertDirectoryEntry(directory, { uuid: successorUuid, title: "Final answer", kind: "decision", topic: topicUuid, supersedes: uuid, status: "decided" });
    const before = resolveDecisionTopics(directory);
    const assertRetained = retained(database, record);

    directory.transact(() => {
      directory.getMap(DIRECTORY_DELETED_DECISION_RECORDS_KEY).set(uuid, { topic: topicUuid, supersedes: successorUuid });
      directory.getMap("deleted-docs").set(uuid, true);
      directory.getMap("docs").delete(uuid);
    });

    assertRetained();
    converged(directory, uuid);
    expect(getDirectoryEntry(directory, uuid)?.title).toBe("Middle answer");
    expect(directory.getMap(DIRECTORY_DELETED_DECISION_RECORDS_KEY).has(uuid)).toBe(true);
    expect(resolveDecisionTopics(directory)).toEqual(before);
    const replica = new Y.Doc();
    documents.push(replica);
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(directory));
    expect(resolveDecisionTopics(replica)).toEqual(before);
  });

  it("refuses a stale pre-archive metadata winner before accepting a record mark, retaining state and history", async () => {
    const database = open();
    const topic = await create(database, "self");
    const topicUuid = parseRoom(topic.name).uuid;
    const record = await create(database, topicUuid);
    const uuid = parseRoom(record.name).uuid;
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, topic, topicUuid);
    publish(directory, record, topicUuid);
    const archiver = new Y.Doc();
    const stale = new Y.Doc();
    const deleter = new Y.Doc();
    documents.push(archiver, stale, deleter);
    Y.applyUpdate(archiver, Y.encodeStateAsUpdate(directory));
    Y.applyUpdate(stale, Y.encodeStateAsUpdate(directory));
    archiver.clientID = 1;
    stale.clientID = 2;
    tombstoneDirectoryEntry(archiver, topicUuid);
    Y.applyUpdate(directory, Y.encodeStateAsUpdate(archiver, Y.encodeStateVector(directory)));
    Y.applyUpdate(deleter, Y.encodeStateAsUpdate(directory));
    expect(getDirectoryEntry(directory, uuid)?.deleted).toBe(true);
    upsertDirectoryEntry(stale, { uuid, title: "Stale metadata winner" });
    Y.applyUpdate(directory, Y.encodeStateAsUpdate(stale, Y.encodeStateVector(directory)));
    expect(getDirectoryEntry(directory, topicUuid)?.deleted).toBe(true);
    expect(getDirectoryEntry(directory, uuid)?.deleted).toBeUndefined();
    const before = resolveDecisionTopics(directory);
    const assertRetained = retained(database, record);

    expect(deleteDecisionRecord(deleter, uuid)).toBe(true);
    Y.applyUpdate(directory, Y.encodeStateAsUpdate(deleter, Y.encodeStateVector(directory)));

    assertRetained();
    converged(directory, uuid);
    expect(getDirectoryEntry(directory, uuid)?.title).toBe("Stale metadata winner");
    expect(resolveDecisionTopics(directory)).toEqual(before);
  });

  it("retains classification first learned from a directory before the room arrives", async () => {
    const database = open();
    const directory = await load(database, directoryRoom(WORKSPACE));
    const room = testRoom();
    const uuid = parseRoom(room).uuid;
    const topic = parseRoom(testRoom()).uuid;
    upsertDirectoryEntry(directory, { uuid, title: "Announced record", kind: "decision", topic, status: "open" });
    const document = await load(database, room);
    initialize(document, uuid);
    await database.onStoreDocument({ document, documentName: room });
    directory.getMap("docs").set(uuid, { title: "Pretend page", tags: [], deleted: true });
    const assertRetained = retained(database, document);
    deleteDirectoryEntry(directory, uuid);
    assertRetained();
    converged(directory, uuid);
  });

  it("keeps the live deletion guard after its first classification write fails", async () => {
    const failures: unknown[] = [];
    const database = new HubDatabase(":memory:", error => { failures.push(error); }, { revisions: true, now: () => 0 });
    database.open();
    databases.push(database);
    const topic = await create(database, "self");
    const topicUuid = parseRoom(topic.name).uuid;
    const room = testRoom();
    const uuid = parseRoom(room).uuid;
    const record = await load(database, room);
    database.connection.exec("CREATE TRIGGER fail_classification BEFORE INSERT ON document_classifications BEGIN SELECT RAISE(ABORT, 'injected classification failure'); END");
    expect(() => initialize(record, uuid, topicUuid)).toThrow("injected classification failure");
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("injected classification failure");
    expect(database.connection.prepare("SELECT name FROM document_classifications WHERE name = ?").get(room)).toBeUndefined();
    database.connection.exec("DROP TRIGGER fail_classification");

    record.transact(() => {
      record.getMap("meta").set("kind", "");
      record.getMap("meta").delete("topic");
      record.getMap("meta").set("title", "Rewritten as a page");
    }, { attribution: { author } });
    await database.onStoreDocument({ document: record, documentName: room });
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, topic, topicUuid);
    directory.getMap("docs").set(uuid, { title: "Pretend archived page", tags: [], deleted: true });
    const assertRetained = retained(database, record);
    deleteDirectoryEntry(directory, uuid);
    assertRetained();
    converged(directory, uuid);
  });

  it.each(["page", "another topic's record"])(
    "keeps a %s and its revisions when a rewritten entry points at an archived topic being deleted", async kind => {
      const database = open();
      const deletedTopic = await create(database, "self");
      const deletedTopicUuid = parseRoom(deletedTopic.name).uuid;
      const ownTopic = kind === "page" ? undefined : await create(database, "self");
      const victim = await create(database, ownTopic === undefined ? undefined : parseRoom(ownTopic.name).uuid);
      const uuid = parseRoom(victim.name).uuid;
      const directory = await load(database, directoryRoom(WORKSPACE));
      publish(directory, deletedTopic, deletedTopicUuid);
      if (ownTopic !== undefined) publish(directory, ownTopic, parseRoom(ownTopic.name).uuid);
      publish(directory, victim, ownTopic === undefined ? undefined : parseRoom(ownTopic.name).uuid);
      tombstoneDirectoryEntry(directory, deletedTopicUuid);
      directory.getMap("docs").set(uuid, { title: "False membership", tags: [], kind: "decision", topic: deletedTopicUuid });
      const assertRetained = retained(database, victim);

      deleteDecisionTopic(directory, deletedTopicUuid);

      expect(database.isDeletedRoom(deletedTopic.name)).toBe(true);
      expect(persisted(database, deletedTopic.name)).toBeUndefined();
      expect(database.revisions.list(deletedTopic.name)).toEqual([]);
      assertRetained();
      converged(directory, uuid);
    },
  );

  it("does not authorize deleting a held record through a topic the hub never held or archived", async () => {
    const database = open();
    const topic = parseRoom(testRoom()).uuid;
    const record = await create(database, topic);
    const uuid = parseRoom(record.name).uuid;
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, record, topic);
    const assertRetained = retained(database, record);
    directory.getMap("deleted-docs").set(topic, true);
    assertRetained();
    converged(directory, uuid);
  });

  it.each([
    { order: "successor before topic", topicUuid: "ffffffff-ffff-4fff-bfff-ffffffffffff", uuid: "00000000-0000-4000-8000-000000000001" },
    { order: "topic before successor", topicUuid: "00000000-0000-4000-8000-000000000001", uuid: "ffffffff-ffff-4fff-bfff-ffffffffffff" },
  ])("keeps successor membership after refusing a live topic deletion, with $order", async ({ topicUuid, uuid }) => {
    const database = open();
    const topic = await load(database, roomForDoc(WORKSPACE, topicUuid));
    initialize(topic, topicUuid, topicUuid);
    await database.onStoreDocument({ document: topic, documentName: topic.name });
    const record = await load(database, roomForDoc(WORKSPACE, uuid));
    initialize(record, uuid, topicUuid);
    await database.onStoreDocument({ document: record, documentName: record.name });
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, topic, topicUuid);
    publish(directory, record, topicUuid);
    const assertRetained = retained(database, record);

    directory.getMap("deleted-docs").set(topicUuid, true);

    assertRetained();
    expect(database.isDeletedRoom(topic.name)).toBe(false);
    expect(directory.getMap("deleted-docs").has(topicUuid)).toBe(false);
    expect(directory.getMap("docs").get(uuid)).toMatchObject({ kind: "decision", topic: topicUuid });
    converged(directory, uuid);
    expect(directory.getMap("docs").get(uuid)).toMatchObject({ kind: "decision", topic: topicUuid });
    const replica = new Y.Doc();
    documents.push(replica);
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(directory));
    enforceDeletedDirectoryEntries(replica);
    expect(replica.getMap("docs").get(uuid)).toMatchObject({ kind: "decision", topic: topicUuid });
  });

  it("deletes an archived page while keeping a decision record that initially claimed it as a topic", async () => {
    const database = open();
    const page = await create(database);
    const pageUuid = parseRoom(page.name).uuid;
    const record = await create(database, pageUuid);
    const uuid = parseRoom(record.name).uuid;
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, page);
    publish(directory, record, pageUuid);
    tombstoneDirectoryEntry(directory, pageUuid);
    const assertRetained = retained(database, record);

    deleteDirectoryEntry(directory, pageUuid);

    expect(database.isDeletedRoom(page.name)).toBe(true);
    expect(persisted(database, page.name)).toBeUndefined();
    expect(database.revisions.list(page.name)).toEqual([]);
    assertRetained();
    converged(directory, uuid);
  });

  it.each(["room", "directory"])("adopts a former page only into its own topic through %s evidence", async source => {
    const database = open();
    const foreign = await create(database, "self");
    const foreignUuid = parseRoom(foreign.name).uuid;
    const page = await create(database);
    const uuid = parseRoom(page.name).uuid;
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, foreign, foreignUuid);
    publish(directory, page);
    if (source === "room") page.transact(() => {
        page.getMap("meta").set("kind", "decision");
        page.getMap("meta").set("topic", foreignUuid);
      });
    directory.getMap("docs").set(uuid, { title: "Adopted", tags: [], kind: "decision", topic: foreignUuid });
    tombstoneDirectoryEntry(directory, foreignUuid);
    const assertRetained = retained(database, page);
    directory.getMap("deleted-docs").set(foreignUuid, true);
    assertRetained();
    converged(directory, uuid);

    tombstoneDirectoryEntry(directory, uuid);
    deleteDecisionTopic(directory, uuid);
    expect(database.isDeletedRoom(page.name)).toBe(true);
    expect(persisted(database, page.name)).toBeUndefined();
  });

  it.each(["page", "decision topic"])("accepts archiving and deleting a %s in the same update", async kind => {
    const database = open();
    const document = await create(database, kind === "page" ? undefined : "self");
    const uuid = parseRoom(document.name).uuid;
    const successor = kind === "page" ? undefined : await create(database, uuid);
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, document, kind === "page" ? undefined : uuid);
    if (successor !== undefined) publish(directory, successor, uuid);
    directory.transact(() => {
      const entry = directory.getMap("docs").get(uuid) as Record<string, unknown>;
      directory.getMap("docs").set(uuid, { ...entry, deleted: true });
      directory.getMap("deleted-docs").set(uuid, true);
    });
    for (const target of successor === undefined ? [document] : [document, successor]) {
      expect(database.isDeletedRoom(target.name)).toBe(true);
      expect(persisted(database, target.name)).toBeUndefined();
      expect(database.revisions.list(target.name)).toEqual([]);
    }
  });

  it("deletes a topic's held record even when an earlier update removed its directory entry", async () => {
    const database = open();
    const topic = await create(database, "self");
    const topicUuid = parseRoom(topic.name).uuid;
    const record = await create(database, topicUuid);
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, topic, topicUuid);
    publish(directory, record, topicUuid);
    directory.getMap("docs").delete(parseRoom(record.name).uuid);
    tombstoneDirectoryEntry(directory, topicUuid);
    deleteDecisionTopic(directory, topicUuid);
    for (const target of [topic, record]) {
      expect(database.isDeletedRoom(target.name)).toBe(true);
      expect(persisted(database, target.name)).toBeUndefined();
      expect(database.revisions.list(target.name)).toEqual([]);
    }
  });

  it("fences a late record from its first room update without waiting for a directory entry", async () => {
    const path = tempDatabasePath();
    const first = open(path);
    const topic = await create(first, "self");
    const topicUuid = parseRoom(topic.name).uuid;
    const directory = await load(first, directoryRoom(WORKSPACE));
    publish(directory, topic, topicUuid);
    tombstoneDirectoryEntry(directory, topicUuid);
    deleteDecisionTopic(directory, topicUuid);
    const room = testRoom();
    const uuid = parseRoom(room).uuid;
    const late = await load(first, room);
    expect(first.isDeletedRoom(room)).toBe(false);

    initialize(late, uuid, topicUuid);

    expect(first.isDeletedRoom(room)).toBe(true);
    expect(() => first.requireRoom(room)).toThrow();
    await first.onStoreDocument({ document: late, documentName: room });
    expect(persisted(first, room)).toBeUndefined();
    expect(first.revisions.list(room)).toEqual([]);
    first.close();
    const restarted = open(path);
    expect(() => restarted.requireRoom(room)).toThrow();
    expect(persisted(restarted, room)).toBeUndefined();
    expect(restarted.revisions.list(room)).toEqual([]);
  });

  it.each(["legacy database", "legacy database with a held late record", "offline replica"])(
    "retains deleted topic evidence from a %s", async source => {
      const path = tempDatabasePath();
      const topicRoom = testRoom();
      const topicUuid = parseRoom(topicRoom).uuid;
      const recordRoom = testRoom();
      const uuid = parseRoom(recordRoom).uuid;
      const heldLate = source === "legacy database with a held late record" ? new Document(testRoom()) : undefined;
      if (heldLate !== undefined) {
        documents.push(heldLate);
        initialize(heldLate, parseRoom(heldLate.name).uuid, topicUuid);
      }
      const savedDirectory = new Document(directoryRoom(WORKSPACE));
      documents.push(savedDirectory);
      upsertDirectoryEntry(savedDirectory, { uuid: topicUuid, title: "Deleted topic", kind: "decision", topic: topicUuid, status: "open" });
      upsertDirectoryEntry(savedDirectory, { uuid, title: "Deleted successor", kind: "decision", topic: topicUuid, status: "open" });
      tombstoneDirectoryEntry(savedDirectory, topicUuid);
      deleteDecisionTopic(savedDirectory, topicUuid);
      expect(savedDirectory.getMap("docs").size).toBe(0);
      expect(savedDirectory.getMap("deleted-docs").get(topicUuid)).toBe(true);
      expect(savedDirectory.getMap("deleted-docs").get(uuid)).toBe(true);
      expect(savedDirectory.getMap("deleted-decision-topics").get(uuid)).toBe(topicUuid);

      if (source !== "offline replica") {
        const legacy = new DatabaseSync(path);
        try {
          legacy.exec("CREATE TABLE documents (name TEXT NOT NULL UNIQUE, data BLOB NOT NULL)");
          legacy.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
            .run(savedDirectory.name, Y.encodeStateAsUpdate(savedDirectory));
          if (heldLate !== undefined) legacy.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
            .run(heldLate.name, Y.encodeStateAsUpdate(heldLate));
        } finally { legacy.close(); }
      }
      const first = open(path);
      if (heldLate !== undefined) {
        for (const room of [topicRoom, recordRoom, heldLate.name]) {
          expect(first.isDeletedRoom(room)).toBe(true);
          expect(persisted(first, room)).toBeUndefined();
          expect(first.connection.prepare("SELECT topic, deleted FROM document_classifications WHERE name = ?").get(room))
            .toMatchObject({ topic: topicUuid, deleted: 1 });
        }
      }
      const directory = await load(first, savedDirectory.name);
      if (source === "offline replica") Y.applyUpdate(directory, Y.encodeStateAsUpdate(savedDirectory));
      expect(first.isDeletedRoom(topicRoom)).toBe(true);
      expect(first.isDeletedRoom(recordRoom)).toBe(true);
      expect(directory.getMap("deleted-docs").get(topicUuid)).toBe(true);
      expect(directory.getMap("deleted-docs").get(uuid)).toBe(true);
      expect(directory.getMap("deleted-decision-topics").get(uuid)).toBe(topicUuid);
      const liveTopic = await create(first, "self");
      const liveTopicUuid = parseRoom(liveTopic.name).uuid;
      const liveRecord = await create(first, liveTopicUuid);
      const liveUuid = parseRoom(liveRecord.name).uuid;
      publish(directory, liveTopic, liveTopicUuid);
      publish(directory, liveRecord, liveTopicUuid);
      directory.getMap("docs").set(liveUuid, { title: "Archived record of a live topic", tags: [], kind: "decision", topic: liveTopicUuid, deleted: true });
      const assertRetained = retained(first, liveRecord);
      deleteDirectoryEntry(directory, liveUuid);
      assertRetained();
      expect(directory.getMap("deleted-docs").has(liveUuid)).toBe(false);
      converged(directory, liveUuid);
      await first.onStoreDocument({ document: directory, documentName: directory.name });
      first.close();

      const restarted = open(path);
      expect(restarted.isDeletedRoom(topicRoom)).toBe(true);
      expect(restarted.isDeletedRoom(recordRoom)).toBe(true);
      const reloadedDirectory = await load(restarted, savedDirectory.name);
      expect(reloadedDirectory.getMap("deleted-docs").get(topicUuid)).toBe(true);
      expect(reloadedDirectory.getMap("deleted-docs").get(uuid)).toBe(true);
      expect(reloadedDirectory.getMap("deleted-decision-topics").get(uuid)).toBe(topicUuid);
      const stale = new Document(recordRoom);
      documents.push(stale);
      initialize(stale, uuid, topicUuid);
      await expect(restarted.onLoadDocument({ document: stale, documentName: recordRoom })).rejects.toMatchObject({ reason: DOC_DELETED_REASON });
      await restarted.onStoreDocument({ document: stale, documentName: recordRoom });
      expect(persisted(restarted, recordRoom)).toBeUndefined();

      const lateRoom = testRoom();
      const lateUuid = parseRoom(lateRoom).uuid;
      const late = await load(restarted, lateRoom);
      initialize(late, lateUuid, topicUuid);
      expect(restarted.isDeletedRoom(lateRoom)).toBe(true);
      publish(reloadedDirectory, late, topicUuid);
      await restarted.onStoreDocument({ document: late, documentName: lateRoom });
      expect(reloadedDirectory.getMap("deleted-docs").get(lateUuid)).toBe(true);
      expect(reloadedDirectory.getMap("docs").has(lateUuid)).toBe(false);
      expect(persisted(restarted, lateRoom)).toBeUndefined();
      expect(restarted.revisions.list(lateRoom)).toEqual([]);
      restarted.close();

      const again = open(path);
      for (const room of [topicRoom, recordRoom, lateRoom, ...(heldLate === undefined ? [] : [heldLate.name])]) {
        expect(again.isDeletedRoom(room)).toBe(true);
        expect(() => again.requireRoom(room)).toThrow();
        expect(persisted(again, room)).toBeUndefined();
      }
    },
  );

  it("retries unfinished stored page purges without trusting persisted topic membership", async () => {
    const path = tempDatabasePath();
    const original = open(path);
    const page = await create(original);
    const pageUuid = parseRoom(page.name).uuid;
    const assertRetained = retained(original, page);
    const deletedPage = await create(original);
    const deletedState = persisted(original, deletedPage.name);
    const deletedUuid = parseRoom(deletedPage.name).uuid;
    const topicUuid = parseRoom(testRoom()).uuid;
    const invalidRoom = roomForDoc(WORKSPACE, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
    const savedDirectory = new Document(directoryRoom(WORKSPACE));
    documents.push(savedDirectory);
    publish(savedDirectory, page, topicUuid);
    savedDirectory.getMap("deleted-docs").set(topicUuid, true);
    savedDirectory.getMap("deleted-docs").set(deletedUuid, true);
    savedDirectory.getMap("deleted-docs").set(parseRoom(invalidRoom).uuid, true);
    const savedState = Y.encodeStateAsUpdate(savedDirectory);
    original.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
      .run(savedDirectory.name, savedState);
    original.connection.exec("CREATE TRIGGER fail_startup_purge BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT, 'injected startup purge failure'); END");
    original.close();

    expect(() => original.open()).toThrow("injected startup purge failure");
    const failed = new DatabaseSync(path);
    try {
      expect(failed.prepare("SELECT data FROM documents WHERE name = ?").get(deletedPage.name)?.data).toEqual(deletedState);
      expect(failed.prepare("SELECT data FROM documents WHERE name = ?").get(savedDirectory.name)?.data).toEqual(savedState);
      expect(failed.prepare("SELECT deleted FROM document_classifications WHERE name = ?").get(deletedPage.name))
        .toMatchObject({ deleted: 0 });
      failed.exec("DROP TRIGGER fail_startup_purge");
    } finally { failed.close(); }

    original.open();
    expect(original.isDeletedRoom(deletedPage.name)).toBe(true);
    expect(original.isDeletedRoom(invalidRoom)).toBe(false);
    expect(persisted(original, deletedPage.name)).toBeUndefined();
    expect(original.revisions.list(deletedPage.name)).toEqual([]);
    assertRetained();
    const directory = await load(original, savedDirectory.name);
    converged(directory, pageUuid);
    original.close();

    original.open();
    assertRetained();
    expect(original.isDeletedRoom(deletedPage.name)).toBe(true);
    expect(persisted(original, deletedPage.name)).toBeUndefined();
    expect(original.revisions.list(deletedPage.name)).toEqual([]);
  });

  it("retries inferred deleted topic identity atomically when a late record arrives after a failed directory write", async () => {
    const path = tempDatabasePath();
    const first = open(path);
    const directory = await load(first, directoryRoom(WORKSPACE));
    const topicRoom = testRoom();
    const topicUuid = parseRoom(topicRoom).uuid;
    const recordRoom = testRoom();
    const uuid = parseRoom(recordRoom).uuid;
    const offline = new Y.Doc();
    documents.push(offline);
    upsertDirectoryEntry(offline, { uuid: topicUuid, title: "Deleted topic", kind: "decision", topic: topicUuid, status: "open" });
    upsertDirectoryEntry(offline, { uuid, title: "Deleted successor", kind: "decision", topic: topicUuid, status: "open" });
    tombstoneDirectoryEntry(offline, topicUuid);
    deleteDecisionTopic(offline, topicUuid);
    first.connection.exec("CREATE TRIGGER fail_deletion BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END");

    expect(() => Y.applyUpdate(directory, Y.encodeStateAsUpdate(offline))).toThrow("injected deletion failure");

    for (const room of [topicRoom, recordRoom]) {
      expect(first.isDeletedRoom(room)).toBe(true);
      expect(first.connection.prepare("SELECT topic, deleted FROM document_classifications WHERE name = ?").get(room)).toBeUndefined();
    }
    expect(persisted(first, directory.name)).toBeUndefined();
    first.connection.exec("DROP TRIGGER fail_deletion");

    const lateRoom = testRoom();
    const lateUuid = parseRoom(lateRoom).uuid;
    const late = await load(first, lateRoom);
    initialize(late, lateUuid, topicUuid);

    for (const [room, topic] of [[topicRoom, topicUuid], [recordRoom, topicUuid], [lateRoom, topicUuid]] as const) {
      expect(first.isDeletedRoom(room)).toBe(true);
      expect(first.connection.prepare("SELECT topic, deleted FROM document_classifications WHERE name = ?").get(room))
        .toMatchObject({ topic, deleted: 1 });
      expect(persisted(first, room)).toBeUndefined();
    }
    const storedDirectory = new Y.Doc();
    documents.push(storedDirectory);
    Y.applyUpdate(storedDirectory, persisted(first, directory.name)!);
    for (const deletedUuid of [topicUuid, uuid, lateUuid]) {
      expect(storedDirectory.getMap("deleted-docs").get(deletedUuid)).toBe(true);
    }
    expect(storedDirectory.getMap("deleted-decision-topics").get(uuid)).toBe(topicUuid);
    expect(storedDirectory.getMap("deleted-decision-topics").get(lateUuid)).toBe(topicUuid);
    first.close();

    const restarted = open(path);
    for (const room of [topicRoom, recordRoom, lateRoom]) {
      expect(restarted.isDeletedRoom(room)).toBe(true);
      expect(() => restarted.requireRoom(room)).toThrow();
      expect(persisted(restarted, room)).toBeUndefined();
    }
  });

  it.each(["refused held page link", "deleted page link", "self link"])(
    "does not infer topic identity from a %s", async source => {
      const path = tempDatabasePath();
      const database = open(path);
      const directory = await load(database, directoryRoom(WORKSPACE));
      const unknownRoom = testRoom();
      const unknownUuid = parseRoom(unknownRoom).uuid;
      const page = source === "self link" ? undefined : await create(database);
      const pageUuid = page === undefined ? undefined : parseRoom(page.name).uuid;
      if (page !== undefined) publish(directory, page);
      if (source === "deleted page link" && pageUuid !== undefined) {
        tombstoneDirectoryEntry(directory, pageUuid);
        deleteDirectoryEntry(directory, pageUuid);
      }
      const assertRetained = page === undefined || source === "deleted page link" ? undefined : retained(database, page);

      directory.transact(() => {
        directory.getMap("deleted-docs").set(unknownUuid, true);
        const claimant = pageUuid ?? unknownUuid;
        directory.getMap("deleted-docs").set(claimant, true);
        directory.getMap("deleted-decision-topics").set(claimant, unknownUuid);
      });

      expect(database.isDeletedRoom(unknownRoom)).toBe(true);
      expect(database.connection.prepare("SELECT topic, deleted FROM document_classifications WHERE name = ?").get(unknownRoom))
        .toMatchObject({ topic: null, deleted: 1 });
      assertRetained?.();
      if (pageUuid !== undefined && source !== "deleted page link") {
        expect(directory.getMap("deleted-docs").has(pageUuid)).toBe(false);
        expect(directory.getMap("deleted-decision-topics").has(pageUuid)).toBe(false);
        converged(directory, pageUuid);
      }

      const late = await create(database, unknownUuid);
      const lateUuid = parseRoom(late.name).uuid;
      publish(directory, late, unknownUuid);
      expect(database.isDeletedRoom(late.name)).toBe(false);
      expect(persisted(database, late.name)).toBeDefined();
      converged(directory, lateUuid);
      assertRetained?.();
      database.close();

      const restarted = open(path);
      expect(restarted.isDeletedRoom(unknownRoom)).toBe(true);
      expect(restarted.isDeletedRoom(late.name)).toBe(false);
      expect(persisted(restarted, late.name)).toBeDefined();
      if (page !== undefined) expect(restarted.isDeletedRoom(page.name)).toBe(source === "deleted page link");
    },
  );

  it("does not retain whole-topic authorization when persisting its archive and deletion failed", async () => {
    const path = tempDatabasePath();
    const first = open(path);
    const topic = await create(first, "self");
    const topicUuid = parseRoom(topic.name).uuid;
    const record = await create(first, topicUuid);
    const uuid = parseRoom(record.name).uuid;
    const directory = await load(first, directoryRoom(WORKSPACE));
    publish(directory, topic, topicUuid);
    publish(directory, record, topicUuid);
    await first.onStoreDocument({ document: directory, documentName: directory.name });
    first.connection.exec("CREATE TRIGGER fail_deletion BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END");
    expect(() => directory.transact(() => {
      const entry = directory.getMap("docs").get(topicUuid) as Record<string, unknown>;
      directory.getMap("docs").set(topicUuid, { ...entry, deleted: true });
      directory.getMap("deleted-docs").set(topicUuid, true);
    })).toThrow("injected deletion failure");
    first.connection.exec("DROP TRIGGER fail_deletion");
    first.close();

    const restarted = open(path);
    const held = await load(restarted, record.name);
    const reloadedDirectory = await load(restarted, directory.name);
    const assertRetained = retained(restarted, held);
    expect(isDirectoryEntryDeleted(reloadedDirectory, uuid)).toBe(false);
    reloadedDirectory.getMap("deleted-docs").set(topicUuid, true);
    assertRetained();
    converged(reloadedDirectory, uuid);
    expect(restarted.isDeletedRoom(topic.name)).toBe(false);
  });

  it("protects a page from a false topic while retrying a previously failed page purge", async () => {
    const database = open();
    const deletedPage = await create(database);
    const deletedUuid = parseRoom(deletedPage.name).uuid;
    const survivor = await create(database);
    const survivorUuid = parseRoom(survivor.name).uuid;
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, deletedPage);
    publish(directory, survivor);
    tombstoneDirectoryEntry(directory, deletedUuid);
    await database.onStoreDocument({ document: directory, documentName: directory.name });
    const assertRetained = retained(database, survivor);
    database.connection.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END");
    expect(() => deleteDirectoryEntry(directory, deletedUuid)).toThrow("injected purge failure");
    expect(database.isDeletedRoom(deletedPage.name)).toBe(true);
    expect(persisted(database, deletedPage.name)).toBeDefined();
    database.connection.exec("DROP TRIGGER fail_purge");

    directory.transact(() => {
      directory.getMap("deleted-docs").delete(deletedUuid);
      directory.getMap("docs").set(survivorUuid, {
        title: "False topic membership during retry", tags: [], kind: "decision", topic: deletedUuid,
      });
    });

    assertRetained();
    converged(directory, survivorUuid);
    expect(database.isDeletedRoom(deletedPage.name)).toBe(true);
    expect(persisted(database, deletedPage.name)).toBeUndefined();
    expect(database.revisions.list(deletedPage.name)).toEqual([]);
    expect(directory.getMap("deleted-docs").get(deletedUuid)).toBe(true);
  });

  it.each(["room metadata", "directory only", "room metadata over a conflicting directory"])(
    "seeds existing decision protection from %s on upgrade", async source => {
      const path = tempDatabasePath();
      const topic = parseRoom(testRoom()).uuid;
      const room = testRoom();
      const uuid = parseRoom(room).uuid;
      const legacyRecord = new Document(room);
      const legacyDirectory = new Document(directoryRoom(WORKSPACE));
      documents.push(legacyRecord, legacyDirectory);
      if (source === "directory only") legacyRecord.getText("body").insert(0, "Legacy content without metadata");
      else initialize(legacyRecord, uuid, topic);
      if (source !== "room metadata") legacyDirectory.getMap("docs").set(uuid, {
        title: "Legacy entry", tags: [], deleted: true,
        ...(source === "directory only" ? { kind: "decision", topic } : {}),
      });
      const legacy = new DatabaseSync(path);
      try {
        legacy.exec("CREATE TABLE documents (name TEXT NOT NULL UNIQUE, data BLOB NOT NULL)");
        legacy.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(room, Y.encodeStateAsUpdate(legacyRecord));
        legacy.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
          .run(legacyDirectory.name, Y.encodeStateAsUpdate(legacyDirectory));
      } finally { legacy.close(); }

      const upgraded = open(path);
      const directory = await load(upgraded, legacyDirectory.name);
      const state = persisted(upgraded, room);
      deleteDirectoryEntry(directory, uuid);
      expect(upgraded.isDeletedRoom(room)).toBe(false);
      expect(persisted(upgraded, room)).toEqual(state);
      converged(directory, uuid);
    },
  );

  it("isolates a corrupt legacy room while seeding protection for a valid decision", async () => {
    const path = tempDatabasePath();
    const room = testRoom();
    const uuid = parseRoom(room).uuid;
    const topic = parseRoom(testRoom()).uuid;
    const corruptRoom = testRoom();
    const legacyRecord = new Document(room);
    const legacyDirectory = new Document(directoryRoom(WORKSPACE));
    documents.push(legacyRecord, legacyDirectory);
    initialize(legacyRecord, uuid, topic);
    legacyDirectory.getMap("docs").set(uuid, { title: "Valid decision with a rewritten entry", tags: [], deleted: true });
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec("CREATE TABLE documents (name TEXT NOT NULL UNIQUE, data BLOB NOT NULL)");
      legacy.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(room, Y.encodeStateAsUpdate(legacyRecord));
      legacy.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(corruptRoom, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      legacy.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
        .run(legacyDirectory.name, Y.encodeStateAsUpdate(legacyDirectory));
    } finally { legacy.close(); }

    const upgraded = open(path);
    const directory = await load(upgraded, legacyDirectory.name);
    const state = persisted(upgraded, room);
    deleteDirectoryEntry(directory, uuid);
    expect(upgraded.isDeletedRoom(room)).toBe(false);
    expect(persisted(upgraded, room)).toEqual(state);
    converged(directory, uuid);
    await expect(load(upgraded, corruptRoom)).rejects.toThrow();
    expect(persisted(upgraded, corruptRoom)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect((await load(upgraded, room)).getText("body").toString()).toBe("Retained room content");
    const barrier = parseRoom(testRoom()).uuid;
    upsertDirectoryEntry(directory, { uuid: barrier, title: "Directory remains writable" });
    expect(directory.getMap("docs").has(barrier)).toBe(true);
  });
});
