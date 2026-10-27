/** Store migrations that separate processes race to apply to one file. */

import { builtWorker } from "./process-helpers.js";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { settingsRoom } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../src/store.js";
import { PACKAGE_ROOT, WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";

const UUID = "3f2b0a6c-8b1e-4a55-9c47-0d5d1e6b7a90";

const GITHUB_ITEM = "uberblick-ai/uberblick-2#1125";
const execFileAsync = promisify(execFile);

const stores: MirrorStore[] = [];

function store(databasePath: string): MirrorStore {
  const opened = new MirrorStore(databasePath, WORKSPACE);
  stores.push(opened);
  return opened;
}

afterEach(() => {
  for (const opened of stores.splice(0)) {
    opened.close();
  }
  removeTempDirs();
});

describe("derived GitHub references", () => {

  it("allows simultaneous processes to upgrade an existing database", async () => {
    const databasePath = tempDatabasePath();
    const record = {
      uuid: UUID,
      title: "Existing decision",
      tags: [],
      description: "",
      links: [],
      body: "record text",
    };
    const before = store(databasePath);
    before.indexDoc(record, 2, 7);
    before.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(
      "DROP TABLE decision_github_refs; " +
        "ALTER TABLE doc_index_seq DROP COLUMN github_refs_indexed",
    );
    legacy.close();

    // Wait for every child even on failure before the fixture is cleaned up.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        execFileAsync(
          process.execPath,
          [builtWorker("store-upgrade"), databasePath, WORKSPACE, JSON.stringify({ ...record, githubRefs: [GITHUB_ITEM] })],
          { cwd: PACKAGE_ROOT, timeout: 20_000 },
        ),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    expect(store(databasePath).decisionsForGithub(GITHUB_ITEM)).toEqual([
      { uuid: UUID, title: record.title },
    ]);
    const inspector = new DatabaseSync(databasePath);
    expect(
      inspector
        .prepare("SELECT indexed_through_seq, catalog_through_seq FROM doc_index_seq WHERE uuid = ?")
        .get(UUID),
    ).toEqual({ indexed_through_seq: 2, catalog_through_seq: 7 });
    inspector.close();
  });
});

describe("write lock contention", () => {
  // Another process holds the write lock briefly, as a peer MCP server or
  // `ub open` does while it commits. The settings append reads its reset
  // generation before inserting; it must wait its turn, not fail at once.
  const HOLD_MS = 300;
  const HOLDER = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO meta (key, value) VALUES ('lock_holder', '1')");
    process.stdout.write("locked\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});
    db.exec("COMMIT");
    db.close();
  `;

  it("waits for another process's write lock before appending to the settings room", async () => {
    const databasePath = tempDatabasePath();
    const opened = store(databasePath);
    const doc = new Y.Doc();
    doc.getMap("settings").set("name", "Locked");
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    const holder = spawn(process.execPath, ["-e", HOLDER, databasePath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = once(holder, "exit");
    try {
      const [chunk] = (await once(holder.stdout, "data")) as [Buffer];
      expect(chunk.toString()).toBe("locked\n");
      const started = Date.now();
      const seq = opened.appendUpdate(settingsRoom(WORKSPACE), update, "remote", 0);
      expect(seq).toBeGreaterThan(0);
      expect(Date.now() - started).toBeGreaterThan(HOLD_MS / 2);
      expect(opened.updatesAfter(settingsRoom(WORKSPACE), 0).map((row) => row.seq)).toEqual([seq]);
    } finally {
      await exited;
    }
    expect(holder.exitCode).toBe(0);
  });
});
