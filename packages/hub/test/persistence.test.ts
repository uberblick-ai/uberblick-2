/**
 * "Hub restart loses nothing."
 *
 * Hocuspocus debounces `onStoreDocument` (2s by default), so between a
 * keystroke and the store there is a window where the document exists only in
 * the hub's memory. It does store immediately when the *last* client of a
 * document disconnects — so the window that actually loses data is a hub going
 * down mid-session, with clients still connected. Every test here therefore
 * keeps the writer connected across the shutdown.
 *
 * `Hub.flush()` closes that window, and is exactly what `main.ts` runs on
 * SIGTERM. It is tested three ways: that it writes what the debounce is still
 * holding (checked in SQLite, not inferred), that a restart serves back both
 * what the flush and what the graceful `stop()` wrote, per room — and that a
 * store which could *not* land makes `stop()` say so, whether it failed during
 * the flush or during the teardown that follows it, because a shutdown that
 * reports success without writing is the same data loss with a clean exit code.
 */

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as Y from "yjs";
import type { HubConfig } from "../src/config.js";
import type { Hub } from "../src/server.js";
import {
  TEXT_KEY,
  createClient,
  removeTempDatabases,
  sleep,
  startHub,
  tempDatabasePath,
  testRoom,
  token,
  waitForText,
  waitUntil,
  type TestClient,
} from "./helpers.js";

const clients: TestClient[] = [];
const hubs: Hub[] = [];

async function hub(
  databasePath: string,
  overrides: Partial<HubConfig> = {},
): Promise<Hub> {
  // A debounce long enough that nothing can be stored spontaneously during a
  // test: anything on disk got there because a flush put it there.
  const started = await startHub({
    databasePath,
    debounce: 60_000,
    ...overrides,
  });
  hubs.push(started);
  return started;
}

async function client(started: Hub, room: string): Promise<TestClient> {
  const created = createClient({
    port: started.port,
    room,
    token: await token("read-write"),
  });
  clients.push(created);
  await created.synced;
  return created;
}

function destroyClients(): void {
  for (const created of clients.splice(0)) {
    created.destroy();
  }
}

/** Read a room's persisted state straight out of the hub's SQLite file. */
function storedText(databasePath: string, room: string): string | null {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .prepare('SELECT data FROM "documents" WHERE name = ?')
      .get(room) as { data: Buffer } | undefined;
    if (row === undefined) {
      return null;
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.data));
    const text = doc.getText(TEXT_KEY).toString();
    doc.destroy();
    return text;
  } finally {
    database.close();
  }
}

afterEach(async () => {
  destroyClients();
  for (const started of hubs.splice(0)) {
    await started.stop();
  }
  removeTempDatabases();
});

describe("flush", () => {
  it("writes what the debounced store is still holding", async () => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath);
    const room = testRoom();
    const writer = await client(started, room);

    writer.text.insert(0, "unflushed");
    await sleep(200);

    // Still only in memory: the debounce has not fired and will not for a
    // minute, and the writer is still connected so nothing triggered a store.
    // This is the window a killed hub would have lost.
    expect(storedText(databasePath, room)).toBeNull();

    await started.flush();

    expect(storedText(databasePath, room)).toBe("unflushed");
  });

  it("refuses to report a successful shutdown after a failed store", async () => {
    const databasePath = tempDatabasePath();
    // The store will fail and leave the document in memory, so destroy() waits
    // for an unload that never comes; don't spend the whole default on it.
    const started = await hub(databasePath, { shutdownTimeoutMs: 500 });
    const room = testRoom();
    const writer = await client(started, room);

    writer.text.insert(0, "never stored");
    await sleep(200);

    // Fault injection: take the table out from under the hub's open handle, so
    // the pending store fails when the flush fires it. Hocuspocus catches that
    // failure, logs it and resolves the hook, which is exactly why the hub has
    // to observe it itself — otherwise stop() reports success and main.ts exits
    // 0 with the edit never written.
    const database = new Database(databasePath);
    database.exec('DROP TABLE "documents"');
    database.close();

    await expect(started.stop()).rejects.toThrow(/not durable/);

    hubs.length = 0;
    destroyClients();
  });

  it("refuses to report a successful shutdown after a store fails during teardown", async () => {
    const databasePath = tempDatabasePath();
    const started = await hub(databasePath, { shutdownTimeoutMs: 2_000 });
    const room = testRoom();
    const writer = await client(started, room);

    writer.text.insert(0, "flushed");
    await sleep(200);

    // A direct connection is a server-side writer: it survives the connection
    // quiesce, so it can edit the document *after* stop()'s flush, in the
    // window where Server.destroy() stores what it unloads and Hocuspocus
    // swallows a failure. Without the post-teardown re-check, stop() resolves
    // here and main.ts exits 0 with the last edit never written.
    const direct = await started.hocuspocus.openDirectConnection(room);

    const stopping = started.stop();
    await waitUntil(
      "stop()'s flush to land",
      () => storedText(databasePath, room) === "flushed",
    );

    const database = new Database(databasePath);
    database.exec('DROP TABLE "documents"');
    database.close();

    await direct.transact((doc) => {
      doc.getText(TEXT_KEY).insert(7, " then lost");
    });
    // Disconnecting stores the document and unloads it, so the teardown
    // completes: the only thing that can make stop() reject is the failed store.
    await direct.disconnect();

    await expect(stopping).rejects.toThrow(/not durable/);

    hubs.length = 0;
    destroyClients();
  });
});

describe("restart", () => {
  // The spike criterion, end to end and over two rooms at once: with writers
  // still attached, an explicit mid-session `flush()` lands in SQLite, the
  // SIGTERM path (`stop()`) lands the rest, and the next process serves both
  // documents back — each its own, never mixed.
  it("loses nothing when a hub is stopped mid-session, per room", async () => {
    const databasePath = tempDatabasePath();
    const roomOne = testRoom();
    const roomTwo = testRoom();

    const first = await hub(databasePath);
    const one = await client(first, roomOne);
    const two = await client(first, roomTwo);
    one.text.insert(0, "document one");
    two.text.insert(0, "document two");
    await sleep(200);

    // Flush with the clients still attached and read the rows back before the
    // shutdown: what the next process serves is what this flush wrote, not
    // something a graceful stop stored afterwards.
    await first.flush();
    expect(storedText(databasePath, roomOne)).toBe("document one");
    expect(storedText(databasePath, roomTwo)).toBe("document two");

    // A further edit only the SIGTERM path can save, on one of the two rooms.
    one.text.insert(one.text.length, ", edited before SIGTERM");
    await sleep(200);

    // Exactly what main.ts calls on a signal, clients still editing.
    await first.stop();
    hubs.length = 0;
    destroyClients();

    expect(storedText(databasePath, roomOne)).toBe(
      "document one, edited before SIGTERM",
    );
    expect(storedText(databasePath, roomTwo)).toBe("document two");

    const second = await hub(databasePath);
    const readerOne = await client(second, roomOne);
    const readerTwo = await client(second, roomTwo);

    await waitForText(
      "reader one",
      readerOne.text,
      "document one, edited before SIGTERM",
    );
    await waitForText("reader two", readerTwo.text, "document two");
  });
});
