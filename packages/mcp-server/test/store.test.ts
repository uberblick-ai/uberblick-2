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

import { getBlocks, getMeta } from "@uberblick/schema";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../src/store.js";
import { WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";

/** Expected content of the independently generated better-sqlite3 fixture. */
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
    // Preserve the fixture's opaque room key; re-keying would invalidate compatibility.
    const room = `main/${LEGACY.uuid}`;

    // Replay both fixture BLOB columns as Yjs v1: snapshot, then live tail.
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

    // Pending watermarks and FTS5 rows written by better-sqlite3 remain readable.
    expect(opened.pendingRooms()).toEqual([{ room, seq: 2 }]);
    expect(opened.search("binding", 10)).toEqual([
      {
        uuid: LEGACY.uuid,
        title: LEGACY.title,
        kind: "regular",
        tags: ["legacy"],
        // Migrating a fixture without the description column leaves its rows empty.
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
        kind: "regular",
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


  it("re-derives pre-change rows once at their existing cuts without admitting older cuts", () => {
    const databasePath = legacyDatabase();
    const legacy = new DatabaseSync(databasePath);
    // Add sequence metadata to the unsequenced fixture so migration exercises
    // already-indexed rows with unchanged log cuts.
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
});
