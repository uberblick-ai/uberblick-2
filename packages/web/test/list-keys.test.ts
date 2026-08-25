/**
 * The list keyboard, asserted end to end: keystrokes in, blocks out.
 *
 * A list here is a run of adjacent `list-item` blocks (#59), so the contracts
 * worth defending are all about blocks rather than about a tree:
 *
 * 1. **Typing a list produces separate, identified blocks.** `- a` Enter `b`
 *    Tab is two blocks with two ids and two depths — which is what makes each
 *    of them addressable by `edit_block`.
 * 2. **The keys refuse everywhere else.** Enter still splits a paragraph and
 *    Backspace still deletes a character, because a list binding that fired
 *    outside a list would break the rest of the editor globally.
 * 3. **Leaving a list keeps the block.** Backspace at the start re-types in
 *    place, id intact, so nothing anchored to that block is orphaned.
 *
 * Everything is read back out of the Y.Doc through the schema package, and the
 * markdown is the schema package's own — the round trip is the deliverable.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  exportMarkdown,
  getBlocks,
  importMarkdown,
  initDoc,
  listAnnotationRanges,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor } from "./helpers.js";

function docWith(texts: string[]): { ydoc: Y.Doc; ids: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "list-doc", title: "Lists" });
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

/** Put the caret `offset` characters into block `index`. */
function caret(editor: Editor, index: number, offset: number): void {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  editor.commands.setTextSelection(pos + offset);
}

function key(editor: Editor, shortcut: string): boolean {
  return editor.commands.keyboardShortcut(shortcut);
}

describe("typing a list", () => {
  /** The acceptance criterion of #59, start to finish. */
  it("makes one block per item, each with its own id and depth", () => {
    const { ydoc } = docWith([""]);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "- a");
      expect(key(editor, "Enter")).toBe(true);
      type(editor, "b");
      expect(key(editor, "Tab")).toBe(true);

      const blocks = getBlocks(ydoc);
      expect(blocks).toEqual([
        expect.objectContaining({
          type: "list-item",
          text: "a",
          list: "bullet",
          indent: 0,
        }),
        expect.objectContaining({
          type: "list-item",
          text: "b",
          list: "bullet",
          indent: 1,
        }),
      ]);
      const ids = blocks.map((block) => block.id);
      expect(new Set(ids).size).toBe(2);
      expect(ids.every((id) => id !== "")).toBe(true);

      // The list a reader typed is the list markdown means: nested, tight, and
      // it comes back as the same two flat blocks.
      const exported = exportMarkdown(ydoc, { frontmatter: false });
      expect(exported).toBe("- a\n    - b\n");
      expect(importMarkdown(exported).blocks).toEqual([
        { type: "list-item", text: "a", list: "bullet", indent: 0 },
        { type: "list-item", text: "b", list: "bullet", indent: 1 },
      ]);
    } finally {
      editor.destroy();
    }
  });

  it("continues an ordered list as ordered, and numbers it on export", () => {
    const { ydoc } = docWith([""]);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "1. first");
      key(editor, "Enter");
      type(editor, "second");

      expect(getBlocks(ydoc).map((block) => [block.type, block.list])).toEqual([
        ["list-item", "ordered"],
        ["list-item", "ordered"],
      ]);
      expect(exportMarkdown(ydoc, { frontmatter: false })).toBe(
        "1. first\n2. second\n",
      );
    } finally {
      editor.destroy();
    }
  });

  it("clamps the depth and keeps Tab inside the list", () => {
    const { ydoc } = docWith([""]);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "- deep");
      for (let i = 0; i < 5; i += 1) expect(key(editor, "Tab")).toBe(true);
      expect(getBlocks(ydoc)[0]?.indent).toBe(3);

      for (let i = 0; i < 5; i += 1) expect(key(editor, "Shift-Tab")).toBe(true);
      expect(getBlocks(ydoc)[0]?.indent).toBe(0);
      // The block itself never changed, only its depth.
      expect(getBlocks(ydoc)[0]).toMatchObject({ type: "list-item", text: "deep" });
    } finally {
      editor.destroy();
    }
  });

  /**
   * The way out of a list, and the reason it goes through the sanctioned
   * re-type: the block a reader is leaving keeps its id, so an annotation
   * anchored in it is still anchored afterwards.
   */
  it("reverts to a paragraph on Backspace at the start, keeping the block", () => {
    const { ydoc } = docWith([""]);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 0, 0);
      type(editor, "- leaving");
      const id = getBlocks(ydoc)[0]?.id ?? "";
      const thread = createAnnotation(ydoc, id, 0, 7, "reviewer", "why?");

      caret(editor, 0, 0);
      expect(key(editor, "Backspace")).toBe(true);
      expect(getBlocks(ydoc)[0]).toMatchObject({
        id,
        type: "paragraph",
        text: "leaving",
      });
      expect(getBlocks(ydoc)[0]?.list).toBeUndefined();
      expect(listAnnotationRanges(ydoc, id)).toEqual([
        { threadId: thread.id, start: 0, end: 7 },
      ]);
    } finally {
      editor.destroy();
    }
  });

  /**
   * The marker a reader sees has to be the marker their document exports, and a
   * nested bullet is *inside* the ordered item above it — so it ends nothing the
   * enclosing list was counting. CSS counters cannot express that (no selector
   * says "a bullet nested inside an ordered item"), which is why the number is
   * decorated onto the block from the schema package's own rule.
   */
  it("numbers ordered items the way the export does, nesting included", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "list-numbers", title: "Numbers" });
    for (const [text, list, indent] of [
      ["parent", "ordered", 0],
      ["child", "bullet", 1],
      ["parent two", "ordered", 0],
      ["nested count", "ordered", 1],
      ["parent three", "ordered", 0],
    ] as const) {
      appendBlock(ydoc, { type: "list-item", text, list, indent });
    }
    const { editor } = mountEditor(ydoc);
    try {
      const drawn = [...editor.view.dom.querySelectorAll("li")].map((item) => [
        item.textContent,
        item.getAttribute("data-number"),
      ]);
      expect(drawn).toEqual([
        ["parent", "1"],
        ["child", null],
        ["parent two", "2"],
        ["nested count", "1"],
        ["parent three", "3"],
      ]);

      // The same numbers the markdown carries — one rule, two readers.
      expect(exportMarkdown(ydoc, { frontmatter: false })).toBe(
        [
          "1. parent",
          "    - child",
          "2. parent two",
          "    1. nested count",
          "3. parent three",
          "",
        ].join("\n"),
      );
    } finally {
      editor.destroy();
    }
  });

  it("leaves Enter, Tab and Backspace alone outside a list", () => {
    const { ydoc, ids } = docWith(["prose"]);
    const { editor } = mountEditor(ydoc);
    try {
      // Enter in a paragraph still splits it into paragraphs.
      caret(editor, 0, "prose".length);
      key(editor, "Enter");
      type(editor, "more");
      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["paragraph", "prose"],
        ["paragraph", "more"],
      ]);

      // Backspace at the start of a paragraph is not this module's business —
      // it joins, the way it always did.
      caret(editor, 1, 0);
      key(editor, "Backspace");
      expect(getBlocks(ydoc)).toEqual([
        expect.objectContaining({ id: ids[0], type: "paragraph", text: "prosemore" }),
      ]);
    } finally {
      editor.destroy();
    }
  });
});
