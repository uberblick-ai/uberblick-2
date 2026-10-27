import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  appendBlock, createAnnotation, editBlock, findBlockElement, getBlock,
  getBlocksFragment, initDoc, setAnnotationResolved, tableCellText, tableRows, writeGfmTable,
} from "../src/index.js";
import { cardPartTexts } from "../src/card.js";
import { figmaCaptionTexts } from "../src/figma.js";
import { compareTables, inlineChanges, snapshotBlocks } from "../src/revision-blocks.js";
import type { RevisionBlock } from "../src/revision-blocks.js";
import { diffWords } from "../src/revision-sequence.js";
import type { InlineRun } from "../src/types.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CELLS = [["Name", "Count"], ["Alpha", "1"], ["Beta", "2"]];

function document(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Revision comparison" });
  return doc;
}

function first(doc: Y.Doc): RevisionBlock {
  return snapshotBlocks(doc)[0]!;
}

function table(values = CELLS): { doc: Y.Doc; id: string; element: Y.XmlElement } {
  const doc = document();
  const id = appendBlock(doc, { type: "table", text: writeGfmTable(values) });
  return { doc, id, element: findBlockElement(doc, id)! };
}

function width(cell: Y.XmlElement, value: number): void {
  (cell as unknown as { setAttribute(name: string, value: unknown): void }).setAttribute("colwidth", [value]);
}

describe("revision authored-content snapshots", () => {
  it("ignores comment-split runs, resolution, IDs and system attributes in each prose container", () => {
    const doc = document();
    const prose = appendBlock(doc, { type: "paragraph", inline: [{ text: "Alpha text", marks: { bold: true } }] });
    const grid = appendBlock(doc, { type: "table", text: writeGfmTable([["Header"], ["**Alpha text**"]]) });
    const card = appendBlock(doc, { type: "card", text: "title: **Alpha text**\n\nBody text" });
    const figma = appendBlock(doc, { type: "figma", text: "url: https://figma.com/design/key\n\n**Alpha text**" });
    const keys = snapshotBlocks(doc).map((block) => block.key);
    const threads = [
      createAnnotation(doc, prose, 1, 4, "reader", "Question"),
      createAnnotation(doc, grid, 1, 4, "reader", "Question", { row: 1, column: 0 }),
      createAnnotation(doc, card, 1, 4, "reader", "Question", { part: "title" }),
      createAnnotation(doc, figma, 1, 4, "reader", "Question", { part: "caption" }),
    ];
    expect(snapshotBlocks(doc).map((block) => block.key)).toEqual(keys);
    for (const thread of threads) setAnnotationResolved(doc, thread.id, true);
    for (const block of snapshotBlocks(doc)) {
      const element = findBlockElement(doc, block.id)!;
      element.setAttribute("updatedAt", "later");
      element.setAttribute("id", crypto.randomUUID());
    }
    expect(snapshotBlocks(doc).map((block) => block.key)).toEqual(keys);
    doc.destroy();
  });

  it("merges equal marks across multiple stored texts in structured parts", () => {
    const doc = document();
    const card = appendBlock(doc, { type: "card", text: "title: Alpha text\n\nBody" });
    const figma = appendBlock(doc, { type: "figma", text: "url: https://figma.com/design/key\n\nAlpha text" });
    const grid = appendBlock(doc, { type: "table", text: writeGfmTable([["Alpha text"]]) });
    const before = snapshotBlocks(doc).map((block) => block.key);
    const texts = [
      cardPartTexts(findBlockElement(doc, card)!, "title")[0]!,
      figmaCaptionTexts(findBlockElement(doc, figma)!)[0]!,
      tableCellText(tableRows(findBlockElement(doc, grid)!)[0]![0]!)!,
    ];
    for (const text of texts) {
      text.delete(5, text.length - 5);
      const tail = new Y.XmlText(" text");
      (text.parent as Y.XmlElement).insert(1, [tail]);
      tail.format(1, 2, { comment: { threadId: UUID } });
    }
    expect(snapshotBlocks(doc).map((block) => block.key)).toEqual(before);
    doc.destroy();
  });

  it("preserves visible-block selection and captures named fields without system attributes", () => {
    const doc = document();
    const id = appendBlock(doc, { type: "heading", text: "Visible", level: 3 });
    const shadow = new Y.XmlElement("paragraph");
    shadow.setAttribute("id", id);
    shadow.insert(0, [new Y.XmlText("Shadowed")]);
    getBlocksFragment(doc).insert(1, [shadow]);
    expect(snapshotBlocks(doc)).toHaveLength(1);
    expect(first(doc)).toMatchObject({ id, type: "heading", text: "Visible", fields: { level: 3 } });
    doc.destroy();
  });

  it("compares chart mappings by top-level fields and keeps invalid mapping source", () => {
    const a = document();
    const b = document();
    appendBlock(a, { type: "chart", text: '{"type":"line","x":{"field":"day","type":"date"},"collection":"days"}' });
    appendBlock(b, { type: "chart", text: '{ "collection": "days", "x": {"type":"date", "field":"day"}, "type":"line" }' });
    expect(first(a).key).toBe(first(b).key);
    expect(first(a).fields).toMatchObject({ type: "line", x: { field: "day" }, collection: "days" });
    const id = getBlock(b, first(b).id)!.id;
    editBlock(b, id, getBlock(b, id)!.text, "invalid mapping");
    const invalid = first(b);
    expect(invalid.fields).toEqual({ source: "invalid mapping" });
    editBlock(b, id, "invalid mapping", '{"source":"invalid mapping"}');
    expect(first(b).key).not.toBe(invalid.key);
    expect(first(b).chartMapping).toBe(true);
    a.destroy(); b.destroy();
  });
});

describe("revision table comparison", () => {
  it("places word spans only in the edited cell and treats a header rename as text", () => {
    const { doc, id } = table();
    const before = first(doc);
    const source = getBlock(doc, id)!.text;
    editBlock(doc, id, source, source.replace("Alpha", "Alpine"));
    const result = compareTables(before, first(doc));
    expect(result.fields).toEqual([]);
    expect(result.rows.map((row) => row.kind)).toEqual(["unchanged", "changed", "unchanged"]);
    expect(result.rows[1]?.cells?.[0]).toMatchObject({ column: 0, kind: "changed", fields: [], spans: [
      { kind: "removed", text: "Alpha" }, { kind: "added", text: "Alpine" },
    ] });
    expect(result.rows.flatMap((row) => row.cells ?? []).filter((cell) => cell.spans.length > 0)).toHaveLength(1);
    const renamed = getBlock(doc, id)!.text;
    const previous = first(doc);
    editBlock(doc, id, renamed, renamed.replace("Name", "Label"));
    expect(compareTables(previous, first(doc)).rows[0]).toMatchObject({ kind: "changed" });
    expect(compareTables(previous, first(doc)).fields).toEqual([]);
    doc.destroy();
  });

  it("reports inserted and deleted rows whole while preserving surrounding row matches", () => {
    const { doc, id } = table();
    const before = first(doc);
    editBlock(doc, id, getBlock(doc, id)!.text, writeGfmTable([CELLS[0]!, ["Inserted", "0"], CELLS[1]!, CELLS[2]!]), {
      tableMapping: { rows: [0, null, 1, 2], columns: [0, 1] },
    });
    const inserted = compareTables(before, first(doc));
    expect(inserted.rows).toMatchObject([
      { kind: "unchanged", beforeIndex: 0, afterIndex: 0 },
      { kind: "added", afterIndex: 1 },
      { kind: "unchanged", beforeIndex: 1, afterIndex: 2 },
      { kind: "unchanged", beforeIndex: 2, afterIndex: 3 },
    ]);
    expect(inserted.rows[1]?.cells).toBeUndefined();
    const middle = first(doc);
    editBlock(doc, id, getBlock(doc, id)!.text, writeGfmTable([CELLS[0]!, CELLS[2]!]), {
      tableMapping: { rows: [0, 3], columns: [0, 1] },
    });
    const removed = compareTables(middle, first(doc));
    expect(removed.rows.map((row) => row.kind)).toEqual(["unchanged", "removed", "removed", "unchanged"]);
    expect(removed.rows.filter((row) => row.kind === "removed").every((row) => row.cells === undefined)).toBe(true);
    doc.destroy();
  });

  it("aligns content-matched rows and an edited row in independently rebuilt documents", () => {
    const a = table();
    const b = table([CELLS[0]!, ["Alpine", "1"], CELLS[2]!, ["Gamma", "3"]]);
    const result = compareTables(first(a.doc), first(b.doc));
    expect(result.rows.map((row) => row.kind)).toEqual(["unchanged", "changed", "unchanged", "added"]);
    expect(result.rows[1]?.cells?.[0]?.spans).toEqual([{ kind: "removed", text: "Alpha" }, { kind: "added", text: "Alpine" }]);
    a.doc.destroy(); b.doc.destroy();
  });

  it("names column structure and suppresses cell spans for insertions and reorderings", () => {
    const a = table();
    const reordered = table(CELLS.map((row) => [row[1]!, row[0]!]));
    const inserted = table(CELLS.map((row) => [row[0]!, "extra", row[1]!]));
    expect(compareTables(first(a.doc), first(reordered.doc))).toEqual({ fields: ["columns"], rows: [] });
    expect(compareTables(first(a.doc), first(inserted.doc))).toEqual({ fields: ["columns"], rows: [] });
    a.doc.destroy(); reordered.doc.destroy(); inserted.doc.destroy();
  });

  it("compares saved widths on retained rows without mistaking a new row's defaults for a resize", () => {
    const { doc, id, element } = table();
    for (const cells of tableRows(element)) width(cells[0]!, 200);
    const before = first(doc);
    editBlock(doc, id, getBlock(doc, id)!.text, writeGfmTable([CELLS[0]!, ["Inserted", "0"], CELLS[1]!, CELLS[2]!]), {
      tableMapping: { rows: [0, null, 1, 2], columns: [0, 1] },
    });
    expect(compareTables(before, first(doc)).fields).toEqual([]);
    const withRow = first(doc);
    width(tableRows(element)[0]![0]!, 250);
    const resized = first(doc);
    expect(resized.key).not.toBe(withRow.key);
    expect(compareTables(withRow, resized).fields).toEqual(["columnWidths"]);
    expect(compareTables(withRow, resized).rows.every((row) => row.kind === "unchanged")).toBe(true);
    doc.destroy();
  });

  it("names a surviving column's resize alongside an inserted column", () => {
    const { doc, id, element } = table();
    width(tableRows(element)[0]![0]!, 200);
    const before = first(doc);
    editBlock(doc, id, getBlock(doc, id)!.text, writeGfmTable(CELLS.map((row) => [row[0]!, "extra", row[1]!])), {
      tableMapping: { rows: [0, 1, 2], columns: [0, null, 1] },
    });
    width(tableRows(element)[0]![0]!, 250);
    expect(compareTables(before, first(doc))).toEqual({ fields: ["columns", "columnWidths"], rows: [] });
    doc.destroy();
  });

  it("names formatting and links in a cell without manufacturing word spans", () => {
    const { doc, element } = table();
    const before = first(doc);
    const text = tableCellText(tableRows(element)[1]![0]!)!;
    text.format(0, text.length, { bold: {}, link: { href: "https://example.test" } });
    const result = compareTables(before, first(doc));
    expect(result.rows[1]?.cells?.[0]).toEqual({ column: 0, kind: "changed", spans: [], fields: ["formatting", "link"] });
    doc.destroy();
  });

  it.each([3, 5000])("aligns cell marks with the displayed spans across %i rewritten words", (count) => {
    const oldText = `Start ${"old ".repeat(count)}end`;
    const newText = `Start ${"new ".repeat(count)}end`;
    const { doc, element } = table([["Header"], [oldText]]);
    const text = tableCellText(tableRows(element)[1]![0]!)!;
    text.format(0, text.length, { bold: {} });
    const before = first(doc);
    text.delete(0, text.length);
    text.insert(0, newText, { bold: {} });
    const spans = diffWords(oldText, newText);
    const changed = compareTables(before, first(doc)).rows[1]!.cells![0]!;
    expect(changed).toEqual({ column: 0, kind: "changed", spans, fields: [] });
    if (count === 5000) expect(spans).toEqual([
      { kind: "unchanged", text: "Start " },
      { kind: "removed", text: "old ".repeat(count).trimEnd() },
      { kind: "added", text: "new ".repeat(count).trimEnd() },
      { kind: "unchanged", text: " end" },
    ]);
    else expect(spans).toContainEqual({ kind: "unchanged", text: " " });
    text.format(0, 5, { italic: {} });
    text.format(newText.length - 3, 3, { link: { href: "https://example.test" } });
    expect(compareTables(before, first(doc)).rows[1]!.cells![0]).toEqual({
      column: 0, kind: "changed", spans, fields: ["formatting", "link"],
    });
    doc.destroy();
  });
});

describe("revision inline mark comparison", () => {
  it("tracks mark positions in unchanged text and aligns marks around replaced words", () => {
    const old: InlineRun[] = [{ text: "Alpha", marks: { bold: true } }, { text: " Beta", marks: {} }];
    const replacement: InlineRun[] = [{ text: "Alpine", marks: { bold: true } }, { text: " Beta", marks: {} }];
    expect(inlineChanges(old, replacement, diffWords("Alpha Beta", "Alpine Beta"))).toEqual([]);
    const moved: InlineRun[] = [{ text: "Alpha ", marks: {} }, { text: "Beta", marks: { bold: true } }];
    expect(inlineChanges(old, moved, diffWords("Alpha Beta", "Alpha Beta"))).toEqual(["formatting"]);
    expect(inlineChanges([{ text: "Alpha", marks: {} }], [{ text: "Beta", marks: { bold: true } }], diffWords("Alpha", "Beta"))).toEqual(["formatting"]);
  });

  it("uses the displayed coarse partition when a mark boundary moves inside a rewritten range", () => {
    const before: InlineRun[] = [
      { text: "Start ", marks: {} },
      { text: "old ".repeat(2500), marks: { bold: true } },
      { text: "old ".repeat(2500), marks: {} },
      { text: "end", marks: {} },
    ];
    const after: InlineRun[] = [
      { text: "Start ", marks: {} },
      { text: "new ".repeat(2499), marks: { bold: true } },
      { text: "new ".repeat(2501), marks: {} },
      { text: "end", marks: {} },
    ];
    const spans = diffWords(before.map((run) => run.text).join(""), after.map((run) => run.text).join(""));
    expect(spans.map((span) => span.kind)).toEqual(["unchanged", "removed", "added", "unchanged"]);
    expect(inlineChanges(before, after, spans)).toEqual([]);
  });
});
