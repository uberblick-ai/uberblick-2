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
 *
 * The other half of the file is about the *file*: a database written by
 * `@hocuspocus/extension-sqlite` and its better-sqlite3 binding must keep
 * working under the hub's own `node:sqlite` adapter, with no migration, no
 * second table and no second file — and both a fresh file and `":memory:"`
 * must store and load.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HubConfig } from "../src/config.js";
import type { HubLogRecord } from "../src/log.js";
import type { Hub } from "../src/server.js";
import {
  TEXT_KEY,
  acknowledged,
  createClient,
  removeTempDatabases,
  startHub,
  storedText,
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

/**
 * Fault injection: take the table out from under the hub's open handle, so its
 * next store fails on a database that is otherwise perfectly healthy.
 */
function dropDocumentsTable(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec('DROP TABLE "documents"');
  database.close();
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
    await acknowledged(writer);

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
    const started = await hub(databasePath, { shutdownTimeoutMs: 100 });
    const room = testRoom();
    const writer = await client(started, room);

    writer.text.insert(0, "never stored");
    await acknowledged(writer);

    // Fault injection: take the table out from under the hub's open handle, so
    // the pending store fails when the flush fires it. Hocuspocus catches that
    // failure, logs it and resolves the hook, which is exactly why the hub has
    // to observe it itself — otherwise stop() reports success and main.ts exits
    // 0 with the edit never written.
    dropDocumentsTable(databasePath);

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
    await acknowledged(writer);

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

    dropDocumentsTable(databasePath);

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

/**
 * Take the database's write lock in another process and hold it for `holdMs`.
 * Resolves once the lock is actually held.
 *
 * The child is synchronous from the lock to the commit — `Atomics.wait`, not a
 * timer — because the hub's store is synchronous too: a holder that went back
 * to an event loop would be waiting for a hub that is itself blocked waiting
 * for the lock.
 */
async function holdWriteLock(
  databasePath: string,
  holdMs: number,
): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.env.DATABASE);
       db.exec("BEGIN IMMEDIATE");
       process.stdout.write("locked\\n");
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
       db.exec("COMMIT");
       db.close();`,
    ],
    {
      env: { ...process.env, DATABASE: databasePath },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => {
      resolve();
    });
    child.once("exit", (code) => {
      reject(new Error(`the lock holder exited before locking (code ${code})`));
    });
  });
  return child;
}

describe("a write lock held by another process", () => {
  // The hub is not the only thing that can open its database — a backup, an
  // inspection tool, a second hub coming up as this one goes down. SQLite
  // answers a held write lock with SQLITE_BUSY, and `node:sqlite` waits zero
  // milliseconds by default where better-sqlite3 waited five seconds. A store
  // that failed here would be sticky: one moment of contention, and every later
  // flush and the shutdown would report the hub as not durable, for a write
  // that only needed to wait its turn.
  it("delays the store instead of failing it", async () => {
    const databasePath = tempDatabasePath();
    const records: HubLogRecord[] = [];
    const started = await hub(databasePath, {
      log: (record) => {
        records.push(record);
      },
    });
    const room = testRoom();
    const writer = await client(started, room);

    writer.text.insert(0, "written while locked");
    await acknowledged(writer);

    const holder = await holdWriteLock(databasePath, 100);
    // Subscribed before the flush, not after: the flush blocks this event loop
    // while the child commits and exits, so a listener attached afterwards can
    // be waiting for an event that has already happened.
    const holderExited = once(holder, "exit");
    try {
      await started.flush();
    } catch (error) {
      // Whatever went wrong, the child must not outlive the test.
      holder.kill("SIGKILL");
      throw error;
    } finally {
      await holderExited;
    }

    expect(storedText(databasePath, room)).toBe("written while locked");
    expect(records.map((record) => record.event)).not.toContain(
      "hub.store.failed",
    );
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
    await Promise.all([acknowledged(one), acknowledged(two)]);

    // Flush with the clients still attached and read the rows back before the
    // shutdown: what the next process serves is what this flush wrote, not
    // something a graceful stop stored afterwards.
    await first.flush();
    expect(storedText(databasePath, roomOne)).toBe("document one");
    expect(storedText(databasePath, roomTwo)).toBe("document two");

    // A further edit only the SIGTERM path can save, on one of the two rooms.
    one.text.insert(one.text.length, ", edited before SIGTERM");
    await acknowledged(one);

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

/** What `test/fixtures/make-legacy.ts` wrote, and where. */
const LEGACY = {
  room: "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411/6c0f2b48-1d5a-4c73-9f2e-8b41d7a90e35",
  text: "written by the sqlite extension",
  fixture: fileURLToPath(
    new URL("./fixtures/extension-sqlite.sqlite", import.meta.url),
  ),
} as const;

/** The fixture, copied somewhere writable — opening it for a hub is a write. */
function legacyDatabase(): string {
  const path = tempDatabasePath();
  copyFileSync(LEGACY.fixture, path);
  return path;
}

/** Every table in the file, and the rowid each document row lives at. */
function inspect(databasePath: string): {
  tables: string[];
  rows: { rowid: number; name: string }[];
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      tables: database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
      rows: database
        .prepare('SELECT rowid, name FROM "documents" ORDER BY rowid')
        .all()
        .map((row) => ({ rowid: Number(row.rowid), name: String(row.name) })),
    };
  } finally {
    database.close();
  }
}

describe("a database written by @hocuspocus/extension-sqlite", () => {
  // The migration that must not exist. The extension and its better-sqlite3
  // binding are gone; every hub database they ever wrote — local, remote, the
  // one on the machine this ships to next — is still a file the hub has to open
  // in place, serve, and write back to. Same file, same table, same row.
  it("is served, edited and restarted with no migration and no second table", async () => {
    const databasePath = legacyDatabase();
    const before = inspect(databasePath);
    expect(before.tables).toEqual(["documents"]);
    expect(before.rows).toEqual([{ rowid: 1, name: LEGACY.room }]);

    const first = await hub(databasePath);
    const reader = await client(first, LEGACY.room);
    // Hydrated from the extension's own Yjs v1 bytes, through a real client.
    await waitForText("the legacy document", reader.text, LEGACY.text);

    reader.text.insert(reader.text.length, ", edited by node:sqlite");
    await acknowledged(reader);
    await first.flush();

    const edited = `${LEGACY.text}, edited by node:sqlite`;
    expect(storedText(databasePath, LEGACY.room)).toBe(edited);
    // The same row, in the same table, in the same file: no new schema, no
    // sibling database, nothing for an operator to reconcile afterwards.
    expect(inspect(databasePath)).toEqual(before);
    expect(readdirSync(dirname(databasePath))).toEqual(["hub.sqlite"]);

    await first.stop();
    hubs.length = 0;
    destroyClients();

    const second = await hub(databasePath);
    const afterRestart = await client(second, LEGACY.room);
    await waitForText("the restarted hub", afterRestart.text, edited);
  });
});

describe("database forms", () => {
  /**
   * Store and load through a real client, without a restart — the only thing an
   * in-memory database can prove, and the same proof for both forms. The
   * second client re-reads what the first one's flush wrote: Hocuspocus unloads
   * a document when its last connection goes, so the room is hydrated from
   * SQLite again rather than served out of memory.
   */
  async function storesAndLoads(databasePath: string): Promise<Hub> {
    const started = await hub(databasePath);
    const room = testRoom();
    const writer = await client(started, room);

    writer.text.insert(0, "stored and loaded");
    await acknowledged(writer);
    await started.flush();

    writer.destroy();
    clients.length = 0;
    await waitUntil(
      "the document to unload",
      () => started.hocuspocus.getDocumentsCount() === 0,
    );

    const reader = await client(started, room);
    await waitForText("the reloaded document", reader.text, "stored and loaded");
    return started;
  }

  it("persists to a fresh file", async () => {
    const databasePath = tempDatabasePath();
    const started = await storesAndLoads(databasePath);

    // A file, with the extension's table in it, created by the hub itself.
    expect(inspect(databasePath).tables).toEqual(["documents"]);

    // The handle is released on stop() — asserted by reading the file after.
    await started.stop();
    hubs.length = 0;
    destroyClients();
    expect(inspect(databasePath).rows).toHaveLength(1);
  });

  it("works in memory", async () => {
    const started = await storesAndLoads(":memory:");
    await expect(started.stop()).resolves.toBeUndefined();
    hubs.length = 0;
    destroyClients();
  });
});
