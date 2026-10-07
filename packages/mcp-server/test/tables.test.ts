import { randomUUID } from "node:crypto";
import {
  COMMENT_MARK,
  appendBlock,
  createAnnotation,
  deleteAnnotation,
  decisionApprovalFingerprint,
  editBlock,
  findBlockElement,
  getBlocksFragment,
  getBlocksWithInline,
  getMetaMap,
  initDoc,
  parseGfmTable,
  parseTableCell,
  roomForDoc,
  setKind,
  setStatus,
  tableCellText,
  tableCellTexts,
  tableRows,
  writeGfmTable,
} from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { TableMapping } from "@uberblick/schema";
import { blockText } from "../src/replica.js";
import { WORKSPACE, removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
async function localRig(databasePath?: string): Promise<Rig> {
  const rig = await startServer(testConfig(databasePath === undefined ? {} : { databasePath }));
  rigs.push(rig);
  return rig;
}
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

const GFM = "| Name | Value |\n| --- | --- |\n| Alpha | Beta |";

function cell(doc: Y.Doc, id: string, row: number, column: number): Y.XmlText {
  const element = findBlockElement(doc, id);
  if (element === null) throw new Error("no table");
  const cell = tableRows(element)[row]?.[column];
  const text = cell === undefined ? null : tableCellText(cell);
  if (text === null) throw new Error("no cell text");
  return text;
}

function cellRuns(doc: Y.Doc, id: string, row: number, column: number) {
  const runs = getBlocksWithInline(doc).find(entry => entry.block.id === id)?.table?.[row]?.[column];
  if (runs === undefined) throw new Error("no cell runs");
  return runs;
}

/** Old persisted shape, including a real thread anchored in its source. */
function legacy(source: string, decided = false): { doc: Y.Doc; id: string; threadId: string } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: randomUUID(), title: "Legacy", description: "A synthetic legacy table." });
  const id = appendBlock(doc, { type: "paragraph", text: source });
  const thread = createAnnotation(doc, id, 0, 1, "Reader", "Existing conversation");
  const old = findBlockElement(doc, id)!;
  const table = new Y.XmlElement("table");
  table.setAttribute("id", id);
  table.insert(0, [(old.firstChild as Y.XmlText).clone()]);
  doc.transact(() => {
    getBlocksFragment(doc).insert(0, [table]);
    getBlocksFragment(doc).delete(1, 1);
  });
  if (decided) {
    setKind(doc, "decision");
    setStatus(doc, "decided");
    getMetaMap(doc).set("approvalFingerprint", decisionApprovalFingerprint(doc));
  }
  return { doc, id, threadId: thread.id };
}

describe("structured tables through MCP", () => {
  it("anchors displayed cell characters including whitespace without changing content, rev or approval", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Cell comments", description: "Cell anchors are outside approved table content.", kind: "decision",
      blocks: [{ type: "table", text: "| Name | Value |\n| --- | --- |\n| **Alpha** | A\\|B |" }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const alpha = cell(doc, id, 1, 0);
    alpha.insert(0, "  ", {});
    alpha.insert(alpha.length, "  ", {});
    const before = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    // Canonical padding is exactly one space; ordinary GFM parsing trims the rest.
    const canonicalCell = before.text.split("\n")[2].split("|")[1].slice(1, -1);
    expect(parseTableCell(canonicalCell).map(run => run.text).join("")).toBe("  Alpha  ");
    expect(parseGfmTable(before.text)?.rows[0]?.[0]).toBe("**Alpha**");
    await rig.ok("set_status", { uuid: created.uuid, status: "decided",
      answer: { who: "Owner", when: "2026-10-07", where: "https://example.com/answer" } });
    const approved = getMetaMap(doc).get("approvalFingerprint");
    const opened = await rig.ok("annotate", { uuid: created.uuid, block_id: id, row: 1, column: 0,
      start: 2, end: 7, text: "Discuss Alpha" });
    const threadId = opened.annotation.id;
    expect(opened.annotation.range).toEqual({ row: 1, column: 0, start: 2, end: 7, collapsed: false });
    expect(alpha.toDelta()).toContainEqual({ insert: "Alpha", attributes: { bold: {}, comment: { threadId } } });
    const escaped = await rig.ok("annotate", { uuid: created.uuid, block_id: id, row: 1, column: 1,
      start: 1, end: 99, text: "Discuss pipe" });
    expect(escaped.annotation.range).toEqual({ row: 1, column: 1, start: 1, end: 3, collapsed: false });
    for (const resolved of [true, false]) {
      const reply = await rig.ok("annotate", { uuid: created.uuid, thread_id: threadId, resolved, text: "Reply" });
      expect(reply.annotation).toMatchObject({ resolved, range: opened.annotation.range });
    }
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks[0]).toEqual(before);
    expect(read.approvalChanged).toBe(false);
    expect(getMetaMap(doc).get("approvalFingerprint")).toBe(approved);
    const exported = await rig.ok("export_markdown", { uuid: created.uuid, annotations: "html-comments", frontmatter: false });
    expect(exported.markdown).toContain("row=1 column=0 range=2-7");
    deleteAnnotation(doc, threadId);
    const deleted = await rig.ok("get_doc", { uuid: created.uuid });
    expect(deleted.blocks[0]).toEqual(before);
    expect(deleted.approvalChanged).toBe(false);
    expect(alpha.toDelta().every((op: { attributes?: Record<string, unknown> }) => op.attributes?.comment === undefined)).toBe(true);
  });

  it("refuses missing, misplaced, outside, empty and overlapping cell ranges before a write", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Cell refusals", description: "Refusals are atomic.",
      blocks: [{ type: "table", text: GFM }, { type: "paragraph", text: "Prose" }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const args = { uuid: created.uuid, block_id: id, start: 0, end: 3, text: "Thread" };
    await rig.ok("annotate", { ...args, row: 1, column: 0 });
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    for (const extra of [{}, { row: 1 }, { column: 0 }, { row: 2, column: 0 }, { row: 1, column: 2 },
      { block_id: created.blocks[1].id, row: 0, column: 0 }]) {
      const refused = await rig.call("annotate", { ...args, ...extra });
      expect(refused.payload).toMatchObject({ error: "annotation_cell", recoveryClass: "manual",
        applied: false, partial: false, synced: false });
      expect(refused.payload.recovery).toContain("row and column");
    }
    for (const offsets of [{ start: 1, end: 4 }, { start: 99, end: 100 }]) {
      const refused = await rig.call("annotate", { ...args, row: 1, column: 0, ...offsets });
      expect(refused.payload).toMatchObject({ error: "annotation_range", applied: false });
    }
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const tool = (await rig.client.listTools()).tools.find(tool => tool.name === "annotate")!;
    expect(tool.description).toContain("header as row 0");
    const thread = (await rig.ok("get_doc", { uuid: created.uuid })).annotations[0];
    for (const coordinates of [{ row: 0 }, { column: 0 }, { row: 0, column: 0 }]) {
      const refused = await rig.call("annotate", { uuid: created.uuid, thread_id: thread.id, text: "Reply", ...coordinates });
      expect(refused.payload.error).toBe("schema_validation");
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const prose = await rig.ok("annotate", { ...args, block_id: created.blocks[1].id });
    expect(prose.annotation.range).toEqual({ start: 0, end: 3, collapsed: false });
  });

  it("recomputes cell coordinates after structural edits and returns null after deletion", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Moving cell anchors", description: "Coordinates follow retained cells.",
      blocks: [{ type: "table", text: GFM }] });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const opened = await rig.ok("annotate", { uuid: created.uuid, block_id: id, row: 1, column: 1,
      start: 0, end: 4, text: "Beta" });
    const after = "| Name | Extra | Value |\n| --- | --- | --- |\n| New | New | New |\n| Alpha | Added | Beta |";
    await rig.ok("edit_block", { uuid: created.uuid, block_id: id, old_text: GFM, new_text: after,
      table_mapping: { rows: [0, null, 1], columns: [0, null, 1] } });
    let read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.annotations[0].range).toEqual({ row: 2, column: 2, start: 0, end: 4, collapsed: false });
    cell(doc, id, 2, 2).delete(0, 4);
    read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.annotations[0]).toMatchObject({ id: opened.annotation.id, range: null });
    const another = await rig.ok("annotate", { uuid: created.uuid, block_id: id, row: 2, column: 0,
      start: 0, end: 5, text: "Alpha" });
    const next = "| Name | Extra | Value |\n| --- | --- | --- |\n| New | New | New |";
    await rig.ok("edit_block", { uuid: created.uuid, block_id: id, old_text: read.blocks[0].text, new_text: next,
      table_mapping: { rows: [0, 1], columns: [0, 1, 2] } });
    expect((await rig.ok("get_doc", { uuid: created.uuid })).annotations.find((a: { id: string }) => a.id === another.annotation.id).range).toBeNull();
  });

  it("uses concatenated cell offsets for concurrent first-text writes", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", { title: "Several shared texts", description: "One cell coordinate space.",
      blocks: [{ type: "table", text: GFM }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const target = tableRows(findBlockElement(doc, id)!)[1]![0]!;
    (target.firstChild as Y.XmlElement).insert(1, [new Y.XmlText(" tail")]);
    const opened = await rig.ok("annotate", { uuid: created.uuid, block_id: id, row: 1, column: 0,
      start: 3, end: 8, text: "Concatenated selection" });
    expect(opened.annotation.range).toEqual({ row: 1, column: 0, start: 3, end: 8, collapsed: false });
    expect(tableCellTexts(target).map(text => text.toDelta())).toEqual([
      [{ insert: "Alp" }, { insert: "ha", attributes: { comment: { threadId: opened.annotation.id } } }],
      [{ insert: " ta", attributes: { comment: { threadId: opened.annotation.id } } }, { insert: "il" }],
    ]);
  });

  it("creates cells through create_doc and insert_block, with canonical reads, search and export", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Cells", description: "Structured cells over GFM.",
      blocks: [{ type: "table", text: "| Name | Value |\n| :--- | ---: |\n| **Alpha** | A\\|B |" }],
    });
    const table = created.blocks[0];
    expect(table.text).toBe("| Name | Value |\n| --- | --- |\n| **Alpha** | A\\|B |");
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const element = findBlockElement(doc, table.id)!;
    expect(element.firstChild).toBeInstanceOf(Y.XmlElement);
    expect(tableRows(element).map(row => row.map(cell => cell.nodeName))).toEqual([
      ["tableHeader", "tableHeader"], ["tableCell", "tableCell"],
    ]);
    expect(cell(doc, table.id, 1, 0).toDelta()).toEqual([{ insert: "Alpha", attributes: { bold: {} } }]);
    expect((await rig.ok("search", { query: "Alpha" })).hits.map((hit: { uuid: string }) => hit.uuid)).toContain(created.uuid);
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, type: "table", text: GFM });
    expect(inserted.block.text).toBe(GFM);
    expect(blockText(doc, inserted.block.id)).toBe(cell(doc, inserted.block.id, 1, 1));
    const cursor = rig.instance.replicas.replica(created.uuid).awareness.getLocalState()!.cursor;
    const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), doc);
    expect(position?.type).toBe(cell(doc, inserted.block.id, 1, 1));
    const exported = await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false });
    expect(exported.markdown).toContain(table.text);
    expect(exported.markdown).toContain(GFM);
    const empty = await rig.ok("insert_block", { uuid: created.uuid, type: "table", text: "|  |\n| --- |\n|  |" });
    const emptyTable = findBlockElement(doc, empty.block.id)!;
    const emptyParagraph = tableRows(emptyTable)[1]![0]!.firstChild;
    const emptyCursor = rig.instance.replicas.replica(created.uuid).awareness.getLocalState()!.cursor;
    const emptyPosition = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(emptyCursor.head), doc);
    expect(emptyPosition?.type).toBe((emptyParagraph as Y.XmlElement).firstChild);
    expect((emptyParagraph as Y.XmlElement).length).toBe(1);
  });

  it.each(["create_doc", "insert_block", "edit_block"])("stores every inline cell mark through %s and indexes document backlinks", async (door) => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Linked page", description: "A known table link target." });
    const body = `\`code\` **bold** *italic* ~~strike~~ [external](https://example.com/page) [document](${target.uuid})`;
    const source = `| **Formats** |\n| --- |\n| ${body} |`;
    const created = await rig.ok("create_doc", {
      title: "Formatted cells", description: "Agent cells store inline formatting.",
      blocks: door === "insert_block" ? [] : [{ type: "table", text: door === "create_doc"
        ? source : "| **Formats** |\n| --- |\n| placeholder |" }],
    });
    const block = door === "create_doc" ? created.blocks[0] : door === "insert_block"
      ? (await rig.ok("insert_block", { uuid: created.uuid, type: "table", text: source })).block
      : (await rig.ok("edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
        old_text: created.blocks[0].text, new_text: source, rev: created.blocks[0].rev })).block;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    expect(cellRuns(doc, block.id, 0, 0)).toEqual([{ text: "Formats", marks: { bold: true } }]);
    expect(cellRuns(doc, block.id, 1, 0)).toEqual([
      { text: "code", marks: { inlineCode: true } }, { text: " ", marks: {} },
      { text: "bold", marks: { bold: true } }, { text: " ", marks: {} },
      { text: "italic", marks: { italic: true } }, { text: " ", marks: {} },
      { text: "strike", marks: { strike: true } }, { text: " ", marks: {} },
      { text: "external", marks: { link: "https://example.com/page" } }, { text: " ", marks: {} },
      { text: "document", marks: { docLink: target.uuid } },
    ]);
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    expect(read.text).toBe(source);
    expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown).toBe(`${read.text}\n`);
    expect((await rig.ok("backlinks", { uuid: target.uuid })).backlinks.map((row: { uuid: string }) => row.uuid)).toEqual([created.uuid]);
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, type: "table", text: read.text });
    expect(inserted.block.text).toBe(read.text);
    expect(cellRuns(doc, inserted.block.id, 0, 0)).toEqual(cellRuns(doc, block.id, 0, 0));
    expect(cellRuns(doc, inserted.block.id, 1, 0)).toEqual(cellRuns(doc, block.id, 1, 0));
    const copy = await rig.ok("create_doc", { title: "Formatted copy", description: "Representable marks round trip exactly.",
      blocks: [{ type: "table", text: read.text }] });
    const copyDoc = rig.instance.replicas.replica(copy.uuid).doc;
    expect(copy.blocks[0].text).toBe(read.text);
    expect(cellRuns(copyDoc, copy.blocks[0].id, 0, 0)).toEqual(cellRuns(doc, block.id, 0, 0));
    expect(cellRuns(copyDoc, copy.blocks[0].id, 1, 0)).toEqual(cellRuns(doc, block.id, 1, 0));
  });

  it("refuses unknown cell document targets before any create seed, insert or edit write", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Known", description: "The earlier table seed can link here." });
    const known = `| Name |\n| --- |\n| [known](${target.uuid}) |`;
    const unknown = `| Name |\n| --- |\n| [unknown](${randomUUID()}) |`;
    const before = await rig.ok("list_docs");
    const logSize = rig.instance.store.logSize();
    const refusedCreate = await rig.call("create_doc", {
      title: "No partial create", description: "Every seed target is checked first.",
      blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "table", text: known }, { type: "table", text: unknown }],
    });
    expect(refusedCreate.payload).toMatchObject({ error: "doclink_target_not_known_locally", applied: false, partial: false });
    expect(refusedCreate.payload.hub).toBeDefined();
    expect(await rig.ok("list_docs")).toEqual(before);
    expect(rig.instance.store.logSize()).toBe(logSize);
    const created = await rig.ok("create_doc", {
      title: "Guarded links", description: "Refused table links leave every cell unchanged.", blocks: [{ type: "table", text: GFM }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const state = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const inserted = await rig.call("insert_block", { uuid: created.uuid, type: "table", text: unknown });
    expect(inserted.payload).toMatchObject({ error: "doclink_target_not_known_locally", applied: false, partial: false });
    const edited = await rig.call("edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
      old_text: GFM, new_text: GFM.replace("Alpha", `[unknown](${randomUUID()})`), rev: created.blocks[0].rev });
    expect(edited.payload).toMatchObject({ error: "doclink_target_not_known_locally", applied: false, partial: false });
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
    expect(rig.instance.store.logSize()).toBe(writes);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual(created.blocks);
  });

  it.each(["no-op", "neighbour", "label", "format", "row", "column"])("keeps an existing unresolved cell link editable through a %s edit", async (change) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Unresolved cell link", description: "An existing link need not be in this replica's directory.",
      blocks: [{ type: "table", text: GFM }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const alpha = cell(doc, id, 1, 0);
    const unknown = randomUUID();
    alpha.format(0, alpha.length, { docLink: { docId: unknown } });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    const rows = [["Name", "Value"], [`[Alpha](${unknown})`, "Beta"]];
    let mapping: TableMapping | undefined;
    if (change === "neighbour") rows[1]![1] = "Gamma";
    if (change === "label") rows[1]![0] = `[Renamed](${unknown})`;
    if (change === "format") rows[1]![0] = `[**Alpha**](${unknown})`;
    if (change === "row") {
      rows.splice(1, 0, ["New", "Row"]);
      mapping = { rows: [0, null, 1], columns: [0, 1] };
    }
    if (change === "column") {
      rows[0]!.unshift("New"); rows[1]!.unshift("Cell");
      mapping = { rows: [0, 1], columns: [null, 0, 1] };
    }
    const state = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const changed = await rig.ok("edit_block", {
      uuid: created.uuid, block_id: id, old_text: read.text, new_text: writeGfmTable(rows), rev: read.rev,
      ...(mapping === undefined ? {} : { table_mapping: mapping }),
    });
    expect(changed.block.text).toBe(writeGfmTable(rows));
    const row = change === "row" ? 2 : 1;
    const column = change === "column" ? 1 : 0;
    expect(cell(doc, id, row, column)).toBe(alpha);
    expect(cellRuns(doc, id, row, column)).toEqual([{
      text: change === "label" ? "Renamed" : "Alpha",
      marks: { docLink: unknown, ...(change === "format" ? { bold: true } : {}) },
    }]);
    if (change === "no-op") {
      expect(updates).toBe(0);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
      expect(rig.instance.store.logSize()).toBe(writes);
    }
  });

  it.each(["neighbour", "target", "row", "column", "replacement"])("refuses an unknown target added through a %s edit beside an existing unresolved link", async (change) => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "New unresolved links", description: "Only existing cell targets are exempt from validation.",
      blocks: [{ type: "table", text: GFM }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const unknown = randomUUID();
    const alpha = cell(doc, id, 1, 0);
    alpha.format(0, alpha.length, { docLink: { docId: unknown } });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    const rows = [["Name", "Value"], [`[Alpha](${unknown})`, "Beta"]];
    let mapping: TableMapping | undefined;
    if (change === "neighbour") rows[1]![1] = `[Copy](${unknown})`;
    if (change === "target") rows[1]![0] = `[Alpha](${randomUUID()})`;
    if (change === "row") {
      rows.push([`[Copy](${unknown})`, "New"]);
      mapping = { rows: [0, 1, null], columns: [0, 1] };
    }
    if (change === "column") {
      rows[0]!.push("New"); rows[1]!.push(`[Copy](${unknown})`);
      mapping = { rows: [0, 1], columns: [0, 1, null] };
    }
    if (change === "replacement") mapping = { rows: [0, null], columns: [0, 1] };
    const state = Y.encodeStateAsUpdate(doc);
    const writes = rig.instance.store.logSize();
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const refused = await rig.call("edit_block", {
      uuid: created.uuid, block_id: id, old_text: read.text, new_text: writeGfmTable(rows), rev: read.rev,
      ...(mapping === undefined ? {} : { table_mapping: mapping }),
    });
    expect(refused.payload).toMatchObject({ error: "doclink_target_not_known_locally", applied: false, partial: false });
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
    expect(rig.instance.store.logSize()).toBe(writes);
  });

  it("keeps existing literal syntax escaped and canonical insertion round trips stable while exact no-ops preserve marked edges", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Round trip boundary", description: "Literal cells and unrepresentable edges have distinct contracts.",
      blocks: [{ type: "table", text: "| Edges | Literal |\n| --- | --- |\n| Alpha | placeholder |" }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const edges = cell(doc, id, 1, 0);
    edges.delete(0, edges.length);
    edges.insert(0, "  Alpha  ");
    edges.format(0, edges.length, { bold: true });
    const literal = cell(doc, id, 1, 1);
    const raw = `[command](${randomUUID()}) **bold** _italic_ ~~strike~~ <tag> & ! | \\ \`code\``;
    literal.delete(0, literal.length);
    literal.insert(0, raw);
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    expect(read.text).toContain("\\[command\\]");
    expect(read.text).toContain("\\<tag\\> \\& \\! \\|");
    expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown).toBe(`${read.text}\n`);
    const state = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const noop = await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
      old_text: read.text, new_text: read.text, rev: read.rev });
    expect(noop.block).toEqual(read);
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
    expect(edges.toDelta()).toEqual([{ insert: "  Alpha  ", attributes: { bold: true } }]);
    expect(literal.toDelta()).toEqual([{ insert: raw }]);
    const roundtrip = await rig.ok("create_doc", {
      title: "Canonical copy", description: "A GFM copy trims only its unrepresentable cell edges.",
      blocks: [{ type: "table", text: read.text }],
    });
    const copy = rig.instance.replicas.replica(roundtrip.uuid).doc;
    expect(cellRuns(copy, roundtrip.blocks[0].id, 1, 0)).toEqual([{ text: "Alpha", marks: { bold: true } }]);
    expect(cell(copy, roundtrip.blocks[0].id, 1, 1).toDelta()).toEqual([{ insert: raw }]);
    const canonical = (await rig.ok("get_doc", { uuid: roundtrip.uuid })).blocks[0].text;
    const inserted = await rig.ok("insert_block", { uuid: roundtrip.uuid, type: "table", text: canonical });
    expect(inserted.block.text).toBe(canonical);
    expect(cellRuns(copy, inserted.block.id, 1, 0)).toEqual(cellRuns(copy, roundtrip.blocks[0].id, 1, 0));
    expect(cell(copy, inserted.block.id, 1, 1).toDelta()).toEqual([{ insert: raw }]);
  });

  it("changes only requested cell mark keys so concurrent marks, characters and other cells survive", async () => {
    const rig = await localRig();
    const source = "| Text | Other |\n| --- | --- |\n| **prefix** *Alpha* ~~tail~~ | keep |";
    const created = await rig.ok("create_doc", {
      title: "Cell mark merge", description: "A formatting edit retains concurrent work.", blocks: [{ type: "table", text: source }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const id = created.blocks[0].id;
    const original = cell(doc, id, 1, 0);
    const other = cell(doc, id, 1, 1);
    other.format(0, other.length, { bold: true });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    const remote = new Y.Doc();
    try {
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
      const remoteOriginal = cell(remote, id, 1, 0);
      remoteOriginal.format(7, 5, { inlineCode: {} });
      remoteOriginal.insert(9, "!");
      cell(remote, id, 1, 1).insert(4, " later");
      const changed = await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
        old_text: read.text, new_text: read.text.replace("*Alpha*", "***Alpha***"), rev: read.rev });
      expect(changed.block.text).toContain("***Alpha***");
      expect(cell(doc, id, 1, 0)).toBe(original);
      expect(cell(doc, id, 1, 1)).toBe(other);
      expect(other.toDelta()).toEqual([{ insert: "keep", attributes: { bold: true } }]);
      const localUpdate = Y.encodeStateAsUpdate(doc);
      const remoteUpdate = Y.encodeStateAsUpdate(remote);
      Y.applyUpdate(doc, remoteUpdate); Y.applyUpdate(remote, localUpdate);
      expect(cellRuns(doc, id, 1, 0)).toEqual(cellRuns(remote, id, 1, 0));
      expect(cellRuns(doc, id, 1, 0).map(run => run.text).join("")).toBe("prefix Al!pha tail");
      const alpha = cellRuns(doc, id, 1, 0).filter(run => run.marks.italic);
      expect(alpha.map(run => run.text).join("")).toBe("Al!pha");
      for (const run of alpha) expect(run.marks).toMatchObject({ italic: true, inlineCode: true });
      expect(alpha.filter(run => run.marks.bold).map(run => run.text).join("").replace("!", "")).toBe("Alpha");
      expect(other.toDelta()).toEqual([{ insert: "keep later", attributes: { bold: true } }]);
      expect(cell(doc, id, 1, 0)).toBe(original);
      expect(cell(doc, id, 1, 1)).toBe(other);
    } finally { remote.destroy(); }
  });

  it("keeps first and delayed writers in one empty cell visible to every agent reader", async () => {
    const rig = await localRig();
    const source = "| h | x |\n| --- | --- |\n|  | keep |";
    const created = await rig.ok("create_doc", {
      title: "Empty cell", description: "First writers share the empty cell text.",
      blocks: [{ type: "table", text: source }],
    });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const remote = new Y.Doc();
    const delayed = new Y.Doc();
    try {
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
      const original = cell(doc, id, 1, 0);
      const remoteText = cell(remote, id, 1, 0);
      const originalPosition = Y.createRelativePositionFromTypeIndex(original, 0).type;
      expect(Y.createRelativePositionFromTypeIndex(remoteText, 0).type).toEqual(originalPosition);
      await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
        old_text: source, new_text: source.replace("|  | keep |", "| Ann | keep |"), rev: created.blocks[0].rev });
      original.format(0, 3, { bold: {} });
      editBlock(remote, id, source, source.replace("|  | keep |", "| Ben | keep |"));
      remoteText.format(0, 3, { italic: {} });
      Y.applyUpdate(delayed, Y.encodeStateAsUpdate(remote));
      const localWrite = Y.encodeStateAsUpdate(doc);
      const remoteWrite = Y.encodeStateAsUpdate(remote);
      Y.applyUpdate(doc, remoteWrite); Y.applyUpdate(remote, localWrite);
      const delayedBefore = cell(delayed, id, 1, 0).length;
      cell(delayed, id, 1, 0).insert(delayedBefore, " later");
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(delayed));
      const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
      for (const value of ["Ann", "Ben", "later"]) expect(read.text).toContain(value);
      expect(read.rev).not.toBe(created.blocks[0].rev);
      expect(cell(doc, id, 1, 0)).toBe(original);
      const paragraph = tableRows(findBlockElement(doc, id)!)[1]![0]!.firstChild as Y.XmlElement;
      expect(paragraph.length).toBe(1);
      const exported = (await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown;
      expect(exported).toContain("**Ann**"); expect(exported).toContain("*Ben");
      expect((await rig.ok("search", { query: parseGfmTable(read.text)?.rows[0]?.[0] ?? "" })).hits.map((hit: { uuid: string }) => hit.uuid)).toContain(created.uuid);
      const stale = await rig.call("edit_block", { uuid: created.uuid, block_id: id,
        old_text: read.text, new_text: read.text, rev: created.blocks[0].rev });
      expect(stale.payload.error).toBe("stale_block");
      const changed = await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
        old_text: read.text, new_text: read.text.replace("keep", "kept"), rev: read.rev });
      expect(changed.block.text).toContain("kept");
      expect(cell(doc, id, 1, 0)).toBe(original);
    } finally { remote.destroy(); delayed.destroy(); }
  });

  it("refuses non-table text before any create, insert or edit write", async () => {
    const rig = await localRig();
    const before = await rig.ok("list_docs");
    const badCreate = await rig.call("create_doc", {
      title: "Refused", description: "Must create nothing.",
      blocks: [{ type: "paragraph", text: "Earlier seed" }, { type: "table", text: "not a table" }],
    });
    expect(badCreate.payload).toMatchObject({ error: "invalid_table", applied: false, partial: false });
    expect(await rig.ok("list_docs")).toEqual(before);
    const created = await rig.ok("create_doc", {
      title: "Valid", description: "Guarded writes.", blocks: [{ type: "table", text: GFM }],
    });
    const replica = rig.instance.replicas.replica(created.uuid);
    const state = Y.encodeStateVector(replica.doc);
    for (const bad of ["not a table", `${GFM}\n\nparagraph`, `${GFM}\n# heading`]) {
      const inserted = await rig.call("insert_block", { uuid: created.uuid, type: "table", text: bad });
      expect(inserted.payload).toMatchObject({ error: "invalid_table", applied: false, partial: false });
      const edited = await rig.call("edit_block", {
        uuid: created.uuid, block_id: created.blocks[0].id,
        old_text: GFM, new_text: bad, rev: created.blocks[0].rev,
      });
      expect(edited.payload).toMatchObject({ error: "invalid_table", applied: false, partial: false });
    }
    expect(Y.encodeStateVector(replica.doc)).toEqual(state);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual(created.blocks);
  });

  it("checks GFM revisions, splices only changed cells and preserves marks across column insertion", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Guarded table", description: "A formatted cell survives structural edits.",
      blocks: [{ type: "table", text: GFM }],
    });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const beta = cell(doc, id, 1, 1);
    beta.format(0, beta.length, { bold: true });
    const unchanged = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    expect(unchanged.rev).not.toBe(created.blocks[0].rev);
    const mismatch = await rig.call("edit_block", {
      uuid: created.uuid, block_id: id, old_text: GFM.replace("Alpha", "Wrong"), new_text: GFM, rev: unchanged.rev,
    });
    expect(mismatch.payload.error).toBe("old_text_mismatch");
    const changed = await rig.ok("edit_block", {
      uuid: created.uuid, block_id: id, old_text: unchanged.text,
      new_text: "| Name | Extra | Value |\n| --- | --- | --- |\n| Alpha changed | New | **Beta** |", rev: unchanged.rev,
      table_mapping: { rows: [0, 1], columns: [0, null, 1] },
    });
    expect(cell(doc, id, 1, 2)).toBe(beta);
    expect(beta.toDelta()).toEqual([{ insert: "Beta", attributes: { bold: true } }]);
    const stale = await rig.call("edit_block", {
      uuid: created.uuid, block_id: id, old_text: changed.block.text, new_text: changed.block.text, rev: unchanged.rev,
    });
    expect(stale.payload.error).toBe("stale_block");
  });

  it("preserves shifted status cells and delayed edits through a guarded same-width column replacement", async () => {
    const rig = await localRig();
    const before = writeGfmTable([["Task", "Status", "Notes"], ["Write", "done", "draft"], ["Ship", "todo", "needs QA"]]);
    const nextRows = [["Task", "Owner", "Status"], ["Write", "ann", "done"], ["Ship", "ben", "**todo**"]];
    const after = writeGfmTable(nextRows);
    const created = await rig.ok("create_doc", {
      title: "Column replacement", description: "Shifted cells keep concurrent work.",
      blocks: [{ type: "table", text: before }],
    });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const ship = cell(doc, id, 2, 1);
    ship.format(0, 4, { bold: {} });
    const remote = new Y.Doc();
    try {
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
      const remoteShip = cell(remote, id, 2, 1);
      remoteShip.insert(remoteShip.length, " (blocked)");
      const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
      expect(read.rev).not.toBe(created.blocks[0].rev);
      const changed = await rig.ok("edit_block", {
        uuid: created.uuid, block_id: id, old_text: read.text, new_text: after, rev: read.rev,
        table_mapping: { rows: [0, 1, 2], columns: [0, null, 1] },
      });
      expect(changed.block.text).toBe(after);
      expect(changed.block.rev).not.toBe(read.rev);
      expect(cell(doc, id, 2, 2)).toBe(ship);
      expect(ship.toDelta()).toEqual([{ insert: "todo", attributes: { bold: {} } }]);
      const localUpdate = Y.encodeStateAsUpdate(doc);
      const remoteUpdate = Y.encodeStateAsUpdate(remote);
      Y.applyUpdate(doc, remoteUpdate);
      Y.applyUpdate(remote, localUpdate);
      nextRows[2]![2] = "**todo (blocked)**";
      const merged = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
      expect(merged.text).toBe(writeGfmTable(nextRows));
      expect(parseGfmTable(merged.text)).toMatchObject({ header: nextRows[0], rows: nextRows.slice(1) });
      expect(cell(doc, id, 2, 2)).toBe(ship);
      expect(cell(remote, id, 2, 2)).toBe(remoteShip);
      expect(ship.toDelta()).toEqual([{ insert: "todo (blocked)", attributes: { bold: {} } }]);
      expect(remoteShip.toDelta()).toEqual(ship.toDelta());
      expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown).toContain("| Ship | ben | **todo (blocked)** |");
      const state = Y.encodeStateVector(doc);
      const stale = await rig.call("edit_block", {
        uuid: created.uuid, block_id: id, old_text: merged.text, new_text: merged.text, rev: changed.block.rev,
      });
      expect(stale.payload.error).toBe("stale_block");
      const mismatch = await rig.call("edit_block", {
        uuid: created.uuid, block_id: id, old_text: after, new_text: merged.text, rev: merged.rev,
      });
      expect(mismatch.payload.error).toBe("old_text_mismatch");
      expect(Y.encodeStateVector(doc)).toEqual(state);
      const followup = await rig.ok("edit_block", {
        uuid: created.uuid, block_id: id, old_text: merged.text,
        new_text: merged.text.replace("| Ship | ben |", "| Ship | ben2 |"), rev: merged.rev,
      });
      expect(followup.block.text).toContain("| Ship | ben2 | **todo (blocked)** |");
      expect(cell(doc, id, 2, 2)).toBe(ship);
      expect(ship.toDelta()).toEqual([{ insert: "todo (blocked)", attributes: { bold: {} } }]);
    } finally { remote.destroy(); }
  });

  it.each([
    {
      name: "reduced row replacement and rename",
      before: [["Task", "Status"], ["Write", "done"], ["Test", "done"]],
      next: [["Task", "Status"], ["New task", "todo"], ["Wrote", "done"]],
      mapping: { rows: [0, null, 1], columns: [0, 1] },
      targetColumn: 1,
    },
    {
      name: "combined row and column replacement",
      before: [["Task", "Status", "Notes", "Owner"], ["Write", "done", "write notes", "ann"],
        ["Test", "done", "test notes", "ann"], ["Ship", "todo", "ship notes", "ben"]],
      next: [["Task", "Extra", "Status", "Owner"], ["New task", "new 1", "todo", "ann"],
        ["Write2", "new 2", "done", "ann"], ["Ship", "new 3", "todo", "ben"]],
      mapping: { rows: [0, null, 1, 3], columns: [0, null, 1, 3] },
      targetColumn: 2,
    },
  ])("preserves identity, marks and offline text in $name with explicit positions", async ({ before, next, mapping, targetColumn }) => {
    const rig = await localRig();
    const source = writeGfmTable(before);
    next[2]![targetColumn] = "**done**";
    const requested = writeGfmTable(next);
    const created = await rig.ok("create_doc", {
      title: "Explicit surviving cells", description: "The caller identifies the intended surviving row.",
      blocks: [{ type: "table", text: source }],
    });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const original = cell(doc, id, 1, 1);
    original.format(0, original.length, { bold: {} });
    const remote = new Y.Doc();
    try {
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
      const remoteOriginal = cell(remote, id, 1, 1);
      const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
      remoteOriginal.insert(remoteOriginal.length, " (blocked)");
      const state = Y.encodeStateAsUpdate(doc);
      let updates = 0;
      const onUpdate = (): void => { updates += 1; };
      doc.on("update", onUpdate);
      const refused = await rig.call("edit_block", {
        uuid: created.uuid, block_id: id, old_text: read.text, new_text: requested, rev: read.rev,
      });
      expect(refused.payload).toMatchObject({ error: "table_mapping_required", recoveryClass: "manual",
        applied: false, partial: false, synced: false });
      expect(refused.payload.recovery).toContain("table_mapping");
      expect(updates).toBe(0);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
      expect(cell(doc, id, 1, 1)).toBe(original);
      doc.off("update", onUpdate);

      const changed = await rig.ok("edit_block", {
        uuid: created.uuid, block_id: id, old_text: read.text, new_text: requested, rev: read.rev,
        table_mapping: mapping,
      });
      expect(changed.block.text).toBe(requested);
      expect(cell(doc, id, 2, targetColumn)).toBe(original);
      expect(original.toDelta()).toEqual([{ insert: "done", attributes: { bold: {} } }]);
      const localUpdate = Y.encodeStateAsUpdate(doc);
      const remoteUpdate = Y.encodeStateAsUpdate(remote);
      Y.applyUpdate(doc, remoteUpdate); Y.applyUpdate(remote, localUpdate);
      next[2]![targetColumn] = "**done (blocked)**";
      const merged = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
      expect(merged.text).toBe(writeGfmTable(next));
      expect(cell(doc, id, 2, targetColumn)).toBe(original);
      expect(cell(remote, id, 2, targetColumn)).toBe(remoteOriginal);
      expect(original.toDelta()).toEqual([{ insert: "done (blocked)", attributes: { bold: {} } }]);
      expect(remoteOriginal.toDelta()).toEqual(original.toDelta());
      expect((await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false })).markdown)
        .toContain("**done (blocked)**");
      expect(cell(doc, id, 1, targetColumn).toString()).toBe("todo");
    } finally { remote.destroy(); }
  });

  it("refuses invalid table mappings before a write, after checking stale assertions and GFM", async () => {
    const rig = await localRig();
    const source = writeGfmTable([["Task", "Status"], ["Write", "done"], ["Test", "done"]]);
    const created = await rig.ok("create_doc", {
      title: "Mapping validation", description: "Semantic mapping errors never write.",
      blocks: [{ type: "table", text: source }, { type: "paragraph", text: "Plain text" }],
    });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const state = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const args = { uuid: created.uuid, block_id: id, old_text: source, new_text: source, rev: created.blocks[0].rev };
    for (const mapping of [
      { rows: [0, 1], columns: [0, 1] },
      { rows: [0, 1, 2], columns: [0] },
      { rows: [null, 1, 2], columns: [0, 1] },
      { rows: [0, 0, 2], columns: [0, 1] },
      { rows: [0, 1, 1], columns: [0, 1] },
      { rows: [0, 2, 1], columns: [0, 1] },
      { rows: [0, 1, 3], columns: [0, 1] },
      { rows: [0, 1, 2], columns: [1, 0] },
      { rows: [0, 1, 2], columns: [0, 2] },
    ]) {
      const refused = await rig.call("edit_block", { ...args, table_mapping: mapping });
      expect(refused.payload).toMatchObject({ error: "invalid_table_mapping", recoveryClass: "manual",
        applied: false, partial: false, synced: false });
      expect(refused.payload.recovery).toContain("table_mapping");
    }
    const invalid = { rows: [0], columns: [0] };
    const stale = await rig.call("edit_block", { ...args, rev: "stale", table_mapping: invalid });
    expect(stale.payload.error).toBe("stale_block");
    const mismatch = await rig.call("edit_block", { ...args, old_text: source.replace("Write", "Wrong"), table_mapping: invalid });
    expect(mismatch.payload.error).toBe("old_text_mismatch");
    const badGfm = await rig.call("edit_block", { ...args, new_text: "not a table", table_mapping: invalid });
    expect(badGfm.payload.error).toBe("invalid_table");
    const nonTable = await rig.call("edit_block", {
      uuid: created.uuid, block_id: created.blocks[1].id, old_text: "Plain text", new_text: "Changed",
      table_mapping: invalid,
    });
    expect(nonTable.payload).toMatchObject({ error: "invalid_table_mapping", recoveryClass: "manual",
      applied: false, partial: false, synced: false });
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  });

  it("accepts ordinary cell edits and explicit positional batches without guessing structure", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Cell edit compatibility", description: "One cell keeps its ordinary path; batches identify positions.",
      blocks: [{ type: "table", text: GFM }],
    });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const beta = cell(doc, id, 1, 1);
    beta.format(0, beta.length, { italic: {} });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const noop = await rig.ok("edit_block", { uuid: created.uuid, block_id: id, old_text: read.text,
      new_text: read.text.replace("---", ":---"), rev: read.rev });
    expect(noop.block.rev).toBe(read.rev);
    expect(updates).toBe(0);
    const batch = read.text.replace("Alpha", "Alpha2").replace("Beta", "Beta2");
    const refused = await rig.call("edit_block", { uuid: created.uuid, block_id: id, old_text: read.text, new_text: batch });
    expect(refused.payload.error).toBe("table_mapping_required");
    expect(updates).toBe(0);
    const changed = await rig.ok("edit_block", { uuid: created.uuid, block_id: id, old_text: read.text, new_text: batch,
      table_mapping: { rows: [0, 1], columns: [0, 1] } });
    expect(changed.block.text).toBe(batch);
    expect(cell(doc, id, 1, 1)).toBe(beta);
    const single = await rig.ok("edit_block", { uuid: created.uuid, block_id: id, old_text: batch,
      new_text: batch.replace("Alpha2", "Alpha3"), rev: changed.block.rev });
    expect(single.block.text).toContain("Alpha3");
    expect(cell(doc, id, 1, 1)).toBe(beta);
    expect(beta.toDelta()).toEqual([{ insert: "Beta2", attributes: { italic: {} } }]);
  });

  it("advertises a strict optional mapping and refuses malformed shapes at the MCP boundary", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Mapping input", description: "The advertised schema and actual input boundary agree.",
      blocks: [{ type: "table", text: GFM }],
    });
    const tool = (await rig.client.listTools()).tools.find(tool => tool.name === "edit_block")!;
    expect(tool.description).toContain("table_mapping_required");
    expect(tool.description).toContain("invalid_table_mapping");
    const mappingSchema = (tool.inputSchema.properties as Record<string, any>).table_mapping;
    expect(mappingSchema.additionalProperties).toBe(false);
    expect(mappingSchema.required).toEqual(["rows", "columns"]);
    expect(tool.inputSchema.required).not.toContain("table_mapping");
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const state = Y.encodeStateAsUpdate(doc);
    for (const mapping of [
      { rows: [0, 1] }, { columns: [0, 1] },
      { rows: [0, 1], columns: [0, 1], force: true },
      { rows: [0, -1], columns: [0, 1] },
      { rows: [0, 1.5], columns: [0, 1] },
      { rows: [0, Number.MAX_SAFE_INTEGER + 1], columns: [0, 1] },
      { rows: [0, "1"], columns: [0, 1] }, null,
    ]) {
      const refused = await rig.call("edit_block", {
        uuid: created.uuid, block_id: created.blocks[0].id, old_text: GFM, new_text: GFM, table_mapping: mapping,
      });
      expect(refused.isError).toBe(true);
      expect(refused.payload.error).toBe("schema_validation");
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  });

  it("executes an explicit replacement mapping even when GFM text is identical", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Explicit identical replacement", description: "Text equality does not override the caller's identities.",
      blocks: [{ type: "table", text: GFM }],
    });
    const id = created.blocks[0].id;
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const oldText = cell(doc, id, 1, 1);
    oldText.format(0, oldText.length, { bold: {} });
    const read = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const changed = await rig.ok("edit_block", { uuid: created.uuid, block_id: id,
      old_text: read.text, new_text: read.text, rev: read.rev,
      table_mapping: { rows: [0, null], columns: [0, 1] } });
    expect(changed.block.text).toBe(read.text);
    expect(updates).toBeGreaterThan(0);
    expect(cell(doc, id, 1, 1)).not.toBe(oldText);
    expect(cell(doc, id, 1, 1).toDelta()).toEqual([{ insert: "Beta", attributes: { bold: {} } }]);
  });

  it("pads ragged tables for reads and lets an agent fill a projected empty cell", async () => {
    const rig = await localRig();
    const created = await rig.ok("create_doc", {
      title: "Ragged", description: "A concurrent structural merge.", blocks: [{ type: "table", text: GFM }],
    });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const element = findBlockElement(doc, created.blocks[0].id)!;
    (element.firstChild as Y.XmlElement).delete(1, 1);
    const block = (await rig.ok("get_doc", { uuid: created.uuid })).blocks[0];
    expect(parseGfmTable(block.text)).toMatchObject({ header: ["Name", ""], rows: [["Alpha", "Beta"]] });
    const beta = cell(doc, block.id, 1, 1);
    await rig.ok("edit_block", {
      uuid: created.uuid, block_id: block.id, old_text: block.text,
      new_text: block.text.replace("| Name |  |", "| Name | Filled |"), rev: block.rev,
    });
    expect(cell(doc, block.id, 0, 1).toString()).toBe("Filled");
    expect(cell(doc, block.id, 1, 1)).toBe(beta);
  });

  it("opens cell threads while preserving orphaned legacy conversations and their lifecycle", async () => {
    const rig = await localRig();
    const old = legacy(GFM);
    const uuid = getMetaMap(old.doc).get("uuid") as string;
    const replica = rig.instance.replicas.replica(uuid);
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(old.doc));
    old.doc.destroy();
    const read = await rig.ok("get_doc", { uuid });
    expect(read.blocks[0]).toMatchObject({ id: old.id, type: "table", text: GFM });
    expect(read.annotations[0]).toMatchObject({ id: old.threadId, range: null });
    const state = Y.encodeStateVector(replica.doc);
    const refused = await rig.call("annotate", { uuid, block_id: old.id, start: 0, end: 3, text: "New thread" });
    expect(refused.payload).toMatchObject({ error: "annotation_cell", applied: false, blockId: old.id });
    expect(Y.encodeStateVector(replica.doc)).toEqual(state);
    for (const resolved of [true, false]) {
      const reply = await rig.ok("annotate", { uuid, thread_id: old.threadId, text: "Reply", resolved });
      expect(reply.annotation).toMatchObject({ resolved, range: null });
    }
    const created = await rig.ok("annotate", { uuid, block_id: old.id, row: 1, column: 0, start: 1, end: 4, text: "New cell thread" });
    expect(created.annotation.range).toEqual({ row: 1, column: 0, start: 1, end: 4, collapsed: false });
    const annotations = (await rig.ok("get_doc", { uuid })).annotations;
    expect(annotations.find((entry: { id: string }) => entry.id === old.threadId)).toMatchObject({ range: null, comments: expect.any(Array) });
    expect(annotations.find((entry: { id: string }) => entry.id === old.threadId).comments).toHaveLength(3);
    const tools = (await rig.client.listTools()).tools;
    expect(tools.find(tool => tool.name === "annotate")!.description).toContain("zero-based GFM projection");
  });

  it("normalizes persisted and late legacy writes, including decided records, and subsequent reads write nothing", async () => {
    const rig = await localRig();
    const old = legacy("Name|Value\n---|---\nAlpha|Beta", true);
    const uuid = getMetaMap(old.doc).get("uuid") as string;
    // Persisted before the new process opens the room: normalization must run
    // on log hydration as well as on live updates.
    rig.instance.store.appendUpdate(roomForDoc(WORKSPACE, uuid), Y.encodeStateAsUpdate(old.doc), "local");
    const replica = rig.instance.replicas.replica(uuid);
    old.doc.destroy();
    const read = await rig.ok("get_doc", { uuid });
    expect(read.approvalChanged).toBe(true);
    expect(read.blocks[0]).toMatchObject({ id: old.id, type: "table", text: GFM });
    const late = legacy("invalid table text");
    const lateElement = findBlockElement(late.doc, late.id)!;
    replica.doc.transact(() => getBlocksFragment(replica.doc).push([lateElement.clone()]));
    late.doc.destroy();
    const reread = await rig.ok("get_doc", { uuid });
    expect(reread.blocks[1]).toMatchObject({ id: late.id, type: "code", text: "invalid table text" });
    const code = findBlockElement(replica.doc, late.id)!;
    expect((code.firstChild as Y.XmlText).toDelta()[0].attributes).toHaveProperty(COMMENT_MARK);
    let updates = 0;
    replica.doc.on("update", () => { updates += 1; });
    await rig.ok("get_doc", { uuid });
    await rig.ok("export_markdown", { uuid });
    expect(updates).toBe(0);
  });
});
