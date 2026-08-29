import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getDirectoryEntry,
  getDirectoryMap,
  listDirectory,
  restoreDirectoryEntry,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GAMMA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// The well-known room name itself is pinned once, in rooms.test.ts.
describe("directory doc", () => {
  it("upserts on create, rename and retag", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", tags: ["draft"] });
    expect(listDirectory(dir)).toEqual([
      { uuid: ALPHA, title: "Alpha", tags: ["draft"] },
    ]);

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha, renamed" });
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha, renamed",
      tags: [],
    });

    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha, renamed",
      tags: ["reference", "schema"],
    });
    expect(getDirectoryEntry(dir, ALPHA)?.tags).toEqual([
      "reference",
      "schema",
    ]);
    expect(getDirectoryEntry(dir, BETA)).toBeNull();
  });

  it("tombstones without removing the entry, and hides tombstones by default", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", tags: ["x"] });
    upsertDirectoryEntry(dir, { uuid: BETA, title: "Beta" });
    tombstoneDirectoryEntry(dir, ALPHA);

    expect(listDirectory(dir)).toEqual([
      { uuid: BETA, title: "Beta", tags: [] },
    ]);
    expect(listDirectory(dir, { includeDeleted: true })).toEqual([
      { uuid: ALPHA, title: "Alpha", tags: ["x"], deleted: true },
      { uuid: BETA, title: "Beta", tags: [] },
    ]);
    // The entry itself is kept, so the deletion replicates.
    expect(getDirectoryMap(dir).has(ALPHA)).toBe(true);
  });

  it("keeps a tombstone sticky across a later upsert", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });
    tombstoneDirectoryEntry(dir, ALPHA);
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha, renamed late" });

    // A rename arriving after a delete must not resurrect the document.
    expect(listDirectory(dir)).toEqual([]);
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha, renamed late",
      tags: [],
      deleted: true,
    });
  });

  it("restores a tombstoned entry, keeping its title and tags", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", tags: ["x"] });
    tombstoneDirectoryEntry(dir, ALPHA);
    restoreDirectoryEntry(dir, ALPHA);

    // Restoring is the sanctioned exception to the sticky tombstone — and it
    // brings the entry back as it was, not as a blank one.
    expect(listDirectory(dir)).toEqual([
      { uuid: ALPHA, title: "Alpha", tags: ["x"] },
    ]);
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha",
      tags: ["x"],
    });

    // And the stickiness it suspended is not disabled: a later tombstone still
    // holds against a later upsert.
    tombstoneDirectoryEntry(dir, ALPHA);
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha, renamed late" });
    expect(listDirectory(dir)).toEqual([]);
  });

  it("writes nothing when there is no tombstone to lift", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });

    let updates = 0;
    dir.on("update", () => {
      updates += 1;
    });

    // A live entry and an unknown uuid are both nothing-to-do. Rewriting them
    // would publish a directory update saying precisely nothing.
    restoreDirectoryEntry(dir, ALPHA);
    restoreDirectoryEntry(dir, GAMMA);

    expect(updates).toBe(0);
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha",
      tags: [],
    });
    // Unlike a tombstone, a restore does not invent an entry for an unseen uuid.
    expect(getDirectoryEntry(dir, GAMMA)).toBeNull();
  });

  // The limit of the sticky tombstone, pinned because it is the contract rather
  // than the preference. Stickiness is observed state: `upsertDirectoryEntry`
  // can only preserve a `deleted` flag it can see. A replica that never saw the
  // tombstone writes an ordinary whole-entry update, and whole-entry updates
  // converge by update order — so an offline rename can outlive an archive and
  // bring the document back with nobody calling restoreDirectoryEntry.
  it("does not hold against a concurrent upsert that never saw the tombstone", () => {
    const archiver = new Y.Doc();
    const renamer = new Y.Doc();
    // Concurrent writes to one key converge by client id, so pin the ids rather
    // than leaving the winner to whichever random id Yjs handed out.
    archiver.clientID = 1;
    renamer.clientID = 2;

    upsertDirectoryEntry(archiver, { uuid: ALPHA, title: "Alpha" });
    syncDocs(archiver, renamer);

    // Neither sees the other: one archives, one renames.
    tombstoneDirectoryEntry(archiver, ALPHA);
    upsertDirectoryEntry(renamer, { uuid: ALPHA, title: "Alpha, renamed offline" });
    syncDocs(archiver, renamer);

    const resurrected = {
      uuid: ALPHA,
      title: "Alpha, renamed offline",
      tags: [],
    };
    expect(getDirectoryEntry(archiver, ALPHA)).toEqual(resurrected);
    expect(getDirectoryEntry(renamer, ALPHA)).toEqual(resurrected);
    expect(listDirectory(archiver)).toEqual([resurrected]);
  });

  it("tombstones a uuid it has never seen", () => {
    const dir = new Y.Doc();
    tombstoneDirectoryEntry(dir, GAMMA);
    expect(listDirectory(dir, { includeDeleted: true })).toEqual([
      { uuid: GAMMA, title: "", tags: [], deleted: true },
    ]);
  });

  it("sorts deterministically by title then uuid", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, { uuid: GAMMA, title: "Same" });
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Same" });
    upsertDirectoryEntry(dir, { uuid: BETA, title: "Another" });
    expect(listDirectory(dir).map((entry) => entry.uuid)).toEqual([
      BETA,
      ALPHA,
      GAMMA,
    ]);
  });

  it("converges when two clients upsert different documents", () => {
    const [a, b] = replicaPair((dir) => {
      upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });
    });

    upsertDirectoryEntry(a, { uuid: BETA, title: "Beta", tags: ["from-a"] });
    upsertDirectoryEntry(b, { uuid: GAMMA, title: "Gamma", tags: ["from-b"] });
    syncDocs(a, b);

    expect(listDirectory(a)).toEqual(listDirectory(b));
    expect(listDirectory(a).map((entry) => entry.uuid)).toEqual([
      ALPHA,
      BETA,
      GAMMA,
    ]);
  });

  it("converges last-write-wins when two clients rename the same document", () => {
    const [a, b] = replicaPair((dir) => {
      upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });
    });

    upsertDirectoryEntry(a, { uuid: ALPHA, title: "Renamed by A" });
    upsertDirectoryEntry(b, { uuid: ALPHA, title: "Renamed by B" });
    syncDocs(a, b);

    const winner = getDirectoryEntry(a, ALPHA);
    expect(getDirectoryEntry(b, ALPHA)).toEqual(winner);
    expect(["Renamed by A", "Renamed by B"]).toContain(winner?.title);
  });

  it("converges a concurrent rename and delete of the same document", () => {
    const [a, b] = replicaPair((dir) => {
      upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });
    });

    tombstoneDirectoryEntry(a, ALPHA);
    upsertDirectoryEntry(b, { uuid: ALPHA, title: "Renamed by B" });
    syncDocs(a, b);

    // Both replicas agree; which of the two writes won is Yjs-deterministic but
    // not something callers should rely on.
    expect(listDirectory(a)).toEqual(listDirectory(b));
    expect(getDirectoryEntry(a, ALPHA)).toEqual(getDirectoryEntry(b, ALPHA));
  });

  it("ignores malformed entries written by a foreign client", () => {
    const dir = new Y.Doc();
    getDirectoryMap(dir).set(ALPHA, "not an entry");
    getDirectoryMap(dir).set(BETA, { title: 42, tags: "nope" });
    expect(listDirectory(dir)).toEqual([{ uuid: BETA, title: "", tags: [] }]);
  });

  it("sets createdAt once and keeps it through rename, delete and restore", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      createdAt: 1_000,
    });
    // A later writer offering a different creation time does not get to move
    // it: created-at is a fact about the document, written once.
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha, renamed",
      createdAt: 9_000,
    });
    expect(getDirectoryEntry(dir, ALPHA)?.createdAt).toBe(1_000);

    tombstoneDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)?.createdAt).toBe(1_000);
    restoreDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)?.createdAt).toBe(1_000);
  });

  it("backfills createdAt onto an entry that never had one", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });
    expect(getDirectoryEntry(dir, ALPHA)?.createdAt).toBeUndefined();

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", createdAt: 500 });
    expect(getDirectoryEntry(dir, ALPHA)?.createdAt).toBe(500);
  });

  it("takes a given updatedAt and carries the stored one forward otherwise", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", updatedAt: 2_000 });
    expect(getDirectoryEntry(dir, ALPHA)?.updatedAt).toBe(2_000);

    // A writer fixing a title must not silently erase the freshness stamp.
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha, renamed" });
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha, renamed",
      tags: [],
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    tombstoneDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)?.updatedAt).toBe(2_000);
    restoreDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)?.updatedAt).toBe(2_000);
  });

  it("converges last-write-wins when two replicas stamp the same entry", () => {
    const [a, b] = replicaPair((dir) => {
      upsertDirectoryEntry(dir, {
        uuid: ALPHA,
        title: "Alpha",
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    });

    // Two servers observing the same document, each on its own clock. The later
    // reading does not win — the later Yjs update does. That is the accepted
    // contract for a cache-quality field, not an accident.
    upsertDirectoryEntry(a, { uuid: ALPHA, title: "Alpha", updatedAt: 5_000 });
    upsertDirectoryEntry(b, { uuid: ALPHA, title: "Alpha", updatedAt: 4_000 });
    syncDocs(a, b);

    const winner = getDirectoryEntry(a, ALPHA);
    expect(getDirectoryEntry(b, ALPHA)).toEqual(winner);
    expect([4_000, 5_000]).toContain(winner?.updatedAt);
    // Whichever write won, created-at survives it untouched.
    expect(winner?.createdAt).toBe(1_000);
  });

  it("mirrors a description and carries it through every rewrite", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      description: "What Alpha is for.",
    });
    expect(getDirectoryEntry(dir, ALPHA)?.description).toBe(
      "What Alpha is for.",
    );

    // The web client repairs stubs without knowing this field exists. A writer
    // that only means to fix a title must not erase what it never mentioned.
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha, renamed" });
    expect(getDirectoryEntry(dir, ALPHA)?.description).toBe(
      "What Alpha is for.",
    );

    tombstoneDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)?.description).toBe(
      "What Alpha is for.",
    );
    restoreDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha, renamed",
      tags: [],
      description: "What Alpha is for.",
    });
  });

  it("clears a description with the empty string, and never stores one", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      description: "What Alpha is for.",
    });
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", description: "" });

    // Absent, not empty: a listing tests one thing to know there is no
    // description, and blank is the same fact as missing.
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha",
      tags: [],
    });
  });

  it("mirrors a lifecycle pair and carries it through every rewrite", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      tags: ["requirement"],
      kind: "requirement",
      status: "planned",
    });

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha, renamed" });
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      kind: "requirement",
      status: "planned",
    });

    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha, renamed",
      tags: ["requirement", "schema"],
    });
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      kind: "requirement",
      status: "planned",
    });

    tombstoneDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      deleted: true,
      kind: "requirement",
      status: "planned",
    });
    restoreDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      kind: "requirement",
      status: "planned",
    });
  });

  it("distinguishes lifecycle omission from clearing at either end", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      kind: "requirement",
      status: "implementing",
    });

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      kind: "requirement",
      status: "implementing",
    });

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", status: "" });
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({ kind: "requirement" });
    expect(getDirectoryEntry(dir, ALPHA)).not.toHaveProperty("status");

    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      status: "planned",
    });
    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", kind: "" });
    expect(getDirectoryEntry(dir, ALPHA)).not.toHaveProperty("kind");
    expect(getDirectoryEntry(dir, ALPHA)).not.toHaveProperty("status");
  });

  it("normalizes malformed and mismatched lifecycle metadata on read", () => {
    const dir = new Y.Doc();
    getDirectoryMap(dir).set(ALPHA, {
      title: "Alpha",
      tags: [],
      kind: "decision",
      status: "implementing",
    });
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha",
      tags: [],
      kind: "decision",
    });

    getDirectoryMap(dir).set(BETA, {
      title: "Beta",
      tags: [],
      kind: "note",
      status: "open",
    });
    expect(getDirectoryEntry(dir, BETA)).toEqual({
      uuid: BETA,
      title: "Beta",
      tags: [],
    });
  });

  it("converges last-write-wins when two replicas describe the same document", () => {
    const [a, b] = replicaPair((dir) => {
      upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });
    });

    // Same shape as the timestamps: the stub is a cache written whole, so two
    // replicas that describe one document converge on an update order rather
    // than on whichever description someone meant more.
    upsertDirectoryEntry(a, {
      uuid: ALPHA,
      title: "Alpha",
      description: "Described by A.",
    });
    upsertDirectoryEntry(b, {
      uuid: ALPHA,
      title: "Alpha",
      description: "Described by B.",
    });
    syncDocs(a, b);

    const winner = getDirectoryEntry(a, ALPHA);
    expect(getDirectoryEntry(b, ALPHA)).toEqual(winner);
    expect(["Described by A.", "Described by B."]).toContain(
      winner?.description,
    );
  });

  it("ignores a malformed description written by a foreign client", () => {
    const dir = new Y.Doc();
    getDirectoryMap(dir).set(ALPHA, {
      title: "Alpha",
      tags: [],
      description: 42,
    });
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha",
      tags: [],
    });
  });

  it("ignores a malformed timestamp written by a foreign client", () => {
    const dir = new Y.Doc();
    getDirectoryMap(dir).set(ALPHA, {
      title: "Alpha",
      tags: [],
      createdAt: "yesterday",
      updatedAt: Number.NaN,
    });
    // Missing, not zero: a client sorting on these must handle absence anyway,
    // and inventing an epoch date would sort a live document to 1970.
    expect(getDirectoryEntry(dir, ALPHA)).toEqual({
      uuid: ALPHA,
      title: "Alpha",
      tags: [],
    });
  });
});
