import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Connection } from "@hocuspocus/server";
import { messageYjsUpdate } from "y-protocols/sync";
import {
  deleteDirectoryEntry,
  directoryRoom,
  parseRoom,
} from "@uberblick/schema";
import { DOC_DELETED_REASON } from "@uberblick/schema/protocol";
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

afterEach(async () => {
  for (const created of clients.splice(0)) created.destroy();
  for (const started of hubs.splice(0)) await started.stop();
  removeTempDatabases();
});

describe("permanent room deletion", () => {
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
