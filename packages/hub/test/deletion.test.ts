import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Connection } from "@hocuspocus/server";
import { messageYjsUpdate } from "y-protocols/sync";
import {
  deleteDirectoryEntry,
  deleteDecisionRecord,
  deleteDecisionTopic,
  DIRECTORY_DELETED_DECISION_TOPICS_KEY,
  directoryRoom,
  enforceDeletedDirectoryEntries,
  getDirectoryEntry,
  initDoc,
  isDirectoryEntryDeleted,
  parseRoom,
  roomForDoc,
  resolveDecisionTopics,
  restoreDirectoryEntry,
  setKind,
  tombstoneDecisionRecord,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { DOC_DELETED_REASON } from "@uberblick/schema/protocol";
import { HubDatabase } from "../src/persistence.js";
import type { Hub, HubContext } from "../src/server.js";
import {
  acknowledged,
  createClient,
  removeTempDatabases,
  startHub,
  storedText,
  tempDatabasePath,
  testRoom,
  token,
  waitUntil,
  WORKSPACE,
  type TestClient,
} from "./helpers.js";

const clients: TestClient[] = [];
const hubs: Hub[] = [];

function decision(uuid: string, topic: string): Y.Doc {
  const document = new Y.Doc();
  document.transact(() => {
    initDoc(document, { uuid, title: "Question", topic, ...(uuid === topic ? {} : { supersedes: topic }) });
    setKind(document, "decision");
  });
  return document;
}

async function hub(databasePath: string): Promise<Hub> {
  const started = await startHub({ databasePath, debounce: 60_000, maxDebounce: 60_000 });
  hubs.push(started);
  return started;
}

async function client(started: Hub, room: string, doc?: Y.Doc): Promise<TestClient> {
  const created = createClient({
    port: started.port,
    room,
    token: await token(),
    ...(doc === undefined ? {} : { doc }),
    reconnectDelayMs: 60_000,
  });
  clients.push(created);
  return created;
}

function storedDirectoryState(databasePath: string): Uint8Array {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT data FROM documents WHERE name = ?")
      .get(directoryRoom(WORKSPACE))!.data as Uint8Array;
  } finally { database.close(); }
}

afterEach(async () => {
  for (const created of clients.splice(0)) created.destroy();
  for (const started of hubs.splice(0)) await started.stop();
  removeTempDatabases();
});

describe("permanent room deletion", () => {
  it.each(["coalesced reconnect", "ordered updates"])("keeps single-record marks through %s without deleting the topic, and requires rearchiving a late record", async (delivery) => {
    const databasePath = tempDatabasePath();
    const first = await hub(databasePath);
    const topicRoom = testRoom();
    const middleRoom = testRoom();
    const lateRoom = testRoom();
    const topic = parseRoom(topicRoom).uuid;
    const middle = parseRoom(middleRoom).uuid;
    const late = parseRoom(lateRoom).uuid;
    const topicWriter = await client(first, topicRoom, decision(topic, topic));
    const middleWriter = await client(first, middleRoom, decision(middle, topic));
    const lateWriter = await client(first, lateRoom, decision(late, topic));
    const directory = await client(first, directoryRoom(WORKSPACE));
    await Promise.all([topicWriter.synced, middleWriter.synced, lateWriter.synced, directory.synced]);
    topicWriter.text.insert(0, "first answer stays");
    middleWriter.text.insert(0, "middle answer removed");
    lateWriter.text.insert(0, "late answer removed later");
    await Promise.all([acknowledged(topicWriter), acknowledged(middleWriter), acknowledged(lateWriter)]);
    upsertDirectoryEntry(directory.doc, { uuid: topic, title: "Question", kind: "decision", topic, status: "decided" });
    upsertDirectoryEntry(directory.doc, { uuid: middle, title: "Question", kind: "decision", topic, supersedes: topic, status: "decided" });
    tombstoneDirectoryEntry(directory.doc, topic);
    await acknowledged(directory, "topic archive");
    upsertDirectoryEntry(directory.doc, { uuid: late, title: "Late answer", kind: "decision", topic, supersedes: middle, status: "decided" });
    await acknowledged(directory, "late record with a live stub");
    expect(getDirectoryEntry(directory.doc, late)?.deleted).toBeUndefined();
    await first.flush();

    const offline = new Y.Doc();
    try {
      Y.applyUpdate(offline, Y.encodeStateAsUpdate(directory.doc));
      expect(deleteDecisionRecord(offline, middle)).toBe(true);
      if (delivery === "coalesced reconnect") {
        const reconnect = await client(first, directoryRoom(WORKSPACE), offline);
        await reconnect.synced;
        await acknowledged(reconnect, "offline middle-record deletion");
        await waitUntil("middle mark to reach the existing reader", () => isDirectoryEntryDeleted(directory.doc, middle));
      } else {
        Y.applyUpdate(directory.doc, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(directory.doc)));
        await acknowledged(directory, "middle-record deletion");
      }
      expect(await middleWriter.denied).toBe(DOC_DELETED_REASON);
      expect(resolveDecisionTopics(directory.doc)[0]?.inForce?.uuid).toBe(late);
      expect(resolveDecisionTopics(directory.doc)[0]?.conflicts).toEqual([]);
      expect(storedText(databasePath, middleRoom)).toBeNull();
      expect(storedText(databasePath, topicRoom)).toBe("first answer stays");
      expect(storedText(databasePath, lateRoom)).toBe("late answer removed later");

      expect(isDirectoryEntryDeleted(directory.doc, middle)).toBe(true);
      expect(directory.doc.getMap("docs").has(middle)).toBe(false);

      Y.applyUpdate(offline, Y.encodeStateAsUpdate(directory.doc));
      expect(deleteDecisionRecord(offline, late)).toBe(false);
      restoreDirectoryEntry(directory.doc, topic);
      await acknowledged(directory, "topic restoration before rearchiving");
      tombstoneDirectoryEntry(directory.doc, topic);
      await acknowledged(directory, "topic rearchive includes late record");
      expect(getDirectoryEntry(directory.doc, late)?.deleted).toBe(true);
      Y.applyUpdate(offline, Y.encodeStateAsUpdate(directory.doc));
      expect(deleteDecisionRecord(offline, late)).toBe(true);
      const deletion = Y.encodeStateAsUpdate(offline, Y.encodeStateVector(directory.doc));
      Y.applyUpdate(directory.doc, deletion);
      await acknowledged(directory, "rearchived late-record deletion in one update");
      expect(await lateWriter.denied).toBe(DOC_DELETED_REASON);
      expect(isDirectoryEntryDeleted(directory.doc, late)).toBe(true);
      expect(isDirectoryEntryDeleted(directory.doc, topic)).toBe(false);
      expect(resolveDecisionTopics(directory.doc)[0]?.inForce?.uuid).toBe(topic);
      expect(storedText(databasePath, lateRoom)).toBeNull();

      restoreDirectoryEntry(directory.doc, topic);
      await acknowledged(directory, "remaining topic restoration");
      expect(resolveDecisionTopics(directory.doc)[0]?.records.map(record => record.uuid)).toEqual([topic]);
      expect(resolveDecisionTopics(directory.doc)[0]?.archived).toBe(false);
      await first.flush();
    } finally { offline.destroy(); }

    for (const created of clients.splice(0)) created.destroy();
    await first.stop();
    hubs.length = 0;
    const second = await hub(databasePath);
    expect(await (await client(second, middleRoom)).denied).toBe(DOC_DELETED_REASON);
    expect(await (await client(second, lateRoom)).denied).toBe(DOC_DELETED_REASON);
    const surviving = await client(second, topicRoom);
    await surviving.synced;
    expect(surviving.text.toString()).toBe("first answer stays");
  });

  it.each(["after archive", "after deletion"])("purges a whole topic and a late record arriving %s, including across restart", async (arrival) => {
    const databasePath = tempDatabasePath();
    const first = await hub(databasePath);
    const topicRoom = testRoom();
    const formerRoom = testRoom();
    const currentRoom = testRoom();
    const lateRoom = testRoom();
    const topic = parseRoom(topicRoom).uuid;
    const former = parseRoom(formerRoom).uuid;
    const current = parseRoom(currentRoom).uuid;
    const late = parseRoom(lateRoom).uuid;
    const topicWriter = await client(first, topicRoom, decision(topic, topic));
    const formerWriter = await client(first, formerRoom, decision(former, topic));
    const currentWriter = await client(first, currentRoom, decision(current, topic));
    const lateWriter = await client(first, lateRoom, arrival === "after archive" ? decision(late, topic) : undefined);
    const directory = await client(first, directoryRoom(WORKSPACE));
    await Promise.all([topicWriter.synced, formerWriter.synced, currentWriter.synced, lateWriter.synced, directory.synced]);
    for (const writer of [topicWriter, formerWriter, currentWriter]) {
      writer.text.insert(0, "topic record content");
      await acknowledged(writer);
    }
    for (const [uuid, status] of [[topic, "decided"], [former, "rejected"], [current, "open"]] as const) {
      upsertDirectoryEntry(directory.doc, { uuid, title: "Question", kind: "decision", topic, status });
    }
    expect(tombstoneDecisionRecord(directory.doc, former)).toBe(true);
    await acknowledged(directory, "topic records");
    await first.flush();
    tombstoneDirectoryEntry(directory.doc, topic);
    await acknowledged(directory, "topic archive");

    if (arrival === "after archive") {
      upsertDirectoryEntry(directory.doc, { uuid: late, title: "Late proposal", kind: "decision", topic, status: "open" });
      await acknowledged(directory, "late proposal");
      expect(getDirectoryEntry(directory.doc, late)?.deleted).toBeUndefined();
    }
    deleteDecisionTopic(directory.doc, current);
    await acknowledged(directory, "topic deletion");

    if (arrival === "after deletion") {
      // A replica can collect an unseen stub before the creator uploads its room metadata.
      const cleaner = new Y.Doc();
      try {
        Y.applyUpdate(cleaner, Y.encodeStateAsUpdate(directory.doc));
        upsertDirectoryEntry(cleaner, { uuid: late, title: "GC erased late proposal", kind: "decision", topic, status: "open" });
        enforceDeletedDirectoryEntries(cleaner);
        expect(cleaner.getMap("docs").has(late)).toBe(false);
        expect(cleaner.getMap(DIRECTORY_DELETED_DECISION_TOPICS_KEY).get(late)).toBe(topic);
        const update = Y.encodeStateAsUpdate(cleaner, Y.encodeStateVector(directory.doc));
        expect(Buffer.from(update).includes("GC erased late proposal")).toBe(false);
        Y.applyUpdate(directory.doc, update);
      } finally { cleaner.destroy(); }
      await acknowledged(directory, "late deletion evidence");
    }
    const rooms = [topicRoom, formerRoom, currentRoom, lateRoom];
    await Promise.all([topicWriter, formerWriter, currentWriter, lateWriter].map(async writer => {
      expect(await writer.denied).toBe(DOC_DELETED_REASON);
    }));
    for (const room of rooms) {
      expect(storedText(databasePath, room)).toBeNull();
      expect(first.hocuspocus.documents.has(room)).toBe(false);
    }
    expect(directory.doc.getMap("deleted-docs").get(late)).toBe(true);
    for (const created of clients.splice(0)) created.destroy();
    await first.stop();
    hubs.length = 0;

    const second = await hub(databasePath);
    for (const room of rooms) {
      expect(await (await client(second, room)).denied).toBe(DOC_DELETED_REASON);
      expect(storedText(databasePath, room)).toBeNull();
    }
  });

  it("rejects a raw whole-topic deletion when the topic authority is live", async () => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath);
    const topicRoom = testRoom();
    const recordRoom = testRoom();
    const topic = parseRoom(topicRoom).uuid;
    const record = parseRoom(recordRoom).uuid;
    const topicWriter = await client(started, topicRoom, decision(topic, topic));
    const recordWriter = await client(started, recordRoom, decision(record, topic));
    const directory = await client(started, directoryRoom(WORKSPACE));
    await Promise.all([topicWriter.synced, recordWriter.synced, directory.synced]);
    topicWriter.text.insert(0, "live topic");
    recordWriter.text.insert(0, "archived record");
    await Promise.all([acknowledged(topicWriter), acknowledged(recordWriter)]);
    upsertDirectoryEntry(directory.doc, { uuid: topic, title: "Live topic", kind: "decision", topic, status: "decided" });
    upsertDirectoryEntry(directory.doc, { uuid: record, title: "Archived proposal", kind: "decision", topic, status: "rejected" });
    expect(tombstoneDecisionRecord(directory.doc, record)).toBe(true);
    await acknowledged(directory, "live topic and separate record archive");

    deleteDecisionTopic(directory.doc, record);
    await acknowledged(directory, "unarchived topic deletion");
    await waitUntil("both topic marks to be refused", () => !isDirectoryEntryDeleted(directory.doc, topic) && !isDirectoryEntryDeleted(directory.doc, record));
    expect(getDirectoryEntry(directory.doc, topic)?.deleted).toBeUndefined();
    expect(getDirectoryEntry(directory.doc, record)?.recordArchived).toBe(true);
    expect(started.hocuspocus.documents.has(roomForDoc(WORKSPACE, topic))).toBe(true);
    expect(started.hocuspocus.documents.has(recordRoom)).toBe(true);
    await started.flush();
    expect(storedText(databasePath, topicRoom)).toBe("live topic");
    expect(storedText(databasePath, recordRoom)).toBe("archived record");
  });

  it("converges after refusing a page's false membership in a deleted topic", async () => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath);
    const topicRoom = testRoom();
    const pageRoom = testRoom();
    const topic = parseRoom(topicRoom).uuid;
    const page = parseRoom(pageRoom).uuid;
    const topicWriter = await client(started, topicRoom, decision(topic, topic));
    const pageDocument = new Y.Doc();
    initDoc(pageDocument, { uuid: page, title: "Live page" });
    const pageWriter = await client(started, pageRoom, pageDocument);
    const writer = await client(started, directoryRoom(WORKSPACE));
    const reader = await client(started, directoryRoom(WORKSPACE));
    await Promise.all([topicWriter.synced, pageWriter.synced, writer.synced, reader.synced]);
    pageWriter.text.insert(0, "Kept page");
    await acknowledged(pageWriter);
    upsertDirectoryEntry(writer.doc, { uuid: topic, title: "Archived topic", kind: "decision", topic, status: "open" });
    upsertDirectoryEntry(writer.doc, { uuid: page, title: "Live page" });
    await acknowledged(writer, "initial directory");
    await started.flush();
    tombstoneDirectoryEntry(writer.doc, topic);
    await acknowledged(writer, "topic archive");
    writer.doc.getMap("docs").set(page, { title: "False membership", tags: [], kind: "decision", topic });
    await acknowledged(writer, "false topic membership");
    writer.doc.getMap("deleted-docs").set(topic, true);
    await acknowledged(writer, "topic deletion");
    await waitUntil("the corrected entry to reach both directory replicas", () =>
      [writer, reader].every(replica =>
        getDirectoryEntry(replica.doc, page)?.title === "False membership" && !isDirectoryEntryDeleted(replica.doc, page)),
    );

    for (const replica of [writer, reader]) {
      enforceDeletedDirectoryEntries(replica.doc);
      expect(isDirectoryEntryDeleted(replica.doc, page)).toBe(false);
    }
    const barrier = parseRoom(testRoom()).uuid;
    upsertDirectoryEntry(writer.doc, { uuid: barrier, title: "Later directory update" });
    await acknowledged(writer, "later directory update");
    await waitUntil("the later directory update to reach the reader", () => getDirectoryEntry(reader.doc, barrier) !== undefined);
    const held = started.hocuspocus.documents.get(directoryRoom(WORKSPACE))!;
    expect(isDirectoryEntryDeleted(held, page)).toBe(false);
    expect(isDirectoryEntryDeleted(reader.doc, page)).toBe(false);
    pageWriter.text.insert(pageWriter.text.length, ", still writable");
    await acknowledged(pageWriter);
    await started.flush();
    expect(storedText(databasePath, pageRoom)).toBe("Kept page, still writable");
    expect(started.hocuspocus.documents.has(pageRoom)).toBe(true);
  });

  it("persists fresh deletion before acknowledgement while later directory writes stay debounced", async () => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath);
    const room = testRoom();
    const survivorUuid = parseRoom(testRoom()).uuid;
    const writer = await client(started, room);
    const directory = await client(started, directoryRoom(WORKSPACE));
    await Promise.all([writer.synced, directory.synced]);
    writer.text.insert(0, "removed immediately");
    await acknowledged(writer);
    directory.doc.getMap("docs").set(survivorUuid, { title: "Before", tags: [] });
    await acknowledged(directory, "surviving entry");
    await started.flush();

    tombstoneDirectoryEntry(directory.doc, parseRoom(room).uuid);
    await acknowledged(directory, "archive");
    deleteDirectoryEntry(directory.doc, parseRoom(room).uuid);
    await acknowledged(directory, "deletion");
    expect(storedText(databasePath, room)).toBeNull();
    const deletionState = storedDirectoryState(databasePath);
    const persisted = new Y.Doc();
    try {
      Y.applyUpdate(persisted, deletionState);
      expect(isDirectoryEntryDeleted(persisted, parseRoom(room).uuid)).toBe(true);
    } finally { persisted.destroy(); }

    directory.doc.getMap("docs").set(survivorUuid, { title: "After", tags: [] });
    await acknowledged(directory, "ordinary directory write");
    expect(storedDirectoryState(databasePath)).toEqual(deletionState);
    await started.flush();
    expect(storedDirectoryState(databasePath)).not.toEqual(deletionState);
  });

  it("retries failed deletion persistence on a later directory transaction without losing the fence", async () => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath);
    const room = testRoom();
    const writer = await client(started, room);
    const directory = await client(started, directoryRoom(WORKSPACE));
    await Promise.all([writer.synced, directory.synced]);
    writer.text.insert(0, "awaiting removal");
    await acknowledged(writer);
    await started.flush();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("CREATE TRIGGER fail_store BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'injected store failure'); END");
      const loaded = started.hocuspocus.documents.get(directoryRoom(WORKSPACE))!;
      tombstoneDirectoryEntry(loaded, parseRoom(room).uuid);
      expect(() => deleteDirectoryEntry(loaded, parseRoom(room).uuid)).toThrow("injected store failure");
      const persistence = started.hocuspocus.configuration.extensions.find(extension => extension instanceof HubDatabase)!;
      expect(persistence.isDeletedRoom(room)).toBe(true);
      expect(storedText(databasePath, room)).toBe("awaiting removal");

      database.exec("DROP TRIGGER fail_store");
      loaded.getMap("docs").set(parseRoom(testRoom()).uuid, { title: "Later write", tags: [] });
      expect(storedText(databasePath, room)).toBeNull();
      const persisted = new Y.Doc();
      try {
        Y.applyUpdate(persisted, storedDirectoryState(databasePath));
        expect(isDirectoryEntryDeleted(persisted, parseRoom(room).uuid)).toBe(true);
      } finally { persisted.destroy(); }
    } finally {
      database.exec("DROP TRIGGER IF EXISTS fail_store");
      database.close();
      for (const created of clients.splice(0)) created.destroy();
      hubs.splice(hubs.indexOf(started), 1);
      await expect(started.stop()).rejects.toThrow(/not durable/);
    }
  });

  it.each(["during load", "after the final load guard"])("refuses a connection deleted %s", async (phase) => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath);
    const room = testRoom();
    const directory = await client(started, directoryRoom(WORKSPACE));
    await directory.synced;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const pause = async ({ documentName }: { documentName: string }): Promise<void> => {
      if (documentName !== room) return;
      entered = true;
      await held;
    };
    const extensions = started.hocuspocus.configuration.extensions;
    if (phase === "during load") extensions.splice(extensions.length - 1, 0, { onLoadDocument: pause });
    else extensions.push({ afterLoadDocument: pause });
    const connecting = await client(started, room);
    try {
      await waitUntil("the admission to pause during loading", () => entered);
      tombstoneDirectoryEntry(directory.doc, parseRoom(room).uuid);
      await acknowledged(directory, "archive");
      deleteDirectoryEntry(directory.doc, parseRoom(room).uuid);
      await acknowledged(directory, "deletion");
      release();
      expect(await connecting.denied).toBe(DOC_DELETED_REASON);
      await waitUntil("the refused room to leave memory", () => !started.hocuspocus.documents.has(room));
      await started.flush();
      expect(storedText(databasePath, room)).toBeNull();
    } finally { release(); }
  });

  it.each([false, true])("fences an authorized update paused before apply, including after detach=%s", async (detached) => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath);
    const room = testRoom();
    const writer = await client(started, room);
    const directory = await client(started, directoryRoom(WORKSPACE));
    await Promise.all([writer.synced, directory.synced]);
    writer.text.insert(0, "preserved");
    await acknowledged(writer);
    await started.flush();
    const document = started.hocuspocus.documents.get(room)!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let paused: Connection<HubContext> | undefined;
    // Run after the core guard, so deletion has to fence its check-to-apply gap.
    started.hocuspocus.configuration.extensions.push({
      async beforeSync({ documentName, type, connection }) {
        if (documentName !== room || type !== messageYjsUpdate || paused !== undefined) return;
        paused = connection;
        await held;
      },
    });
    try {
      writer.text.insert(0, "held update ");
      await waitUntil("the update to pause after authorization", () => paused !== undefined);
      writer.text.insert(writer.text.length, " queued update");
      if (detached) paused!.close({ code: 1000, reason: "unrelated closure" });
      tombstoneDirectoryEntry(directory.doc, parseRoom(room).uuid);
      await acknowledged(directory, "archive");
      deleteDirectoryEntry(directory.doc, parseRoom(room).uuid);
      await acknowledged(directory, "deletion");
      expect(paused!.readOnly).toBe(true);
      release();
      await paused!.waitForPendingMessages();
      expect(document.getText("body").toString()).toBe("preserved");
      await started.flush();
      expect(storedText(databasePath, room)).toBeNull();
    } finally { release(); }
  });

  it("purges a loaded room, fences pending stores and an offline reconnect, and keeps other rooms syncing", async () => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath);
    const room = testRoom();
    const writer = await client(started, room);
    const directory = await client(started, directoryRoom(WORKSPACE));
    const survivor = await client(started, testRoom());
    await Promise.all([writer.synced, directory.synced, survivor.synced]);
    writer.text.insert(0, "private content");
    await acknowledged(writer);
    await started.flush();
    const staleState = Y.encodeStateAsUpdate(writer.doc);
    writer.text.insert(writer.text.length, " pending debounce");
    await acknowledged(writer);
    directory.doc.getMap("docs").set(parseRoom(room).uuid, {
      title: "private directory title", description: "private directory description", tags: [], deleted: true,
    });
    await acknowledged(directory, "archived directory metadata");

    let reason: string | undefined;
    writer.provider.on("close", ({ event }: { event: { reason: string } }) => { reason = event.reason; });
    deleteDirectoryEntry(directory.doc, parseRoom(room).uuid);
    await acknowledged(directory, "deletion");
    await waitUntil("the deleted room to close", () => reason !== undefined);
    expect(reason).toBe(DOC_DELETED_REASON);
    expect(await writer.denied).toBe(DOC_DELETED_REASON);
    expect(storedText(databasePath, room)).toBeNull();
    expect(started.hocuspocus.documents.has(room)).toBe(false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const bytes = database.prepare("SELECT data FROM documents WHERE name = ?").get(directoryRoom(WORKSPACE))!.data as Uint8Array;
      expect(Buffer.from(bytes).includes("private directory title")).toBe(false);
      expect(Buffer.from(bytes).includes("private directory description")).toBe(false);
    } finally { database.close(); }

    const offline = new Y.Doc();
    Y.applyUpdate(offline, staleState);
    offline.getText("body").insert(0, "offline write ");
    const reconnect = await client(started, room, offline);
    expect(await reconnect.denied).toBe(DOC_DELETED_REASON);
    expect(offline.getText("body").toString()).toBe("offline write private content");
    survivor.text.insert(0, "still syncing");
    await acknowledged(survivor);
    await started.flush();
    expect(storedText(databasePath, room)).toBeNull();
  });

  it("loads deletion evidence before admission and removes a stale row on restart without opening the directory", async () => {
    const databasePath = tempDatabasePath();
    const first = await hub(databasePath);
    const room = testRoom();
    const writer = await client(first, room);
    const directory = await client(first, directoryRoom(WORKSPACE));
    await Promise.all([writer.synced, directory.synced]);
    writer.text.insert(0, "old content");
    await acknowledged(writer);
    const staleState = Y.encodeStateAsUpdate(writer.doc);
    tombstoneDirectoryEntry(directory.doc, parseRoom(room).uuid);
    await acknowledged(directory, "archive");
    deleteDirectoryEntry(directory.doc, parseRoom(room).uuid);
    await acknowledged(directory, "deletion");
    for (const created of clients.splice(0)) created.destroy();
    await first.stop();
    hubs.length = 0;

    const database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(room, staleState);
    database.close();
    expect(storedText(databasePath, room)).toBe("old content");

    const second = await hub(databasePath);
    expect(storedText(databasePath, room)).toBeNull();
    const reconnect = await client(second, room);
    expect(await reconnect.denied).toBe(DOC_DELETED_REASON);
    expect(second.hocuspocus.documents.has(room)).toBe(false);
  });

  it.each(["leaves the live entry in place", "removes the live entry in the same change", "removed the live entry earlier"])(
    "reverses a deletion mark for a live, unarchived document when the writer %s", async (shape) => {
      const databasePath = tempDatabasePath();
      const started = await hub(databasePath);
      const room = testRoom();
      const uuid = parseRoom(room).uuid;
      const writer = await client(started, room);
      const directory = await client(started, directoryRoom(WORKSPACE));
      await Promise.all([writer.synced, directory.synced]);
      writer.text.insert(0, "live content");
      await acknowledged(writer);
      const live = { title: "Live, never archived", tags: [] };
      directory.doc.getMap("docs").set(uuid, live);
      await acknowledged(directory, "live entry");

      if (shape === "removed the live entry earlier") {
        directory.doc.getMap("docs").delete(uuid);
        await acknowledged(directory, "entry removal");
      }
      if (shape === "removes the live entry in the same change") deleteDirectoryEntry(directory.doc, uuid);
      else directory.doc.getMap("deleted-docs").set(uuid, true);
      await acknowledged(directory, "unarchived deletion mark");
      await waitUntil("the reversal to reach the writer", () => !isDirectoryEntryDeleted(directory.doc, uuid));

      const held = started.hocuspocus.documents.get(directoryRoom(WORKSPACE))!;
      expect(isDirectoryEntryDeleted(held, uuid)).toBe(false);
      if (shape !== "removed the live entry earlier") {
        expect(held.getMap("docs").get(uuid)).toEqual(live);
        expect(directory.doc.getMap("docs").get(uuid)).toEqual(live);
      }
      expect(started.hocuspocus.documents.has(room)).toBe(true);
      writer.text.insert(writer.text.length, ", still writable");
      await acknowledged(writer);
      await started.flush();
      expect(storedText(databasePath, room)).toBe("live content, still writable");
      const persisted = new Y.Doc();
      try {
        Y.applyUpdate(persisted, storedDirectoryState(databasePath));
        expect(isDirectoryEntryDeleted(persisted, uuid)).toBe(false);
      } finally { persisted.destroy(); }
    },
  );

  it("keeps stored rooms when the directory is missing or empty", async () => {
    const databasePath = tempDatabasePath();
    const first = await hub(databasePath);
    const room = testRoom();
    const writer = await client(first, room);
    await writer.synced;
    writer.text.insert(0, "kept without a directory entry");
    await acknowledged(writer);
    await first.flush();
    const directory = await client(first, directoryRoom(WORKSPACE));
    await directory.synced;
    await first.flush();
    expect(storedText(databasePath, room)).toBe("kept without a directory entry");
    for (const created of clients.splice(0)) created.destroy();
    await first.stop();
    hubs.length = 0;
    const second = await hub(databasePath);
    const reader = await client(second, room);
    await reader.synced;
    expect(reader.text.toString()).toBe("kept without a directory entry");
  });
});
