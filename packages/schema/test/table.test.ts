import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  InvalidTableError, MarksNotAllowedError, TableAnnotationError,
  addComment, appendBlock, buildTableRow, createAnnotation, editBlock,
  exportMarkdown, findBlockElement, getBlock, getBlocks, getBlocksFragment,
  getBlockText, initDoc, insertBlock, isSupportedTable, listAnnotations,
  normalizeLegacyTables, parseGfmTable, repairDuplicateBlocks,
  resolveAnnotationRange, setAnnotationResolved, setBlockType,
  tableCellText, tableRows, writeGfmTable,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CELLS = [["Name", "Count"], ["Alpha", "1"], ["Beta", "2"]];
const GFM = writeGfmTable(CELLS);

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Tables" });
  return doc;
}

function element(doc: Y.Doc, id: string): Y.XmlElement {
  const found = findBlockElement(doc, id);
  if (found === null) throw new Error("Missing fixture block");
  return found;
}

function legacy(doc: Y.Doc, source: string): string {
  const table = new Y.XmlElement("table");
  const id = crypto.randomUUID();
  table.setAttribute("id", id);
  table.insert(0, [new Y.XmlText(source)]);
  getBlocksFragment(doc).insert(0, [table]);
  return id;
}

describe("structured table contract", () => {
  it("writes canonical TableKit nodes with same-id retyping and no opening repair", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "paragraph", text: GFM });
    setBlockType(doc, id, "table");
    const table = element(doc, id);
    expect(isSupportedTable(table)).toBe(true);
    expect(tableRows(table).map((row) => row.map((cell) => cell.nodeName))).toEqual([
      ["tableHeader", "tableHeader"], ["tableCell", "tableCell"], ["tableCell", "tableCell"],
    ]);
    expect(tableRows(table)[0]?.[0]?.getAttributes()).toEqual({ colspan: 1, rowspan: 1 });
    expect(getBlockText(doc, id)).toBe(GFM);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(normalizeLegacyTables(doc)).toBe(0);
    setBlockType(doc, id, "table");
    expect(updates).toBe(0);
    setBlockType(doc, id, "paragraph");
    expect(getBlock(doc, id)).toMatchObject({ id, type: "paragraph", text: GFM });
  });

  it("round-trips every backslash count next to pipes without interpreting inline markdown", () => {
    for (let count = 0; count < 8; count += 1) {
      const cell = `**literal** ${"\\".repeat(count)}| \\*end\\`;
      const source = writeGfmTable([[cell], [" value "]]);
      expect(parseGfmTable(source)).toMatchObject({ header: [cell], rows: [["value"]] });
      const doc = seeded();
      const id = appendBlock(doc, { type: "table", text: source });
      expect(tableCellText(tableRows(element(doc, id))[0]![0]!)?.toDelta()).toEqual([{ insert: cell }]);
    }
  });

  it("refuses non-table writes, extra blocks and new table threads without an update", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: GFM });
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const separateBlocks = ["# heading", "#", "> quote", "---", "* * *", "_ _ _", "-", "+", "1.", "2. item", "<div>after</div>", "<b>", "<?xml test>", "<!DOCTYPE html>", "<![CDATA[foo]]>", "    indented", "\tindented"];
    for (const bad of ["not a table", "# Heading | h\n--- | ---", "- item | h\n--- | ---", "<div> | h\n--- | ---", "a | b\n- | -", `${GFM}\n\nprose`, ...separateBlocks.map((block) => `${GFM}\n${block}`), GFM.split("\n").map((line) => `    ${line}`).join("\n")]) {
      expect(() => insertBlock(doc, id, { type: "table", text: bad })).toThrow(InvalidTableError);
      expect(() => editBlock(doc, id, GFM, bad)).toThrow(InvalidTableError);
    }
    expect(() => createAnnotation(doc, id, 0, 4, "reader", "why?")).toThrow(TableAnnotationError);
    expect(updates).toBe(0);
    expect(listAnnotations(doc)).toEqual([]);
    expect(getBlocks(doc)).toHaveLength(1);
  });

  it("accepts inline HTML and autolinks as literal cells when they do not start another block", () => {
    const doc = seeded();
    const text = "| Header |\n| --- |\n<b>bold</b>\n<http://example.test>";
    const id = appendBlock(doc, { type: "table", text });
    expect(parseGfmTable(getBlockText(doc, id))?.rows).toEqual([["<b>bold</b>"], ["<http://example.test>"]]);
  });

  it("preserves untouched cell identity, whitespace and marks when editing a neighbour", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: GFM });
    const cells = tableRows(element(doc, id));
    const beta = tableCellText(cells[2]![0]!)!;
    beta.insert(0, " ");
    beta.insert(beta.length, " ");
    beta.format(1, 4, { bold: {} });
    const old = getBlockText(doc, id);
    editBlock(doc, id, old, old.replace("Alpha", "Alpine"));
    expect(tableCellText(tableRows(element(doc, id))[2]![0]!)).toBe(beta);
    expect(beta.toDelta()).toEqual([
      { insert: " " }, { insert: "Beta", attributes: { bold: {} } }, { insert: " " },
    ]);
  });

  it("splices a changed cell rather than replacing its marked text", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: GFM });
    const alpha = tableCellText(tableRows(element(doc, id))[1]![0]!)!;
    alpha.format(0, 5, { italic: {} });
    editBlock(doc, id, GFM, GFM.replace("Alpha", "Alphax"));
    expect(tableCellText(tableRows(element(doc, id))[1]![0]!)).toBe(alpha);
    expect(alpha.toDelta()).toEqual([{ insert: "Alphax", attributes: { italic: {} } }]);
  });

  it("adds and removes rows and columns, including a combined insertion, without rewriting survivors", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: GFM });
    const table = element(doc, id);
    const survivingRows = table.toArray();
    const survivingCells = tableRows(table);
    const beta = tableCellText(survivingCells[2]![0]!)!;
    beta.format(0, 4, { bold: {} });
    const expanded = writeGfmTable([
      ["Name", "Extra", "Count"], ["Inserted", "x", "0"],
      ["Alpha", "y", "1"], ["Beta", "z", "2"],
    ]);
    editBlock(doc, id, GFM, expanded);
    expect(table.toArray()[2]).toBe(survivingRows[1]);
    expect(table.toArray()[3]).toBe(survivingRows[2]);
    expect(tableRows(table)[3]?.[0]).toBe(survivingCells[2]?.[0]);
    expect(tableRows(table)[3]?.[2]).toBe(survivingCells[2]?.[1]);
    expect(beta.toDelta()).toEqual([{ insert: "Beta", attributes: { bold: {} } }]);
    editBlock(doc, id, expanded, GFM);
    expect(table.toArray()).toEqual(survivingRows);
    expect(tableRows(table)).toEqual(survivingCells);
    expect(getBlockText(doc, id)).toBe(GFM);
  });

  it("projects uneven merged rows without hiding cells and fills only requested padded positions", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: GFM });
    const table = element(doc, id);
    table.insert(3, [buildTableRow(["Long", "row", "visible"], false)]);
    expect(isSupportedTable(table)).toBe(true);
    const old = getBlockText(doc, id);
    expect(parseGfmTable(old)).toMatchObject({ header: ["Name", "Count", ""], rows: [["Alpha", "1", ""], ["Beta", "2", ""], ["Long", "row", "visible"]] });
    editBlock(doc, id, old, old.replace("| Alpha | 1 |  |", "| Alpha | 1 | Filled |"));
    expect(tableRows(table).map((row) => row.length)).toEqual([2, 3, 2, 3]);
    expect(parseGfmTable(getBlockText(doc, id))?.rows[0]?.[2]).toBe("Filled");
    expect(exportMarkdown(doc, { frontmatter: false })).toContain("| Long | row | visible |");
  });

  it("identifies inserted columns by body text when the header cells are empty", () => {
    for (const insertRow of [false, true]) {
      const doc = seeded();
      const before = writeGfmTable([["", ""], ["Alpha", "Beta"]]);
      const id = appendBlock(doc, { type: "table", text: before });
      const beta = tableCellText(tableRows(element(doc, id))[1]![1]!)!;
      beta.format(0, 4, { bold: {} });
      const after = writeGfmTable([["", "", ""], ...(insertRow ? [["Inserted", "x", "Row"]] : []), ["Alpha", "New", "Beta"]]);
      editBlock(doc, id, before, after);
      expect(tableCellText(tableRows(element(doc, id))[insertRow ? 2 : 1]![2]!)).toBe(beta);
      expect(beta.toDelta()).toEqual([{ insert: "Beta", attributes: { bold: {} } }]);
      editBlock(doc, id, after, before);
      expect(tableCellText(tableRows(element(doc, id))[1]![1]!)).toBe(beta);
    }
  });

  it("preserves surviving cells when a structural mutation also edits a neighbouring cell", () => {
    for (const rowChange of [false, true]) {
      const doc = seeded();
      const before = writeGfmTable([["", "", ""], ["a1", "b1", "c1"], ["a2", "b2", "c2"]]);
      const id = appendBlock(doc, { type: "table", text: before });
      const oldCells = tableRows(element(doc, id));
      const untouched = tableCellText(oldCells[rowChange ? 1 : 2]![1]!)!;
      untouched.format(0, 2, { bold: {} });
      const after = rowChange
        ? writeGfmTable([["", "", ""], ["Inserted", "New", "Row"], ["changed-a1", "b1", "c1"], ["a2", "b2", "c2"]])
        : writeGfmTable([["", "", "", ""], ["a1", "New", "changed-b1", "c1"], ["a2", "New", "b2", "c2"]]);
      editBlock(doc, id, before, after);
      expect(tableCellText(tableRows(element(doc, id))[2]![rowChange ? 1 : 2]!)).toBe(untouched);
      expect(untouched.toDelta()).toEqual([{ insert: rowChange ? "b1" : "b2", attributes: { bold: {} } }]);
      editBlock(doc, id, after, before);
      expect(tableCellText(tableRows(element(doc, id))[rowChange ? 1 : 2]![1]!)).toBe(untouched);
    }
  });

  it.each(["delete", "insert", "insert-repeated", "delete-and-column"])("preserves repeated untouched cells during a %s and neighbouring text edit", (change) => {
    const rows = [["Task", "Status"], ["Write", "done"], ["Test", "done"], ["Ship", "todo"], ["Fix", "todo"]];
    const before = writeGfmTable(rows);
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Tables" });
      id = appendBlock(doc, { type: "table", text: before });
      tableCellText(tableRows(element(doc, id))[2]![1]!)!.format(0, 4, { italic: {} });
      tableCellText(tableRows(element(doc, id))[3]![1]!)!.format(0, 4, { bold: {} });
    });
    const shipA = tableCellText(tableRows(element(a, id))[3]![1]!)!;
    const shipB = tableCellText(tableRows(element(b, id))[3]![1]!)!;
    shipB.insert(shipB.length, " (blocked)");
    const nextRows = rows.map((row) => row.slice());
    nextRows[3]![0] = "Ship2";
    const insertion = change.startsWith("insert");
    if (insertion) nextRows.splice(3, 0, ["Audit", change === "insert-repeated" ? "todo" : "later"]);
    else nextRows.splice(2, 1);
    if (change === "delete-and-column") nextRows.forEach((row, index) => { row.splice(1, 0, index === 0 ? "Owner" : "team"); });
    const shipRow = insertion ? 4 : 2;
    const statusColumn = change === "delete-and-column" ? 2 : 1;
    editBlock(a, id, before, writeGfmTable(nextRows));
    expect(tableCellText(tableRows(element(a, id))[shipRow]![statusColumn]!)).toBe(shipA);
    expect(shipA.toDelta()).toEqual([{ insert: "todo", attributes: { bold: {} } }]);
    syncDocs(a, b);
    expect(getBlockText(a, id)).toBe(getBlockText(b, id));
    expect(getBlockText(a, id)).toContain("todo (blocked)");
    expect(tableCellText(tableRows(element(a, id))[shipRow]![statusColumn]!)).toBe(shipA);
    expect(tableCellText(tableRows(element(b, id))[shipRow]![statusColumn]!)).toBe(shipB);
    expect(shipA.toDelta()).toEqual([{ insert: "todo (blocked)", attributes: { bold: {} } }]);
    a.destroy();
    b.destroy();
  });

  it("preserves repeated untouched column cells when deleting a column and renaming its neighbour", () => {
    const rows = [["Write", "Test", "Ship", "Fix"], ["done", "done", "todo", "todo"], ["no", "no", "yes", "yes"]];
    const before = writeGfmTable(rows);
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Tables" });
      id = appendBlock(doc, { type: "table", text: before });
      tableCellText(tableRows(element(doc, id))[1]![1]!)!.format(0, 4, { italic: {} });
      tableCellText(tableRows(element(doc, id))[1]![2]!)!.format(0, 4, { bold: {} });
    });
    const ship = tableCellText(tableRows(element(a, id))[1]![2]!)!;
    const concurrentShip = tableCellText(tableRows(element(b, id))[1]![2]!)!;
    concurrentShip.insert(concurrentShip.length, " (blocked)");
    editBlock(a, id, before, writeGfmTable([["Write", "Ship2", "Fix"], ["done", "todo", "todo"], ["no", "yes", "yes"]]));
    expect(tableCellText(tableRows(element(a, id))[1]![1]!)).toBe(ship);
    syncDocs(a, b);
    expect(getBlockText(a, id)).toBe(getBlockText(b, id));
    expect(tableCellText(tableRows(element(b, id))[1]![1]!)).toBe(concurrentShip);
    expect(ship.toDelta()).toEqual([{ insert: "todo (blocked)", attributes: { bold: {} } }]);
    a.destroy();
    b.destroy();
  });

  it("keeps different-cell and same-cell concurrent typing on shared text types", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => { initDoc(doc, { uuid: UUID, title: "Tables" }); id = appendBlock(doc, { type: "table", text: GFM }); });
    editBlock(a, id, GFM, GFM.replace("Alpha", "Alpha A"));
    editBlock(b, id, GFM, GFM.replace("Beta", "Beta B"));
    syncDocs(a, b);
    expect(getBlockText(a, id)).toBe(getBlockText(b, id));
    expect(getBlockText(a, id)).toContain("Alpha A");
    expect(getBlockText(a, id)).toContain("Beta B");
    const shared = getBlockText(a, id);
    editBlock(a, id, shared, shared.replace("Alpha A", "X Alpha A"));
    editBlock(b, id, shared, shared.replace("Alpha A", "Alpha A Y"));
    syncDocs(a, b);
    expect(getBlockText(a, id)).toBe(getBlockText(b, id));
    expect(getBlockText(a, id)).toContain("X Alpha A Y");
  });

  it("shares the stored empty text across concurrent first agent writes and a delayed third writer", () => {
    const before = writeGfmTable([["", ""], ["", ""], ["", ""]]);
    let id = "";
    const [a, b] = replicaPair((doc) => { initDoc(doc, { uuid: UUID, title: "Tables" }); id = appendBlock(doc, { type: "table", text: before }); });
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    const texts = [a, b, c].map((doc) => {
      const paragraph = tableRows(element(doc, id))[1]![0]!.firstChild as Y.XmlElement;
      expect(paragraph.toArray()).toHaveLength(1);
      expect(paragraph.firstChild).toBeInstanceOf(Y.XmlText);
      expect((paragraph.firstChild as Y.XmlText).length).toBe(0);
      return paragraph.firstChild;
    });
    for (const [doc, value] of [[a, "agentA"], [b, "agentB"], [c, "agentC"]] as const) {
      editBlock(doc, id, before, writeGfmTable([["", ""], [value, ""], ["", ""]]));
    }
    syncDocs(a, b);
    const observed = getBlockText(a, id);
    editBlock(a, id, observed, observed.replace("agentA", "agentA updated").replace("|  |  |\n", "| Header |  |\n"));
    syncDocs(a, b);
    // C's first write was absent when A edited the already-merged table.
    syncDocs(a, c);
    syncDocs(a, b);
    const canonical = getBlockText(a, id);
    for (const [index, doc] of [a, b, c].entries()) {
      expect(getBlockText(doc, id)).toBe(canonical);
      const paragraph = tableRows(element(doc, id))[1]![0]!.firstChild as Y.XmlElement;
      expect(paragraph.toArray()).toEqual([texts[index]]);
      expect(isSupportedTable(element(doc, id))).toBe(true);
      const markdown = exportMarkdown(doc, { frontmatter: false });
      for (const word of ["agentA", "agentB", "agentC", "updated", "Header"]) {
        expect(canonical).toContain(word);
        expect(markdown).toContain(word);
      }
      let updates = 0;
      doc.on("update", () => { updates += 1; });
      expect(normalizeLegacyTables(doc)).toBe(0);
      expect(updates).toBe(0);
      doc.destroy();
    }
  });

  it("reads every malformed text child while refusing binding and marked retyping without writes", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: GFM });
    const table = element(doc, id);
    const paragraph = tableRows(table)[1]![0]!.firstChild as Y.XmlElement;
    const extra = new Y.XmlText("Suffix");
    paragraph.insert(1, [extra]);
    extra.format(0, extra.length, { bold: {} });
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(isSupportedTable(table)).toBe(false);
    expect(getBlockText(doc, id)).toContain("AlphaSuffix");
    expect(exportMarkdown(doc, { frontmatter: false })).toContain("Alpha**Suffix**");
    expect(() => setBlockType(doc, id, "paragraph")).toThrow(MarksNotAllowedError);
    expect(normalizeLegacyTables(doc)).toBe(0);
    expect(updates).toBe(0);
    doc.destroy();
  });

  it("converges a concurrent row addition and column addition without squaring or repair loops", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => { initDoc(doc, { uuid: UUID, title: "Tables" }); id = appendBlock(doc, { type: "table", text: GFM }); });
    editBlock(a, id, GFM, writeGfmTable([...CELLS, ["Added", "3"]]));
    editBlock(b, id, GFM, writeGfmTable(CELLS.map((row) => [...row, "Column"])));
    syncDocs(a, b);
    expect(tableRows(element(a, id)).map((row) => row.length)).toEqual([3, 3, 3, 2]);
    expect(getBlockText(a, id)).toBe(getBlockText(b, id));
    expect(isSupportedTable(element(a, id))).toBe(true);
    let updates = 0;
    a.on("update", () => { updates += 1; });
    for (let pass = 0; pass < 3; pass += 1) { normalizeLegacyTables(a); repairDuplicateBlocks(a); syncDocs(a, b); }
    expect(updates).toBe(0);
    expect(tableRows(element(b, id)).map((row) => row.length)).toEqual([3, 3, 3, 2]);
  });

  it("normalizes concurrent legacy converters to one same-id table and leaves other content alone", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => { initDoc(doc, { uuid: UUID, title: "Tables" }); id = legacy(doc, GFM); appendBlock(doc, { type: "paragraph", text: "Unrelated" }); });
    normalizeLegacyTables(a);
    normalizeLegacyTables(b);
    syncDocs(a, b);
    repairDuplicateBlocks(a);
    repairDuplicateBlocks(b);
    syncDocs(a, b);
    expect(getBlocks(a).map((block) => [block.id, block.type, block.text])).toEqual(getBlocks(b).map((block) => [block.id, block.type, block.text]));
    expect(getBlocks(a)).toHaveLength(2);
    expect(getBlocks(a)[0]).toMatchObject({ id, type: "table", text: GFM });
    expect(getBlocks(a)[1]?.text).toBe("Unrelated");
    expect(getBlocksFragment(a).length).toBe(2);
  });

  it("drops only valid legacy table anchors, preserves conversations and keeps invalid source anchors in code", () => {
    const doc = seeded();
    const id = legacy(doc, GFM);
    // Legacy opening happened before the new schema refused table threads.
    const source = element(doc, id).firstChild as Y.XmlText;
    const paragraphId = appendBlock(doc, { type: "paragraph", text: GFM });
    const thread = createAnnotation(doc, paragraphId, 2, 6, "reader", "Existing");
    const threadMap = doc.getMap("annotations").get(thread.id) as Y.Map<unknown>;
    threadMap.set("blockId", id);
    source.format(2, 4, { comment: { threadId: thread.id } });
    normalizeLegacyTables(doc);
    expect(resolveAnnotationRange(doc, thread.id)).toBeNull();
    expect(addComment(doc, thread.id, "writer", "Reply")?.comments).toHaveLength(2);
    expect(setAnnotationResolved(doc, thread.id, true)?.resolved).toBe(true);
    expect(setAnnotationResolved(doc, thread.id, false)?.resolved).toBe(false);

    const invalid = legacy(doc, "Unparseable source");
    const invalidThread = createAnnotation(doc, paragraphId, 8, 12, "reader", "Other");
    const invalidMap = doc.getMap("annotations").get(invalidThread.id) as Y.Map<unknown>;
    invalidMap.set("blockId", invalid);
    (element(doc, invalid).firstChild as Y.XmlText).format(1, 4, { comment: { threadId: invalidThread.id } });
    normalizeLegacyTables(doc);
    expect(getBlock(doc, invalid)).toMatchObject({ id: invalid, type: "code", text: "Unparseable source" });
    expect(resolveAnnotationRange(doc, invalidThread.id)).toMatchObject({ start: 1, end: 5 });
  });

  it("removes stray direct text from structured tables without rewriting their rows", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: GFM });
    const table = element(doc, id);
    const rows = table.toArray();
    table.insert(0, [new Y.XmlText("Old process text")]);
    normalizeLegacyTables(doc);
    expect(table.toArray()).toEqual(rows);
    expect(getBlockText(doc, id)).toBe(GFM);
  });

  it("refuses table retyping when it would silently drop cell marks or prose anchors", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: GFM });
    tableCellText(tableRows(element(doc, id))[1]![0]!)!.format(0, 5, { bold: {} });
    expect(() => setBlockType(doc, id, "paragraph")).toThrow(MarksNotAllowedError);
    expect(getBlock(doc, id)?.type).toBe("table");
    const prose = appendBlock(doc, { type: "paragraph", text: GFM });
    createAnnotation(doc, prose, 2, 6, "reader", "Anchor");
    expect(() => setBlockType(doc, prose, "table")).toThrow(MarksNotAllowedError);
    expect(getBlock(doc, prose)?.type).toBe("paragraph");
  });

  it("exports cell marks as inline markdown while escaping literal punctuation, HTML and pipes", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "table", text: writeGfmTable([["Header"], ["**literal** <b> &amp; \\|"], ["Bold"], ["a\\|b"]]) });
    const rows = tableRows(element(doc, id));
    tableCellText(rows[2]![0]!)!.format(0, 4, { bold: {} });
    tableCellText(rows[3]![0]!)!.format(0, 4, { inlineCode: {} });
    expect(exportMarkdown(doc, { frontmatter: false })).toBe([
      "| Header |", "| --- |", "| \\*\\*literal\\*\\* \\<b\\> \\&amp; \\\\\\| |",
      "| **Bold** |", "| `a\\\\|b` |", "",
    ].join("\n"));
  });
});
