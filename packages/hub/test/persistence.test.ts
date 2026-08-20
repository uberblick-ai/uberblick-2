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
 * SIGTERM. It is tested four ways: that it writes what the debounce is still
 * holding (checked in SQLite, not inferred), that a hub which dies right after
 * a flush loses nothing, that a graceful `stop()` is durable end to end — and
 * that a flush which could *not* store says so, because a shutdown that reports
 * success without writing is the same data loss with a clean exit code.
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

/**
 * Simulate the process dying immediately after a flush: everything Hocuspocus
 * still holds in memory is dropped without a further store, so only what the
 * flush already wrote can survive. A test cannot usefully SIGKILL itself,
 * which is why the flush is factored out as its own awaitable operation.
 */
async function dieAbruptly(started: Hub): Promise<void> {
  started.hocuspocus.documents.clear();
  await started.stop({ flush: false });
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

  it("is a no-op when nothing is pending", async () => {
    const started = await hub(tempDatabasePath());
    await expect(started.flush()).resolves.toBeUndefined();
    await expect(started.flush()).resolves.toBeUndefined();
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
});

describe("restart", () => {
  it("serves a flushed document to a client of the next process", async () => {
    const databasePath = tempDatabasePath();
    const room = testRoom();

    const first = await hub(databasePath);
    const writer = await client(first, room);
    writer.text.insert(0, "written before the crash");
    await sleep(200);

    // Flush with the client still attached, then lose the process without any
    // graceful store: the flush is the only thing that wrote anything.
    await first.flush();
    await dieAbruptly(first);
    hubs.length = 0;
    destroyClients();

    expect(storedText(databasePath, room)).toBe("written before the crash");

    const second = await hub(databasePath);
    const reader = await client(second, room);

    await waitForText("reader", reader.text, "written before the crash");
  });

  it("loses nothing when a hub is stopped mid-session", async () => {
    const databasePath = tempDatabasePath();
    const room = testRoom();

    const first = await hub(databasePath);
    const writer = await client(first, room);
    writer.text.insert(0, "written before SIGTERM");
    await sleep(200);

    // The SIGTERM path, with the client still editing: exactly what main.ts
    // calls on a signal.
    await first.stop();
    hubs.length = 0;
    destroyClients();

    expect(storedText(databasePath, room)).toBe("written before SIGTERM");

    const second = await hub(databasePath);
    const reader = await client(second, room);

    await waitForText("reader", reader.text, "written before SIGTERM");
  });

  it("keeps documents separate across a restart", async () => {
    const databasePath = tempDatabasePath();
    const roomOne = testRoom();
    const roomTwo = testRoom();

    const first = await hub(databasePath);
    const one = await client(first, roomOne);
    const two = await client(first, roomTwo);
    one.text.insert(0, "document one");
    two.text.insert(0, "document two");
    await sleep(200);

    await first.stop();
    hubs.length = 0;
    destroyClients();

    expect(storedText(databasePath, roomOne)).toBe("document one");
    expect(storedText(databasePath, roomTwo)).toBe("document two");

    const second = await hub(databasePath);
    const readerOne = await client(second, roomOne);
    const readerTwo = await client(second, roomTwo);

    await waitForText("reader one", readerOne.text, "document one");
    await waitForText("reader two", readerTwo.text, "document two");
  });
});
