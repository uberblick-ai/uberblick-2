import { findBlockElement, getBlockInline } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readBlocks, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const variants = ["note", "tip", "important", "warning", "caution"] as const;
const paragraph = { type: "paragraph", text: "Earlier valid entry" };

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "Callouts", description: "Short prose with a variant and an optional icon.", ...fields,
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

async function refuse(rig: Rig, tool: string, args: Record<string, unknown>, uuid: string) {
  const before = state(rig, uuid);
  const result = await rig.call(tool, args);
  expect(result).toMatchObject({ isError: true, payload: {
    error: "invalid_callout", recoveryClass: "manual", recovery: expect.any(String),
    applied: false, partial: false, synced: false,
  } });
  const guidance = `${result.payload.message} ${result.payload.recovery}`;
  for (const variant of variants) expect(guidance).toContain(variant);
  expect(guidance).toMatch(/emoji/);
  expect(guidance).toMatch(/curated/);
  expect(guidance).toContain(":name:");
  expect(state(rig, uuid)).toEqual(before);
  if (tool === "insert_block") {
    expect(result.payload.entry_index).toBe(2);
    expect(result.payload.message).toContain("Nothing was written.");
  } else expect(result.payload).not.toHaveProperty("entry_index");
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

describe("MCP callout attributes", () => {
  it.each(["create_doc", "insert_block"])("writes, reads and exports every variant through %s", async (tool) => {
    const rig = await local();
    const blocks = variants.map((variant, index) => ({
      type: "callout", variant,
      ...(index === 0 ? {} : { icon: index % 2 ? "🚀" : ":claude:" }),
      text: "Ignored in favor of inline",
      inline: [{ text: `Read ${variant}`, marks: { bold: true } }],
    }));
    const page = await create(rig, tool === "create_doc" ? { blocks } : {});
    const written = tool === "create_doc" ? page : await rig.ok(tool, { uuid: page.uuid, blocks });
    const read = await readBlocks(rig, page.uuid, written.blocks);
    expect(read).toMatchObject(blocks.map(({ variant, icon }) => ({
      type: "callout", variant, ...(icon === undefined ? {} : { icon }), text: `Read ${variant}`,
    })));
    expect(read[0]).not.toHaveProperty("icon");
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    expect(getBlockInline(doc, read[0].id)).toEqual([{ text: "Read note", marks: { bold: true } }]);
    const expected = blocks.map(({ variant, icon }) =>
      `> [!${variant.toUpperCase()}]\n${icon === undefined ? "" : `> <!-- icon: ${icon} -->\n`}> **Read ${variant}**`,
    ).join("\n\n");
    expect((await rig.ok("export_markdown", { uuid: page.uuid, frontmatter: false })).markdown)
      .toBe(`${expected}\n`);
  });

  it.each(["create_doc", "insert_block"])("defaults callouts to note and ignores callout attributes on other %s inputs", async (tool) => {
    const rig = await local();
    const blocks = [
      { type: "callout", text: "Default note" },
      { ...paragraph, variant: "invalid", icon: "invalid" },
      { type: "quote", text: "Ordinary quote", variant: "warning", icon: "" },
      { type: "code", text: "literal()", variant: "caution", icon: "🚀" },
    ];
    const page = await create(rig, tool === "create_doc" ? { blocks } : {});
    const written = tool === "create_doc" ? page : await rig.ok(tool, { uuid: page.uuid, blocks });
    const [callout, ...ordinary] = await readBlocks(rig, page.uuid, written.blocks);
    expect(callout).toMatchObject({ type: "callout", variant: "note", text: "Default note" });
    expect(callout).not.toHaveProperty("icon");
    for (const block of ordinary) {
      expect(block).not.toHaveProperty("variant");
      expect(block).not.toHaveProperty("icon");
    }
  });

  it("edits only supplied attributes in place, clears icons, and can change text with attributes", async () => {
    const rig = await local();
    const page = await create(rig, { blocks: [{ type: "callout", variant: "tip", icon: "🚀",
      inline: [{ text: "Read this", marks: { bold: true } }] }] });
    const id = page.blocks[0].id;
    await rig.ok("annotate", { uuid: page.uuid, block_id: id, start: 0, end: 4, text: "Which passage?" });
    const original = await rig.ok("get_doc", { uuid: page.uuid });
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    const element = findBlockElement(doc, id)!;
    const text = element.firstChild as Y.XmlText;
    const delta = text.toDelta();
    let current = original.blocks[0];
    for (const fields of [
      { variant: "warning" }, { icon: ":codex:" }, { icon: "" },
    ]) {
      const result = await rig.ok("edit_block", { uuid: page.uuid, block_id: id,
        old_text: current.text, new_text: current.text, rev: current.rev, ...fields });
      const read = await rig.ok("get_doc", { uuid: page.uuid });
      expect(read.blocks[0]).toMatchObject({ id, text: "Read this", type: "callout", variant: "warning", rev: result.block.rev });
      expect(read.blocks[0].rev).not.toBe(current.rev);
      if ("icon" in fields && fields.icon === "") expect(read.blocks[0]).not.toHaveProperty("icon");
      else expect(read.blocks[0].icon).toBe("icon" in fields ? fields.icon : "🚀");
      expect(read.annotations).toEqual(original.annotations);
      expect(findBlockElement(doc, id)).toBe(element);
      expect(element.firstChild).toBe(text);
      expect(text.toDelta()).toEqual(delta);
      const markdown = (await rig.ok("export_markdown", { uuid: page.uuid, frontmatter: false })).markdown;
      expect(markdown).toBe(`> [!WARNING]\n${read.blocks[0].icon === undefined ? "" : `> <!-- icon: ${read.blocks[0].icon} -->\n`}> **Read this**\n`);
      current = read.blocks[0];
    }
    await rig.ok("edit_block", { uuid: page.uuid, block_id: id, old_text: current.text,
      new_text: "Read this again", rev: current.rev, variant: "important", icon: "👩‍💻" });
    const changed = await rig.ok("get_doc", { uuid: page.uuid });
    expect(changed.blocks[0]).toMatchObject({ id, text: "Read this again", variant: "important", icon: "👩‍💻" });
    expect(getBlockInline(doc, id)[0]?.marks).toEqual({ bold: true });
    expect(changed.annotations).toEqual(original.annotations);
    expect((await rig.ok("export_markdown", { uuid: page.uuid, frontmatter: false })).markdown)
      .toContain("> [!IMPORTANT]\n> <!-- icon: 👩‍💻 -->\n");
  });

  it.each([
    { variant: "info", icon: "🚀" },
    { variant: "warning", icon: "letters" },
    { icon: ":rocket:" },
    { icon: "🚀🚀" },
  ])("refuses invalid attributes %j without any mutation in every write tool", async (fields) => {
    const rig = await local();
    const page = await create(rig, { blocks: [{ type: "callout", text: "Read this", variant: "tip", icon: ":claude:" }] });
    const [block] = await readBlocks(rig, page.uuid, page.blocks);
    await refuse(rig, "create_doc", { title: "Invalid", description: "Must not be created.",
      blocks: [paragraph, { type: "callout", text: "Invalid", ...fields }] }, page.uuid);
    await refuse(rig, "insert_block", { uuid: page.uuid,
      blocks: [paragraph, { type: "callout", text: "Invalid", ...fields }, paragraph] }, page.uuid);
    await refuse(rig, "edit_block", { uuid: page.uuid, block_id: block.id,
      old_text: block.text, new_text: "Must not change", rev: block.rev, ...fields }, page.uuid);
    expect((await rig.ok("list_docs")).docs.map((entry: { uuid: string }) => entry.uuid)).toEqual([page.uuid]);
  });

  it("refuses an empty icon on creation and insertion before earlier valid seeds are written", async () => {
    const rig = await local();
    const page = await create(rig);
    const blocks = [paragraph, { type: "callout", text: "Empty override", icon: "" }];
    await refuse(rig, "create_doc", { title: "Invalid", description: "Must not be created.", blocks }, page.uuid);
    await refuse(rig, "insert_block", { uuid: page.uuid, blocks }, page.uuid);
    expect((await rig.ok("list_docs")).docs.map((entry: { uuid: string }) => entry.uuid)).toEqual([page.uuid]);
  });

  it.each(["paragraph", "quote", "code"])("refuses either callout attribute on an existing %s before changing text", async (type) => {
    const rig = await local();
    const page = await create(rig, { blocks: [{ type, text: "Read this" }] });
    const [block] = await readBlocks(rig, page.uuid, page.blocks);
    for (const fields of [{ variant: "warning" }, { icon: "🚀" }, { icon: "" }]) {
      await refuse(rig, "edit_block", { uuid: page.uuid, block_id: block.id,
        old_text: block.text, new_text: "Must not change", rev: block.rev, ...fields }, page.uuid);
    }
  });
});
