import { compareRevisions, findBlockElement, tableCellText, tableRows } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const GFM = "| Name | Value |\n| --- | --- |\n| **Alpha** | Beta |";
const rigs: Rig[] = [];

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "Column widths", description: "Agent widths use the editor's stored column attributes.",
    blocks: [{ type: "table", text: GFM }], ...fields,
  });
}

function rows(rig: Rig, uuid: string, id: string) {
  return tableRows(findBlockElement(rig.instance.replicas.replica(uuid).doc, id)!);
}

function setWidth(cell: Y.XmlElement, width: number): void {
  (cell as unknown as { setAttribute(name: string, value: unknown): void }).setAttribute("colwidth", [width]);
}

function storedWidths(rig: Rig, uuid: string, id: string) {
  return rows(rig, uuid, id).map(row => row.map(cell => cell.getAttributes().colwidth ?? null));
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
    error: "invalid_column_widths", recoveryClass: "manual", recovery: expect.any(String),
    applied: false, partial: false, synced: false,
  } });
  expect(result.payload.recovery.length).toBeGreaterThan(0);
  expect(state(rig, uuid)).toEqual(before);
  if (tool === "insert_block") {
    expect(result.payload.entry_index).toBe(2);
    expect(result.payload.message).toContain("Nothing was written.");
  } else expect(result.payload).not.toHaveProperty("entry_index");
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

describe("MCP table column widths", () => {
  it("reads rounded header widths, ignoring body widths, and returns null for unsized columns", async () => {
    const rig = await local();
    const page = await create(rig, { blocks: [
      { type: "table", text: GFM }, { type: "table", text: GFM },
      { type: "paragraph", text: "Ordinary prose" },
    ] });
    const original = await rig.ok("get_doc", { uuid: page.uuid });
    const grid = rows(rig, page.uuid, page.blocks[0].id);
    setWidth(grid[0]![0]!, 225.5);
    setWidth(grid[1]![0]!, 444);
    setWidth(grid[1]![1]!, 333);
    const read = await rig.ok("get_doc", { uuid: page.uuid });
    expect(read.blocks[0].column_widths).toEqual([226, null]);
    expect(read.blocks[1].column_widths).toEqual([null, null]);
    expect(read.blocks[2]).not.toHaveProperty("column_widths");
    expect(read.rev).toBe(original.rev);
    expect(read.blocks.map((block: { rev: string }) => block.rev))
      .toEqual(original.blocks.map((block: { rev: string }) => block.rev));
    setWidth(grid[0]![0]!, 0.1);
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks[0].column_widths).toEqual([0, null]);
  });

  it("changes only width attributes while retaining cells, formatting, comments and text revs", async () => {
    const rig = await local();
    const page = await create(rig);
    const id = page.blocks[0].id;
    await rig.ok("annotate", { uuid: page.uuid, block_id: id, row: 1, column: 0,
      start: 0, end: 5, text: "Keep this cell's discussion" });
    const before = await rig.ok("get_doc", { uuid: page.uuid });
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    const cells = rows(rig, page.uuid, id);
    const texts = cells.map(row => row.map(cell => tableCellText(cell)!));
    const deltas = texts.map(row => row.map(text => text.toDelta()));
    const previous = new Y.Doc();
    Y.applyUpdate(previous, Y.encodeStateAsUpdate(doc));
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    try {
      const edited = await rig.ok("edit_block", { uuid: page.uuid, block_id: id,
        old_text: before.blocks[0].text, new_text: before.blocks[0].text,
        rev: before.blocks[0].rev, column_widths: [120, 360] });
      expect(edited.block).toEqual({ id, rev: before.blocks[0].rev });
      expect(updates).toBe(1);
      const read = await rig.ok("get_doc", { uuid: page.uuid });
      expect(read.blocks[0]).toEqual({ ...before.blocks[0], column_widths: [120, 360] });
      expect(read.rev).toBe(before.rev);
      expect(read.annotations).toEqual(before.annotations);
      expect(storedWidths(rig, page.uuid, id)).toEqual([[[120], [360]], [[120], [360]]]);
      for (const [rowIndex, row] of rows(rig, page.uuid, id).entries()) {
        for (const [column, cell] of row.entries()) {
          expect(cell).toBe(cells[rowIndex]![column]);
          expect(tableCellText(cell)).toBe(texts[rowIndex]![column]);
          expect(tableCellText(cell)!.toDelta()).toEqual(deltas[rowIndex]![column]);
        }
      }
      const comparison = compareRevisions(previous, doc);
      expect(comparison.blocks).toHaveLength(1);
      expect(comparison.blocks[0]).toMatchObject({ kind: "changed", fields: ["columnWidths"] });
      expect(comparison.blocks[0]!.rows!.every(row => row.kind === "unchanged")).toBe(true);
      await rig.ok("edit_block", { uuid: page.uuid, block_id: id,
        old_text: read.blocks[0].text, new_text: read.blocks[0].text,
        rev: before.blocks[0].rev, column_widths: [null, null] });
      expect(storedWidths(rig, page.uuid, id)).toEqual([[null, null], [null, null]]);
      const cleared = await rig.ok("get_doc", { uuid: page.uuid });
      expect(cleared.blocks[0]).toEqual(before.blocks[0]);
      expect(cleared.rev).toBe(before.rev);
      expect(cleared.annotations).toEqual(before.annotations);
    } finally {
      previous.destroy();
    }
  });

  it("sizes an inserted table and applies explicit widths with text and mapping in one edit", async () => {
    const rig = await local();
    const page = await create(rig, { blocks: [] });
    const inserted = await rig.ok("insert_block", { uuid: page.uuid,
      blocks: [{ type: "table", text: GFM, column_widths: [180, 300] }] });
    const id = inserted.blocks[0].id;
    expect(inserted.blocks[0]).toEqual({ id, rev: expect.any(String) });
    expect(storedWidths(rig, page.uuid, id)).toEqual([[[180], [300]], [[180], [300]]]);
    let read = await rig.ok("get_doc", { uuid: page.uuid });
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const changed = "| Name | Added | Value |\n| --- | --- | --- |\n| **Alpha** | New | Gamma |";
    await rig.ok("edit_block", { uuid: page.uuid, block_id: id, old_text: read.blocks[0].text,
      new_text: changed, rev: read.blocks[0].rev,
      table_mapping: { rows: [0, 1], columns: [0, null, 1] }, column_widths: [200, null, 420] });
    expect(updates).toBe(1);
    read = await rig.ok("get_doc", { uuid: page.uuid });
    expect(read.blocks[0]).toMatchObject({ text: changed, column_widths: [200, null, 420] });
    expect(storedWidths(rig, page.uuid, id)).toEqual([[[200], null, [420]], [[200], null, [420]]]);
    const textOnly = changed.replace("Gamma", "Delta");
    await rig.ok("edit_block", { uuid: page.uuid, block_id: id,
      old_text: changed, new_text: textOnly, rev: read.blocks[0].rev, column_widths: [220, 140, null] });
    read = await rig.ok("get_doc", { uuid: page.uuid });
    expect(read.blocks[0]).toMatchObject({ text: textOnly, column_widths: [220, 140, null] });
    expect(storedWidths(rig, page.uuid, id)).toEqual([[[220], [140], null], [[220], [140], null]]);
    const unrestricted = await rig.ok("insert_block", { uuid: page.uuid,
      blocks: [{ type: "table", text: GFM, column_widths: [1, 1e20] }] });
    expect(storedWidths(rig, page.uuid, unrestricted.blocks[0].id)).toEqual([[[1], [1e20]], [[1], [1e20]]]);
    expect((await rig.ok("get_doc", { uuid: page.uuid })).blocks[0].column_widths).toEqual([1, 1e20]);
  });

  it("keeps retained widths when omitted while new rows and columns remain unsized", async () => {
    const rig = await local();
    const page = await create(rig);
    const id = page.blocks[0].id;
    await rig.ok("edit_block", { uuid: page.uuid, block_id: id,
      old_text: GFM, new_text: GFM, column_widths: [180, 300] });
    const changed = "| Name | Added | Value |\n| --- | --- | --- |\n| New | New | New |\n| **Alpha** | Added | Beta |";
    await rig.ok("edit_block", { uuid: page.uuid, block_id: id, old_text: GFM, new_text: changed,
      table_mapping: { rows: [0, null, 1], columns: [0, null, 1] } });
    const read = await rig.ok("get_doc", { uuid: page.uuid });
    expect(read.blocks[0]).toMatchObject({ text: changed, column_widths: [180, null, 300] });
    expect(storedWidths(rig, page.uuid, id)).toEqual([
      [[180], null, [300]], [null, null, null], [[180], null, [300]],
    ]);
  });

  it.each([
    [], [120], [120, null, 240], [0, null], [-1, null], [120.5, null],
    ["120", null], [true, null], [{ width: 120 }, null], null, "120, null",
  ].map(column_widths => ({ column_widths })))("refuses malformed widths %j atomically on edit and insert", async ({ column_widths }) => {
    const rig = await local();
    const page = await create(rig);
    const read = await rig.ok("get_doc", { uuid: page.uuid });
    const block = read.blocks[0];
    await refuse(rig, "edit_block", { uuid: page.uuid, block_id: block.id,
      old_text: block.text, new_text: block.text.replace("Beta", "Must not change"),
      rev: block.rev, column_widths }, page.uuid);
    await refuse(rig, "insert_block", { uuid: page.uuid, blocks: [
      { type: "paragraph", text: "Earlier valid entry" },
      { type: "table", text: GFM, column_widths }, { type: "paragraph", text: "Later valid entry" },
    ] }, page.uuid);
  });

  it("refuses column widths on non-table blocks before changing text or inserting a batch", async () => {
    const rig = await local();
    const page = await create(rig, { blocks: [{ type: "paragraph", text: "Keep this prose" }] });
    const block = (await rig.ok("get_doc", { uuid: page.uuid })).blocks[0];
    await refuse(rig, "edit_block", { uuid: page.uuid, block_id: block.id,
      old_text: block.text, new_text: "Must not change", rev: block.rev, column_widths: [120] }, page.uuid);
    await refuse(rig, "insert_block", { uuid: page.uuid, blocks: [
      { type: "table", text: GFM, column_widths: [120, null] },
      { type: "paragraph", text: "Not a table", column_widths: [120] },
    ] }, page.uuid);
  });

  it("keeps refusing column_widths on create_doc seed blocks without creating a document", async () => {
    const rig = await local();
    const page = await create(rig);
    const before = state(rig, page.uuid);
    const result = await rig.call("create_doc", { title: "Refused seed", description: "No widths on seeds.",
      blocks: [{ type: "table", text: GFM, column_widths: [120, null] }] });
    expect(result).toMatchObject({ isError: true, payload: { error: "schema_validation" } });
    expect(result.payload.message).toContain("column_widths");
    expect(state(rig, page.uuid)).toEqual(before);
  });

  it("reads projected ragged tables but refuses sizing their unequal stored rows", async () => {
    const rig = await local();
    const page = await create(rig);
    const id = page.blocks[0].id;
    const grid = rows(rig, page.uuid, id);
    (grid[1]![1]!.parent as Y.XmlElement).delete(1, 1);
    const block = (await rig.ok("get_doc", { uuid: page.uuid })).blocks[0];
    expect(block.column_widths).toEqual([null, null]);
    await refuse(rig, "edit_block", { uuid: page.uuid, block_id: id,
      old_text: block.text, new_text: block.text, rev: block.rev, column_widths: [120, null] }, page.uuid);
  });

  it("treats width-only edits to a decided answer as read-only content writes", async () => {
    const rig = await local();
    const page = await create(rig, { kind: "decision" });
    await rig.ok("set_status", { uuid: page.uuid, status: "decided" });
    const before = state(rig, page.uuid);
    const block = (await rig.ok("get_doc", { uuid: page.uuid })).blocks[0];
    const result = await rig.call("edit_block", { uuid: page.uuid, block_id: block.id,
      old_text: block.text, new_text: block.text, rev: block.rev, column_widths: [120, null] });
    expect(result).toMatchObject({ isError: true, payload: {
      error: "decision_read_only", applied: false, partial: false, synced: false,
    } });
    expect(state(rig, page.uuid)).toEqual(before);
  });
});
