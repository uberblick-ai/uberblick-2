/**
 * What a tool accepts — and what it refuses before it has done anything.
 *
 * Three claims are defended here, all of them about the boundary rather than
 * about any handler:
 *
 * - **A field nobody declared is refused, not dropped.** A stripped key is an
 *   input the caller believes it sent: `create_doc` with a top-level
 *   `pinned: true` created an unpinned document, and a misspelled mutation
 *   field wrote the document with the mistake silently discarded. The proof
 *   that a rejection is free is the durable one — the update log does not grow.
 * - **`annotate` is two shapes, never a mixture.** Opening a thread names a
 *   block and a range; a reply names a thread. Both at once was accepted and
 *   the range quietly ignored.
 * - **`sidebar_group` is three shapes, and each takes only its own field.** A
 *   `rename` carrying an `index` moved nothing and said nothing.
 *
 * `tools/list` is asserted alongside the calls on purpose: a caller that cannot
 * read the rule from the advertised schema has to learn it by being refused,
 * which is the state this suite exists to end. What the shapes MEAN — how a
 * thread anchors, what a group delete does to its pins — belongs to
 * `sidebar.test.ts` and the schema package, and is not retested here.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

/** The advertised input schema of one tool, as a client reads it. */
async function inputSchema(rig: Rig, tool: string): Promise<any> {
  const { tools } = await rig.client.listTools();
  const found = tools.find((candidate) => candidate.name === tool);
  if (found === undefined) throw new Error(`no tool ${tool}`);
  return found.inputSchema as any;
}

/** A document with one paragraph. */
async function seeded(rig: Rig): Promise<{ uuid: string; blockId: string }> {
  const created = await rig.ok("create_doc", {
    title: "Arguments",
    description: "A document the input boundary is exercised against.",
    blocks: [{ type: "paragraph", text: "one two three" }],
  });
  return { uuid: created.uuid, blockId: created.blocks[0].id };
}

/** Group names in sidebar order. */
async function groups(rig: Rig): Promise<string[]> {
  const sidebar = await rig.ok("get_sidebar");
  return sidebar.groups.map((group: { name: string }) => group.name);
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("unknown fields", () => {
  it("are refused by every tool, and cost the log nothing", async () => {
    const rig = await localRig();
    const doc = await seeded(rig);
    const store = rig.instance.replicas.store;

    // The rule is advertised, so a client reads it before it sends anything —
    // over the whole tool set, because one tool left stripping is the one a
    // caller will hit.
    const { tools } = await rig.client.listTools();
    for (const tool of tools) {
      expect(
        (tool.inputSchema as any).additionalProperties,
        `${tool.name} strips unknown fields instead of refusing them`,
      ).toBe(false);
    }

    const logged = store.logSize();
    const before = (await rig.ok("list_docs")).docs.length;

    // #314's boundary: placement implies pinning, so `pinned` is a field this
    // input deliberately cannot express — and creating an UNPINNED document
    // for a caller that asked for a pinned one is the outcome refusing avoids.
    const created = await rig.call("create_doc", {
      title: "Rejected",
      description: "A test document.",
      pinned: true,
    });
    expect(created.isError).toBe(true);

    // Strictness has to reach the nested objects an input declares, or the
    // guarantee stops at the first array: a block carrying a key the schema
    // does not know would otherwise be created with that key discarded.
    const nested = await rig.call("create_doc", {
      title: "Rejected",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "x", bogus: 1 }],
    });
    expect(nested.isError).toBe(true);

    // A mutation field with a typo in it. The write it asked for is the one
    // that must not happen quietly under a different field.
    const renamed = await rig.call("set_title", {
      uuid: doc.uuid,
      titel: "Typo",
    });
    expect(renamed.isError).toBe(true);

    // No uuid, no room update, nothing durable: the handlers never ran.
    expect((await rig.ok("list_docs")).docs).toHaveLength(before);
    expect(store.logSize()).toBe(logged);
  });
});

describe("annotate", () => {
  it("advertises two shapes and accepts nothing in between", async () => {
    const rig = await localRig();
    const doc = await seeded(rig);

    expect((await inputSchema(rig, "annotate")).oneOf).toEqual([
      {
        title: "A reply (`thread_id`)",
        required: ["thread_id"],
        properties: { block_id: false, start: false, end: false },
      },
      {
        title: "Opening a thread over a range",
        required: ["block_id", "start", "end"],
        properties: { thread_id: false },
      },
    ]);

    const opened = await rig.ok("annotate", {
      uuid: doc.uuid,
      block_id: doc.blockId,
      start: 0,
      end: 3,
      text: "the first thread",
    });
    const threadId = opened.annotation.id;
    const replied = await rig.ok("annotate", {
      uuid: doc.uuid,
      thread_id: threadId,
      text: "and a reply",
    });
    expect(replied.annotation.comments).toHaveLength(2);

    const refused = [
      // A reply that also carries a range says two things at once. Each range
      // field on its own, because the handler used to ignore all three.
      { thread_id: threadId, block_id: doc.blockId },
      { thread_id: threadId, start: 0 },
      { thread_id: threadId, end: 3 },
      // And a create that never finished stating its range.
      { block_id: doc.blockId },
      { block_id: doc.blockId, start: 4 },
      { start: 4, end: 7 },
      // Neither shape at all.
      {},
    ];
    for (const args of refused) {
      const result = await rig.call("annotate", {
        uuid: doc.uuid,
        text: "refused",
        ...args,
      });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.payload.error, JSON.stringify(args)).toBe("schema_validation");
    }

    // The document holds what the two valid calls put there, and nothing else.
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.annotations).toHaveLength(1);
    expect(read.annotations[0].comments).toHaveLength(2);
  });
});

describe("sidebar_group", () => {
  it("advertises three shapes and refuses another action's fields", async () => {
    const rig = await localRig();
    const doc = await seeded(rig);
    await rig.ok("pin_doc", { uuid: doc.uuid, group: "Start here" });
    await rig.ok("pin_doc", { uuid: doc.uuid, group: "Reference" });

    expect((await inputSchema(rig, "sidebar_group")).oneOf).toEqual([
      {
        title: "rename",
        required: ["name"],
        properties: { action: { const: "rename" }, index: false },
      },
      {
        title: "move",
        properties: { action: { const: "move" }, name: false },
      },
      {
        title: "delete",
        properties: { action: { const: "delete" }, name: false, index: false },
      },
    ]);

    const refused = [
      // rename says which name, and nothing about position.
      { action: "rename" },
      { action: "rename", name: "Renamed", index: 0 },
      { action: "rename", index: 0 },
      // move says which position, and nothing about naming.
      { action: "move", name: "Renamed" },
      { action: "move", name: "Renamed", index: 0 },
      // delete says neither.
      { action: "delete", name: "Renamed" },
      { action: "delete", index: 0 },
      // A field belonging to no action at all.
      { action: "move", position: 0 },
    ];
    for (const args of refused) {
      const result = await rig.call("sidebar_group", {
        group: "Start here",
        ...args,
      });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.payload.error, JSON.stringify(args)).toBe("schema_validation");
    }
    // Nothing was renamed, moved or deleted on the way through.
    expect(await groups(rig)).toEqual(["Start here", "Reference"]);

    // The three shapes themselves are unchanged.
    await rig.ok("sidebar_group", {
      action: "rename",
      group: "Start here",
      name: "Entry points",
    });
    expect(await groups(rig)).toEqual(["Entry points", "Reference"]);

    await rig.ok("sidebar_group", {
      action: "move",
      group: "Entry points",
      index: 1,
    });
    expect(await groups(rig)).toEqual(["Reference", "Entry points"]);

    // Omitted `index` still means last, so a move with neither is a valid move.
    await rig.ok("sidebar_group", { action: "move", group: "Reference" });
    expect(await groups(rig)).toEqual(["Entry points", "Reference"]);

    await rig.ok("sidebar_group", { action: "delete", group: "Reference" });
    expect(await groups(rig)).toEqual(["Entry points"]);
  });
});
