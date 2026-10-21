/**
 * Three properties of the store that are about the SQLite binding rather than
 * the data model, and that nothing else in the suite would notice losing.
 *
 * 1. **Released files open in place.** A database written by v0.1.0, the
 *    oldest release, opens with its log, snapshot, pending watermark and index
 *    readable. Migrations leave the authoritative log intact.
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
import { constants, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../src/store.js";
import { WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";

/**
 * Content of fixtures/v0.1.0.sqlite, written by v0.1.0's own MirrorStore so
 * opening it runs every released migration. To rebuild: `git archive v0.1.0`
 * into an empty directory outside the repository, `mise trust && mise run
 * install` there, then run a tsx script in its packages/mcp-server that opens
 * `new MirrorStore(path, WORKSPACE)` and writes this document with v0.1.0's
 * schema helpers: a remote snapshot compacted through seq 1, a local tail at
 * seq 2, and `indexDoc` at cuts (2, 7) with tag `legacy` and a link to `linked`.
 */
const LEGACY = {
  uuid: "3f2b0a6c-8b1e-4a55-9c47-0d5d1e6b7a90",
  linked: "9a1c7d2e-4f60-4b18-8f3a-2c5e9b0d6c11",
  title: "Written by v0.1.0",
  description: "Seeded through the first release's store",
  blocks: ["seeded by the first release", "appended after the snapshot"],
} as const;

const FIXTURE = join(
  fileURLToPath(new URL("./fixtures/", import.meta.url)),
  "v0.1.0.sqlite",
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

/** The authoritative rows, which no migration may rewrite. */
function logRows(databasePath: string): unknown[] {
  const db = new DatabaseSync(databasePath);
  try {
    return ["updates", "snapshots", "pending_rooms"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const opened of stores.splice(0)) {
    opened.close();
  }
  removeTempDirs();
});

it("re-purges peer index rows without scanning unrelated FTS content for absent copies", () => {
  const opened = store(tempDatabasePath());
  const room = `${WORKSPACE}/deleted`;
  const indexed = {
    uuid: "deleted", title: "Private", description: "", body: "secret",
    tags: [], links: [],
  };
  opened.indexDoc({ ...indexed, uuid: "survivor", title: "Survivor" }, 1);
  opened.indexDoc(indexed, 1);
  opened.purgeDoc(room, indexed.uuid);
  // A stale process may rebuild only the disposable index, without a new log row.
  opened.indexDoc(indexed, 1);
  opened.purgeDoc(room, indexed.uuid);
  const db = (opened as unknown as { db: DatabaseSync }).db;
  expect(db.prepare("SELECT uuid FROM docs_fts").all()).toEqual([{ uuid: "survivor" }]);
  db.setAuthorizer((action, table) =>
    action === constants.SQLITE_READ && table?.startsWith("docs_fts")
      ? constants.SQLITE_DENY : constants.SQLITE_OK,
  );
  try {
    for (let pass = 0; pass < 50; pass++) opened.purgeDoc(room, indexed.uuid);
  } finally {
    db.setAuthorizer(null);
  }
  expect(opened.search("secret", 10).map(hit => hit.uuid)).toEqual(["survivor"]);
});

it("removes fragment text left by an older peer's purge without repeatedly scanning or locking absent copies", () => {
  const path = tempDatabasePath();
  const opened = store(path);
  const room = `${WORKSPACE}/deleted`;
  const indexed = {
    uuid: "deleted", title: "Private workspace", description: "Private description", body: "secret",
    tags: ["private"], tagNames: ["Private tag"], links: [],
  };
  opened.indexDoc({ ...indexed, uuid: "survivor", title: "Survivor" }, 1);
  // Prime the absent-copy check before another connection changes the file.
  opened.purgeDoc(room, indexed.uuid);
  opened.indexDoc(indexed, 1);
  const peer = new DatabaseSync(path);
  const db = (opened as unknown as { db: DatabaseSync }).db;
  try {
    // Replay the older store's purge, which cannot know the fragment table.
    peer.exec("BEGIN IMMEDIATE");
    for (const [table, key, value] of [
      ["docs_fts", "uuid", indexed.uuid], ["doc_tags", "uuid", indexed.uuid],
      ["doc_links", "source", indexed.uuid], ["decision_github_refs", "source", indexed.uuid],
      ["doc_index", "uuid", indexed.uuid], ["doc_index_seq", "uuid", indexed.uuid],
      ["updates", "room", room], ["snapshots", "room", room], ["pending_rooms", "room", room],
    ] as const) {
      peer.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(value);
    }
    peer.exec("COMMIT");
    expect(peer.prepare("SELECT title, body, description, tag_names FROM docs_fragment_fts WHERE uuid = ?").get(indexed.uuid))
      .toEqual({ title: indexed.title, body: indexed.body, description: indexed.description, tag_names: "Private tag" });

    db.setAuthorizer((action, table) => action === constants.SQLITE_DELETE && table === "docs_fragment_fts"
      ? constants.SQLITE_DENY : constants.SQLITE_OK);
    try {
      expect(() => opened.purgeDoc(room, indexed.uuid)).toThrow();
    } finally {
      db.setAuthorizer(null);
    }
    expect(peer.prepare("SELECT uuid FROM docs_fragment_fts WHERE uuid = ?").get(indexed.uuid))
      .toEqual({ uuid: indexed.uuid });
    opened.purgeDoc(room, indexed.uuid);
    expect(peer.prepare("SELECT uuid FROM docs_fragment_fts").all()).toEqual([{ uuid: "survivor" }]);

    // An unrelated writer must not make an absent-copy check take a write lock.
    peer.prepare("UPDATE doc_index SET title = title WHERE uuid = ?").run("survivor");
    peer.exec("BEGIN IMMEDIATE");
    opened.purgeDoc(room, indexed.uuid);
    db.setAuthorizer((action, table) =>
      action === constants.SQLITE_READ && (table?.startsWith("docs_fts") || table?.startsWith("docs_fragment_fts"))
        ? constants.SQLITE_DENY : constants.SQLITE_OK,
    );
    try {
      for (let pass = 0; pass < 50; pass++) opened.purgeDoc(room, indexed.uuid);
    } finally {
      db.setAuthorizer(null);
      peer.exec("ROLLBACK");
    }
    expect(opened.searchUuids("survi")).toEqual(["survivor"]);
    opened.close();
    expect(store(path).searchUuids("survi")).toEqual(["survivor"]);
  } finally {
    peer.close();
  }
});

describe("a database written by v0.1.0", () => {
  it("opens with its log, snapshot, pending watermark and index intact", () => {
    const databasePath = legacyDatabase();
    const before = logRows(databasePath);
    const opened = store(databasePath);
    expect(logRows(databasePath)).toEqual(before);
    const room = `${WORKSPACE}/${LEGACY.uuid}`;

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

    // Rows written before the search and fragment index migrations stay searchable.
    expect(opened.pendingRooms()).toEqual([{ room, seq: 2 }]);
    expect(opened.search("release", 10)).toEqual([
      {
        uuid: LEGACY.uuid,
        title: LEGACY.title,
        kind: "regular",
        tags: ["legacy"],
        description: LEGACY.description,
        snippet: expect.stringContaining("first release"),
      },
    ]);
    expect(opened.searchUuids("snapsho")).toEqual([LEGACY.uuid]);
    expect(opened.backlinks(LEGACY.linked)).toEqual([
      { uuid: LEGACY.uuid, title: LEGACY.title, description: LEGACY.description },
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
    const opened = store(databasePath);
    const record = {
      uuid: LEGACY.uuid,
      title: LEGACY.title,
      tags: ["legacy"],
      description: LEGACY.description,
      links: [LEGACY.linked],
      githubRefs: [GITHUB_ITEM],
      body: LEGACY.blocks.join("\n"),
    };
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([]);
    opened.indexDoc({ ...record, title: "Older document" }, 1, 7);
    opened.indexDoc({ ...record, title: "Older catalog" }, 2, 6);
    expect(opened.decisionsForGithub(GITHUB_ITEM)).toEqual([]);
    expect(opened.search("release", 10)[0]?.title).toBe(LEGACY.title);

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
