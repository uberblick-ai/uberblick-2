/**
 * Three properties of the store that are about the SQLite binding rather than
 * the data model, and that nothing else in the suite would notice losing.
 *
 * 1. **The file format is the format.** `better-sqlite3.sqlite` was written by
 *    the better-sqlite3 build (see `fixtures/make-legacy.ts`); `node:sqlite`
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
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getBlocks, getMeta } from "@uberblick/schema";
import { MirrorStore } from "../src/store.js";
import { PACKAGE_ROOT, WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";

/** The document `fixtures/make-legacy.ts` wrote, and what it wrote about it. */
const LEGACY = {
  uuid: "3f2b0a6c-8b1e-4a55-9c47-0d5d1e6b7a90",
  linked: "9a1c7d2e-4f60-4b18-8f3a-2c5e9b0d6c11",
  title: "Written by better-sqlite3",
  blocks: ["seeded by the old binding", "appended after the snapshot"],
} as const;

const FIXTURE = join(
  fileURLToPath(new URL("./fixtures/", import.meta.url)),
  "better-sqlite3.sqlite",
);

const GITHUB_ITEM = "uberblick-ai/uberblick-2#1125";
const OTHER_GITHUB_ITEM = "uberblick-ai/uberblick-2#1135";
const execFileAsync = promisify(execFile);

const stores: MirrorStore[] = [];

function store(databasePath: string): MirrorStore {
  const opened = new MirrorStore(databasePath, WORKSPACE);
  stores.push(opened);
  return opened;
}

/** The fixture, copied somewhere writable — opening it is a write. */
function legacyDatabase(): string {
  const path = tempDatabasePath();
  copyFileSync(FIXTURE, path);
  return path;
}

afterEach(() => {
  for (const opened of stores.splice(0)) {
    opened.close();
  }
  removeTempDirs();
});

describe("a database written by the better-sqlite3 build", () => {
  it("opens under node:sqlite with its log, snapshot and index intact", () => {
    const opened = store(legacyDatabase());
    // The room key as the old binding wrote it into this fixture, back when a
    // workspace id was a name. Room keys are opaque to the store, and the
    // fixture is a byte-for-byte historical artefact: it is not re-keyed.
    const room = `main/${LEGACY.uuid}`;

    // The log: a snapshot the old binding compacted, plus the tail it appended
    // after. Both BLOB columns, replayed with Yjs v1 as they always were.
    const slice = opened.readSince(room, 0);
    expect(slice.snapshot?.throughSeq).toBe(1);
    expect(slice.updates.map((entry) => entry.seq)).toEqual([2]);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, slice.snapshot?.state as Uint8Array);
    for (const entry of slice.updates) {
      Y.applyUpdate(doc, entry.payload);
    }
    expect(getBlocks(doc).map((block) => block.text)).toEqual(LEGACY.blocks);
    expect(getMeta(doc).title).toBe(LEGACY.title);

    // The pending watermark, and the derived index — FTS5 rows written by the
    // old binding, matched by the new one.
    expect(opened.pendingRooms()).toEqual([{ room, seq: 2 }]);
    expect(opened.search("binding", 10)).toEqual([
      {
        uuid: LEGACY.uuid,
        title: LEGACY.title,
        tags: ["legacy"],
        // The column this file predates, added by migration and empty for
        // every row it already held.
        description: null,
        snippet: expect.stringContaining("old binding"),
      },
    ]);
    expect(opened.backlinks(LEGACY.linked)).toEqual([
      { uuid: LEGACY.uuid, title: LEGACY.title, description: null },
    ]);
  });
});

describe("last hub acknowledgement time", () => {
  it("is absent in fresh and historical replicas, and survives reopening", () => {
    expect(store(legacyDatabase()).readLastSync()).toBeNull();
    const databasePath = tempDatabasePath();
    const opened = store(databasePath);
    expect(opened.readLastSync()).toBeNull();

    const timestamp = Date.parse("2026-10-05T19:58:12.987Z");
    opened.recordLastSync(timestamp);
    opened.close();
    expect(store(databasePath).readLastSync()).toBe(timestamp);
  });

  it("refuses older readings committed after newer ones on another connection", () => {
    const databasePath = tempDatabasePath();
    const slow = store(databasePath);
    const fast = store(databasePath);
    const older = Date.parse("2026-10-05T19:58:12Z");
    const newer = older + 5_000;

    fast.recordLastSync(newer);
    slow.recordLastSync(older);
    expect(slow.readLastSync()).toBe(newer);
    expect(fast.readLastSync()).toBe(newer);

    // A clock that stays behind the shared value remains unable to regress it.
    fast.recordLastSync(older - 60_000);
    slow.recordLastSync(newer);
    expect(fast.readLastSync()).toBe(newer);
    slow.recordLastSync(newer + 1);
    expect(fast.readLastSync()).toBe(newer + 1);
  });

  it("reports invalid metadata without making the replica log unusable", () => {
    const databasePath = tempDatabasePath();
    const opened = store(databasePath);
    const saboteur = new DatabaseSync(databasePath);
    saboteur
      .prepare("INSERT INTO meta (key, value) VALUES ('last_sync_at', ?)")
      .run("invalid timestamp");
    saboteur.close();

    expect(() => opened.readLastSync()).toThrow(/invalid last_sync_at/);
    const seq = opened.appendUpdate("a-room", new Uint8Array([1]), "local");
    expect(opened.pendingRooms()).toEqual([{ room: "a-room", seq }]);
  });
});

describe("a payload that is a view into a larger buffer", () => {
  it("is logged as the view, not as the buffer behind it", () => {
    // Yjs hands out `Uint8Array`s, and nothing promises they start at byte zero
    // of their own `ArrayBuffer`. A binding that binds the backing buffer rather
    // than the view writes a corrupt update that only fails on replay, far from
    // here — so the bytes are checked at the boundary they cross.
    const opened = store(tempDatabasePath());
    const backing = new Uint8Array([0xff, 0xff, 1, 2, 3, 0xff]);
    const payload = backing.subarray(2, 5);

    const seq = opened.appendUpdate("a-room", payload, "remote");
    const [logged] = opened.updatesAfter("a-room", seq - 1);
    expect(logged?.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(logged?.payload ?? [])).toEqual([1, 2, 3]);
  });
});

describe("a transaction body that throws", () => {
  it("leaves none of its earlier statements behind", () => {
    const databasePath = tempDatabasePath();
    const opened = store(databasePath);
    opened.indexDoc(
      {
        uuid: LEGACY.uuid,
        title: "before",
        tags: ["kept"],
        description: "",
        links: [],
        githubRefs: [GITHUB_ITEM],
        body: "the indexed body",
      },
      1,
    );

    // Abort at the GitHub reference statement, after the other rows and the
    // deletion of the old reference have been offered in the transaction.
    const saboteur = new DatabaseSync(databasePath);
    saboteur.exec(
      "CREATE TRIGGER refuse_links BEFORE INSERT ON decision_github_refs " +
        "BEGIN SELECT RAISE(ABORT, 'no reindexing today'); END",
    );
    saboteur.close();

    expect(() =>
      opened.indexDoc(
        {
          uuid: LEGACY.uuid,
          title: "after",
          tags: ["replaced"],
          description: "",
          links: [LEGACY.linked],
          githubRefs: [OTHER_GITHUB_ITEM],
          body: "a different body",
        },
        2,
      ),
    ).toThrow(/no reindexing today/);

    // Nothing from the failed attempt survives — not the title, not the tags,
    // not either kind of link, not the FTS row, not its generation marker.
    expect(opened.search("body", 10)).toEqual([
      {
        uuid: LEGACY.uuid,
        title: "before",
        tags: ["kept"],
        description: null,
        snippet: expect.stringContaining("indexed body"),
      },
    ]);
    expect(opened.search("different", 10)).toEqual([]);
    expect(opened.backlinks(LEGACY.linked)).toEqual([]);
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([
      { uuid: LEGACY.uuid, title: "before" },
    ]);
    expect(opened.decisionsForGithub(OTHER_GITHUB_ITEM)).toEqual([]);

    const inspector = new DatabaseSync(databasePath);
    expect(
      inspector
        .prepare("SELECT indexed_through_seq FROM doc_index_seq WHERE uuid = ?")
        .get(LEGACY.uuid),
    ).toEqual({ indexed_through_seq: 1 });
    inspector.close();
  });
});

describe("derived index sequencing", () => {
  it("refuses an older derivation that commits after a newer one", () => {
    const databasePath = tempDatabasePath();
    const slow = store(databasePath);
    const fast = store(databasePath);
    const older = {
      uuid: LEGACY.uuid,
      title: "Older derivation",
      tags: ["old"],
      description: "",
      links: [],
      githubRefs: [OTHER_GITHUB_ITEM],
      body: "stateBravo",
    };

    // `slow` derived these rows first. It offers them only after the other
    // connection has committed a derivation from the newer log cut — the store
    // boundary of the two-process interleaving, with no timing guess in the
    // test.
    fast.indexDoc(
      {
        uuid: LEGACY.uuid,
        title: "Newer derivation",
        tags: ["new"],
        description: "",
        links: [LEGACY.linked],
        githubRefs: [GITHUB_ITEM],
        body: "stateCharlie",
      },
      2,
    );
    slow.indexDoc(older, 1);

    expect(slow.search("stateBravo", 10)).toEqual([]);
    expect(slow.search("stateCharlie", 10)).toEqual([
      expect.objectContaining({
        title: "Newer derivation",
        tags: ["new"],
      }),
    ]);
    expect(slow.backlinks(LEGACY.linked)).toEqual([
      {
        uuid: LEGACY.uuid,
        title: "Newer derivation",
        description: null,
      },
    ]);
    expect(slow.decisionsForGithub(GITHUB_ITEM)).toEqual([
      { uuid: LEGACY.uuid, title: "Newer derivation" },
    ]);
    expect(slow.decisionsForGithub(OTHER_GITHUB_ITEM)).toEqual([]);
  });
});

describe("derived GitHub references", () => {
  it("deduplicates and orders records, replaces references, and clears them with the index", () => {
    const opened = store(tempDatabasePath());
    const record = {
      uuid: LEGACY.uuid,
      title: "Zulu",
      tags: [],
      description: "",
      links: [],
      githubRefs: [GITHUB_ITEM, GITHUB_ITEM],
      body: "record text",
    };
    opened.indexDoc(record, 1);
    opened.indexDoc({ ...record, uuid: LEGACY.linked, title: "Alpha" }, 1);
    opened.indexDoc(
      { ...record, uuid: "00000000-0000-4000-8000-000000000001", title: "Alpha" },
      1,
    );

    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([
      { uuid: "00000000-0000-4000-8000-000000000001", title: "Alpha" },
      { uuid: LEGACY.linked, title: "Alpha" },
      { uuid: LEGACY.uuid, title: "Zulu" },
    ]);

    // An empty replacement also represents losing the decision kind.
    opened.indexDoc({ ...record, githubRefs: [] }, 2);
    opened.unindexDoc(LEGACY.linked);
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([
      { uuid: "00000000-0000-4000-8000-000000000001", title: "Alpha" },
    ]);
    opened.clearDerived();
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([]);
    opened.indexDoc(record, 1);
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([
      { uuid: LEGACY.uuid, title: "Zulu" },
    ]);
  });

  it("re-derives pre-change rows once at their existing cuts without admitting older cuts", () => {
    const databasePath = legacyDatabase();
    const legacy = new DatabaseSync(databasePath);
    // The historical file predates sequencing. Give it the immediately prior
    // schema to exercise an already-indexed database with unchanged log cuts.
    legacy.exec(
      "CREATE TABLE doc_index_seq (uuid TEXT PRIMARY KEY, " +
        "indexed_through_seq INTEGER NOT NULL, catalog_through_seq INTEGER NOT NULL DEFAULT 0)",
    );
    legacy.prepare("INSERT INTO doc_index_seq VALUES (?, 2, 7)").run(LEGACY.uuid);
    legacy.close();

    const opened = store(databasePath);
    const record = {
      uuid: LEGACY.uuid,
      title: LEGACY.title,
      tags: ["legacy"],
      description: "",
      links: [LEGACY.linked],
      githubRefs: [GITHUB_ITEM],
      body: LEGACY.blocks.join("\n"),
    };
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([]);
    opened.indexDoc({ ...record, title: "Older document" }, 1, 7);
    opened.indexDoc({ ...record, title: "Older catalog" }, 2, 6);
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([]);
    expect(opened.search("binding", 10)[0]?.title).toBe(LEGACY.title);

    // No document or catalog edit is needed: the migration permits one equal
    // cut and marks the derivation complete only with the new rows committed.
    opened.indexDoc(record, 2, 7);
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([
      { uuid: LEGACY.uuid, title: LEGACY.title },
    ]);
    opened.indexDoc({ ...record, githubRefs: [] }, 2, 7);
    opened.close();
    const reopened = store(databasePath);
    reopened.indexDoc({ ...record, githubRefs: [] }, 2, 7);
    expect(reopened.decisionsForGithub(GITHUB_ITEM)).toEqual([
      { uuid: LEGACY.uuid, title: LEGACY.title },
    ]);
  });

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

    const source = `
      import { MirrorStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const store = new MirrorStore(${JSON.stringify(databasePath)}, ${JSON.stringify(WORKSPACE)});
      store.indexDoc({...${JSON.stringify(record)}, githubRefs: [${JSON.stringify(GITHUB_ITEM)}]}, 2, 7);
      store.close();
    `;
    // Wait for every child even on failure before the fixture is cleaned up.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        execFileAsync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", source],
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
