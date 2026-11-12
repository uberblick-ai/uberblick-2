import { Document } from "@hocuspocus/server";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { DIRECTORY_DOCS_KEY, roomForDoc } from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { HubLogRecord } from "../src/log.js";
import { collectWorkspaceMetrics } from "../src/metrics.js";
import { HubDatabase } from "../src/persistence.js";
import { createHub, type Hub } from "../src/server.js";
import {
  acknowledged,
  createClient,
  OTHER_WORKSPACE,
  removeTempDatabases,
  storedText,
  tempDatabasePath,
  TEST_SECRET,
  testRoom,
  token,
  waitUntil,
  WORKSPACE,
  type TestClient,
} from "./helpers.js";

const ACTIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARCHIVED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HISTORY_ONLY_WORKSPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INTERVAL_MS = 20;
const databases: HubDatabase[] = [];
const documents: Y.Doc[] = [];
const hubs: Hub[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  for (const document of documents.splice(0)) document.destroy();
  for (const database of databases.splice(0)) database.close();
  removeTempDatabases();
});

function database(revisions = false, onFailed: (error: unknown) => void = () => {}): HubDatabase {
  const result = new HubDatabase(":memory:", onFailed, { revisions });
  result.open();
  databases.push(result);
  return result;
}

function metrics(records: HubLogRecord[]): HubLogRecord[] {
  return records.filter(record => record.event === "hub.metrics");
}

describe("workspace metric figures", () => {
  it("sums stored room and revision bytes without exposing room names or contents", async () => {
    const db = database();
    const connection = db.connection;
    const room = roomForDoc(WORKSPACE, ACTIVE);
    const archived = roomForDoc(WORKSPACE, ARCHIVED);
    const other = roomForDoc(OTHER_WORKSPACE, ACTIVE);
    const historical = roomForDoc(HISTORY_ONLY_WORKSPACE, ACTIVE);
    const directory = new Y.Doc();
    documents.push(directory);
    directory.getMap(DIRECTORY_DOCS_KEY).set(ARCHIVED, { title: "private archived title", deleted: true });
    const directoryBytes = Y.encodeStateAsUpdate(directory);
    const insertRoom = connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)");
    insertRoom.run(room, new Uint8Array(11));
    insertRoom.run(archived, new Uint8Array(13));
    insertRoom.run(roomForDoc(WORKSPACE, "_directory"), directoryBytes);
    insertRoom.run(roomForDoc(WORKSPACE, "_sidebar"), new Uint8Array(2));
    insertRoom.run(roomForDoc(WORKSPACE, "_settings"), new Uint8Array(3));
    insertRoom.run(roomForDoc(WORKSPACE, "_github_items"), new Uint8Array(4));
    insertRoom.run(other, new Uint8Array(29));
    insertRoom.run("private-workspace-name/private-document-title", Buffer.from("private document content"));
    const insertRevision = connection.prepare(`INSERT INTO document_revisions
      (id, room, author, started_at, ended_at, checksum, data) VALUES (?, ?, ?, 0, 1, 'checksum', ?)`);
    insertRevision.run("revision-one", room, "private author", new Uint8Array(17));
    insertRevision.run("revision-two", archived, "private author", new Uint8Array(19));
    insertRevision.run("revision-other", other, null, new Uint8Array(31));
    insertRevision.run("revision-only", historical, null, new Uint8Array(41));
    const insertHead = connection.prepare(`INSERT INTO document_revision_heads
      (room, id, author, author_key, started_at, checksum, previous_checksum, data)
      VALUES (?, ?, 'private author', 'private author key', 0, 'checksum', 'previous', ?)`);
    insertHead.run(room, "head-one", new Uint8Array(23));
    insertHead.run(archived, "head-null", null);
    insertHead.run(other, "head-other", new Uint8Array(37));
    insertHead.run(historical, "head-only", new Uint8Array(43));

    const result = await collectWorkspaceMetrics(connection);
    expect(result).toEqual({
      [WORKSPACE]: { documentCount: 2, storedBytes: 92 + directoryBytes.length },
      [OTHER_WORKSPACE]: { documentCount: 1, storedBytes: 97 },
      [HISTORY_ONLY_WORKSPACE]: { documentCount: 0, storedBytes: 84 },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain(ACTIVE);
    expect(serialized).not.toContain(ARCHIVED);
    expect(serialized).not.toContain("_directory");
  });

  it("accounts for real room and revision writes once, then resets the interval", async () => {
    const db = database(true);
    const room = testRoom();
    const document = new Document(room);
    documents.push(document);
    await db.onLoadDocument({ documentName: room, document });
    document.getMap("meta").set("title", "private content");
    await db.onStoreDocument({ documentName: room, document });

    const timing = db.writeTiming.take();
    expect(timing.roomStoreMs).toBeGreaterThan(0);
    expect(timing.revisionWriteMs).toBeGreaterThan(0);
    expect(db.writeTiming.take()).toEqual({ roomStoreMs: 0, revisionWriteMs: 0 });

    const local = database();
    const localDocument = new Document(room);
    documents.push(localDocument);
    await local.onLoadDocument({ documentName: room, document: localDocument });
    localDocument.getMap("meta").set("title", "local content");
    await local.onStoreDocument({ documentName: room, document: localDocument });
    expect(local.writeTiming.take()).toMatchObject({ roomStoreMs: expect.any(Number), revisionWriteMs: 0 });
  });
});

describe("periodic hub metrics", () => {
  it("counts unique sockets and direct connections, reports idle intervals, and ends on stop", async () => {
    const records: HubLogRecord[] = [];
    const intervals = vi.spyOn(globalThis, "setInterval");
    const databasePath = tempDatabasePath();
    const hub = await createHub({ port: 0, address: "127.0.0.1", databasePath,
      authSecret: TEST_SECRET, log: record => { records.push(record); } }, { metricsIntervalMs: INTERVAL_MS });
    hubs.push(hub);
    const timerIndex = intervals.mock.calls.findIndex(call => call[1] === INTERVAL_MS);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    expect(intervals.mock.results[timerIndex]?.value.hasRef()).toBe(false);

    const websocket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${hub.port}`,
      autoConnect: false });
    const providers: HocuspocusProvider[] = [];
    let direct: Awaited<ReturnType<typeof hub.hocuspocus.openDirectConnection>> | undefined;
    try {
      const presented = wrapToken(await token());
      const synced: Promise<void>[] = [];
      for (let index = 0; index < 2; index++) {
        const document = new Y.Doc();
        documents.push(document);
        const provider = new HocuspocusProvider({ websocketProvider: websocket,
          name: testRoom(), token: presented, document });
        providers.push(provider);
        synced.push(new Promise(resolve => provider.on("synced", () => resolve())));
        provider.attach();
      }
      await websocket.connect();
      await Promise.all(synced);
      direct = await hub.hocuspocus.openDirectConnection(testRoom());
      await direct.transact(document => { document.getText("body").insert(0, "stored directly"); });
      await hub.flush();
      const beforeFlushMetrics = metrics(records).length;
      await waitUntil("metrics to count a multiplexed socket and direct connection", () =>
        metrics(records).slice(beforeFlushMetrics).some(record => record.connections === 2 && record.rooms === 3));
      const live = metrics(records).slice(beforeFlushMetrics)
        .find(record => record.connections === 2 && record.rooms === 3)!;
      expect(live).toMatchObject({
        eventLoopDelayP50Ms: expect.any(Number), eventLoopDelayP99Ms: expect.any(Number),
        eventLoopDelayMaxMs: expect.any(Number), roomStoreMs: expect.any(Number),
        revisionWriteMs: 0, databaseBytes: statSync(databasePath).size,
        collectionMs: expect.any(Number), collectionFailures: 0,
      });
      expect(Number(live.eventLoopDelayP50Ms)).toBeGreaterThanOrEqual(0);
      expect(Number(live.eventLoopDelayP99Ms)).toBeGreaterThanOrEqual(Number(live.eventLoopDelayP50Ms));
      expect(Number(live.eventLoopDelayMaxMs)).toBeGreaterThanOrEqual(Number(live.eventLoopDelayP99Ms));
      expect(Number(live.collectionMs)).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(live)).not.toContain("stored directly");
      const liveIndex = metrics(records).indexOf(live);
      await waitUntil("a quiet interval to reset write time", () => metrics(records).slice(liveIndex + 1)
        .some(record => record.roomStoreMs === 0 && record.revisionWriteMs === 0));
    } finally {
      for (const provider of providers) provider.destroy();
      websocket.destroy();
      await direct?.disconnect();
    }

    await hub.stop();
    const stoppedCount = metrics(records).length;
    // The interval itself supplies the observation window for the negative assertion.
    await delay(INTERVAL_MS * 3);
    expect(metrics(records)).toHaveLength(stoppedCount);
  });

  it("recovers collection and logger failures while new rooms sync and flush durably", async () => {
    const records: HubLogRecord[] = [];
    let captured: HubDatabase | undefined;
    let throwFromLogger = true;
    const databasePath = tempDatabasePath();
    const hub = await createHub({ port: 0, address: "127.0.0.1", databasePath,
      authSecret: TEST_SECRET, debounce: 60_000, maxDebounce: 60_000,
      log(record) {
        records.push(record);
        if (record.event === "hub.metrics" && throwFromLogger) {
          throwFromLogger = false;
          throw new Error("metrics logger failed");
        }
      } }, {
      metricsIntervalMs: INTERVAL_MS,
      extension(context) {
        captured = context.database;
        return { extensions: [], admissionConfigured: false, signInConfigured: false,
          async handleRequest() { return false; }, async start() {}, async stop() {} };
      },
    });
    hubs.push(hub);
    if (captured === undefined) throw new Error("database capture failed");
    const collection = vi.spyOn(captured, "collectMetrics")
      .mockRejectedValueOnce(new Error("private collection failure"));
    await waitUntil("a collection failure to be isolated", () =>
      metrics(records).some(record => Number(record.collectionFailures) > 0));
    const failed = metrics(records).find(record => Number(record.collectionFailures) > 0)!;
    expect(failed).not.toHaveProperty("workspaces");
    expect(failed).toMatchObject({ connections: expect.any(Number), rooms: expect.any(Number),
      databaseBytes: expect.any(Number), collectionMs: expect.any(Number) });
    expect(JSON.stringify(failed)).not.toContain("private collection failure");

    const room = testRoom();
    const client = createClient({ port: hub.port, room, token: await token() });
    clients.push(client);
    await client.synced;
    client.text.insert(0, "durable after metrics failure");
    await acknowledged(client);
    await expect(hub.flush()).resolves.toBeUndefined();
    expect(storedText(databasePath, room)).toBe("durable after metrics failure");
    await waitUntil("a later interval to collect workspace figures", () =>
      metrics(records).some(record => record.collectionFailures === 0 && record.workspaces !== undefined));
    expect(collection.mock.calls.length).toBeGreaterThan(1);
    expect(records.some(record => record.event === "hub.store.failed")).toBe(false);
    client.destroy();
    await expect(hub.stop()).resolves.toBeUndefined();
  });

  it("cancels a yielded collection before closing its database", async () => {
    const records: HubLogRecord[] = [];
    let captured: HubDatabase | undefined;
    const hub = await createHub({ port: 0, address: "127.0.0.1", databasePath: tempDatabasePath(),
      authSecret: TEST_SECRET, log: record => { records.push(record); } }, {
      metricsIntervalMs: INTERVAL_MS,
      extension(context) {
        captured = context.database;
        return { extensions: [], admissionConfigured: false, signInConfigured: false,
          async handleRequest() { return false; }, async start() {}, async stop() {} };
      },
    });
    hubs.push(hub);
    if (captured === undefined) throw new Error("database capture failed");
    const database = captured;
    const connection = database.connection;
    const insert = connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)");
    connection.exec("BEGIN");
    for (let index = 0; index < 385; index++) insert.run(testRoom(), new Uint8Array(1));
    connection.exec("COMMIT");
    let entered!: () => void;
    const collectionEntered = new Promise<void>(resolve => { entered = resolve; });
    let queriedAfterClose = false;
    let batchReads = 0;
    const prepare = connection.prepare.bind(connection);
    vi.spyOn(connection, "prepare").mockImplementation(sql => {
      if (!connection.isOpen) queriedAfterClose = true;
      const statement = prepare(sql);
      if (sql.startsWith("SELECT rowid AS cursor")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters) => {
          if (!connection.isOpen) queriedAfterClose = true;
          const rows = all(...parameters);
          batchReads++;
          if (batchReads === 1) entered();
          return rows;
        });
      }
      return statement;
    });
    let settled = false;
    const collect = database.collectMetrics.bind(database);
    vi.spyOn(database, "collectMetrics").mockImplementation(async signal => {
      const collecting = collect(signal);
      try { return await collecting; }
      finally { settled = true; }
    });
    let settledWhenClosed = false;
    const close = database.close.bind(database);
    vi.spyOn(database, "close").mockImplementation(() => {
      settledWhenClosed = settled;
      close();
    });

    await collectionEntered;
    expect(settled).toBe(false);
    expect(batchReads).toBe(1);
    const inserted = testRoom();
    connection.exec("BEGIN IMMEDIATE");
    insert.run(inserted, new Uint8Array(7));
    connection.exec("COMMIT");
    expect(connection.prepare("SELECT length(data) AS bytes FROM documents WHERE name = ?")
      .get(inserted)?.bytes).toBe(7);
    await expect(hub.stop()).resolves.toBeUndefined();
    expect(settledWhenClosed).toBe(true);
    expect(connection.isOpen).toBe(false);
    await delay(INTERVAL_MS * 3);
    expect(queriedAfterClose).toBe(false);
    expect(batchReads).toBe(1);
    expect(metrics(records)).toHaveLength(0);
  });
});
