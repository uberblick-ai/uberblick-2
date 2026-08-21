import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getDirectoryEntry,
  getDirectoryMap,
  listDirectory,
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
});
