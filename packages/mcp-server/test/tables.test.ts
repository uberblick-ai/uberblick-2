import { randomUUID } from "node:crypto";
import {
  COMMENT_MARK,
  appendBlock,
  createAnnotation,
  decisionApprovalFingerprint,
  findBlockElement,
  getBlocksFragment,
  getMetaMap,
  initDoc,
  parseGfmTable,
  roomForDoc,
  setKind,
  setStatus,
  tableCellText,
  tableRows,
} from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
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
    expect(cell(doc, table.id, 1, 0).toDelta()).toEqual([{ insert: "**Alpha**" }]);
    expect((await rig.ok("search", { query: "Alpha" })).hits.map((hit: { uuid: string }) => hit.uuid)).toContain(created.uuid);
    const inserted = await rig.ok("insert_block", { uuid: created.uuid, type: "table", text: GFM });
    expect(inserted.block.text).toBe(GFM);
    expect(blockText(doc, inserted.block.id)).toBe(cell(doc, inserted.block.id, 1, 1));
    const cursor = rig.instance.replicas.replica(created.uuid).awareness.getLocalState()!.cursor;
    const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), doc);
    expect(position?.type).toBe(cell(doc, inserted.block.id, 1, 1));
    const exported = await rig.ok("export_markdown", { uuid: created.uuid, frontmatter: false });
    expect(exported.markdown).toContain("\\*\\*Alpha\\*\\*");
    expect(exported.markdown).toContain(GFM);
    const empty = await rig.ok("insert_block", { uuid: created.uuid, type: "table", text: "|  |\n| --- |\n|  |" });
    const emptyTable = findBlockElement(doc, empty.block.id)!;
    const emptyParagraph = tableRows(emptyTable)[1]![0]!.firstChild;
    const emptyCursor = rig.instance.replicas.replica(created.uuid).awareness.getLocalState()!.cursor;
    const emptyPosition = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(emptyCursor.head), doc);
    expect(emptyPosition?.type).toBe(emptyParagraph);
    expect((emptyParagraph as Y.XmlElement).length).toBe(0);
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
    expect(unchanged.rev).toBe(created.blocks[0].rev);
    const mismatch = await rig.call("edit_block", {
      uuid: created.uuid, block_id: id, old_text: GFM.replace("Alpha", "Wrong"), new_text: GFM, rev: unchanged.rev,
    });
    expect(mismatch.payload.error).toBe("old_text_mismatch");
    const changed = await rig.ok("edit_block", {
      uuid: created.uuid, block_id: id, old_text: GFM,
      new_text: "| Name | Extra | Value |\n| --- | --- | --- |\n| Alpha changed | New | Beta |", rev: unchanged.rev,
    });
    expect(cell(doc, id, 1, 2)).toBe(beta);
    expect(beta.toDelta()).toEqual([{ insert: "Beta", attributes: { bold: true } }]);
    const stale = await rig.call("edit_block", {
      uuid: created.uuid, block_id: id, old_text: changed.block.text, new_text: changed.block.text, rev: unchanged.rev,
    });
    expect(stale.payload.error).toBe("stale_block");
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

  it("refuses new table threads but preserves orphaned legacy conversations and their lifecycle", async () => {
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
    expect(refused.payload).toMatchObject({ error: "table_comments_unavailable", applied: false, blockId: old.id });
    expect(Y.encodeStateVector(replica.doc)).toEqual(state);
    for (const resolved of [true, false]) {
      const reply = await rig.ok("annotate", { uuid, thread_id: old.threadId, text: "Reply", resolved });
      expect(reply.annotation).toMatchObject({ resolved, range: null });
    }
    expect((await rig.ok("get_doc", { uuid })).annotations[0].comments).toHaveLength(3);
    const tools = (await rig.client.listTools()).tools;
    expect(tools.find(tool => tool.name === "annotate")!.description).toContain("table_comments_unavailable");
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
