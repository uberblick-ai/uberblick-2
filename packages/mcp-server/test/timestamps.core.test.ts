/**
 * Directory timestamps: sort keys a fresh client gets without opening a room.
 *
 * What this suite defends is the bargain behind them. `createdAt` is a fact
 * written once. `updatedAt` is deliberately coarse, because the directory is
 * broadcast to every client in the workspace and a stamp per keystroke would
 * turn typing in one document into traffic for everyone — so the contract is
 * "at most one bump per window, and immediately on a title or tag change,
 * which writes the stub anyway".
 *
 * The other half of the bargain is authorship: `updatedAt` says when someone
 * changed the document, not when a replica noticed it, so everything a server
 * merely observes — a log replay, an index rebuild, an archive restore — repairs
 * a stub that disagrees without ever restamping it. The hub's own arm of
 * that rule, a peer's edit arriving over the wire, is in `sync.test.ts`, where
 * the hub and the second client already live. Concurrent authored stamps resolve
 * to the greater number, so a future-skewed clock stands until a later authored
 * stamp exceeds it.
 *
 * The clock is faked (`toFake: ["Date"]`) and the timers are not: these rigs
 * run a real server over a real store, and a window is crossed by moving the
 * clock rather than by shrinking the window down to something untrue.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendBlock, getDirectoryEntry, getDirectoryMap, setCodeCheck, setTags, setTitle } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { McpConfig } from "../src/config.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

async function localRig(config: McpConfig = testConfig()): Promise<Rig> {
  const rig = await startServer(config);
  rigs.push(rig);
  return rig;
}

/** Midnight of a day that is not now, so a real clock could never pass for it. */
const T0 = Date.UTC(2031, 0, 1, 0, 0, 0);

/** The coarseness window in force, from the config the rigs are built with. */
const WINDOW = testConfig().updatedAtCoarsenessMs;
const CHECK = {
  repository: "uberblick-ai/uberblick-2",
  commit: "33086e02eb66f2e32dcce67a21c6c8ece9cf9ae4",
  result: "matches",
} as const;

function stub(rig: Rig, uuid: string): DirectoryEntry {
  const entry = getDirectoryEntry(rig.instance.replicas.directory().doc, uuid);
  if (entry === null) {
    throw new Error(`no directory entry for ${uuid}`);
  }
  return entry;
}

/** Count updates published by the directory room from now on. */
function countDirectoryUpdates(rig: Rig): () => number {
  let updates = 0;
  rig.instance.replicas.directory().doc.on("update", () => {
    updates += 1;
  });
  return () => updates;
}

async function typeInto(rig: Rig, uuid: string, text: string): Promise<void> {
  await rig.ok("insert_block", { uuid, type: "paragraph", text });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  vi.useRealTimers();
});

afterAll(() => {
  removeTempDirs();
});

describe("directory timestamps", () => {
  it("stamps createdAt on create_doc and returns both from list_docs", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Stamped", description: "A test document." });

    const listed = await rig.ok("list_docs");
    const entry = listed.docs.find((row: any) => row.uuid === doc.uuid);
    expect(entry.createdAt).toBe(T0);
    expect(entry.updatedAt).toBe(T0);
  });

  it("bumps updatedAt at most once per window under a burst of edits", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Burst", description: "A test document." });
    const directoryUpdates = countDirectoryUpdates(rig);

    // Twenty edits spread over twenty seconds — a plausible minute of an agent
    // writing — all inside the first window.
    for (let index = 0; index < 20; index += 1) {
      vi.setSystemTime(T0 + index * 1_000);
      await typeInto(rig, doc.uuid, `line ${index}`);
    }
    expect(stub(rig, doc.uuid).updatedAt).toBe(T0);
    // The point of the coarseness: the whole burst cost the workspace nothing.
    expect(directoryUpdates()).toBe(0);

    // The first edit past the window stamps, and one more inside the new window
    // does not.
    vi.setSystemTime(T0 + WINDOW);
    await typeInto(rig, doc.uuid, "after the window");
    expect(stub(rig, doc.uuid).updatedAt).toBe(T0 + WINDOW);
    expect(directoryUpdates()).toBe(1);

    vi.setSystemTime(T0 + WINDOW + 1_000);
    await typeInto(rig, doc.uuid, "still inside the next window");
    expect(stub(rig, doc.uuid).updatedAt).toBe(T0 + WINDOW);
    expect(directoryUpdates()).toBe(1);

    // Created-at is a fact about the document, not a moving stamp.
    expect(stub(rig, doc.uuid).createdAt).toBe(T0);
  });

  it("bumps updatedAt immediately on a tag or title change", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Before", description: "A test document." });

    vi.setSystemTime(T0 + 1_000);
    await rig.ok("set_metadata", { uuid: doc.uuid, tags: ["mcp"] });
    expect(stub(rig, doc.uuid).updatedAt).toBe(T0 + 1_000);

    // The web editor's path: the title lives in the document, and the stub
    // follows it.
    vi.setSystemTime(T0 + 2_000);
    setTitle(rig.instance.replicas.replica(doc.uuid).doc, "After");
    expect(stub(rig, doc.uuid)).toMatchObject({
      title: "After",
      updatedAt: T0 + 2_000,
      createdAt: T0,
    });
  });

  it("refreshes code-check caches without stamping or consuming the content-edit window", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Checked", description: "A test document." });
    const { rev } = await rig.ok("get_doc", { uuid: doc.uuid });
    const changedCheck = { ...CHECK, commit: "a".repeat(40), result: "drift" };

    for (const [time, codeCheck] of [
      [T0 + 1_000, CHECK],
      [T0 + 1_000, CHECK],
      [T0 + 2_000, CHECK],
      [T0 + WINDOW + 1_000, changedCheck],
      [T0 + 2 * WINDOW, changedCheck],
    ] as const) {
      vi.setSystemTime(time);
      const written = await rig.ok("set_metadata", { uuid: doc.uuid, code_check: { ...codeCheck, rev } });
      expect(written.code_check).toEqual([{ ...codeCheck, rev, checked_at: new Date(time).toISOString() }]);
      expect(stub(rig, doc.uuid)).toMatchObject({ createdAt: T0, updatedAt: T0 });
      const listed = (await rig.ok("list_docs")).docs.find((entry: any) => entry.uuid === doc.uuid);
      expect(listed).toMatchObject({ code_check: written.code_check, updatedAt: T0 });
    }

    vi.setSystemTime(T0 + 2 * WINDOW + 1_000);
    await typeInto(rig, doc.uuid, "an authored content edit");
    expect(stub(rig, doc.uuid).updatedAt).toBe(T0 + 2 * WINDOW + 1_000);
    vi.setSystemTime(T0 + 2 * WINDOW + 2_000);
    await typeInto(rig, doc.uuid, "still in that content-edit window");
    expect(stub(rig, doc.uuid).updatedAt).toBe(T0 + 2 * WINDOW + 1_000);
    vi.setSystemTime(T0 + 3 * WINDOW + 1_000);
    await typeInto(rig, doc.uuid, "the next content-edit window");
    expect(stub(rig, doc.uuid).updatedAt).toBe(T0 + 3 * WINDOW + 1_000);
  });

  it.each([
    { field: "title", value: "Changed title" },
    { field: "description", value: "Changed description." },
    { field: "tldr", value: "A short summary." },
    { field: "tags", value: ["mcp"] },
    { field: "links", value: null },
  ])("stamps a code check immediately when $field also changes", async ({ field, value }) => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Checked", description: "A test document." });
    const changed = field === "links"
      ? [(await rig.ok("create_doc", { title: "Link target", description: "A related page." })).uuid]
      : value;
    const { rev } = await rig.ok("get_doc", { uuid: doc.uuid });

    vi.setSystemTime(T0 + 1_000);
    const written = await rig.ok("set_metadata", { uuid: doc.uuid, [field]: changed, code_check: { ...CHECK, rev } });
    expect(stub(rig, doc.uuid)).toMatchObject({ updatedAt: T0 + 1_000, createdAt: T0 });
    const listed = (await rig.ok("list_docs")).docs.find((entry: any) => entry.uuid === doc.uuid);
    expect(listed).toMatchObject({ code_check: written.code_check, updatedAt: T0 + 1_000 });
  });

  it("stamps a code check immediately when the same transaction also edits content", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Checked", description: "A test document." });
    const replica = rig.instance.replicas.replica(doc.uuid);

    vi.setSystemTime(T0 + 1_000);
    replica.doc.transact(() => {
      setCodeCheck(replica.doc, CHECK);
      appendBlock(replica.doc, { type: "paragraph", text: "An authored content edit." });
    });
    expect(stub(rig, doc.uuid)).toMatchObject({ updatedAt: T0 + 1_000, createdAt: T0 });
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).blocks).toEqual([
      expect.objectContaining({ text: "An authored content edit." }),
    ]);
  });

  it("stamps a regular document immediately when its open-thread count changes", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Discussed", description: "A test document.",
      blocks: [{ type: "paragraph", text: "one two three" }],
    });
    vi.setSystemTime(T0 + 1_000);
    const opened = await rig.ok("annotate", {
      uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "Question",
    });
    expect(stub(rig, doc.uuid)).toMatchObject({ openThreadCount: 1, updatedAt: T0 + 1_000 });
    vi.setSystemTime(T0 + 2_000);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: opened.annotation.id, text: "Reply" });
    expect(stub(rig, doc.uuid)).toMatchObject({ openThreadCount: 1, updatedAt: T0 + 1_000 });
    vi.setSystemTime(T0 + 3_000);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: opened.annotation.id, text: "Done", resolved: true });
    expect(stub(rig, doc.uuid)).toMatchObject({ openThreadCount: 0, updatedAt: T0 + 3_000 });
    vi.setSystemTime(T0 + 4_000);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: opened.annotation.id, text: "Reconsider", resolved: false });
    expect(stub(rig, doc.uuid)).toMatchObject({ openThreadCount: 1, updatedAt: T0 + 4_000 });
  });

  it("backfills createdAt on a stub that predates the field", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Old", description: "A test document." });

    // Write a stub without stamps directly; upsertDirectoryEntry would preserve
    // createdAt and leave nothing to backfill.
    getDirectoryMap(rig.instance.replicas.directory().doc).set(doc.uuid, {
      title: "Old",
      tags: [],
    });
    // Clear the separate max candidate too, so neither timestamp representation remains.
    rig.instance.replicas.directory().doc.getMap("updatedAt").clear();
    expect(stub(rig, doc.uuid).createdAt).toBeUndefined();

    vi.setSystemTime(T0 + 1_000);
    await typeInto(rig, doc.uuid, "the first thing anyone observed");
    expect(stub(rig, doc.uuid)).toMatchObject({
      createdAt: T0 + 1_000,
      updatedAt: T0 + 1_000,
    });
  });

  it("backfills only missing createdAt without stamping", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Right",
      description: "A test document.",
    });

    // Keep every cached field and updatedAt correct, isolating the missing
    // creation time. A normal upsert would carry createdAt forward.
    getDirectoryMap(rig.instance.replicas.directory().doc).set(doc.uuid, {
      title: "Right",
      tags: [],
      description: "A test document.",
      updatedAt: T0,
    });

    // Rebuilding the derived index is not editing a document — but it does reach
    // the stub, and the stub is the one thing here that is not rebuildable.
    vi.setSystemTime(T0 + 3 * WINDOW);
    rig.instance.replicas.rebuildIndex();

    expect(stub(rig, doc.uuid)).toMatchObject({
      title: "Right",
      createdAt: T0 + 3 * WINDOW,
      updatedAt: T0,
    });
  });

  it("republishes a stub on restore without inventing a stamp for it", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", {
      title: "Archived",
      description: "A test document.",
    });
    await rig.ok("archive_doc", { uuid: doc.uuid });

    // The shape `republishStub` exists for: the document has metadata newer than
    // its tombstoned stub. This server did not author that change, so restoring
    // repairs the cached fields without inventing a stamp at the restore time.
    // The honest answer remains the greatest stamp an author actually wrote.
    vi.setSystemTime(T0 + 3 * WINDOW);
    setTags(rig.instance.replicas.replica(doc.uuid).doc, [
      "00000000-0000-4000-8000-000000000002",
    ]);
    await rig.ok("restore_doc", { uuid: doc.uuid });

    expect(stub(rig, doc.uuid)).toMatchObject({
      tags: ["00000000-0000-4000-8000-000000000002"],
      updatedAt: T0,
    });
  });
});
