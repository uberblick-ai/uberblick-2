import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readBlocks, removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "List", description: "Structured list items.",
    blocks: [{ type: "list-item", text: "Item" }], ...fields,
  });
}

function state(rig: Rig, uuid: string) {
  return {
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    sidebar: Y.encodeStateAsUpdate(rig.instance.replicas.sidebar().doc),
    document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc),
    log: rig.instance.store.logSize(),
  };
}

async function refuse(rig: Rig, tool: string, args: Record<string, unknown>, error: string, uuid: string) {
  const before = state(rig, uuid);
  const result = await rig.call(tool, args);
  expect(result).toMatchObject({ isError: true, payload: { error } });
  expect(state(rig, uuid)).toEqual(before);
  return result.payload;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("MCP list attributes", () => {
  it.each(["ordered", "unchecked", "checked"].flatMap(list =>
    ["create_doc", "insert_block", "edit_block"].map(tool => ({ list, tool })),
  ))("passes $list style and depth through $tool", async ({ list, tool }) => {
    const rig = await local();
    const input = { type: "list-item", text: "Nested", list, indent: 2 };
    const doc = await create(rig, tool === "create_doc" ? { blocks: [input] } : {});
    const written = tool === "create_doc" ? doc.blocks[0] : tool === "insert_block"
      ? (await rig.ok(tool, { uuid: doc.uuid, blocks: [input] })).blocks[0]
      : (await rig.ok(tool, { uuid: doc.uuid, block_id: doc.blocks[0].id,
        old_text: "Item", new_text: input.text, rev: doc.blocks[0].rev,
        list: input.list, indent: input.indent })).block;
    expect((await readBlocks(rig, doc.uuid, [written]))[0]).toMatchObject({ ...input, rev: written.rev });
  });

  it("ticks and unticks with unchanged text, preserving formatting and threads while changing rev", async () => {
    const rig = await local();
    const doc = await create(rig, { blocks: [{ type: "list-item", list: "unchecked", indent: 1,
      inline: [{ text: "Review ", marks: {} }, { text: "notes", marks: { bold: true } }],
    }] });
    const [initial] = await readBlocks(rig, doc.uuid, doc.blocks);
    await rig.ok("annotate", { uuid: doc.uuid, block_id: initial.id, start: 0, end: 6, text: "Keep this comment." });
    const before = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(before.annotations).toHaveLength(1);
    let current = initial;
    for (const list of ["checked", "unchecked"]) {
      const edited = await rig.ok("edit_block", { uuid: doc.uuid, block_id: current.id,
        old_text: current.text, new_text: current.text, rev: current.rev, list });
      expect(edited.block.rev).not.toBe(current.rev);
      const read = await rig.ok("get_doc", { uuid: doc.uuid });
      expect(read.blocks[0]).toEqual({ ...initial, list, rev: edited.block.rev });
      expect(read.annotations).toEqual(before.annotations);
      current = read.blocks[0];
    }
  });

  it("keeps decided answers read-only when toggling an item, while open answers accept it", async () => {
    const rig = await local();
    for (const status of ["open", "decided"]) {
      const doc = await create(rig, { kind: "decision", status,
        blocks: [{ type: "list-item", text: "Review notes", list: "unchecked" }],
      });
      const [block] = await readBlocks(rig, doc.uuid, doc.blocks);
      const args = { uuid: doc.uuid, block_id: block.id, old_text: block.text,
        new_text: block.text, rev: block.rev, list: "checked" };
      if (status === "decided") {
        await refuse(rig, "edit_block", args, "decision_read_only", doc.uuid);
      } else {
        const edited = await rig.ok("edit_block", args);
        expect(edited.block.rev).not.toBe(block.rev);
        expect((await readBlocks(rig, doc.uuid, [edited.block]))[0]).toMatchObject({ list: "checked" });
      }
    }
  });

  it.each([
    { list: "numbered" }, { indent: 4 },
  ])("refuses invalid list attributes %j on every write before any mutation", async (fields) => {
    const rig = await local();
    const doc = await create(rig);
    const [block] = await readBlocks(rig, doc.uuid, doc.blocks);
    await refuse(rig, "create_doc", {
      title: "Invalid", description: "Must not be created.",
      blocks: [{ type: "paragraph", text: "Must not be seeded." }, { type: "list-item", text: "Invalid", ...fields }],
    }, "schema_validation", doc.uuid);
    await refuse(rig, "insert_block", {
      uuid: doc.uuid,
      blocks: [{ type: "list-item", text: "Invalid", ...fields }],
    }, "schema_validation", doc.uuid);
    const refused = await refuse(rig, "edit_block", {
      uuid: doc.uuid, block_id: block.id, old_text: block.text, new_text: "Must not change.", rev: block.rev, ...fields,
    }, "schema_validation", doc.uuid);
    if ("list" in fields) {
      for (const style of ["bullet", "ordered", "unchecked", "checked"]) expect(refused.message).toContain(style);
    }
    expect((await rig.ok("list_docs")).docs.map((entry: { uuid: string }) => entry.uuid)).toEqual([doc.uuid]);
  });
});
