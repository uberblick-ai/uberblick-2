import { findBlockElement } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readBlocks, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const paragraph = { type: "paragraph", text: "Earlier valid entry" };

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

function state(rig: Rig, uuid: string) {
  return {
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    sidebar: Y.encodeStateAsUpdate(rig.instance.replicas.sidebar().doc),
    document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc),
    log: rig.instance.store.logSize(),
  };
}

async function refuse(rig: Rig, tool: string, args: Record<string, unknown>, uuid: string, error: string) {
  const before = state(rig, uuid);
  const result = await rig.call(tool, args);
  expect(result).toMatchObject({ isError: true, payload: {
    error, message: expect.stringMatching(/divider/), recoveryClass: error === "inline_link_range" ? "reread" : "manual", recovery: expect.any(String),
    applied: false, partial: false, synced: false,
  } });
  expect(state(rig, uuid)).toEqual(before);
  return result.payload;
}

afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

describe("MCP dividers", () => {
  it("creates and inserts childless dividers, then moves and deletes them with stable revisions", async () => {
    const rig = await local();
    const page = await rig.ok("create_doc", { title: "Separations", description: "Separate two sections.",
      blocks: [paragraph, { type: "divider" }] });
    const inserted = await rig.ok("insert_block", { uuid: page.uuid, blocks: [
      { type: "divider", text: "", inline: [] },
    ] });
    const blocks = await readBlocks(rig, page.uuid, [inserted.blocks[0], ...page.blocks]);
    expect(blocks.map(({ type, text }) => ({ type, text }))).toEqual([
      { type: "divider", text: "" }, paragraph, { type: "divider", text: "" },
    ]);
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    for (const id of [inserted.blocks[0].id, page.blocks[1].id]) {
      expect(findBlockElement(doc, id)!.length).toBe(0);
    }
    const moved = await rig.ok("move_block", { uuid: page.uuid,
      block_ids: [inserted.blocks[0].id], after_block_id: page.blocks[0].id });
    expect(moved.blocks).toEqual(inserted.blocks);
    const reordered = await rig.ok("get_doc", { uuid: page.uuid });
    expect(reordered.blocks.map((block: { id: string }) => block.id))
      .toEqual([page.blocks[0].id, inserted.blocks[0].id, page.blocks[1].id]);
    expect((await rig.ok("export_markdown", { uuid: page.uuid, frontmatter: false })).markdown)
      .toBe("Earlier valid entry\n\n---\n\n---\n\n");
    await rig.ok("delete_block", { uuid: page.uuid, block_id: inserted.blocks[0].id });
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks.map((block: { id: string }) => block.id))
      .toEqual(page.blocks.map((block: { id: string }) => block.id));
  });

  it.each([{ text: "content" }, { text: " " }, { inline: [{ text: "content", marks: {} }] }, { inline: [{ text: "", marks: {} }] }])(
    "refuses divider content %j before any create or insert batch writes", async (content) => {
      const rig = await local();
      const page = await rig.ok("create_doc", { title: "Existing", description: "An unchanged page." });
      const blocks = [paragraph, { type: "divider", ...content }, paragraph];
      await refuse(rig, "create_doc", { title: "Invalid", description: "Must not be created.", blocks }, page.uuid, "invalid_divider");
      const failure = await refuse(rig, "insert_block", { uuid: page.uuid, blocks }, page.uuid, "invalid_divider");
      expect(failure.entry_index).toBe(2);
      expect((await rig.ok("list_docs")).docs.map((doc: { uuid: string }) => doc.uuid)).toEqual([page.uuid]);
    },
  );

  it("refuses text edits and new or moved anchors, even after an older writer adds a text child", async () => {
    const rig = await local();
    const page = await rig.ok("create_doc", { title: "Anchors", description: "Dividers carry no text.",
      blocks: [paragraph, { type: "divider" }] });
    const [prose, divider] = await readBlocks(rig, page.uuid, page.blocks);
    const thread = await rig.ok("annotate", { uuid: page.uuid, block_id: prose.id, start: 0, end: 7, text: "Keep this anchor." });
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    const child = new Y.XmlText();
    findBlockElement(doc, divider.id)!.insert(0, [child]);
    child.insert(0, "quartzlegacytext");
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks[1]).toEqual(divider);
    await refuse(rig, "edit_block", { uuid: page.uuid, block_id: divider.id,
      old_text: "", new_text: "change", rev: divider.rev }, page.uuid, "divider_not_editable");
    for (const extra of [{}, { thread_id: thread.annotation.id }]) {
      await refuse(rig, "annotate", { uuid: page.uuid, block_id: divider.id, start: 0, end: 1,
        text: "No anchor", ...extra }, page.uuid, "divider_annotation");
    }
    await refuse(rig, "link_range", { uuid: page.uuid, block_id: divider.id, start: 0, end: 1,
      doc_id: page.uuid, rev: divider.rev }, page.uuid, "inline_link_range");
    expect((await rig.ok("search", { query: "quartzlegacytext" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "Earlier" })).hits).toMatchObject([{ uuid: page.uuid }]);
  });

  it("keeps dividers out of decision answers", async () => {
    const rig = await local();
    const page = await rig.ok("create_doc", { title: "Why?", description: "An open answer.", kind: "decision" });
    for (const tool of ["create_doc", "insert_block"]) {
      const args = tool === "create_doc"
        ? { title: "Unsupported", description: "No divider answer.", kind: "decision" }
        : { uuid: page.uuid };
      const before = state(rig, page.uuid);
      expect(await rig.call(tool, { ...args, blocks: [{ type: "divider" }] })).toMatchObject({
        isError: true, payload: { error: "decision_block_unsupported", applied: false, partial: false, synced: false },
      });
      expect(state(rig, page.uuid)).toEqual(before);
    }
  });
});
