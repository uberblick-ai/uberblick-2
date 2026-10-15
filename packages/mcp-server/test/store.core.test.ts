import { afterEach, describe, expect, it } from "vitest";
import { MirrorStore } from "../src/store.js";
import { WORKSPACE, removeTempDirs } from "./core-helpers.js";

/** Expected content of the independently generated better-sqlite3 fixture. */
const LEGACY = {
  uuid: "3f2b0a6c-8b1e-4a55-9c47-0d5d1e6b7a90",
  linked: "9a1c7d2e-4f60-4b18-8f3a-2c5e9b0d6c11",
  title: "Written by better-sqlite3",
  blocks: ["seeded by the old binding", "appended after the snapshot"],
} as const;

const GITHUB_ITEM = "uberblick-ai/uberblick-2#1125";

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

describe("a payload that is a view into a larger buffer", () => {
  it("is logged as the view, not as the buffer behind it", () => {
    // Yjs hands out `Uint8Array`s, and nothing promises they start at byte zero
    // of their own `ArrayBuffer`. A binding that binds the backing buffer rather
    // than the view writes a corrupt update that only fails on replay, far from
    // here — so the bytes are checked at the boundary they cross.
    const opened = store(":memory:");
    const backing = new Uint8Array([0xff, 0xff, 1, 2, 3, 0xff]);
    const payload = backing.subarray(2, 5);

    const seq = opened.appendUpdate("a-room", payload, "remote");
    const [logged] = opened.updatesAfter("a-room", seq - 1);
    expect(logged?.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(logged?.payload ?? [])).toEqual([1, 2, 3]);
  });
});

describe("derived GitHub references", () => {
  it("deduplicates and orders records, replaces references, and clears them with the index", () => {
    const opened = store(":memory:");
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
});
