/** Framework column drags remain shared, undoable edits under live permissions. */
import { describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/core";
import { columnResizingPluginKey } from "@tiptap/pm/tables";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import { appendBlock, createAnnotation, deleteBlock, getBlocks, getBlocksFragment, initDoc, tableCellText, tableRows } from "@uberblick/schema";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { findForeignBlocks } from "../src/editor/palette.js";
import { isOrdinaryTable } from "../src/editor/table.js";
import { mountEditor } from "./helpers.js";

const SOURCE = "| A | B |\n| --- | --- |\n| alpha | bravo |";

function fixture(): { ydoc: Y.Doc; id: string; table: Y.XmlElement } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "table-resize", title: "Tables" });
  const id = appendBlock(ydoc, { type: "table", text: SOURCE });
  const table = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
  ydoc.transact(() => {
    for (const row of tableRows(table)) {
      row[0]!.setAttribute("colwidth", [180] as unknown as string);
      row[1]!.setAttribute("colwidth", [220] as unknown as string);
    }
  });
  return { ydoc, id, table };
}

function widths(table: Y.XmlElement): unknown[][] {
  return tableRows(table).map((row) => row.map((cell) => cell.getAttribute("colwidth")));
}

function firstCell(editor: Editor): number {
  let position = -1;
  editor.state.doc.descendants((node, pos) => {
    if (position < 0 && node.type.name === "tableHeader") position = pos;
  });
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
}

/** Bypass hit testing only; the framework owns the drag and the stored edit. */
function startDrag(editor: Editor, x = 180): void {
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: firstCell(editor) }));
  expect(editor.view.dom.querySelector(".column-resize-handle")).not.toBeNull();
  editor.view.dom.querySelector("th")!.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true, cancelable: true, clientX: x, button: 0,
  }));
  expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeTruthy();
}

function moveDrag(x: number): void {
  const event = new MouseEvent("mousemove", { bubbles: true, clientX: x, buttons: 1 });
  Object.defineProperty(event, "which", { value: 1 });
  window.dispatchEvent(event);
}

function finishDrag(x: number): void {
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, button: 0 }));
}

describe("table column resizing", () => {
  it("accepts saved widths and changes only the dragged column, preserving shared content and highlights", () => {
    const f = fixture();
    const rows = tableRows(f.table);
    tableCellText(rows[1]![0]!)!.format(0, 3, { bold: {}, link: { href: "https://example.test/table" } });
    const thread = createAnnotation(f.ydoc, f.id, 1, 3, "Reader", "Keep this", { row: 1, column: 0 });
    const before = rows.map((row) => row.map((cell) => ({ cell, text: tableCellText(cell)!.toDelta() })));
    const { editor } = mountEditor(f.ydoc);
    try {
      expect(findForeignBlocks(getBlocksFragment(f.ydoc))).toEqual([]);
      expect(isOrdinaryTable(editor.state.doc.child(0))).toBe(true);
      startDrag(editor);
      moveDrag(260);
      expect(widths(f.table)).toEqual([[[180], [220]], [[180], [220]]]);
      expect(editor.view.dom.querySelector("col")!.style.width).toBe("260px");
      finishDrag(260);
      expect(widths(f.table)).toEqual([[[260], [220]], [[260], [220]]]);
      expect(tableRows(f.table).map((row) => row.map((cell) => ({ cell, text: tableCellText(cell)!.toDelta() })))).toEqual(before);
      expect(editor.view.dom.querySelector(`[data-comment-thread="${thread.id}"]`)!.textContent).toBe("lp");
      expect(editor.view.dom.querySelector("a")!.getAttribute("href")).toBe("https://example.test/table");
      expect(findForeignBlocks(getBlocksFragment(f.ydoc))).toEqual([]);
      editor.commands.setTextSelection(firstCell(editor) + 2);
      editor.view.dispatch(editor.state.tr.insertText("kept "));
      expect(getBlocks(f.ydoc)[0]?.text).toContain("| kept A | B |");
      expect(widths(f.table)).toEqual([[[260], [220]], [[260], [220]]]);
    } finally { editor.destroy(); f.ydoc.destroy(); }
  });

  it("cancels a drag when editing becomes unavailable and restores its unsaved preview", () => {
    const f = fixture();
    const { editor } = mountEditor(f.ydoc);
    try {
      startDrag(editor);
      moveDrag(300);
      expect(editor.view.dom.querySelector("col")!.style.width).toBe("300px");
      editor.setEditable(false);
      expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(-1);
      expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeFalsy();
      expect(editor.view.dom.querySelector(".column-resize-handle")).toBeNull();
      expect(editor.view.dom.classList.contains("resize-cursor")).toBe(false);
      expect(editor.view.dom.querySelector("col")!.style.width).toBe("180px");
      finishDrag(300);
      expect(widths(f.table)).toEqual([[[180], [220]], [[180], [220]]]);
      editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: firstCell(editor) }));
      expect(editor.view.dom.querySelector(".column-resize-handle")).toBeNull();
      editor.setEditable(true);
      startDrag(editor);
      finishDrag(240);
      expect(widths(f.table)).toEqual([[[240], [220]], [[240], [220]]]);
    } finally { finishDrag(180); editor.destroy(); f.ydoc.destroy(); }
  });

  it.each(["removed", "ragged"] as const)("cancels a drag when a collaborator leaves its table %s", (change) => {
    const f = fixture();
    appendBlock(f.ydoc, { type: "paragraph", text: "tail" });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(f.ydoc));
    const { editor } = mountEditor(f.ydoc);
    const errors: ErrorEvent[] = [];
    const onError = (event: ErrorEvent): void => { errors.push(event); event.preventDefault(); };
    window.addEventListener("error", onError);
    try {
      startDrag(editor);
      moveDrag(300);
      if (change === "removed") deleteBlock(remote, f.id);
      else ((getBlocksFragment(remote).get(0) as Y.XmlElement).get(1) as Y.XmlElement).delete(1, 1);
      Y.applyUpdate(f.ydoc, Y.encodeStateAsUpdate(remote));
      expect(columnResizingPluginKey.getState(editor.state)?.activeHandle).toBe(-1);
      expect(columnResizingPluginKey.getState(editor.state)?.dragging).toBeFalsy();
      expect(editor.view.dom.querySelector(".column-resize-handle")).toBeNull();
      const before = getBlocks(f.ydoc);
      let writes = 0;
      f.ydoc.on("update", () => { writes += 1; });
      expect(() => finishDrag(300)).not.toThrow();
      expect(errors).toEqual([]);
      expect(writes).toBe(0);
      expect(getBlocks(f.ydoc)).toEqual(before);
      editor.commands.setTextSelection(editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize + 1);
      editor.view.dispatch(editor.state.tr.insertText("kept "));
      expect(getBlocks(f.ydoc).at(-1)?.text).toBe("kept tail");
      expect(writes).toBe(1);
      if (change === "ragged") expect(widths(f.table)).toEqual([[[180], [220]], [[180]]]);
    } finally {
      finishDrag(180);
      window.removeEventListener("error", onError);
      editor.destroy(); f.ydoc.destroy(); remote.destroy();
    }
  });

  it("keeps a resize in its own undo step and preserves collaborator edits on both clients", () => {
    const f = fixture();
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(f.ydoc));
    const { editor } = mountEditor(f.ydoc);
    const { editor: other } = mountEditor(remote);
    try {
      editor.commands.setTextSelection(firstCell(editor) + 2);
      editor.view.dispatch(editor.state.tr.insertText("before "));
      startDrag(editor);
      finishDrag(280);
      editor.view.dispatch(editor.state.tr.insertText("after "));
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(f.ydoc));
      const remoteTable = getBlocksFragment(remote).get(0) as Y.XmlElement;
      tableCellText(tableRows(remoteTable)[1]![1]!)!.insert(0, "remote ");
      Y.applyUpdate(f.ydoc, Y.encodeStateAsUpdate(remote));
      expect(widths(remoteTable)).toEqual([[[280], [220]], [[280], [220]]]);
      expect(getBlocks(f.ydoc)[0]?.text).toContain("| before after A | B |");
      expect(undo(editor.state)).toBe(true);
      expect(getBlocks(f.ydoc)[0]?.text).toContain("| before A | B |");
      expect(widths(f.table)).toEqual([[[280], [220]], [[280], [220]]]);
      expect(undo(editor.state)).toBe(true);
      expect(widths(f.table)).toEqual([[[180], [220]], [[180], [220]]]);
      expect(getBlocks(f.ydoc)[0]?.text).toContain("| before A | B |");
      expect(getBlocks(f.ydoc)[0]?.text).toContain("| alpha | remote bravo |");
      expect(undo(editor.state)).toBe(true);
      expect(getBlocks(f.ydoc)[0]?.text).toContain("| A | B |");
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(f.ydoc));
      expect(getBlocks(remote)).toEqual(getBlocks(f.ydoc));
      expect(widths(remoteTable)).toEqual(widths(f.table));
      expect(other.state.doc.toJSON()).toEqual(editor.state.doc.toJSON());
    } finally { finishDrag(180); editor.destroy(); other.destroy(); f.ydoc.destroy(); remote.destroy(); }
  });

  it("installs resizing for an initially read-only editor and preserves the table view's identity", () => {
    const f = fixture();
    const element = document.createElement("div");
    document.body.appendChild(element);
    const editor = createUberblickEditor({ element, fragment: getBlocksFragment(f.ydoc), editable: false });
    try {
      const table = editor.view.dom.querySelector("table")!;
      expect(table.classList.contains("ub-table")).toBe(true);
      expect(table.getAttribute("data-block-type")).toBe("table");
      expect(table.id).toBe(f.id);
      expect(table.querySelector("col")!.style.width).toBe("180px");
      expect(editor.view.dom.querySelector(".column-resize-handle")).toBeNull();
      editor.setEditable(true);
      startDrag(editor);
      finishDrag(250);
      expect(widths(f.table)).toEqual([[[250], [220]], [[250], [220]]]);
      editor.view.dispatch(editor.state.tr.setNodeAttribute(0, "id", "replacement-table"));
      expect(editor.view.dom.querySelector("table")).toBe(table);
      expect(table.id).toBe("replacement-table");
      expect(table.classList.contains("ub-table")).toBe(true);
      expect(table.getAttribute("data-block-type")).toBe("table");
    } finally { finishDrag(180); editor.destroy(); element.remove(); f.ydoc.destroy(); }
  });
});
