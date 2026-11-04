import { DatabaseSync } from "node:sqlite";
import { Document } from "@hocuspocus/server";
import {
  deleteDecisionTopic,
  deleteDirectoryEntry,
  directoryRoom,
  enforceDeletedDirectoryEntries,
  initDoc,
  isDirectoryEntryDeleted,
  parseRoom,
  setKind,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
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

function retained(database: HubDatabase, document: Document): () => void {
  const state = persisted(database, document.name);
  const history = database.revisions.list(document.name);
  expect(history.length).toBeGreaterThan(0);
  const snapshots = history.map(revision => database.revisions.getSnapshot(document.name, revision.id));
  return () => {
    expect(database.isDeletedRoom(document.name)).toBe(false);
    expect(() => database.requireRoom(document.name)).not.toThrow();
    expect(persisted(database, document.name)).toEqual(state);
    expect(database.revisions.list(document.name)).toEqual(history);
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

  it("refuses deleting an archived record alone even when its topic is archived", async () => {
    const database = open();
    const topic = await create(database, "self");
    const topicUuid = parseRoom(topic.name).uuid;
    const record = await create(database, topicUuid);
    const uuid = parseRoom(record.name).uuid;
    const directory = await load(database, directoryRoom(WORKSPACE));
    publish(directory, topic, topicUuid);
    publish(directory, record, topicUuid);
    tombstoneDirectoryEntry(directory, topicUuid);
    const assertRetained = retained(database, record);
    deleteDirectoryEntry(directory, uuid);
    assertRetained();
    converged(directory, uuid);
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
});
