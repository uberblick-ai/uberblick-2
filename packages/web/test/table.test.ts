/** Structured tables: GFM doors, direct cell edits, and CRDT merges. */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  editBlock,
  exportMarkdown,
  getBlockInline,
  getBlocks,
  importMarkdown,
  initDoc,
  listAnnotationRanges,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { getBlocksFragment, tableRows, tableCellText } from "@uberblick/schema";
import { commentTargetOf } from "../src/editor/selection.js";
import { BLOCK_MENU_ENTRIES, convertBlockAtTrigger, insertBlockBelow, slashTriggerAt } from "../src/editor/block-menu.js";
import { findForeignBlocks } from "../src/editor/palette.js";
import { mountEditor } from "./helpers.js";

const HEADER = "| name | count |";
const DELIMITER = "| --- | --- |";

function docWith(texts: string[]): { ydoc: Y.Doc; ids: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "table-doc", title: "Tables" });
  const ids = texts.map((text) => appendBlock(ydoc, { type: "paragraph", text }));
  return { ydoc, ids };
}

/** One keypress, delivered the way prosemirror-view delivers one. */
function press(editor: Editor, char: string): void {
  const { view } = editor;
  const { from, to } = view.state.selection;
  const deflt = (): ReturnType<typeof view.state.tr.insertText> =>
    view.state.tr.insertText(char, from, to);
  if (!view.someProp("handleTextInput", (f) => f(view, from, to, char, deflt))) {
    view.dispatch(deflt());
  }
}

function type(editor: Editor, text: string): void {
  for (const char of text) press(editor, char);
}

function caret(editor: Editor, index: number, offset: number): void {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  editor.commands.setTextSelection(pos + offset);
}

/** The cell texts of the drawn table, header row first. */
function drawn(editor: Editor): string[][] {
  const table = editor.view.dom.querySelector(".ub-table");
  if (table === null) return [];
  return [...table.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent ?? ""),
  );
}

describe("the table block", () => {
  it("merges a header row and its delimiter row into one block, keeping the id", () => {
    const { ydoc, ids } = docWith([""]);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, HEADER);
      editor.commands.keyboardShortcut("Enter");
      type(editor, DELIMITER);

      expect(getBlocks(ydoc)).toEqual([
        expect.objectContaining({
          id: ids[0],
          type: "table",
          text: `${HEADER}\n${DELIMITER}`,
        }),
      ]);

      // Drawn from the structured cells the GFM door created.
      expect(drawn(editor)).toEqual([["name", "count"]]);
      // Export projects those cells back to canonical GFM.
      const exported = exportMarkdown(ydoc, { frontmatter: false });
      expect(exported).toBe(`${HEADER}\n${DELIMITER}\n`);
      expect(importMarkdown(exported).blocks).toEqual([
        { type: "table", text: `${HEADER}\n${DELIMITER}` },
      ]);
    } finally {
      editor.destroy();
    }
  });

  /**
   * Agents write GFM while the editor binds the shared cells, so an agent edit
   * arrives live without a second representation to keep in step.
   */
  it("redraws when an agent edits a cell through the GFM projection", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "table-agent", title: "Tables" });
    const source = `${HEADER}\n${DELIMITER}\n| alpha | 1 |`;
    const id = appendBlock(ydoc, { type: "table", text: source });
    const { editor } = mountEditor(ydoc);
    try {
      expect(drawn(editor)).toEqual([
        ["name", "count"],
        ["alpha", "1"],
      ]);

      editBlock(ydoc, id, source, source.replace("| alpha | 1 |", "| alpha | 42 |"));

      expect(drawn(editor)).toEqual([
        ["name", "count"],
        ["alpha", "42"],
      ]);
      // The edit stays inside the same table block.
      expect(getBlocks(ydoc)).toHaveLength(1);
      expect(getBlocks(ydoc)[0]?.type).toBe("table");
    } finally {
      editor.destroy();
    }
  });

  it("keeps the table drawn while editing its one-paragraph cells", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "table-open", title: "Tables" });
    const id = appendBlock(ydoc, { type: "table", text: `${HEADER}\n${DELIMITER}\n| alpha | 1 |` });
    let writes = 0;
    ydoc.on("update", () => { writes += 1; });
    const { editor } = mountEditor(ydoc);
    try {
      expect(writes).toBe(0);
      editor.commands.setTextSelection(4);
      expect(editor.state.selection.$head.parent.type.name).toBe("paragraph");
      editor.commands.insertContent("Edited ");
      expect(drawn(editor)[0]?.[0]).toBe("Edited name");
      expect(editor.view.dom.querySelector(".ub-table-source")).toBeNull();
      for (const key of ["Enter", "Shift-Enter"]) editor.commands.keyboardShortcut(key);
      expect(getBlocks(ydoc)).toHaveLength(1);
      expect(tableRows(getBlocksFragment(ydoc).get(0) as Y.XmlElement)[0]?.[0]?.length).toBe(1);
      editor.commands.setTextSelection({ from: 4, to: 10 });
      expect(commentTargetOf(editor, ydoc)).toBeNull();
      expect(getBlocks(ydoc)[0]?.id).toBe(id);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("creates the menu's three-column header and two body rows and supports undo", () => {
    const { ydoc, ids } = docWith(["/table"]);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 0, 6);
      const entry = BLOCK_MENU_ENTRIES.find((item) => item.type === "table")!;
      const trigger = slashTriggerAt(editor)!;
      expect(convertBlockAtTrigger(editor, trigger, entry)).toBe(true);
      expect(drawn(editor)).toEqual([["", "", ""], ["", "", ""], ["", "", ""]]);
      expect(getBlocks(ydoc)[0]?.id).toBe(ids[0]);
      expect(editor.state.selection.from).toBe(4);
      editor.commands.keyboardShortcut("Mod-z");
      expect(getBlocks(ydoc)[0]).toMatchObject({ type: "paragraph", text: "/table" });
      expect(insertBlockBelow(editor, ids[0]!, entry)).toBe(true);
      expect(drawn(editor)).toHaveLength(3);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("pastes GFM table text into a table block, and leaves other text alone", () => {
    const { ydoc, ids } = docWith(["", ""]);
    const { editor } = mountEditor(ydoc);
    try {
      const paste = (text: string): boolean =>
        editor.view.someProp("handlePaste", (handler) =>
          handler(
            editor.view,
            { clipboardData: { getData: () => text } } as unknown as ClipboardEvent,
            editor.state.selection.content(),
          ),
        ) === true;

      caret(editor, 0, 0);
      expect(paste(`${HEADER}\n${DELIMITER}\n| alpha | 1 |\n`)).toBe(true);
      expect(getBlocks(ydoc)[0]).toMatchObject({
        id: ids[0],
        type: "table",
        text: `${HEADER}\n${DELIMITER}\n| alpha | 1 |`,
      });

      // Pipes without a delimiter row are prose, and prose pastes as prose.
      caret(editor, 1, 0);
      expect(paste("a | b\nc | d")).toBe(false);
      expect(getBlocks(ydoc)[1]?.type).toBe("paragraph");

      // A clipboard that merely *starts* with a table is a document: taking it
      // would store the prose under it as rows of a table nobody wrote, so it
      // falls through to the ordinary paste and stays the blocks it is.
      expect(paste(`${HEADER}\n${DELIMITER}\n\nprose after it\n`)).toBe(false);
      expect(getBlocks(ydoc)[1]?.type).toBe("paragraph");
      // These lines end a GFM table even without a blank separator. The
      // tolerant reader can project them as rows; the write door must not.
      const before = getBlocks(ydoc);
      for (const nextBlock of ["# Heading | text", "---"]) {
        expect(paste(`${HEADER}\n${DELIMITER}\n${nextBlock}`)).toBe(false);
        expect(getBlocks(ydoc)).toEqual(before);
      }
    } finally {
      editor.destroy();
    }
  });

  /**
   * The conversion rewrites one paragraph's text and deletes another, and
   * neither can carry an annotation across: the anchor is a mark on the very
   * characters being replaced. A thread must never be destroyed by someone
   * typing a row of hyphens, so a marked paragraph is left as it is — the
   * reader keeps their text and their thread, and the table is still a menu
   * entry or a paste away.
   */
  it("refuses to convert a paragraph carrying an annotation", () => {
    const { ydoc, ids } = docWith([HEADER, ""]);
    const thread = createAnnotation(ydoc, ids[0] ?? "", 2, 6, "reviewer", "why?");
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 1, 0);
      type(editor, DELIMITER);

      // Two paragraphs, exactly as they were typed…
      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["paragraph", HEADER],
        ["paragraph", DELIMITER],
      ]);
      // …and the thread is still anchored to the characters it was about.
      expect(listAnnotationRanges(ydoc, ids[0] ?? "")).toEqual([
        { threadId: thread.id, start: 2, end: 6 },
      ]);
    } finally {
      editor.destroy();
    }
  });

  /**
   * A stored mark — bold left switched on — lands on the character being typed
   * *now*, so it exists only in the state after that character is dispatched.
   * Asking an older state whether the paragraph is marked answers about a
   * document the reader has already moved past, and the conversion would then
   * insert the marked character and wipe it in the same gesture.
   */
  it("refuses when the character completing the row carries a stored mark", () => {
    const { ydoc, ids } = docWith([HEADER, ""]);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 1, 0);
      // Not a delimiter row yet: one cell against the header's two.
      type(editor, "| --- | ");
      expect(getBlocks(ydoc)[1]?.type).toBe("paragraph");

      // Bold switched on with nothing selected is a stored mark: it applies to
      // the next character, which is the one that completes the row.
      expect(editor.commands.toggleMark("bold")).toBe(true);
      type(editor, "-");

      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["paragraph", HEADER],
        ["paragraph", "| --- | -"],
      ]);
      // The mark the reader asked for is still on the character they typed.
      expect(getBlockInline(ydoc, ids[1] ?? "")).toEqual([
        { text: "| --- | ", marks: {} },
        { text: "-", marks: { bold: true } },
      ]);
    } finally {
      editor.destroy();
    }
  });

  it("never converts a paragraph that only looks like one", () => {
    const { ydoc } = docWith(["a | b", ""]);
    const { editor } = mountEditor(ydoc);
    try {
      // A second line of pipes, typed under the first: no delimiter row, so no
      // table — two paragraphs, exactly as they were typed.
      caret(editor, 1, 0);
      type(editor, "c | d");
      expect(getBlocks(ydoc).map((block) => block.type)).toEqual([
        "paragraph",
        "paragraph",
      ]);
    } finally {
      editor.destroy();
    }
  });

  it("keeps edits in different cells and concurrent text in the same cell", () => {
    const a = new Y.Doc();
    initDoc(a, { uuid: "table-pair", title: "Tables" });
    appendBlock(a, { type: "table", text: `${HEADER}\n${DELIMITER}\n| alpha | one |` });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ea = mountEditor(a).editor;
    const eb = mountEditor(b).editor;
    try {
      const position = (editor: Editor, row: number, col: number): number => {
        let found = 0;
        let index = 0;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "paragraph") {
            if (index === row * 2 + col) found = pos + 1;
            index += 1;
          }
        });
        return found;
      };
      ea.view.dispatch(ea.state.tr.insertText("A", position(ea, 1, 0)));
      eb.view.dispatch(eb.state.tr.insertText("B", position(eb, 1, 1)));
      const ua = Y.encodeStateAsUpdate(a);
      const ub = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(a, ub); Y.applyUpdate(b, ua);
      expect(drawn(ea)).toEqual(drawn(eb));
      expect(drawn(ea)[1]).toEqual(["Aalpha", "Bone"]);
      ea.view.dispatch(ea.state.tr.insertText("X", position(ea, 1, 0)));
      eb.view.dispatch(eb.state.tr.insertText("Y", position(eb, 1, 0)));
      const va = Y.encodeStateAsUpdate(a); const vb = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(a, vb); Y.applyUpdate(b, va);
      expect(drawn(ea)).toEqual(drawn(eb));
      expect(drawn(ea)[1]?.[0]).toContain("X");
      expect(drawn(ea)[1]?.[0]).toContain("Y");
    } finally { ea.destroy(); eb.destroy(); a.destroy(); b.destroy(); }
  });

  it("merges Tab's added row with an agent column without duplicated padding or rewrite loops", () => {
    const a = new Y.Doc();
    initDoc(a, { uuid: "table-structure", title: "Tables" });
    const source = `${HEADER}\n${DELIMITER}\n| alpha | one |`;
    const id = appendBlock(a, { type: "table", text: source });
    const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ea = mountEditor(a).editor; const eb = mountEditor(b).editor;
    try {
      ea.commands.setTextSelection(ea.state.doc.content.size - 4);
      expect(ea.commands.keyboardShortcut("Tab")).toBe(true);
      expect(drawn(ea)).toHaveLength(3);
      editBlock(b, id, source, "| name | count | extra |\n| --- | --- | --- |\n| alpha | one | new |" );
      const ua = Y.encodeStateAsUpdate(a); const ub = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(a, ub); Y.applyUpdate(b, ua);
      const expected = [["name", "count", "extra"], ["alpha", "one", "new"], ["", ""]];
      expect(drawn(ea)).toEqual(expected); expect(drawn(eb)).toEqual(expected);
      expect(findForeignBlocks(getBlocksFragment(a))).toEqual([]);
      expect(getBlocks(a)).toEqual(getBlocks(b));
      expect(getBlocks(a)[0]?.text).toContain("|  |  |  |");
      let writes = 0;
      a.on("update", () => { writes += 1; });
      let position = 0;
      ea.state.doc.descendants((node, pos) => {
        if (node.type.name === "paragraph" && position === 0 && node.textContent === "") position = pos + 1;
      });
      ea.commands.setTextSelection(position);
      ea.view.dispatch(ea.state.tr.insertText("kept"));
      expect(writes).toBe(1);
      expect(drawn(ea).map((row) => row.length)).toEqual([3, 3, 2]);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      expect(drawn(eb)).toEqual(drawn(ea));
      const rows = tableRows(getBlocksFragment(a).get(0) as Y.XmlElement);
      expect(tableCellText(rows[2]![0]!)?.toString()).toBe("kept");
    } finally { ea.destroy(); eb.destroy(); a.destroy(); b.destroy(); }
  });

  it("pastes multiple lines into one cell and refuses unsupported local marks and spans", () => {
    const ydoc = new Y.Doc(); initDoc(ydoc, { uuid: "cell-paste", title: "Tables" });
    appendBlock(ydoc, { type: "table", text: `${HEADER}\n${DELIMITER}` });
    const { editor } = mountEditor(ydoc);
    try {
      editor.commands.setTextSelection(4);
      expect(editor.view.someProp("handlePaste", (handler) => handler(editor.view,
        { clipboardData: { getData: (type: string) => type === "text/plain" ? "two\nlines" : "" } } as unknown as ClipboardEvent,
        editor.state.selection.content()))).toBe(true);
      expect(drawn(editor)[0]?.[0]).toBe("two linesname");
      const before = getBlocks(ydoc);
      editor.view.dispatch(editor.state.tr.addMark(4, 7, editor.schema.marks.docLink!.create({ docId: "00000000-0000-4000-8000-000000000001" })));
      expect(getBlocks(ydoc)).toEqual(before);
      editor.view.dispatch(editor.state.tr.setNodeAttribute(2, "colspan", 2));
      expect(getBlocks(ydoc)).toEqual(before);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

});
