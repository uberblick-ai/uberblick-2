/**
 * Three properties of the store that are about the SQLite binding rather than
 * the data model, and that nothing else in the suite would notice losing.
 *
 * 1. **The file format is the format.** `better-sqlite3.sqlite` was written by
 *    the better-sqlite3 build (see `fixtures/make-legacy.ts`); `node:sqlite`
 *    opens it and finds the same log, the same snapshot and the same FTS index.
 *    There is no migration, and this test is what says so.
 * 2. **BLOBs are the bytes handed in**, including when those bytes are a view
 *    into a longer buffer.
 * 3. **All-or-nothing writes.** `node:sqlite` has no `.transaction()` wrapper,
 *    so the store issues BEGIN/COMMIT/ROLLBACK itself. A body that throws
 *    part-way through must leave nothing behind — proven on `indexDoc`, the
 *    longest of the six bodies, by aborting one of its later statements.
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getBlocks, getMeta } from "@uberblick/schema";
import { MirrorStore } from "../src/store.js";
import { WORKSPACE, removeTempDirs, tempDatabasePath } from "./helpers.js";

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
        snippet: expect.stringContaining("old binding"),
      },
    ]);
    expect(opened.backlinks(LEGACY.linked)).toEqual([
      { uuid: LEGACY.uuid, title: LEGACY.title },
    ]);
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
    opened.indexDoc({
      uuid: LEGACY.uuid,
      title: "before",
      tags: ["kept"],
      links: [],
      body: "the indexed body",
    });

    // Abort `indexDoc` from inside SQLite, at its link statement — by which
    // point the title row and the tag rows have already been rewritten.
    const saboteur = new DatabaseSync(databasePath);
    saboteur.exec(
      "CREATE TRIGGER refuse_links BEFORE INSERT ON doc_links " +
        "BEGIN SELECT RAISE(ABORT, 'no reindexing today'); END",
    );
    saboteur.close();

    expect(() =>
      opened.indexDoc({
        uuid: LEGACY.uuid,
        title: "after",
        tags: ["replaced"],
        links: [LEGACY.linked],
        body: "a different body",
      }),
    ).toThrow(/no reindexing today/);

    // Nothing from the failed attempt survives — not the title, not the tags,
    // not the links, not the FTS row.
    expect(opened.search("body", 10)).toEqual([
      {
        uuid: LEGACY.uuid,
        title: "before",
        tags: ["kept"],
        snippet: expect.stringContaining("indexed body"),
      },
    ]);
    expect(opened.search("different", 10)).toEqual([]);
    expect(opened.backlinks(LEGACY.linked)).toEqual([]);
  });
});
