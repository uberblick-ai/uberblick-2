import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blockText } from "../src/replica.js";
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
  it.each(["create_doc", "insert_block"])("stores chosen style and depth through %s, including defaults and boundaries", async (tool) => {
    const rig = await local();
    const inputs = [
      { type: "list-item", text: "Default" },
      { type: "list-item", text: "Nested", list: "ordered", indent: 2 },
      { type: "list-item", text: "Top", list: "ordered", indent: 0 },
      { type: "list-item", text: "Deep", list: "bullet", indent: 3 },
    ];
    const doc = await create(rig, { blocks: tool === "create_doc" ? inputs : [] });
    if (tool === "insert_block") {
      let after: string | null = null;
      for (const input of inputs) {
        const inserted = await rig.ok(tool, { uuid: doc.uuid, after_block_id: after, ...input });
        expect(inserted.block).toMatchObject({
          ...input, list: input.list ?? "bullet", indent: input.indent ?? 0,
        });
        after = inserted.block.id;
      }
    }
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).blocks).toMatchObject(inputs.map((input) => ({
      ...input, list: input.list ?? "bullet", indent: input.indent ?? 0,
    })));
  });

  it.each([
    { list: "numbered" }, { indent: -1 }, { indent: 4 }, { indent: 1.5 }, { indent: "2" },
  ])("refuses invalid list attributes %j on every write before any mutation", async (fields) => {
    const rig = await local();
    const doc = await create(rig);
    const block = doc.blocks[0];
    await refuse(rig, "create_doc", {
      title: "Invalid", description: "Must not be created.",
      blocks: [{ type: "paragraph", text: "Must not be seeded." }, { type: "list-item", text: "Invalid", ...fields }],
    }, "schema_validation", doc.uuid);
    await refuse(rig, "insert_block", {
      uuid: doc.uuid, type: "list-item", text: "Invalid", ...fields,
    }, "schema_validation", doc.uuid);
    await refuse(rig, "edit_block", {
      uuid: doc.uuid, block_id: block.id, old_text: block.text, new_text: "Must not change.", rev: block.rev, ...fields,
    }, "schema_validation", doc.uuid);
    expect((await rig.ok("list_docs")).docs.map((entry: { uuid: string }) => entry.uuid)).toEqual([doc.uuid]);
  });

  it("changes style, depth and text independently under fresh revisions, preserving omitted attributes", async () => {
    const rig = await local();
    const doc = await create(rig);
    let block = doc.blocks[0];
    for (const fields of [
      { list: "ordered" }, { indent: 3 }, { list: "bullet", indent: 2, new_text: "Changed item" },
      { new_text: "Changed again" },
    ]) {
      const edited = await rig.ok("edit_block", {
        uuid: doc.uuid, block_id: block.id, old_text: block.text, new_text: block.text, rev: block.rev, ...fields,
      });
      expect(edited.block).toMatchObject({
        id: block.id, type: "list-item", text: fields.new_text ?? block.text,
        list: fields.list ?? block.list, indent: fields.indent ?? block.indent,
      });
      expect(edited.block.rev).not.toBe(block.rev);
      block = edited.block;
    }
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).blocks).toEqual([block]);
  });

  it("rejects stale revisions and mismatched old_text without applying attributes or text", async () => {
    const rig = await local();
    const doc = await create(rig);
    const original = doc.blocks[0];
    const { block } = await rig.ok("edit_block", {
      uuid: doc.uuid, block_id: original.id, old_text: original.text, new_text: original.text,
      rev: original.rev, list: "ordered",
    });
    await refuse(rig, "edit_block", {
      uuid: doc.uuid, block_id: block.id, old_text: block.text, new_text: "Rejected", rev: original.rev,
      list: "bullet", indent: 3,
    }, "stale_block", doc.uuid);
    await refuse(rig, "edit_block", {
      uuid: doc.uuid, block_id: block.id, old_text: "Wrong", new_text: "Rejected", rev: block.rev,
      list: "bullet", indent: 3,
    }, "old_text_mismatch", doc.uuid);
    await refuse(rig, "edit_block", {
      uuid: doc.uuid, block_id: block.id, old_text: "Wrong", new_text: "Rejected", indent: 3,
    }, "stale_block", doc.uuid);
  });

  it("keeps text, inline formatting, thread anchors and document order on attribute-only edits", async () => {
    const rig = await local();
    const doc = await create(rig, { blocks: [
      { type: "paragraph", text: "Before" },
      { type: "list-item", text: "", inline: [{ text: "Bold", marks: { bold: true } }, { text: " item", marks: {} }] },
      { type: "paragraph", text: "After" },
    ] });
    const block = doc.blocks[1];
    await rig.ok("annotate", { uuid: doc.uuid, block_id: block.id, start: 0, end: 4, text: "Keep this thread." });
    const before = await rig.ok("get_doc", { uuid: doc.uuid });
    const text = blockText(rig.instance.replicas.replica(doc.uuid).doc, block.id);
    const delta = text?.toDelta();
    expect(delta).toMatchObject([{ insert: "Bold", attributes: { bold: {} } }, { insert: " item" }]);
    const edited = await rig.ok("edit_block", {
      uuid: doc.uuid, block_id: block.id, old_text: block.text, new_text: block.text,
      rev: block.rev, list: "ordered", indent: 2,
    });
    const after = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(after.blocks).toEqual([before.blocks[0], edited.block, before.blocks[2]]);
    expect(edited.block).toMatchObject({ id: block.id, text: block.text, list: "ordered", indent: 2 });
    expect(after.annotations).toEqual(before.annotations);
    expect(blockText(rig.instance.replicas.replica(doc.uuid).doc, block.id)).toBe(text);
    expect(text?.toDelta()).toEqual(delta);
  });

  it.each([
    { type: "paragraph", text: "Plain", next: "Changed" },
    { type: "table", text: "| Name |\n| --- |\n| Before |", next: "| Name |\n| --- |\n| After |" },
    { type: "card", text: "title: Before", next: "title: After" },
    { type: "figma", text: "url: https://www.figma.com/design/Abc123/Before", next: "url: https://www.figma.com/design/Abc123/After" },
  ])("refuses list attributes on $type before changing its text or structure", async ({ type, text, next }) => {
    const rig = await local();
    const doc = await create(rig, { blocks: [{ type, text }] });
    const block = doc.blocks[0];
    for (const fields of [{ list: "ordered" }, { indent: 2 }]) {
      await refuse(rig, "edit_block", {
        uuid: doc.uuid, block_id: block.id, old_text: block.text, new_text: next, rev: block.rev, ...fields,
      }, "invalid_list_attributes", doc.uuid);
    }
  });

  it.each(["archived", "decided"])("retains the %s content lock for attribute-only edits", async (lock) => {
    const rig = await local();
    const doc = await create(rig, lock === "decided" ? { kind: "decision", status: "decided" } : {});
    if (lock === "archived") await rig.ok("archive_doc", { uuid: doc.uuid });
    const block = (await rig.ok("get_doc", { uuid: doc.uuid })).blocks[0];
    await refuse(rig, "edit_block", {
      uuid: doc.uuid, block_id: block.id, old_text: block.text, new_text: block.text,
      rev: block.rev, list: "ordered", indent: 2,
    }, lock === "archived" ? "doc_archived" : "decision_read_only", doc.uuid);
  });
});
