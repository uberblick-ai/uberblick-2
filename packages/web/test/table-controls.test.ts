/** Structural actions use TableKit, shared row identity and independent undo. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import { appendBlock, createAnnotation, deleteBlock, editBlock, getBlocks, initDoc, listAnnotations, resolveAnnotationRange } from "@uberblick/schema";
import { actOnTable, resolveTableRow, tableRowTarget } from "../src/editor/table-controls.js";
import type { TableAction, TableRowTarget } from "../src/editor/table-controls.js";
import { mountEditor } from "./helpers.js";

const SOURCE = "| A | B |\n| --- | --- |\n| alpha | one |\n| beta | two |";
const ACTIONS: TableAction[] = ["row-before", "row-after", "row-delete", "column-before", "column-after"];

function fixture(source = SOURCE): {
  a: Y.Doc;
  b: Y.Doc;
  id: string;
  editor: ReturnType<typeof mountEditor>["editor"];
  close: () => void;
} {
  const a = new Y.Doc();
  initDoc(a, { uuid: "table-controls", title: "Tables" });
  const id = appendBlock(a, { type: "table", text: source });
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const { editor } = mountEditor(a);
  return { a, b, id, editor, close: () => { editor.destroy(); a.destroy(); b.destroy(); } };
}

function targetOf(editor: ReturnType<typeof mountEditor>["editor"], id: string, row: number): TableRowTarget {
  const target = tableRowTarget(editor, id, row);
  expect(target).not.toBeNull();
  return target!;
}

function cells(editor: ReturnType<typeof mountEditor>["editor"]): string[][] {
  const table = editor.state.doc.child(0);
  return Array.from({ length: table.childCount }, (_, row) => {
    const node = table.child(row);
    return Array.from({ length: node.childCount }, (_, column) => node.child(column).textContent);
  });
}

describe("table structural controls", () => {
  it("moves a cell thread with its duplicate-text cell through insertions and orphans it when its row is deleted", () => {
    const f = fixture("| Same | Same |\n| --- | --- |\n| Same | Same |\n| Same | Same |");
    try {
      const thread = createAnnotation(f.a, f.id, 1, 3, "Reader", "Keep this cell", { row: 1, column: 1 });
      const target = targetOf(f.editor, f.id, 1);
      const anchoredAt = (row: number, column: number): void => {
        Y.applyUpdate(f.b, Y.encodeStateAsUpdate(f.a));
        for (const doc of [f.a, f.b]) {
          expect(resolveAnnotationRange(doc, thread.id)).toEqual({ row, column, start: 1, end: 3, collapsed: false });
        }
        const highlight = f.editor.view.dom.querySelector(`[data-comment-thread="${thread.id}"]`)!;
        expect(highlight.textContent).toBe("am");
        expect(highlight.closest("tr")).toBe(f.editor.view.dom.querySelectorAll("tr")[row]);
        expect(highlight.closest("td, th")).toBe(highlight.closest("tr")!.children[column]);
      };
      expect(actOnTable(f.editor, target, 1, "row-before")).toBe(true);
      anchoredAt(2, 1);
      expect(actOnTable(f.editor, target, 1, "column-before")).toBe(true);
      anchoredAt(2, 2);
      expect(actOnTable(f.editor, target, 2, "row-delete")).toBe(true);
      Y.applyUpdate(f.b, Y.encodeStateAsUpdate(f.a));
      for (const doc of [f.a, f.b]) {
        expect(resolveAnnotationRange(doc, thread.id)).toBeNull();
        expect(listAnnotations(doc).map((annotation) => annotation.id)).toContain(thread.id);
      }
      expect(f.editor.view.dom.querySelector(`[data-comment-thread="${thread.id}"]`)).toBeNull();
    } finally { f.close(); }
  });

  it.each([
    ["column-before", 0], ["column-after", 0], ["column-before", 1], ["column-after", 1],
  ] as const)("inserts %s at column %i in a header-only table as an undoable shared edit", (action, column) => {
    const f = fixture("| A | B |\n| --- | --- |");
    try {
      const target = targetOf(f.editor, f.id, 0);
      let updates = 0;
      f.a.on("update", () => { updates += 1; });
      expect(actOnTable(f.editor, target, column, action)).toBe(true);
      expect(updates).toBeGreaterThan(0);
      const expected = column + (action === "column-after" ? 1 : 0);
      const row = ["A", "B"];
      row.splice(expected, 0, "");
      expect(cells(f.editor)).toEqual([row]);
      f.editor.state.doc.child(0).child(0).forEach((cell) => { expect(cell.type.name).toBe("tableHeader"); });
      Y.applyUpdate(f.b, Y.encodeStateAsUpdate(f.a));
      expect(getBlocks(f.b)).toEqual(getBlocks(f.a));
      expect(undo(f.editor.state)).toBe(true);
      expect(cells(f.editor)).toEqual([["A", "B"]]);
    } finally { f.close(); }
  });

  it.each(["column-before", "column-after"] as const)("extends a single-column header-only table with %s", (action) => {
    const f = fixture("| A |\n| --- |");
    try {
      expect(actOnTable(f.editor, targetOf(f.editor, f.id, 0), 0, action)).toBe(true);
      expect(cells(f.editor)).toEqual([action === "column-before" ? ["", "A"] : ["A", ""]]);
      f.editor.state.doc.child(0).child(0).forEach((cell) => { expect(cell.type.name).toBe("tableHeader"); });
    } finally { f.close(); }
  });

  it.each([[0, "row-after"], [1, "row-before"], [1, "row-after"], [2, "row-before"], [2, "row-after"]] as const)(
    "inserts beside row %i with %s, retaining one header and a cell in every column",
    (rowIndex, action) => {
      const f = fixture();
      try {
        const target = targetOf(f.editor, f.id, rowIndex);
        expect(actOnTable(f.editor, target, 1, action)).toBe(true);
        const expected = [["A", "B"], ["alpha", "one"], ["beta", "two"]];
        expected.splice(rowIndex + (action === "row-after" ? 1 : 0), 0, ["", ""]);
        expect(cells(f.editor)).toEqual(expected);
        f.editor.state.doc.child(0).forEach((row, _offset, index) => {
          row.forEach((cell) => { expect(cell.type.name).toBe(index === 0 ? "tableHeader" : "tableCell"); });
        });
      } finally { f.close(); }
    },
  );

  it("protects the header while allowing deletion of the final body row", () => {
    const f = fixture("| A | B |\n| --- | --- |\n| alpha | one |");
    try {
      const header = targetOf(f.editor, f.id, 0);
      let updates = 0;
      f.a.on("update", () => { updates += 1; });
      const selection = f.editor.state.selection.toJSON();
      expect(actOnTable(f.editor, header, 0, "row-before")).toBe(false);
      expect(actOnTable(f.editor, header, 0, "row-delete")).toBe(false);
      expect(f.editor.state.selection.toJSON()).toEqual(selection);
      expect(updates).toBe(0);
      expect(actOnTable(f.editor, targetOf(f.editor, f.id, 1), 0, "row-delete")).toBe(true);
      expect(cells(f.editor)).toEqual([["A", "B"]]);
      expect(actOnTable(f.editor, header, 1, "column-after")).toBe(true);
      expect(cells(f.editor)).toEqual([["A", "B", ""]]);
    } finally { f.close(); }
  });

  it.each(ACTIONS)("isolates %s from typing before and after it", (action) => {
    const f = fixture();
    try {
      const original = getBlocks(f.a);
      const target = targetOf(f.editor, f.id, 1);
      const live = resolveTableRow(f.editor, target)!;
      f.editor.commands.setTextSelection(live.rowPos + 3);
      f.editor.view.dispatch(f.editor.state.tr.insertText("before"));
      const before = getBlocks(f.a);
      expect(actOnTable(f.editor, target, 0, action)).toBe(true);
      const changed = getBlocks(f.a);
      expect(changed).not.toEqual(before);
      // No artificial timeout or test-owned capture boundary separates these.
      f.editor.view.dispatch(f.editor.state.tr.insertText("after"));
      expect(getBlocks(f.a)).not.toEqual(changed);
      expect(undo(f.editor.state)).toBe(true);
      expect(getBlocks(f.a)).toEqual(changed);
      expect(undo(f.editor.state)).toBe(true);
      expect(getBlocks(f.a)).toEqual(before);
      expect(undo(f.editor.state)).toBe(true);
      expect(getBlocks(f.a)).toEqual(original);
    } finally { f.close(); }
  });

  it("keeps its row through remote cell edits and insertion before it", () => {
    const f = fixture();
    try {
      const target = targetOf(f.editor, f.id, 2);
      const edited = SOURCE.replace("beta", "edited beta");
      editBlock(f.b, f.id, SOURCE, edited);
      Y.applyUpdate(f.a, Y.encodeStateAsUpdate(f.b));
      expect(resolveTableRow(f.editor, target)?.rowIndex).toBe(2);
      const expanded = edited.replace("| alpha | one |", "| new | row |\n| alpha | one |");
      editBlock(f.b, f.id, edited, expanded, { tableMapping: { rows: [0, null, 1, 2], columns: [0, 1] } });
      Y.applyUpdate(f.a, Y.encodeStateAsUpdate(f.b));
      expect(resolveTableRow(f.editor, target)?.rowIndex).toBe(3);
      expect(actOnTable(f.editor, target, 0, "row-delete")).toBe(true);
      expect(cells(f.editor)).toEqual([["A", "B"], ["new", "row"], ["alpha", "one"]]);
    } finally { f.close(); }
  });

  it.each(["row", "table"])("refuses a target whose %s was remotely deleted", (deleted) => {
    const f = fixture();
    try {
      const target = targetOf(f.editor, f.id, 1);
      if (deleted === "row") {
        editBlock(f.b, f.id, SOURCE, "| A | B |\n| --- | --- |\n| beta | two |", {
          tableMapping: { rows: [0, 2], columns: [0, 1] },
        });
      } else deleteBlock(f.b, f.id);
      Y.applyUpdate(f.a, Y.encodeStateAsUpdate(f.b));
      expect(resolveTableRow(f.editor, target)).toBeNull();
      const before = getBlocks(f.a);
      let updates = 0;
      f.a.on("update", () => { updates += 1; });
      for (const action of ACTIONS) expect(actOnTable(f.editor, target, 0, action)).toBe(false);
      expect(getBlocks(f.a)).toEqual(before);
      expect(updates).toBe(0);
    } finally { f.close(); }
  });

  it("offers no targets or writes after becoming read-only", () => {
    const f = fixture();
    try {
      const target = targetOf(f.editor, f.id, 1);
      f.editor.setEditable(false);
      expect(tableRowTarget(f.editor, f.id, 1)).toBeNull();
      expect(resolveTableRow(f.editor, target)).toBeNull();
      const before = getBlocks(f.a);
      let updates = 0;
      f.a.on("update", () => { updates += 1; });
      for (const action of ACTIONS) expect(actOnTable(f.editor, target, 0, action)).toBe(false);
      expect(getBlocks(f.a)).toEqual(before);
      expect(updates).toBe(0);
    } finally { f.close(); }
  });

  it("refuses every structural action after a ragged concurrent merge while cells remain editable", () => {
    const source = "| A | B |\n| --- | --- |\n| alpha | one |";
    const f = fixture(source);
    try {
      const target = targetOf(f.editor, f.id, 1);
      expect(actOnTable(f.editor, target, 0, "row-after")).toBe(true);
      editBlock(f.b, f.id, source, "| A | B | extra |\n| --- | --- | --- |\n| alpha | one | new |", {
        tableMapping: { rows: [0, 1], columns: [0, 1, null] },
      });
      Y.applyUpdate(f.a, Y.encodeStateAsUpdate(f.b));
      expect(cells(f.editor).map((row) => row.length)).toEqual([3, 3, 2]);
      for (let row = 0; row < 3; row += 1) expect(tableRowTarget(f.editor, f.id, row)).toBeNull();
      expect(resolveTableRow(f.editor, target)).toBeNull();
      let updates = 0;
      f.a.on("update", () => { updates += 1; });
      for (const action of ACTIONS) expect(actOnTable(f.editor, target, 0, action)).toBe(false);
      expect(updates).toBe(0);
      f.editor.commands.setTextSelection(4);
      f.editor.view.dispatch(f.editor.state.tr.insertText("still editable "));
      expect(updates).toBe(1);
      expect(cells(f.editor)[0]?.[0]).toBe("still editable A");
      expect(cells(f.editor).map((row) => row.length)).toEqual([3, 3, 2]);
    } finally { f.close(); }
  });
});
