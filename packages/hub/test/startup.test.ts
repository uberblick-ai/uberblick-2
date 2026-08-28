/**
 * Startup contracts.
 *
 * A hub either comes up completely or not at all. Both ways of failing to come
 * up used to escape the promise `createHub` returns — the database is opened
 * from a Hocuspocus hook nobody awaits, and `Server.listen()` never watches the
 * HTTP server's `error` event — so a broken hub logged that it was listening and
 * then died, or took the process down with an uncaught `EADDRINUSE`.
 *
 * The bind address is here too: loopback by default is the hub's security model
 * while its only credential is one shared dev secret.
 *
 * And the handle itself: one `DatabaseSync` per hub, owned by `packages/hub`.
 * A second connection to the same file would be a second writer meeting the
 * first one's locks, so the workspace registry (#216) extends this one rather
 * than opening its own — which only holds if startup opens exactly one.
 */

import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST, resolveHubConfig } from "../src/config.js";
import type { HubLogRecord } from "../src/log.js";
import type { Hub } from "../src/server.js";
import { removeTempDatabases, startHub, tempDatabasePath } from "./helpers.js";

/** Every database this file's module graph opens, in order. */
const sqlite = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
        super(...args);
        sqlite.opened.push(String(args[0]));
      }
    },
  };
});

const hubs: Hub[] = [];

afterEach(async () => {
  for (const started of hubs.splice(0)) {
    await started.stop();
  }
  removeTempDatabases();
});

describe("bind address", () => {
  it("is loopback unless HUB_HOST says otherwise", () => {
    const env = { HUB_AUTH_TOKEN: "secret" };

    expect(resolveHubConfig(env).address).toBe(DEFAULT_HOST);
    expect(resolveHubConfig({ ...env, HUB_HOST: "  " }).address).toBe(
      DEFAULT_HOST,
    );
    // Exposing the hub to the network is a deliberate act, never a default.
    expect(resolveHubConfig({ ...env, HUB_HOST: "0.0.0.0" }).address).toBe(
      "0.0.0.0",
    );
  });
});

describe("createHub", () => {
  it("rejects without listening when the database cannot be opened", async () => {
    // A directory is not a database — the shape of the mistake that used to
    // produce a listening hub and then an unhandled SQLITE_CANTOPEN.
    const directory = dirname(tempDatabasePath());
    const records: HubLogRecord[] = [];

    // A port nobody holds: taken from a hub that has since released it.
    const probe = await startHub();
    const port = probe.port;
    await probe.stop();

    await expect(
      startHub({
        port,
        databasePath: directory,
        log: (record) => {
          records.push(record);
        },
      }),
    ).rejects.toThrow(/SQLite database/);

    expect(records.map((record) => record.event)).not.toContain("hub.listen");

    // The socket was never bound, so it is still there for the next hub — the
    // rejection left nothing running and nothing held.
    const after = await startHub({ port });
    hubs.push(after);
    expect(after.port).toBe(port);
  });

  it("rejects a protocol version the refusal sentinel could not spell", async () => {
    // The sentinel is the only way a client learns this number and it can only
    // carry 1..999999, so a hub outside that range would refuse every client
    // with a reason none of them could read.
    await expect(startHub({ protocolVersion: 0 })).rejects.toThrow(
      /protocolVersion must be an integer between 1 and 999999/,
    );
  });

  it("rejects when the port is already bound", async () => {
    const first = await startHub();
    hubs.push(first);

    await expect(startHub({ port: first.port })).rejects.toThrow(/EADDRINUSE/);
  });

  it("opens exactly one database connection, owned inside the package", async () => {
    const databasePath = tempDatabasePath();
    sqlite.opened.length = 0;

    const started = await startHub({ databasePath });
    hubs.push(started);

    expect(sqlite.opened).toEqual([databasePath]);

    // And the handle stays hub-internal: `src/persistence.ts` is not part of
    // the package entry, so nothing outside `packages/hub` can hold a second
    // reference to it — or open a second connection through it.
    const entry = await import("../src/index.js");
    expect(Object.keys(entry)).not.toContain("HubDatabase");

    // The seam is a live handle or nothing: after the close it must fail
    // loudly, never hand #216's registry a database that is already shut.
    const { HubDatabase } = await import("../src/persistence.js");
    const owned = new HubDatabase(tempDatabasePath(), () => {});
    owned.open();
    expect(owned.connection.isOpen).toBe(true);
    owned.close();
    expect(() => owned.connection).toThrow(/not open/);
  });
});
