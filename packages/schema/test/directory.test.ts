import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  addComment,
  appendBlock,
  createAnnotation,
  deleteBlock,
  deleteDirectoryEntry,
  decisionTopicArchived,
  DIRECTORY_ARCHIVED_RECORDS_KEY,
  directoryStubDiffers,
  documentDirectoryFields,
  enforceDeletedDirectoryEntries,
  getAnnotationsMap,
  getDirectoryEntry,
  getDirectoryMap,
  getMeta,
  initDoc,
  isDirectoryEntryDeleted,
  isDirectoryEntryArchived,
  listDeletedDirectoryUuids,
  listDirectory,
  resolveAnnotationRange,
  restoreDirectoryEntry,
  setAnnotationResolved,
  setKind,
  tombstoneDirectoryEntry,
  tombstoneDecisionRecord,
  upsertDirectoryEntry,
} from "../src/index.js";
import type { DirectoryEntry, DocMeta } from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GAMMA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// The well-known room name itself is pinned once, in rooms.test.ts.
describe("directory doc", () => {
  it("keeps record archives through modern and older whole-stub rewrites and restores one layer", () => {
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "First", kind: "decision", topic: ALPHA, status: "decided" });
    upsertDirectoryEntry(directory, { uuid: BETA, title: "Current", kind: "decision", topic: ALPHA, supersedes: ALPHA, status: "decided" });
    expect(tombstoneDecisionRecord(directory, ALPHA)).toBe(true);
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Cache repair", tags: ["tag"] });
    expect(getDirectoryEntry(directory, ALPHA)?.recordArchived).toBe(true);
    const peer = new Y.Doc(); syncDocs(directory, peer);
    getDirectoryMap(peer).set(ALPHA, { title: "Older client", tags: [], kind: "decision", topic: ALPHA, status: "decided" });
    syncDocs(directory, peer);
    expect(directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).get(ALPHA)).toBe(true);
    expect(getDirectoryEntry(directory, ALPHA)).toMatchObject({ title: "Older client", recordArchived: true });
    expect(decisionTopicArchived(directory, ALPHA)).toBe(false);
    tombstoneDirectoryEntry(directory, BETA);
    expect(isDirectoryEntryArchived(directory, BETA)).toBe(true);
    expect(restoreDirectoryEntry(directory, ALPHA)).toEqual([ALPHA, BETA]);
    expect(decisionTopicArchived(directory, ALPHA)).toBe(false);
    expect(isDirectoryEntryArchived(directory, ALPHA)).toBe(true);
    expect(isDirectoryEntryArchived(directory, BETA)).toBe(false);
    expect(listDirectory(directory).map((entry) => entry.uuid)).toEqual([BETA]);
    expect(restoreDirectoryEntry(directory, ALPHA)).toEqual([ALPHA]);
    expect(getDirectoryEntry(directory, ALPHA)?.recordArchived).toBeUndefined();
    expect(listDirectory(directory)).toHaveLength(2);
  });

  it("keeps only permanent UUID evidence and refuses every later metadata write", () => {
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: ALPHA, title: "Secret", tags: ["private"], description: "Description",
      createdAt: 10, updatedAt: 20, kind: "decision", topic: ALPHA, answerPreview: "Answer",
    });
    deleteDirectoryEntry(directory, ALPHA);
    expect(isDirectoryEntryDeleted(directory, ALPHA)).toBe(true);
    expect(listDeletedDirectoryUuids(directory)).toEqual([ALPHA]);
    expect(getDirectoryEntry(directory, ALPHA)).toBeNull();
    expect(getDirectoryMap(directory).has(ALPHA)).toBe(false);
    expect(directory.getMap("updatedAt").size).toBe(0);
    expect(listDirectory(directory, { includeDeleted: true })).toEqual([]);

    const before = Y.encodeStateAsUpdate(directory);
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Repaired", tags: ["new"] });
    restoreDirectoryEntry(directory, ALPHA);
    tombstoneDirectoryEntry(directory, ALPHA);
    deleteDirectoryEntry(directory, ALPHA);
    expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
  });

  it.each([1, 3])("permanent deletion wins unseen restores, metadata writes and repair with client id %i", (writerId) => {
    const deleter = new Y.Doc();
    deleter.clientID = 2;
    const writer = new Y.Doc();
    writer.clientID = writerId;
    upsertDirectoryEntry(deleter, { uuid: ALPHA, title: "Private", tags: ["a"], updatedAt: 10 });
    tombstoneDirectoryEntry(deleter, ALPHA);
    syncDocs(deleter, writer);

    deleteDirectoryEntry(deleter, ALPHA);
    restoreDirectoryEntry(writer, ALPHA);
    upsertDirectoryEntry(writer, { uuid: ALPHA, title: "Offline rename", tags: ["b"], description: "Offline", updatedAt: 30 });
    syncDocs(deleter, writer);
    for (const directory of [deleter, writer]) {
      expect(isDirectoryEntryDeleted(directory, ALPHA)).toBe(true);
      expect(getDirectoryEntry(directory, ALPHA)).toBeNull();
      expect(listDirectory(directory, { includeDeleted: true })).toEqual([]);
      enforceDeletedDirectoryEntries(directory);
      expect(getDirectoryMap(directory).has(ALPHA)).toBe(false);
      expect(directory.getMap("updatedAt").size).toBe(0);
    }
    syncDocs(deleter, writer);

    // An older process may later append another whole entry to the shared log.
    getDirectoryMap(writer).set(ALPHA, { title: "Late repair", tags: ["leaked"] });
    expect(getDirectoryEntry(writer, ALPHA)).toBeNull();
    enforceDeletedDirectoryEntries(writer);
    syncDocs(deleter, writer);
    expect(getDirectoryMap(deleter).has(ALPHA)).toBe(false);
    expect(listDeletedDirectoryUuids(deleter)).toEqual([ALPHA]);

    const restarted = new Y.Doc();
    Y.applyUpdate(restarted, Y.encodeStateAsUpdate(deleter));
    expect(isDirectoryEntryDeleted(restarted, ALPHA)).toBe(true);
    expect(getDirectoryEntry(restarted, ALPHA)).toBeNull();
  });

  it("never infers deletion from missing or malformed directory entries", () => {
    const directory = new Y.Doc();
    expect(isDirectoryEntryDeleted(directory, ALPHA)).toBe(false);
    getDirectoryMap(directory).set(ALPHA, null);
    enforceDeletedDirectoryEntries(directory);
    expect(listDeletedDirectoryUuids(directory)).toEqual([]);
    expect(getDirectoryMap(directory).has(ALPHA)).toBe(true);
  });

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

  it.each([
    [5_000, 4_000],
    [4_000, 5_000],
  ])(
    "keeps the greater concurrent stamp when the whole-entry winner carries %i and the other carries %i",
    (stampA, stampB) => {
      const a = new Y.Doc();
      const b = new Y.Doc();
      // Client 2 wins the whole-object key. Swapping the stamps forces both
      // cases: the maximum wins once with and once without its entry winning.
      a.clientID = 1;
      b.clientID = 2;
      upsertDirectoryEntry(a, {
        uuid: ALPHA,
        title: "Alpha",
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      syncDocs(a, b);

      upsertDirectoryEntry(a, {
        uuid: ALPHA,
        title: "Renamed by A",
        tags: ["a"],
        updatedAt: stampA,
      });
      upsertDirectoryEntry(b, {
        uuid: ALPHA,
        title: "Renamed by B",
        tags: ["b"],
        updatedAt: stampB,
      });
      syncDocs(a, b);

      const winner = getDirectoryEntry(a, ALPHA);
      expect(getDirectoryEntry(b, ALPHA)).toEqual(winner);
      expect(winner).toMatchObject({
        title: "Renamed by B",
        tags: ["b"],
        createdAt: 1_000,
        updatedAt: 5_000,
      });
    },
  );

  it("never lowers a stamp and carries the maximum through archive and restore", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      updatedAt: 5_000,
    });

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Missing stamp" });
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Lower stamp",
      updatedAt: 4_000,
    });
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Malformed stamp",
      updatedAt: Number.NaN,
    });
    expect(getDirectoryEntry(dir, ALPHA)?.updatedAt).toBe(5_000);

    tombstoneDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)?.updatedAt).toBe(5_000);
    restoreDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)?.updatedAt).toBe(5_000);

    const losingMaximum = (deleted: boolean): Y.Doc => {
      const author = new Y.Doc();
      const observer = new Y.Doc();
      author.clientID = 1;
      observer.clientID = 2;
      upsertDirectoryEntry(author, {
        uuid: ALPHA,
        title: "Alpha",
        updatedAt: 1_000,
      });
      syncDocs(author, observer);

      upsertDirectoryEntry(author, {
        uuid: ALPHA,
        title: "Authored",
        updatedAt: 5_000,
      });
      upsertDirectoryEntry(observer, {
        uuid: ALPHA,
        title: "Observed",
        updatedAt: 4_000,
      });
      if (deleted) tombstoneDirectoryEntry(observer, ALPHA);
      syncDocs(author, observer);

      expect(getDirectoryMap(observer).get(ALPHA)).toMatchObject({
        updatedAt: 4_000,
      });
      expect(getDirectoryEntry(observer, ALPHA)?.updatedAt).toBe(5_000);
      return observer;
    };

    const live = losingMaximum(false);
    tombstoneDirectoryEntry(live, ALPHA);
    expect(getDirectoryMap(live).get(ALPHA)).toMatchObject({
      deleted: true,
      updatedAt: 5_000,
    });

    const archived = losingMaximum(true);
    restoreDirectoryEntry(archived, ALPHA);
    expect(getDirectoryMap(archived).get(ALPHA)).toMatchObject({
      updatedAt: 5_000,
    });
    expect(getDirectoryMap(archived).get(ALPHA)).not.toHaveProperty("deleted");
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

    // A writer that only means to fix a title must not erase the description
    // when it does not restate it.
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
      tags: ["reference"],
      kind: "decision",
      status: "open",
    });

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha, renamed" });
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      kind: "decision",
      status: "open",
    });

    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha, renamed",
      tags: ["reference", "schema"],
    });
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      kind: "decision",
      status: "open",
    });

    tombstoneDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      deleted: true,
      kind: "decision",
      status: "open",
    });
    restoreDirectoryEntry(dir, ALPHA);
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      kind: "decision",
      status: "open",
    });
  });

  it("distinguishes lifecycle omission from clearing at either end", () => {
    const dir = new Y.Doc();
    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      kind: "decision",
      status: "decided",
    });

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha" });
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({
      kind: "decision",
      status: "decided",
    });

    upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Alpha", status: "" });
    expect(getDirectoryEntry(dir, ALPHA)).toMatchObject({ kind: "decision" });
    expect(getDirectoryEntry(dir, ALPHA)).not.toHaveProperty("status");

    upsertDirectoryEntry(dir, {
      uuid: ALPHA,
      title: "Alpha",
      status: "open",
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

  it.each([undefined, "decided"])(
    "projects stored requirement stubs with status %j without writing on read",
    (status) => {
      const dir = new Y.Doc();
      const stored = {
        title: "Stored proposal", tags: ["rfc"], description: "Preserved purpose.",
        createdAt: 10, updatedAt: 20, kind: "requirement",
        ...(status === undefined ? {} : { status }),
      };
      getDirectoryMap(dir).set(ALPHA, stored);
      getDirectoryMap(dir).set(BETA, { ...stored, deleted: true });
      const before = Y.encodeStateAsUpdate(dir);
      const regular = {
        uuid: ALPHA, title: stored.title, tags: stored.tags,
        description: stored.description, createdAt: 10, updatedAt: 20,
      };
      expect(getDirectoryEntry(dir, ALPHA)).toEqual(regular);
      expect(listDirectory(dir)).toEqual([regular]);
      expect(listDirectory(dir, { includeDeleted: true })).toEqual([
        regular, { ...regular, uuid: BETA, deleted: true },
      ]);
      expect(Y.encodeStateAsUpdate(dir)).toEqual(before);
      expect(getDirectoryMap(dir).get(ALPHA)).toEqual(stored);

      // A cache rewrite can discard the obsolete pair while retaining the row.
      upsertDirectoryEntry(dir, { uuid: ALPHA, title: "Renamed", tags: stored.tags });
      expect(getDirectoryEntry(dir, ALPHA)).toEqual({ ...regular, title: "Renamed" });
      expect(getDirectoryMap(dir).get(ALPHA)).not.toHaveProperty("kind");
      expect(getDirectoryMap(dir).get(ALPHA)).not.toHaveProperty("status");
      tombstoneDirectoryEntry(dir, ALPHA);
      expect(listDirectory(dir)).toEqual([]);
      expect(getDirectoryEntry(dir, ALPHA)).toEqual({ ...regular, title: "Renamed", deleted: true });
      restoreDirectoryEntry(dir, ALPHA);
      expect(listDirectory(dir)).toEqual([{ ...regular, title: "Renamed" }]);
      dir.destroy();
    },
  );

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

describe("directory unresolved thread cache", () => {
  it.each([undefined, "decision"] as const)("counts threads on %s documents regardless of anchors or replies", (kind) => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: ALPHA, title: "Alpha" });
    if (kind !== undefined) setKind(doc, kind);
    expect(documentDirectoryFields(doc).openThreadCount).toBe(0);
    const block = appendBlock(doc, { type: "paragraph", text: "Discussion" });
    const open = createAnnotation(doc, block, 0, 3, "reviewer", "First thread");
    const resolved = createAnnotation(doc, block, 3, 6, "reviewer", "Second thread");
    setAnnotationResolved(doc, resolved.id, true);
    addComment(doc, open.id, "author", "Reply");
    deleteBlock(doc, block);
    expect(resolveAnnotationRange(doc, open.id)).toBeNull();
    expect(documentDirectoryFields(doc).openThreadCount).toBe(1);
    if (kind === "decision") expect(documentDirectoryFields(doc).commentCount).toBe(3);

    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: "", ...documentDirectoryFields(doc) });
    setAnnotationResolved(doc, open.id, true);
    expect(documentDirectoryFields(doc).openThreadCount).toBe(0);
    expect(directoryStubDiffers(getDirectoryEntry(directory, ALPHA), getMeta(doc), documentDirectoryFields(doc))).toBe(true);
    setAnnotationResolved(doc, resolved.id, false);
    expect(documentDirectoryFields(doc).openThreadCount).toBe(1);
    (getAnnotationsMap(doc).get(open.id) as Y.Map<unknown>).set("resolved", "true");
    expect(documentDirectoryFields(doc).openThreadCount).toBe(2);
  });

  it.each([undefined, "decision"] as const)("preserves known counts for %s stubs through omitted writes, archive and restore", (kind) => {
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Alpha", ...(kind === undefined ? {} : { kind }), openThreadCount: 2 });
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Renamed" });
    tombstoneDirectoryEntry(directory, ALPHA);
    expect(getDirectoryEntry(directory, ALPHA)).toMatchObject({ deleted: true, openThreadCount: 2 });
    restoreDirectoryEntry(directory, ALPHA);
    expect(listDirectory(directory)[0]).toMatchObject({ title: "Renamed", openThreadCount: 2 });
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Renamed", openThreadCount: 0 });
    expect(getDirectoryEntry(directory, ALPHA)?.openThreadCount).toBe(0);
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Renamed", openThreadCount: null });
    expect(getDirectoryEntry(directory, ALPHA)).not.toHaveProperty("openThreadCount");
  });

  it("treats absent, malformed and older-client counts as unknown until hydrated repair", () => {
    const directory = new Y.Doc();
    const doc = new Y.Doc();
    initDoc(doc, { uuid: ALPHA, title: "Alpha" });
    const block = appendBlock(doc, { type: "paragraph", text: "Review this" });
    const thread = createAnnotation(doc, block, 0, 6, "reviewer", "Open");
    const fields = documentDirectoryFields(doc);
    for (const value of [undefined, null, "1", true, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      getDirectoryMap(directory).set(ALPHA, { title: "Alpha", tags: [], openThreadCount: value });
      expect(getDirectoryEntry(directory, ALPHA)).not.toHaveProperty("openThreadCount");
      expect(listDirectory(directory)[0]).not.toHaveProperty("openThreadCount");
      expect(directoryStubDiffers(getDirectoryEntry(directory, ALPHA), getMeta(doc), fields)).toBe(true);
      upsertDirectoryEntry(directory, { ...getMeta(doc), description: "", ...fields });
      expect(getDirectoryEntry(directory, ALPHA)?.openThreadCount).toBe(1);
      expect(directoryStubDiffers(getDirectoryEntry(directory, ALPHA), getMeta(doc), fields)).toBe(false);
    }
    setAnnotationResolved(doc, thread.id, true);
    expect(directoryStubDiffers(getDirectoryEntry(directory, ALPHA), getMeta(doc), documentDirectoryFields(doc))).toBe(true);
  });

  it("converges the count with the winning whole-entry write", () => {
    const [a, b] = replicaPair((directory) => {
      upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Alpha", openThreadCount: 0 });
    });
    upsertDirectoryEntry(a, { uuid: ALPHA, title: "From A", openThreadCount: 1 });
    upsertDirectoryEntry(b, { uuid: ALPHA, title: "From B", openThreadCount: 2 });
    syncDocs(a, b);
    const winner = getDirectoryEntry(a, ALPHA);
    expect(getDirectoryEntry(b, ALPHA)).toEqual(winner);
    expect(winner?.openThreadCount).toBe(winner?.title === "From A" ? 1 : 2);
  });
});

describe("directory timestamp reads", () => {
  it("preserves arbitrary synced suffixes and the existing single-read prefix semantics", () => {
    const directory = new Y.Doc();
    getDirectoryMap(directory).set(ALPHA, { title: "Alpha", tags: [] });
    expect(getDirectoryEntry(directory, ALPHA)?.updatedAt).toBeUndefined();
    directory.transact(() => {
      const stamps = directory.getMap("updatedAt");
      stamps.set(`${ALPHA}:not-a-client-id`, 100);
      stamps.set(`${ALPHA}:`, 200);
      stamps.set(`${ALPHA}:replica:foreign`, 300);
      stamps.set(`${ALPHA}:malformed`, Number.NaN);
      stamps.set(`${ALPHA}x:foreign`, 1_000);
    });
    expect(getDirectoryEntry(directory, ALPHA)?.updatedAt).toBe(300);
    expect(listDirectory(directory)[0]?.updatedAt).toBe(200);
  });

  it("refreshes a warm maximum when remote candidates decrease, disappear or become malformed", () => {
    const writer = new Y.Doc();
    const reader = new Y.Doc();
    getDirectoryMap(writer).set(ALPHA, { title: "Alpha", tags: [] });
    const stamps = writer.getMap("updatedAt");
    stamps.set(`${ALPHA}:first`, 100);
    stamps.set(`${ALPHA}:second`, 200);
    const receive = (): void => {
      Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer, Y.encodeStateVector(reader)));
    };
    receive();
    expect(getDirectoryEntry(reader, ALPHA)?.updatedAt).toBe(200);

    stamps.set(`${ALPHA}:second`, 50);
    receive();
    expect(getDirectoryEntry(reader, ALPHA)?.updatedAt).toBe(100);
    stamps.set(`${ALPHA}:first`, Number.NaN);
    receive();
    expect(getDirectoryEntry(reader, ALPHA)?.updatedAt).toBe(50);
    stamps.set(`${ALPHA}:second`, "malformed");
    receive();
    expect(getDirectoryEntry(reader, ALPHA)?.updatedAt).toBeUndefined();
    stamps.set(`${ALPHA}:third`, 300);
    receive();
    expect(getDirectoryEntry(reader, ALPHA)?.updatedAt).toBe(300);
    stamps.delete(`${ALPHA}:third`);
    receive();
    expect(getDirectoryEntry(reader, ALPHA)?.updatedAt).toBeUndefined();
  });

  it("exposes remote stamps to the docs observer before the stamp-map observer runs", () => {
    const reader = new Y.Doc();
    getDirectoryMap(reader).set(ALPHA, { title: "Alpha", tags: [] });
    expect(getDirectoryEntry(reader, ALPHA)?.updatedAt).toBeUndefined();
    const observed: Array<[string, number | undefined]> = [];
    getDirectoryMap(reader).observe(() => {
      observed.push(["docs", getDirectoryEntry(reader, ALPHA)?.updatedAt]);
    });
    reader.getMap("updatedAt").observe(() => {
      observed.push(["stamps", getDirectoryEntry(reader, ALPHA)?.updatedAt]);
    });
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(reader));
    writer.transact(() => {
      getDirectoryMap(writer).set(ALPHA, { title: "Renamed", tags: [] });
      writer.getMap("updatedAt").set(`${ALPHA}:remote-writer`, 500);
    });
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer, Y.encodeStateVector(reader)));
    expect(observed).toEqual([["docs", 500], ["stamps", 500]]);
  });

  it("keeps local upserts and lifecycle reads current inside one outer transaction", () => {
    const directory = new Y.Doc();
    directory.transact(() => {
      upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Alpha", updatedAt: 100 });
      expect(getDirectoryEntry(directory, ALPHA)?.updatedAt).toBe(100);
      upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Renamed", updatedAt: 200 });
      expect(getDirectoryEntry(directory, ALPHA)?.updatedAt).toBe(200);
      tombstoneDirectoryEntry(directory, ALPHA);
      expect(getDirectoryMap(directory).get(ALPHA)).toMatchObject({ deleted: true, updatedAt: 200 });
      restoreDirectoryEntry(directory, ALPHA);
      expect(getDirectoryMap(directory).get(ALPHA)).toMatchObject({ updatedAt: 200 });
      expect(getDirectoryEntry(directory, ALPHA)?.deleted).toBeUndefined();
      upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Newer", updatedAt: 300 });
      expect(getDirectoryEntry(directory, ALPHA)?.updatedAt).toBe(300);
    });
    expect(getDirectoryEntry(directory, ALPHA)?.updatedAt).toBe(300);
  });

  it("keeps permanent deletion authoritative after warming timestamp reads", () => {
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Alpha", updatedAt: 100 });
    upsertDirectoryEntry(directory, { uuid: BETA, title: "Beta", updatedAt: 200 });
    expect(getDirectoryEntry(directory, ALPHA)?.updatedAt).toBe(100);
    deleteDirectoryEntry(directory, ALPHA);
    getDirectoryMap(directory).set(ALPHA, { title: "Late metadata", tags: [] });
    directory.getMap("updatedAt").set(`${ALPHA}:remote-writer`, 500);
    expect(getDirectoryEntry(directory, ALPHA)).toBeNull();
    enforceDeletedDirectoryEntries(directory);
    expect(directory.getMap("updatedAt").has(`${ALPHA}:remote-writer`)).toBe(false);
    expect(getDirectoryEntry(directory, ALPHA)).toBeNull();
    expect(getDirectoryEntry(directory, BETA)?.updatedAt).toBe(200);
  });

  it("does not enumerate the stamp map for repeated entry and shared-topic archive reads", () => {
    const directory = new Y.Doc();
    const uuids = [ALPHA, ...Array.from({ length: 63 }, (_, index) =>
      `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`)];
    directory.transact(() => {
      const stamps = directory.getMap("updatedAt");
      for (const [index, uuid] of uuids.entries()) {
        getDirectoryMap(directory).set(uuid, { title: uuid, tags: [], kind: "decision", topic: ALPHA });
        stamps.set(`${uuid}:foreign`, index);
        stamps.set(`${ALPHA}:writer-${index}`, index);
      }
    });
    expect(getDirectoryEntry(directory, ALPHA)?.updatedAt).toBe(63);
    const stamps = directory.getMap("updatedAt");
    const scans = [
      vi.spyOn(stamps, "entries"),
      vi.spyOn(stamps, "keys"),
      vi.spyOn(stamps, "values"),
      vi.spyOn(stamps, "forEach"),
      vi.spyOn(stamps, Symbol.iterator),
    ];
    try {
      for (const uuid of uuids) {
        expect(getDirectoryEntry(directory, uuid)).not.toBeNull();
        expect(decisionTopicArchived(directory, uuid)).toBe(false);
      }
      for (const scan of scans) expect(scan).not.toHaveBeenCalled();
    } finally {
      for (const scan of scans) scan.mockRestore();
    }
  });
});

describe("directory stub metadata divergence", () => {
  const meta: DocMeta = {
    uuid: ALPHA,
    title: "Alpha",
    tags: ["draft", "schema"],
    description: "What Alpha is for.",
    links: [],
  };
  const undescribedStub: DirectoryEntry = {
    uuid: ALPHA,
    title: meta.title,
    tags: meta.tags,
  };
  const stub: DirectoryEntry = {
    ...undescribedStub,
    description: meta.description ?? "",
  };

  it("detects a missing stub or a difference in any cached field alone", () => {
    expect(directoryStubDiffers(null, meta)).toBe(true);
    for (const [field, change] of [
      ["title", { title: "Alpha, renamed" }],
      ["tag set", { tags: ["draft", "reference"] }],
      ["description", { description: "A new purpose." }],
      ["kind", { kind: "decision" }],
      ["status", { status: "open" }],
    ] satisfies Array<[string, Partial<DirectoryEntry>]>) {
      expect(directoryStubDiffers({ ...stub, ...change }, meta), field).toBe(true);
    }
    // A description present on only one side.
    expect(directoryStubDiffers(undescribedStub, meta)).toBe(true);
    expect(directoryStubDiffers(stub, { ...meta, description: null })).toBe(true);
  });

  it("accepts matching metadata, tags in any order and an absent or empty description", () => {
    expect(directoryStubDiffers(stub, meta)).toBe(false);
    expect(
      directoryStubDiffers({ ...stub, tags: ["schema", "draft"] }, meta),
    ).toBe(false);
    for (const [cached, document] of [
      [undefined, null],
      [undefined, ""],
      ["", null],
      ["", ""],
    ] satisfies Array<[string | undefined, string | null]>) {
      expect(
        directoryStubDiffers(
          {
            ...undescribedStub,
            ...(cached === undefined ? {} : { description: cached }),
          },
          { ...meta, description: document },
        ),
        `${cached}/${document}`,
      ).toBe(false);
    }
  });

  it("leaves uncached metadata, timestamps and tombstones to callers", () => {
    expect(
      directoryStubDiffers(
        { ...stub, uuid: BETA, createdAt: 1_000, updatedAt: 2_000, deleted: true },
        {
          ...meta,
          links: [GAMMA],
          tldr: "A summary for readers.",
          supersedes: GAMMA,
        },
      ),
    ).toBe(false);
  });
});
