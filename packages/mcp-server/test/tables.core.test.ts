import { randomUUID } from "node:crypto";
import { COMMENT_MARK, appendBlock, createAnnotation, decisionApprovalFingerprint, findBlockElement, getBlocksFragment, getBlocksWithInline, getMetaMap, initDoc, parseGfmTable, parseTableCell, roomForDoc, setKind, setStatus, tableCellText, tableCellTexts, tableRows, writeGfmTable } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { TableMapping } from "@uberblick/schema";
import { blockText } from "../src/replica.js";
import { WORKSPACE, removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

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

  it("stores inline cell marks through edit_block and indexes document backlinks", async () => {
    const rig = await localRig();
    const target = await rig.ok("create_doc", { title: "Linked page", description: "A known table link target." });
    const body = `\`code\` **bold** *italic* ~~strike~~ [external](https://example.com/page) [document](${target.uuid})`;
    const source = `| **Formats** |\n| --- |\n| ${body} |`;
    const created = await rig.ok("create_doc", {
      title: "Formatted cells", description: "Agent cells store inline formatting.",
      blocks: [{ type: "table", text: "| **Formats** |\n| --- |\n| placeholder |" }],
    });
    const { block } = await rig.ok("edit_block", { uuid: created.uuid, block_id: created.blocks[0].id,
      old_text: created.blocks[0].text, new_text: source, rev: created.blocks[0].rev });
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
    const inserted = await rig.call("insert_block", { uuid: created.uuid, type: "table", text: "not a table" });
    expect(inserted.payload).toMatchObject({ error: "invalid_table", applied: false, partial: false });
    const edited = await rig.call("edit_block", {
      uuid: created.uuid, block_id: created.blocks[0].id,
      old_text: GFM, new_text: "not a table", rev: created.blocks[0].rev,
    });
    expect(edited.payload).toMatchObject({ error: "invalid_table", applied: false, partial: false });
    expect(Y.encodeStateVector(replica.doc)).toEqual(state);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks).toEqual(created.blocks);
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
