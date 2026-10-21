import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { removeTempDirs, startServer } from "./core-helpers.js";
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
  expect(await rig.call(tool, args)).toMatchObject({ isError: true, payload: { error } });
  expect(state(rig, uuid)).toEqual(before);
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("MCP list attributes", () => {
  it.each(["create_doc", "insert_block", "edit_block"])("passes list style and depth through %s", async (tool) => {
    const rig = await local();
    const input = { type: "list-item", text: "Nested", list: "ordered", indent: 2 };
    const doc = await create(rig, tool === "create_doc" ? { blocks: [input] } : {});
    const block = tool === "create_doc" ? doc.blocks[0] : tool === "insert_block"
      ? (await rig.ok(tool, { uuid: doc.uuid, blocks: [input] })).blocks[0]
      : (await rig.ok(tool, { uuid: doc.uuid, block_id: doc.blocks[0].id,
        old_text: doc.blocks[0].text, new_text: input.text, rev: doc.blocks[0].rev,
        list: input.list, indent: input.indent })).block;
    expect(block).toMatchObject(input);
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).blocks).toContainEqual(block);
  });

  it.each([
    { list: "numbered" }, { indent: 4 },
  ])("refuses invalid list attributes %j on every write before any mutation", async (fields) => {
    const rig = await local();
    const doc = await create(rig);
    const block = doc.blocks[0];
    await refuse(rig, "create_doc", {
      title: "Invalid", description: "Must not be created.",
      blocks: [{ type: "paragraph", text: "Must not be seeded." }, { type: "list-item", text: "Invalid", ...fields }],
    }, "schema_validation", doc.uuid);
    await refuse(rig, "insert_block", {
      uuid: doc.uuid,
      blocks: [{ type: "list-item", text: "Invalid", ...fields }],
    }, "schema_validation", doc.uuid);
    await refuse(rig, "edit_block", {
      uuid: doc.uuid, block_id: block.id, old_text: block.text, new_text: "Must not change.", rev: block.rev, ...fields,
    }, "schema_validation", doc.uuid);
    expect((await rig.ok("list_docs")).docs.map((entry: { uuid: string }) => entry.uuid)).toEqual([doc.uuid]);
  });
});
