import { appendBlock, findBlockElement } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { startServer, toolNamed } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig, blocks: Record<string, unknown>[] = []) {
  const page = await rig.ok("create_doc", { title: "Notes", description: "Keep footnotes across clients.", blocks });
  return rig.ok("get_doc", { uuid: page.uuid });
}

function state(rig: Rig, uuid: string) {
  return {
    document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc),
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    sidebar: Y.encodeStateAsUpdate(rig.instance.replicas.sidebar().doc),
    log: rig.instance.store.logSize(),
  };
}

async function refuse(rig: Rig, uuid: string, tool: string, args: Record<string, unknown>, error: string) {
  const before = state(rig, uuid);
  const result = await rig.call(tool, args);
  expect(result).toMatchObject({ isError: true, payload: {
    error, applied: false, partial: false, synced: false,
    recoveryClass: "manual", recovery: expect.any(String),
  } });
  expect(state(rig, uuid)).toEqual(before);
  return result.payload;
}

afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

describe("MCP footnotes", () => {
  it.each(["create_doc", "insert_block"])("accepts explicit reference runs through %s", async tool => {
    const rig = await local();
    const blocks = [{ type: "paragraph", inline: [
      { text: "[^one]", marks: { footnoteRef: true, bold: true } },
      { text: "[^two]", marks: { footnoteRef: true, bold: true } },
    ] }];
    const page = await create(rig, tool === "create_doc" ? blocks : []);
    if (tool === "insert_block") await rig.ok("insert_block", { uuid: page.uuid, blocks });
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks[0].inline).toEqual(blocks[0]!.inline);
  });

  it("writes separate adjacent references and formatted, duplicate and unused notes, searches their text, edits labels and deletes notes", async () => {
    const rig = await local();
    const page = await create(rig, [
      { type: "paragraph", text: "Read[^One][^missing][^One]." },
      { type: "footnote", label: "one", inline: [{ text: "quartzneedle", marks: { bold: true } }] },
      { type: "footnote", label: "ONE", text: "Repeated note" },
      { type: "footnote", label: "unused", text: "Unused note" },
    ]);
    expect(page.blocks[0].inline).toEqual([
      { text: "Read", marks: {} },
      { text: "[^One]", marks: { footnoteRef: true } },
      { text: "[^missing]", marks: { footnoteRef: true } },
      { text: "[^One]", marks: { footnoteRef: true } },
      { text: ".", marks: {} },
    ]);
    expect(page.blocks[1]).toMatchObject({ type: "footnote", label: "one", text: "quartzneedle",
      inline: [{ text: "quartzneedle", marks: { bold: true } }] });
    expect(page.blocks.slice(1).map((block: { label: string }) => block.label)).toEqual(["one", "ONE", "unused"]);
    expect((await rig.ok("search", { query: "quartzneedle" })).hits).toMatchObject([{ uuid: page.uuid }]);
    const note = page.blocks[1];
    await rig.ok("edit_block", { uuid: page.uuid, block_id: note.id, old_text: note.text, new_text: note.text,
      rev: note.rev, label: "changed" });
    const changed = (await rig.ok("get_doc", { uuid: page.uuid })).blocks[1];
    expect(changed).toMatchObject({ id: note.id, text: note.text, label: "changed", inline: note.inline });
    expect(changed.rev).not.toBe(note.rev);
    await rig.ok("delete_block", { uuid: page.uuid, block_id: page.blocks[3].id });
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks).toHaveLength(3);
    const inserted = await rig.ok("insert_block", { uuid: page.uuid, after_block_id: page.blocks[2].id, blocks: [
      { type: "footnote", label: "added", text: "Inserted note" },
    ] });
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks.at(-1)).toMatchObject({
      id: inserted.blocks[0].id, type: "footnote", label: "added", text: "Inserted note",
    });
  });

  it("keeps references literal in excluded contexts and does not migrate untouched text on an edit", async () => {
    const rig = await local();
    const page = await create(rig, [
      { type: "paragraph", inline: [
        { text: "[^code]", marks: { inlineCode: true } },
        { text: "[^link]", marks: { link: "https://example.com" } },
      ] },
      ...["code", "terminal", "chart"].map(type => ({ type, text: "[^source]" })),
      { type: "table", text: "| Head |\n| --- |\n| [^table] |" },
      { type: "card", text: "title: [^title]\n\n[^body]" },
      { type: "figma", text: "url: https://www.figma.com/design/key/File\n\n[^caption]" },
      { type: "paragraph", text: "Legacy[^old] TOKEN" },
      { type: "footnote", label: "outer", text: "Literal[^inner]" },
    ]);
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    const legacy = findBlockElement(doc, page.blocks[7].id)!.get(0) as Y.XmlText;
    legacy.format(0, legacy.length, { footnoteRef: null });
    const before = await rig.ok("get_doc", { uuid: page.uuid });
    for (const block of before.blocks.slice(1)) expect(block).not.toHaveProperty("inline");
    await rig.ok("edit_block", { uuid: page.uuid, block_id: page.blocks[7].id,
      old_text: "Legacy[^old] TOKEN", new_text: "Legacy[^old] Added[^new]" });
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks[7].inline).toEqual([
      { text: "Legacy[^old] Added", marks: {} }, { text: "[^new]", marks: { footnoteRef: true } },
    ]);
    const decision = await rig.ok("create_doc", { title: "Why?", description: "Literal answer.", kind: "decision",
      blocks: [{ type: "paragraph", text: "Literal[^answer]" }] });
    expect((await rig.ok("get_doc", { uuid: decision.uuid })).blocks[0]).not.toHaveProperty("inline");
    await rig.ok("edit_block", { uuid: decision.uuid, block_id: decision.blocks[0].id,
      old_text: "Literal[^answer]", new_text: "Literal[^answer][^another]" });
    expect((await rig.ok("get_doc", { uuid: decision.uuid })).blocks[0]).not.toHaveProperty("inline");
  });

  it("refuses missing or malformed labels and explicit reference runs before any create, insert or edit writes", async () => {
    const rig = await local();
    const page = await create(rig, [{ type: "paragraph", text: "Body" }, { type: "footnote", label: "valid", text: "Note" }]);
    for (const label of [undefined, "", "two words", "[nested", "end]", "slash\\", null, 5]) {
      const invalid = { type: "footnote", text: "Invalid", ...(label === undefined ? {} : { label }) };
      await refuse(rig, page.uuid, "create_doc", { title: "Invalid", description: "No room should be created.",
        blocks: [{ type: "paragraph", text: "Valid first" }, invalid] }, "invalid_footnote_label");
      const failure = await refuse(rig, page.uuid, "insert_block", { uuid: page.uuid, after_block_id: page.blocks[0].id,
        blocks: [{ type: "paragraph", text: "Valid first" }, invalid] }, "invalid_footnote_label");
      expect(failure.entry_index).toBe(2);
      if (label !== undefined) await refuse(rig, page.uuid, "edit_block", { uuid: page.uuid,
        block_id: page.blocks[1].id, old_text: "Note", new_text: "Changed", label }, "invalid_footnote_label");
    }
    for (const block of [
      { type: "paragraph", inline: [{ text: "[^a][^b]", marks: { footnoteRef: true } }] },
      { type: "paragraph", inline: [{ text: "[^bad label]", marks: { footnoteRef: true } }] },
      { type: "paragraph", inline: [{ text: "[^a]", marks: { footnoteRef: true, inlineCode: true } }] },
      { type: "paragraph", inline: [{ text: "[^a]", marks: { footnoteRef: true, link: "https://example.com" } }] },
      { type: "paragraph", inline: [{ text: "[^a]", marks: { footnoteRef: true, docLink: page.uuid } }] },
      { type: "code", inline: [{ text: "[^a]", marks: { footnoteRef: true } }] },
      { type: "footnote", label: "outer", inline: [{ text: "[^a]", marks: { footnoteRef: true } }] },
    ]) {
      await refuse(rig, page.uuid, "create_doc", { title: "Invalid", description: "No invalid reference.", blocks: [block] }, "invalid_footnote_reference");
      await refuse(rig, page.uuid, "insert_block", { uuid: page.uuid, after_block_id: page.blocks[0].id, blocks: [block] }, "invalid_footnote_reference");
    }
    await refuse(rig, page.uuid, "edit_block", { uuid: page.uuid, block_id: page.blocks[0].id,
      old_text: "Body", new_text: "Changed", label: "valid" }, "invalid_footnote_label");
    expect((await rig.ok("list_docs")).docs).toHaveLength(1);
  });

  it("enforces trailing-note placement atomically and supplies usable anchors for insert and move", async () => {
    const rig = await local();
    const page = await create(rig, [
      { type: "paragraph", text: "First" }, { type: "paragraph", text: "Last" },
      { type: "footnote", label: "one", text: "One" }, { type: "footnote", label: "two", text: "Two" },
    ]);
    const body = { type: "paragraph", text: "Added" };
    const note = { type: "footnote", label: "added", text: "Added note" };
    const first = page.blocks[0].id;
    const last = page.blocks[1].id;
    const noteOne = page.blocks[2].id;
    const noteTwo = page.blocks[3].id;
    const seedFailure = await refuse(rig, page.uuid, "create_doc", { title: "Wrong order", description: "Refuse seeds.",
      blocks: [note, body] }, "footnote_position");
    expect(seedFailure.recovery).toContain("all body blocks first");
    const lateBody = await refuse(rig, page.uuid, "insert_block", { uuid: page.uuid, after_block_id: noteTwo,
      blocks: [body] }, "footnote_position");
    expect(lateBody).toMatchObject({ entry_index: 1, after_block_id: last });
    const earlyNote = await refuse(rig, page.uuid, "insert_block", { uuid: page.uuid, blocks: [note] }, "footnote_position");
    expect(earlyNote.after_block_id).toBe(noteTwo);
    const earlyMixed = await refuse(rig, page.uuid, "insert_block", { uuid: page.uuid, after_block_id: first,
      blocks: [body, note] }, "footnote_position");
    expect(earlyMixed).toMatchObject({ entry_index: 2, after_block_id: last });
    const mixed = await refuse(rig, page.uuid, "insert_block", { uuid: page.uuid, after_block_id: last,
      blocks: [note, body] }, "footnote_position");
    expect(mixed).toMatchObject({ entry_index: 2, after_block_id: last });
    expect((await refuse(rig, page.uuid, "move_block", { uuid: page.uuid, block_ids: [first],
      after_block_id: noteOne }, "footnote_position")).after_block_id).toBe(last);
    expect((await refuse(rig, page.uuid, "move_block", { uuid: page.uuid, block_ids: [noteTwo] }, "footnote_position")).after_block_id).toBe(noteOne);
    await rig.ok("insert_block", { uuid: page.uuid, after_block_id: lateBody.after_block_id, blocks: [body, note] });
    await rig.ok("move_block", { uuid: page.uuid, block_ids: [noteTwo], after_block_id: noteOne });
    const read = await rig.ok("get_doc", { uuid: page.uuid });
    expect(read.blocks.map((block: { type: string }) => block.type)).toEqual([
      "paragraph", "paragraph", "paragraph", "footnote", "footnote", "footnote",
    ]);
    // An older client can leave a note in the body; unrelated placements do not relocate it.
    const legacyId = appendBlock(rig.instance.replicas.replica(page.uuid).doc, { type: "paragraph", text: "Legacy last body" });
    await rig.ok("insert_block", { uuid: page.uuid, after_block_id: first, blocks: [body] });
    await rig.ok("move_block", { uuid: page.uuid, block_ids: [noteOne], after_block_id: legacyId });
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks.at(-1)).toMatchObject({ id: noteOne, type: "footnote" });
    const emptyBody = await create(rig, [{ type: "footnote", label: "only", text: "Only note" }]);
    expect((await refuse(rig, emptyBody.uuid, "insert_block", { uuid: emptyBody.uuid,
      after_block_id: emptyBody.blocks[0].id, blocks: [body] }, "footnote_position")).after_block_id).toBeNull();
  });

  it("advertises the input and read shapes and documents named refusals and history compatibility", async () => {
    const rig = await local();
    for (const name of ["create_doc", "insert_block"]) {
      const schema = JSON.stringify(toolNamed(name).input);
      expect(schema).toContain("footnoteRef");
      expect(schema).toContain("label");
    }
    const help = (await rig.ok("get_help", { topic: "markdown" })).text;
    for (const term of ["## Footnotes", "footnoteRef", "invalid_footnote_label", "invalid_footnote_reference",
      "footnote_position", "revision_stale_state", "revisions_unreachable", "updated client and hub"]) expect(help).toContain(term);
  });
});
