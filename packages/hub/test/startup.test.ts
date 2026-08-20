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
 */

import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST, resolveHubConfig } from "../src/config.js";
import type { HubLogRecord } from "../src/log.js";
import type { Hub } from "../src/server.js";
import { removeTempDatabases, startHub, tempDatabasePath } from "./helpers.js";

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

    await expect(
      startHub({
        databasePath: directory,
        log: (record) => {
          records.push(record);
        },
      }),
    ).rejects.toThrow(/SQLite database/);

    expect(records.map((record) => record.event)).not.toContain("hub.listen");
  });

  it("rejects when the port is already bound", async () => {
    const first = await startHub();
    hubs.push(first);

    await expect(startHub({ port: first.port })).rejects.toThrow(/EADDRINUSE/);
  });
});
