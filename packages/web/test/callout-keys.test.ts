import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { undo, redo } from "y-prosemirror";
import type { Editor } from "@tiptap/core";
import {
  appendBlock, createAnnotation, findBlockElement, getBlockInline, getBlocks,
  initDoc, listAnnotationRanges,
} from "@uberblick/schema";
import { mountEditor, typeText } from "./helpers.js";

function key(editor: Editor, name: string, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", { key: name, shiftKey });
  return editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, event)) === true;
}

function fixture(text: string) {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "callout-keys", title: "Callout keys" });
  const id = appendBlock(ydoc, { type: "callout", variant: "warning", icon: "🚀", text });
  appendBlock(ydoc, { type: "paragraph", text: "After" });
  const mounted = mountEditor(ydoc);
  return { ydoc, id, ...mounted };
}

describe("callout body keys", () => {
  it("inserts literal line breaks in the middle and on Shift+Enter, including an empty last line", () => {
    const { ydoc, id, editor } = fixture("one two");
    try {
      editor.commands.setTextSelection(4);
      key(editor, "Enter");
      expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "callout", text: "one\n two", variant: "warning", icon: "🚀" });
      editor.commands.setTextSelection(9);
      key(editor, "Enter", true);
      key(editor, "Enter", true);
      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["callout", "one\n two\n\n"], ["paragraph", "After"],
      ]);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it.each(["", "one\n", "one\n\n"])("leaves an empty final line of %j in one undo step", (text) => {
    const { ydoc, id, editor } = fixture(text);
    try {
      editor.commands.setTextSelection(text.length + 1);
      key(editor, "Enter");
      const blocks = getBlocks(ydoc);
      expect(blocks.map((block) => [block.type, block.text])).toEqual([
        ["callout", text.endsWith("\n") ? text.slice(0, -1) : text],
        ["paragraph", ""], ["paragraph", "After"],
      ]);
      expect(blocks[0]?.id).toBe(id);
      expect(blocks[1]?.id).toBeTruthy();
      expect(blocks[1]?.id).not.toBe(id);
      expect(editor.state.selection.$head.parent.type.name).toBe("paragraph");
      expect(undo(editor.state)).toBe(true);
      expect(getBlocks(ydoc).map((block) => [block.type, block.text])).toEqual([
        ["callout", text], ["paragraph", "After"],
      ]);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("replaces a selection with a line break rather than dropping the remaining body", () => {
    const { ydoc, editor } = fixture("one two three");
    try {
      editor.commands.setTextSelection({ from: 5, to: 8 });
      key(editor, "Enter");
      expect(getBlocks(ydoc)[0]?.text).toBe("one \n three");
      expect(getBlocks(ydoc)).toHaveLength(2);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("Backspace at the start preserves id, inline marks and comments, syncs and undoes alone", () => {
    const ydoc = new Y.Doc();
    const peer = new Y.Doc();
    initDoc(ydoc, { uuid: "callout-backspace", title: "Backspace" });
    const id = appendBlock(ydoc, { type: "callout", variant: "tip", icon: ":claude:", inline: [
      { text: "Keep ", marks: {} }, { text: "bold", marks: { bold: true } },
    ] });
    createAnnotation(ydoc, id, 5, 9, "Reader", "Keep this");
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const { editor } = mountEditor(ydoc);
    const other = mountEditor(peer).editor;
    try {
      editor.commands.setTextSelection(10);
      typeText(editor, "!");
      const inline = getBlockInline(ydoc, id);
      const anchors = listAnnotationRanges(ydoc, id);
      editor.commands.setTextSelection(1);
      key(editor, "Backspace");
      expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "paragraph", text: "Keep bold!" });
      expect(getBlockInline(ydoc, id)).toEqual(inline);
      expect(listAnnotationRanges(ydoc, id)).toEqual(anchors);
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
      expect(other.state.doc.firstChild?.type.name).toBe("paragraph");
      expect(getBlockInline(peer, id)).toEqual(getBlockInline(ydoc, id));
      expect(listAnnotationRanges(peer, id)).toEqual(anchors);
      expect(undo(editor.state)).toBe(true);
      expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "callout", text: "Keep bold!", variant: "tip", icon: ":claude:" });
      expect(listAnnotationRanges(ydoc, id)).toEqual(anchors);
      expect(redo(editor.state)).toBe(true);
      expect(findBlockElement(ydoc, id)?.getAttributes()).toEqual({ id });
    } finally { editor.destroy(); other.destroy(); ydoc.destroy(); peer.destroy(); }
  });

  it("gives open caret menus Enter and Tab before callout keys", () => {
    const { ydoc, editor } = fixture("body");
    const picked: string[] = [];
    try {
      editor.commands.setTextSelection(5);
      editor.storage.caretMenuKeys.menus.add({
        handleKey: (key) => {
          if (key !== "Enter" && key !== "Tab") return false;
          picked.push(key);
          return true;
        }, listId: "test-picker", activeId: "test-option",
      });
      expect(key(editor, "Enter")).toBe(true);
      expect(key(editor, "Tab")).toBe(true);
      expect(picked).toEqual(["Enter", "Tab"]);
      expect(getBlocks(ydoc)[0]?.text).toBe("body");
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("leaves ordinary Backspace to the editor and ignores composing keys", () => {
    const { ydoc, editor } = fixture("body");
    try {
      editor.commands.setTextSelection(3);
      const event = new KeyboardEvent("keydown", { key: "Backspace", isComposing: true });
      expect(editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, event))).toBeFalsy();
      expect(getBlocks(ydoc)[0]?.text).toBe("body");
      key(editor, "Backspace");
      expect(getBlocks(ydoc)[0]?.type).toBe("callout");
    } finally { editor.destroy(); ydoc.destroy(); }
  });
});
