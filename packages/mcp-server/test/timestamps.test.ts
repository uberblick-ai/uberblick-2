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
import { getDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { removeTempDirs, startServer, tempDatabasePath, testConfig } from "./helpers.js";
import type { McpConfig } from "../src/config.js";
import type { Rig } from "./helpers.js";

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

function stub(rig: Rig, uuid: string): DirectoryEntry {
  const entry = getDirectoryEntry(rig.instance.replicas.directory().doc, uuid);
  if (entry === null) {
    throw new Error(`no directory entry for ${uuid}`);
  }
  return entry;
}

/** Count updates published by the directory room from now on. */

async function typeInto(rig: Rig, uuid: string, text: string): Promise<void> {
  await rig.ok("insert_block", { uuid, blocks: [{ type: "paragraph", text }] });
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

  it("does not stamp for a change it only replayed from the log", async () => {
    // Two servers on one database, which is the ordinary case: the second one
    // learns this document by replaying the log, long after it was written.
    const databasePath = tempDatabasePath();
    const author = await localRig(testConfig({ databasePath }));
    const doc = await author.ok("create_doc", {
      title: "Written elsewhere",
      description: "A test document.",
    });

    vi.setSystemTime(T0 + 3 * WINDOW);
    const observer = await localRig(testConfig({ databasePath }));
    await observer.ok("list_docs");
    expect(stub(observer, doc.uuid).updatedAt).toBe(T0);

    // And back the other way: the first server reads whatever the second wrote
    // on its next call, and stamps for none of it either.
    await author.ok("list_docs");
    expect(stub(author, doc.uuid).updatedAt).toBe(T0);
  });

  it("repairs description-only drift on a later log replay without stamping", async () => {
    const databasePath = tempDatabasePath();
    const author = await localRig(testConfig({ databasePath }));
    const doc = await author.ok("create_doc", {
      title: "Described elsewhere",
      description: "Current description.",
    });
    const observer = await localRig(testConfig({ databasePath }));
    await observer.ok("list_docs");

    // The author stays inside its stamp window. Only the later observer's
    // document replay can repair this subsequently drifted description.
    vi.setSystemTime(T0 + 1_000);
    await typeInto(author, doc.uuid, "a later update");
    upsertDirectoryEntry(author.instance.replicas.directory().doc, {
      uuid: doc.uuid,
      title: "Described elsewhere",
      description: "Stale description.",
    });

    vi.setSystemTime(T0 + 3 * WINDOW);
    await observer.ok("list_docs");
    expect(stub(observer, doc.uuid)).toMatchObject({
      description: "Current description.",
      createdAt: T0,
      updatedAt: T0,
    });
  });

});
