/**
 * Block-scoped writes: what happens when they conflict, and what the derived
 * index does afterwards.
 *
 * Two MCP servers sharing one database is the normal case (a user runs their
 * agent twice), so the concurrency test uses exactly that rather than a mocked
 * second replica: each instance appends to the shared log, and each picks the
 * other up by polling the log tail at tool-call start.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(databasePath?: string): Promise<Rig> {
  const rig = await startServer(
    testConfig(databasePath === undefined ? {} : { databasePath }),
  );
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("edit_block", () => {

  it("merges concurrent edits to different blocks across two instances", async () => {
    const databasePath = testConfig().databasePath;
    const first = await localRig(databasePath);
    const doc = await first.ok("create_doc", {
      title: "Two agents",
      description: "A test document.",
      blocks: [
        { type: "paragraph", text: "block one" },
        { type: "paragraph", text: "block two" },
      ],
    });

    const second = await localRig(databasePath);
    const seen = await second.ok("get_doc", { uuid: doc.uuid });
    expect(seen.blocks.map((block: { text: string }) => block.text)).toEqual([
      "block one",
      "block two",
    ]);

    // Neither instance has seen the other's edit when it makes its own.
    const [one, two] = await Promise.all([
      first.ok("edit_block", {
        uuid: doc.uuid,
        block_id: seen.blocks[0].id,
        old_text: "block one",
        new_text: "block one, edited by the first agent",
        rev: seen.blocks[0].rev,
      }),
      second.ok("edit_block", {
        uuid: doc.uuid,
        block_id: seen.blocks[1].id,
        old_text: "block two",
        new_text: "block two, edited by the second agent",
        rev: seen.blocks[1].rev,
      }),
    ]);
    expect(one.applied).toBe(true);
    expect(two.applied).toBe(true);

    for (const rig of [first, second]) {
      const merged = await rig.ok("get_doc", { uuid: doc.uuid });
      expect(merged.blocks.map((block: { text: string }) => block.text)).toEqual(
        [
          "block one, edited by the first agent",
          "block two, edited by the second agent",
        ],
      );
    }
  });
});

describe("the derived index", () => {

  it("rebuilds an inline edge from a second instance's log replay", async () => {
    const databasePath = testConfig().databasePath;
    const first = await localRig(databasePath);
    const target = await first.ok("create_doc", { title: "Target", description: "A test document." });
    const source = await first.ok("create_doc", {
      title: "Source",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "See the hub docs" }],
    });
    await first.ok("link_range", {
      uuid: source.uuid,
      block_id: source.blocks[0].id,
      start: 4,
      end: 11,
      doc_id: target.uuid,
      rev: source.blocks[0].rev,
    });

    // A second server over the same log: it hydrates from the log alone, so
    // the edge has to come back out of the updates rather than out of any row.
    const second = await localRig(databasePath);
    await second.ok("list_docs", {});
    const store = second.instance.store;
    store.clearDerived();
    expect(store.backlinks(target.uuid)).toEqual([]);

    second.instance.replicas.rebuildIndex();
    expect(store.backlinks(target.uuid).map((row) => row.uuid)).toEqual([
      source.uuid,
    ]);
  });

});
