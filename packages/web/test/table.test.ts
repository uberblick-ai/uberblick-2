/**
 * The table block: one text, two representations.
 *
 * The contracts worth defending, all of them about the fact that the *source is
 * the storage*:
 *
 * 1. **A typed table becomes one block.** A header row and the delimiter row
 *    under it merge into a single `table` block holding both lines — and it
 *    keeps the header's block id, so nothing pointing at that block is orphaned.
 * 2. **The drawing follows the document, live.** An agent's `edit_block`
 *    rewriting one cell's text arrives as an ordinary update and the rendered
 *    table redraws — there is no second copy of the table to keep in step.
 * 3. **Clicking it opens the source**, which is the whole editing model: the
 *    caret lands in the block and the source appears where the drawing was.
 * 4. **Nothing is a table by accident.** Pipes without a delimiter row stay the
 *    prose they are.
 *
 * Read back through the schema package, as everywhere: the document is the
 * deliverable, the DOM is what a reader happens to see.
 */

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
import { EDITING_CLASS } from "../src/editor/table.js";
import { mountEditor } from "./helpers.js";

const HEADER = "| name | count |";
const DELIMITER = "| --- | ---: |";

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
  const table = editor.view.dom.querySelector(".ub-table-render table");
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

      // Drawn as a real table, from that source and nothing else.
      expect(drawn(editor)).toEqual([["name", "count"]]);
      // …and the source is what goes back out, verbatim.
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
   * The point of storing GFM: an agent rewrites one cell the way it writes
   * markdown, and the reader watching sees the table change.
   */
  it("redraws when an agent edits a cell through the source", () => {
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
      // One block, one text: the drawing added nothing to the document.
      expect(getBlocks(ydoc)).toHaveLength(1);
      expect(getBlocks(ydoc)[0]?.type).toBe("table");
    } finally {
      editor.destroy();
    }
  });

  it("shows the source under the caret, and the drawing everywhere else", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "table-open", title: "Tables" });
    appendBlock(ydoc, { type: "table", text: `${HEADER}\n${DELIMITER}` });
    appendBlock(ydoc, { type: "paragraph", text: "elsewhere" });
    const { editor } = mountEditor(ydoc);
    try {
      const block = (): Element | null =>
        editor.view.dom.querySelector(".ub-table");
      // The caret is not in the table: it is a table.
      caret(editor, 1, 0);
      expect(block()?.classList.contains(EDITING_CLASS)).toBe(false);

      // Clicking the drawing is what opens the source — the NodeView puts the
      // caret in the block, because a `contenteditable="false"` drawing would
      // otherwise only get itself selected.
      const rendered = editor.view.dom.querySelector(".ub-table-render");
      rendered?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );

      expect(editor.state.selection.$head.parent.type.name).toBe("table");
      expect(block()?.classList.contains(EDITING_CLASS)).toBe(true);
      // Source that is not a table yet keeps itself visible rather than hiding
      // a reader's half-typed text behind an empty drawing.
      expect(block()?.getAttribute("data-parsed")).toBe("true");
    } finally {
      editor.destroy();
    }
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
});
