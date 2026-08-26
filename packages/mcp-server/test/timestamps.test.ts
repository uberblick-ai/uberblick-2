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
 * The clock is faked (`toFake: ["Date"]`) and the timers are not: these rigs
 * run a real server over a real store, and a window is crossed by moving the
 * clock rather than by shrinking the window down to something untrue.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDirectoryEntry, getDirectoryMap, setTitle } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import {
  removeTempDirs,
  startServer,
  testConfig,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

/** Midnight of a day that is not now, so a real clock could never pass for it. */
const T0 = Date.UTC(2031, 0, 1, 0, 0, 0);

/** The coarseness window in force, from the config the rigs are built with. */
const WINDOW = testConfig().updatedAtCoarsenessMs;

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
    const doc = await rig.ok("create_doc", { title: "Stamped" });

    const listed = await rig.ok("list_docs");
    const entry = listed.docs.find((row: any) => row.uuid === doc.uuid);
    expect(entry.createdAt).toBe(T0);
    expect(entry.updatedAt).toBe(T0);
  });

  it("bumps updatedAt at most once per window under a burst of edits", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Burst" });
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

  it("bumps updatedAt immediately on a tag change", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Retagged" });

    vi.setSystemTime(T0 + 1_000);
    await rig.ok("set_tags", { uuid: doc.uuid, tags: ["reference"] });
    expect(stub(rig, doc.uuid).updatedAt).toBe(T0 + 1_000);
  });

  it("bumps updatedAt immediately on a title change", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Before" });

    // The web editor's path: the title lives in the document, and the stub
    // follows it.
    vi.setSystemTime(T0 + 1_000);
    setTitle(rig.instance.replicas.replica(doc.uuid).doc, "After");
    expect(stub(rig, doc.uuid)).toMatchObject({
      title: "After",
      updatedAt: T0 + 1_000,
      createdAt: T0,
    });
  });

  it("backfills createdAt on a stub that predates the field", async () => {
    const rig = await localRig();
    const doc = await rig.ok("create_doc", { title: "Old" });

    // A stub exactly as a writer that predates the fields left it: right title,
    // right tags, no stamps at all. Written into the map directly, because
    // `upsertDirectoryEntry` would carry the existing createdAt forward and
    // there would be nothing left to backfill.
    getDirectoryMap(rig.instance.replicas.directory().doc).set(doc.uuid, {
      title: "Old",
      tags: [],
    });
    expect(stub(rig, doc.uuid).createdAt).toBeUndefined();

    vi.setSystemTime(T0 + 1_000);
    await typeInto(rig, doc.uuid, "the first thing anyone observed");
    expect(stub(rig, doc.uuid)).toMatchObject({
      createdAt: T0 + 1_000,
      updatedAt: T0 + 1_000,
    });
  });
});
