import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  AnnotationCellError,
  AnnotationRangeError,
  InvalidTableError,
  addComment,
  appendBlock,
  buildTableRow,
  createAnnotation,
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  deleteAnnotation,
  editBlock,
  exportMarkdown,
  findBlockElement,
  getAnnotation,
  getBlock,
  getBlockText,
  getMetaMap,
  initDoc,
  listAnnotationRanges,
  listAnnotations,
  setAnnotationResolved,
  setKind,
  setStatus,
  resolveAnnotationRange,
  tableCellTexts,
  tableRows,
  writeGfmTable,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CELLS = [["Name", "Count"], ["Alpha", "1"], ["Beta", "2"]];

function fixture(values = CELLS): { doc: Y.Doc; id: string; table: Y.XmlElement } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Cell comments" });
  const id = appendBlock(doc, { type: "table", text: writeGfmTable(values) });
  return { doc, id, table: findBlockElement(doc, id)! };
}

function cellText(table: Y.XmlElement, row: number, column: number): Y.XmlText {
  return tableCellTexts(tableRows(table)[row]![column]!)[0]!;
}

describe("table-cell annotation contract", () => {
  it("uses displayed cell characters including edge whitespace, excluding inline syntax and escapes", () => {
    const { doc, id, table } = fixture();
    const text = cellText(table, 1, 0);
    text.delete(0, text.length);
    text.insert(0, "  Alpha | tail  ");
    text.format(2, 5, { bold: {} });
    const before = getBlock(doc, id);
    const thread = createAnnotation(doc, id, 2, 7, "reader", "Why?", { row: 1, column: 0 });
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ row: 1, column: 0, start: 2, end: 7, collapsed: false });
    expect(listAnnotationRanges(doc, id)).toEqual([{ threadId: thread.id, row: 1, column: 0, start: 2, end: 7 }]);
    expect(text.toDelta()).toEqual([
      { insert: "  " },
      { insert: "Alpha", attributes: { bold: {}, comment: { threadId: thread.id } } },
      { insert: " | tail  " },
    ]);
    expect(getBlock(doc, id)).toEqual(before);
    expect(exportMarkdown(doc, { frontmatter: false, annotations: "html-comments" })).toContain(
      `<!-- annotation ${thread.id} row=1 column=0 range=2-7 reader: "Why?" -->`,
    );
    doc.destroy();
  });

  it("marks and clears exact intersections across adjacent shared texts in one cell", () => {
    const { doc, id, table } = fixture();
    const paragraph = tableRows(table)[1]![0]!.firstChild as Y.XmlElement;
    const suffix = new Y.XmlText("Suffix");
    paragraph.insert(1, [suffix]);
    suffix.format(0, suffix.length, { italic: {} });
    const before = getBlock(doc, id);
    const thread = createAnnotation(doc, id, 3, 8, "reader", "Across texts", { row: 1, column: 0 });
    expect(cellText(table, 1, 0).toDelta()).toEqual([
      { insert: "Alp" }, { insert: "ha", attributes: { comment: { threadId: thread.id } } },
    ]);
    expect(suffix.toDelta()).toEqual([
      { insert: "Suf", attributes: { italic: {}, comment: { threadId: thread.id } } },
      { insert: "fix", attributes: { italic: {} } },
    ]);
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ row: 1, column: 0, start: 3, end: 8, collapsed: false });
    expect(listAnnotationRanges(doc, id)).toEqual([{ threadId: thread.id, row: 1, column: 0, start: 3, end: 8 }]);
    expect(getBlock(doc, id)).toEqual(before);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(() => createAnnotation(doc, id, 7, 10, "reader", "Overlap", { row: 1, column: 0 })).toThrow(AnnotationRangeError);
    expect(updates).toBe(0);
    const neighbour = createAnnotation(doc, id, 0, 1, "reader", "Different cell", { row: 1, column: 1 });
    expect(deleteAnnotation(doc, thread.id)).toBe(true);
    expect(listAnnotationRanges(doc, id)).toEqual([{ threadId: neighbour.id, row: 1, column: 1, start: 0, end: 1 }]);
    expect(cellText(table, 1, 0).toDelta()).toEqual([{ insert: "Alpha" }]);
    expect(suffix.toDelta()).toEqual([{ insert: "Suffix", attributes: { italic: {} } }]);
    expect(getBlock(doc, id)).toEqual(before);
    doc.destroy();
  });

  it("clamps and swaps cell offsets and refuses empty ranges without writes", () => {
    const { doc, id } = fixture();
    const thread = createAnnotation(doc, id, 50, -10, "reader", "Whole cell", { row: 1, column: 0 });
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ row: 1, column: 0, start: 0, end: 5, collapsed: false });
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    for (const [start, end] of [[2, 2], [10, 20]]) {
      expect(() => createAnnotation(doc, id, start!, end!, "reader", "Empty", { row: 2, column: 0 })).toThrow(AnnotationRangeError);
    }
    expect(updates).toBe(0);
    doc.destroy();
  });

  it("uses the widest stored row for ragged projection coordinates without materializing padding", () => {
    const { doc, id, table } = fixture([["H"], ["short"]]);
    table.insert(2, [buildTableRow(["long", "two", "three"], false)]);
    const thread = createAnnotation(doc, id, 0, 5, "reader", "Visible cell", { row: 2, column: 2 });
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ row: 2, column: 2, start: 0, end: 5, collapsed: false });
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(() => createAnnotation(doc, id, 0, 5, "reader", "Padding", { row: 0, column: 2 })).toThrow(AnnotationRangeError);
    expect(() => createAnnotation(doc, id, 0, 5, "reader", "Outside", { row: 2, column: 3 })).toThrow(AnnotationCellError);
    expect(updates).toBe(0);
    expect(tableRows(table).map((row) => row.length)).toEqual([1, 1, 3]);
    doc.destroy();
  });

  it("refuses missing, non-table and out-of-projection coordinates before writing", () => {
    const { doc, id } = fixture();
    const prose = appendBlock(doc, { type: "paragraph", text: "Prose" });
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(() => createAnnotation(doc, id, 0, 1, "reader", "Missing")).toThrow(AnnotationCellError);
    expect(() => createAnnotation(doc, prose, 0, 1, "reader", "Wrong block", { row: 0, column: 0 })).toThrow(AnnotationCellError);
    for (const cell of [{ row: -1, column: 0 }, { row: 0, column: 0.5 }, { row: 3, column: 0 }, { row: 0, column: 2 }]) {
      expect(() => createAnnotation(doc, id, 0, 1, "reader", "Outside", cell)).toThrow(AnnotationCellError);
    }
    expect(updates).toBe(0);
    expect(listAnnotations(doc)).toEqual([]);
    doc.destroy();
  });

  it("refuses invisible embeds before marking a different displayed character", () => {
    const { doc, id, table } = fixture();
    cellText(table, 1, 0).insertEmbed(1, { future: "hidden" });
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(() => createAnnotation(doc, id, 1, 3, "reader", "Displayed characters", { row: 1, column: 0 })).toThrow(InvalidTableError);
    expect(updates).toBe(0);
    expect(listAnnotations(doc)).toEqual([]);
    doc.destroy();
  });

  it("recomputes coordinates when mapped rows and columns move", () => {
    const { doc, id } = fixture();
    const thread = createAnnotation(doc, id, 1, 3, "reader", "Beta", { row: 2, column: 0 });
    const expanded = writeGfmTable([
      ["Extra", "Name", "Count"], ["x", "Inserted", "0"],
      ["y", "Alpha", "1"], ["z", "Beta", "2"],
    ]);
    editBlock(doc, id, getBlockText(doc, id), expanded, { tableMapping: { rows: [0, null, 1, 2], columns: [null, 0, 1] } });
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ row: 3, column: 1, start: 1, end: 3, collapsed: false });
    const reduced = writeGfmTable([["Extra", "Name"], ["x", "Inserted"], ["z", "Beta"]]);
    editBlock(doc, id, expanded, reduced, { tableMapping: { rows: [0, 1, 3], columns: [0, 1] } });
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ row: 2, column: 1, start: 1, end: 3, collapsed: false });
    doc.destroy();
  });

  it.each(["characters", "row", "column"] as const)("orphans a cell thread when its marked %s are deleted and keeps its conversation", (what) => {
    const { doc, id } = fixture();
    const thread = createAnnotation(doc, id, 0, 5, "reader", "Alpha", { row: 1, column: 0 });
    if (what === "characters") {
      editBlock(doc, id, getBlockText(doc, id), writeGfmTable([["Name", "Count"], ["", "1"], ["Beta", "2"]]));
    } else if (what === "row") {
      editBlock(doc, id, getBlockText(doc, id), writeGfmTable([["Name", "Count"], ["Beta", "2"]]), { tableMapping: { rows: [0, 2], columns: [0, 1] } });
    } else {
      editBlock(doc, id, getBlockText(doc, id), writeGfmTable([["Count"], ["1"], ["2"]]), { tableMapping: { rows: [0, 1, 2], columns: [1] } });
    }
    expect(resolveAnnotationRange(doc, thread.id)).toBeNull();
    expect(getAnnotation(doc, thread.id)?.comments).toHaveLength(1);
    expect(addComment(doc, thread.id, "writer", "Reply")?.comments).toHaveLength(2);
    doc.destroy();
  });

  it("changes neither table content nor decided approval when opening, replying, resolving, reopening or deleting", () => {
    const { doc, id } = fixture();
    setKind(doc, "decision");
    setStatus(doc, "decided");
    const fingerprint = decisionApprovalFingerprint(doc);
    getMetaMap(doc).set("approvalFingerprint", fingerprint);
    const before = getBlock(doc, id);
    const thread = createAnnotation(doc, id, 0, 5, "reader", "Alpha", { row: 1, column: 0 });
    addComment(doc, thread.id, "writer", "Reply");
    setAnnotationResolved(doc, thread.id, true);
    setAnnotationResolved(doc, thread.id, false);
    expect(getBlock(doc, id)).toEqual(before);
    expect(decisionApprovalFingerprint(doc)).toBe(fingerprint);
    expect(decisionApprovalChanged(doc)).toBe(false);
    deleteAnnotation(doc, thread.id);
    expect(getBlock(doc, id)).toEqual(before);
    expect(decisionApprovalChanged(doc)).toBe(false);
    doc.destroy();
  });

  it("converges cell edits and concurrent replies while tracking the shared text marks", () => {
    const { doc: a, id, table } = fixture();
    const thread = createAnnotation(a, id, 1, 4, "reader", "Middle", { row: 1, column: 0 });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    cellText(table, 1, 0).insert(0, "prefix ");
    addComment(a, thread.id, "one", "First reply");
    addComment(b, thread.id, "two", "Second reply");
    syncDocs(a, b);
    expect(resolveAnnotationRange(a, thread.id)).toEqual({ row: 1, column: 0, start: 8, end: 11, collapsed: false });
    expect(resolveAnnotationRange(b, thread.id)).toEqual(resolveAnnotationRange(a, thread.id));
    expect(getAnnotation(a, thread.id)?.comments).toHaveLength(3);
    expect(getAnnotation(b, thread.id)).toEqual(getAnnotation(a, thread.id));
    a.destroy();
    b.destroy();
  });
});
