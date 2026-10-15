import { builtWorker } from "./process-helpers.js";
/**
 * Three properties of the store that are about the SQLite binding rather than
 * the data model, and that nothing else in the suite would notice losing.
 *
 * 1. **The file format is the format.** The better-sqlite3 fixture (see
 *    `fixtures/make-legacy.ts`) must stay independently generated; `node:sqlite`
 *    opens it and finds the same log, the same snapshot and the same FTS index.
 *    Compatibility migrations leave the authoritative log intact.
 * 2. **BLOBs are the bytes handed in**, including when those bytes are a view
 *    into a longer buffer.
 * 3. **All-or-nothing writes.** `node:sqlite` has no `.transaction()` wrapper,
 *    so the store issues BEGIN/COMMIT/ROLLBACK itself. A body that throws
 *    part-way through must leave nothing behind — proven on `indexDoc`, the
 *    longest of the six bodies, by aborting one of its later statements.
 */

/**
 * Three properties of the store that are about the SQLite binding rather than
 * the data model, and that nothing else in the suite would notice losing.
 *
 * 1. **The file format is the format.** The better-sqlite3 fixture (see
 *    `fixtures/make-legacy.ts`) must stay independently generated; `node:sqlite`
 *    opens it and finds the same log, the same snapshot and the same FTS index.
 *    Compatibility migrations leave the authoritative log intact.
 * 2. **BLOBs are the bytes handed in**, including when those bytes are a view
 *    into a longer buffer.
 * 3. **All-or-nothing writes.** `node:sqlite` has no `.transaction()` wrapper,
 *    so the store issues BEGIN/COMMIT/ROLLBACK itself. A body that throws
 *    part-way through must leave nothing behind — proven on `indexDoc`, the
 *    longest of the six bodies, by aborting one of its later statements.
 */
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MirrorStore } from "../src/store.js";
import { PACKAGE_ROOT, WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";

/** Expected content of the independently generated better-sqlite3 fixture. */
const LEGACY = {
  uuid: "3f2b0a6c-8b1e-4a55-9c47-0d5d1e6b7a90",
  linked: "9a1c7d2e-4f60-4b18-8f3a-2c5e9b0d6c11",
  title: "Written by better-sqlite3",
  blocks: ["seeded by the old binding", "appended after the snapshot"],
} as const;

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
      uuid: LEGACY.uuid,
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
      { uuid: LEGACY.uuid, title: record.title },
    ]);
    const inspector = new DatabaseSync(databasePath);
    expect(
      inspector
        .prepare("SELECT indexed_through_seq, catalog_through_seq FROM doc_index_seq WHERE uuid = ?")
        .get(LEGACY.uuid),
    ).toEqual({ indexed_through_seq: 2, catalog_through_seq: 7 });
    inspector.close();
  });
});
