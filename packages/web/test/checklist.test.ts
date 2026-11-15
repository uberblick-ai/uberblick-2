import { beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/dom";
import type { Editor } from "@tiptap/core";
import { AllSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  getBlocks,
  getBlocksFragment,
  initDoc,
  listAnnotationRanges,
} from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { mountEditor, snapshotFragment, typeText } from "./helpers.js";
import { onTestCleanup } from "./test-cleanup.js";

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

function docWith(blocks: readonly BlockInput[]): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "checklist", title: "Checklist" });
  for (const block of blocks) appendBlock(ydoc, block);
  onTestCleanup(() => ydoc.destroy());
  return ydoc;
}

function checkbox(editor: Editor, index = 0): HTMLInputElement {
  const input = within(editor.view.dom).getAllByRole<HTMLInputElement>("checkbox", { name: "Checklist item" })[index];
  if (input === undefined) throw new Error("fixture checkbox is missing");
  return input;
}

function firstBlockId(ydoc: Y.Doc): string {
  const block = getBlocks(ydoc)[0];
  if (block === undefined) throw new Error("fixture block is missing");
  return block.id;
}

function caret(editor: Editor, index: number, offset: number): void {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  editor.commands.setTextSelection(pos + offset);
}

describe("checklist editing", () => {
  it("exposes the native checkbox state at every depth without adding document content", () => {
    const ydoc = docWith([
      { type: "list-item", text: "First", list: "unchecked", indent: 0 },
      { type: "list-item", text: "Second", list: "checked", indent: 1 },
      { type: "list-item", text: "Third", list: "unchecked", indent: 2 },
      { type: "list-item", text: "Fourth", list: "checked", indent: 3 },
      { type: "list-item", text: "Bullet", list: "bullet" },
      { type: "list-item", text: "Number", list: "ordered" },
    ]);
    const before = snapshotFragment(ydoc);
    const { editor } = mountEditor(ydoc);
    const boxes = within(editor.view.dom).getAllByRole<HTMLInputElement>("checkbox", { name: "Checklist item" });
    expect(boxes.map((box) => [box.type, box.checked, box.tabIndex, box.disabled])).toEqual([
      ["checkbox", false, -1, false],
      ["checkbox", true, -1, false],
      ["checkbox", false, -1, false],
      ["checkbox", true, -1, false],
    ]);
    for (const box of boxes) {
      expect(box.title).toMatch(/(?:Cmd|Ctrl|⌘).*Enter/);
      expect(box.getAttribute("aria-keyshortcuts")).toMatch(/(?:Meta|Control)\+Enter/);
    }
    expect(snapshotFragment(ydoc)).toEqual(before);
  });

  it.each(["pointer", "shortcut"])("changes only the checklist state through %s", (route) => {
    const ydoc = docWith([{ type: "list-item", text: "Keep this", list: "unchecked", indent: 2 }]);
    const id = firstBlockId(ydoc);
    const thread = createAnnotation(ydoc, id, 0, 4, "Reader", "Keep the anchor");
    const { editor } = mountEditor(ydoc);
    const before = snapshotFragment(ydoc)[0];
    if (before === undefined) throw new Error("fixture block is missing");
    caret(editor, 0, 3);
    const selection = editor.state.selection;
    const toggle = () => route === "pointer"
      ? checkbox(editor).click()
      : editor.commands.keyboardShortcut("Mod-Enter");

    toggle();
    expect(checkbox(editor).checked).toBe(true);
    expect(snapshotFragment(ydoc)).toEqual([{
      ...before,
      attributes: { ...before.attributes, list: "checked" },
    }]);
    expect(listAnnotationRanges(ydoc, id)).toEqual([{ threadId: thread.id, start: 0, end: 4 }]);
    expect(editor.state.selection.eq(selection)).toBe(true);
    toggle();
    expect(checkbox(editor).checked).toBe(false);
    expect(snapshotFragment(ydoc)).toEqual([before]);
  });

  it("keeps a toggle separate from typing both before and after it in undo", () => {
    const ydoc = docWith([{ type: "list-item", text: "Task", list: "unchecked" }]);
    const { editor } = mountEditor(ydoc);
    caret(editor, 0, 4);
    typeText(editor, " before");
    checkbox(editor).click();
    typeText(editor, " after");
    expect(getBlocks(ydoc)[0]).toMatchObject({ text: "Task before after", list: "checked" });

    editor.commands.keyboardShortcut("Mod-z");
    expect(getBlocks(ydoc)[0]).toMatchObject({ text: "Task before", list: "checked" });
    editor.commands.keyboardShortcut("Mod-z");
    expect(getBlocks(ydoc)[0]).toMatchObject({ text: "Task before", list: "unchecked" });
    editor.commands.keyboardShortcut("Mod-z");
    expect(getBlocks(ydoc)[0]).toMatchObject({ text: "Task", list: "unchecked" });
  });

  it("ignores the shortcut on a text range and outside checklist items", () => {
    const ydoc = docWith([
      { type: "list-item", text: "Task", list: "unchecked" },
      { type: "list-item", text: "Bullet", list: "bullet" },
      { type: "paragraph", text: "Prose" },
    ]);
    const { editor } = mountEditor(ydoc);
    const before = snapshotFragment(ydoc);
    editor.commands.setTextSelection({ from: 1, to: 4 });
    editor.commands.keyboardShortcut("Mod-Enter");
    expect(snapshotFragment(ydoc)).toEqual(before);
    caret(editor, 1, 2);
    editor.commands.keyboardShortcut("Mod-Enter");
    expect(snapshotFragment(ydoc)).toEqual(before);
    caret(editor, 2, 2);
    editor.commands.keyboardShortcut("Mod-Enter");
    expect(snapshotFragment(ydoc)).toEqual(before);
  });

  it("refreshes disabled state on setEditable without a transaction and refuses both toggle routes", () => {
    const ydoc = docWith([{ type: "list-item", text: "Task", list: "checked" }]);
    const { editor } = mountEditor(ydoc);
    caret(editor, 0, 2);
    const before = snapshotFragment(ydoc);
    const state = editor.state;
    editor.setEditable(false, false);
    expect(editor.state).toBe(state);
    expect(checkbox(editor).checked).toBe(true);
    expect(checkbox(editor).disabled).toBe(true);
    checkbox(editor).click();
    editor.commands.keyboardShortcut("Mod-Enter");
    expect(snapshotFragment(ydoc)).toEqual(before);

    editor.setEditable(true, false);
    expect(checkbox(editor).disabled).toBe(false);
    checkbox(editor).click();
    expect(getBlocks(ydoc)[0]?.list).toBe("unchecked");
  });

  it("honours the live content guard before a stale editable control can write", () => {
    const ydoc = docWith([{ type: "list-item", text: "Task", list: "unchecked" }]);
    const element = document.createElement("div");
    document.body.append(element);
    let allowed = true;
    const editor = createUberblickEditor({
      element,
      fragment: getBlocksFragment(ydoc),
      canEditContent: () => allowed,
    });
    onTestCleanup(() => { editor.destroy(); element.remove(); });
    caret(editor, 0, 2);
    const before = snapshotFragment(ydoc);
    allowed = false;
    checkbox(editor).click();
    editor.commands.keyboardShortcut("Mod-Enter");
    expect(snapshotFragment(ydoc)).toEqual(before);
    allowed = true;
    checkbox(editor).click();
    expect(getBlocks(ydoc)[0]?.list).toBe("checked");
  });

  it.each(["checked", "unchecked"] as const)("continues a %s item unticked at the same depth, with a fresh id", (list) => {
    const ydoc = docWith([{ type: "list-item", text: "Task", list, indent: 2 }]);
    const id = firstBlockId(ydoc);
    const { editor } = mountEditor(ydoc);
    caret(editor, 0, 4);
    editor.commands.keyboardShortcut("Enter");
    const blocks = getBlocks(ydoc);
    expect(blocks).toMatchObject([
      { id, type: "list-item", text: "Task", list, indent: 2 },
      { type: "list-item", text: "", list: "unchecked", indent: 2 },
    ]);
    const next = blocks[1];
    if (next === undefined) throw new Error("checklist continuation is missing");
    expect(next.id).not.toBe(id);
    expect(next.id).not.toBe("");
    expect(editor.state.selection.$head.parent.attrs.id).toBe(next.id);
  });

  it("keeps Tab indentation and lifts the checklist to a paragraph at its start without losing its anchor", () => {
    const ydoc = docWith([{ type: "list-item", text: "Keep this", list: "checked", indent: 1 }]);
    const id = firstBlockId(ydoc);
    const thread = createAnnotation(ydoc, id, 0, 4, "Reader", "Keep the anchor");
    const { editor } = mountEditor(ydoc);
    caret(editor, 0, 2);
    editor.commands.keyboardShortcut("Tab");
    expect(getBlocks(ydoc)[0]).toMatchObject({ id, indent: 2, list: "checked" });
    editor.commands.keyboardShortcut("Shift-Tab");
    expect(getBlocks(ydoc)[0]).toMatchObject({ id, indent: 1, list: "checked" });
    caret(editor, 0, 0);
    editor.commands.keyboardShortcut("Backspace");
    expect(getBlocks(ydoc)).toMatchObject([{ id, type: "paragraph", text: "Keep this" }]);
    expect(getBlocks(ydoc)[0]?.list).toBeUndefined();
    expect(listAnnotationRanges(ydoc, id)).toEqual([{ threadId: thread.id, start: 0, end: 4 }]);
    expect(within(editor.view.dom).queryByRole("checkbox")).toBeNull();
  });

  it("keeps every stored list style and depth through the editor's HTML clipboard route", () => {
    const source = docWith([
      { type: "list-item", text: "Bullet", list: "bullet", indent: 0 },
      { type: "list-item", text: "Number", list: "ordered", indent: 1 },
      { type: "list-item", text: "Unticked", list: "unchecked", indent: 2 },
      { type: "list-item", text: "Ticked", list: "checked", indent: 3 },
    ]);
    const destination = docWith([{ type: "paragraph", text: "" }]);
    const { editor: sourceEditor } = mountEditor(source);
    const { editor } = mountEditor(destination);
    const copied = sourceEditor.view.serializeForClipboard(new AllSelection(sourceEditor.state.doc).content());
    caret(editor, 0, 0);
    expect(editor.view.pasteHTML(copied.dom.innerHTML, new Event("paste") as ClipboardEvent)).toBe(true);
    expect(getBlocks(destination).map(({ type, text, list, indent }) => ({ type, text, list, indent })))
      .toEqual(getBlocks(source).map(({ type, text, list, indent }) => ({ type, text, list, indent })));
  });
});
