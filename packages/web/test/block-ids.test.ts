/**
 * The id-assignment plugin, tested against a plain ProseMirror state (no Yjs) so
 * failures point at the plugin rather than at the binding.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { yUndoPluginKey } from "y-prosemirror";
import type { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { appendBlock, getBlocks, initDoc } from "@uberblick/schema";
import { blockIdPlugin } from "../src/editor/block-ids.js";
import { uberblickSchema } from "../src/editor/create-editor.js";
import { mountEditor, sequentialIds } from "./helpers.js";

function stateWith(
  blocks: Array<{ type: string; attrs?: Record<string, unknown>; text?: string }>,
  newId: () => string,
): EditorState {
  const nodes: PMNode[] = blocks.map((block) =>
    uberblickSchema.node(
      block.type,
      block.attrs ?? {},
      block.text === undefined || block.text === ""
        ? undefined
        : uberblickSchema.text(block.text),
    ),
  );
  return EditorState.create({
    doc: uberblickSchema.node("doc", null, nodes),
    plugins: [blockIdPlugin({ newId })],
  });
}

function idsOf(state: EditorState): Array<unknown> {
  const ids: unknown[] = [];
  state.doc.forEach((node) => {
    ids.push(node.attrs.id);
  });
  return ids;
}

/** Apply an empty transaction so appendTransaction runs. */
function settle(state: EditorState): EditorState {
  return state.apply(state.tr.setMeta("settle", true));
}

describe("blockIdPlugin", () => {
  it("assigns an id to a block that has none, empty string included", () => {
    const state = settle(
      stateWith([{ type: "paragraph", text: "hello" }], sequentialIds()),
    );
    expect(idsOf(state)).toEqual(["fresh-1"]);

    // An empty id has claimed no identity, so it counts as absent.
    const blank = settle(
      stateWith(
        [{ type: "paragraph", attrs: { id: "" }, text: "x" }],
        sequentialIds(),
      ),
    );
    expect(idsOf(blank)).toEqual(["fresh-1"]);
  });

  it("keeps the first occurrence and re-ids later duplicates", () => {
    const state = settle(
      stateWith(
        [
          { type: "paragraph", attrs: { id: "dup" }, text: "first" },
          { type: "paragraph", attrs: { id: "dup" }, text: "second" },
          { type: "paragraph", attrs: { id: "dup" }, text: "third" },
        ],
        sequentialIds(),
      ),
    );
    expect(idsOf(state)).toEqual(["dup", "fresh-1", "fresh-2"]);

    // Ids that are already unique are left exactly as they are — the plugin
    // repairs, it does not renumber.
    const untouched = settle(
      stateWith(
        [
          { type: "heading", attrs: { id: "a", level: "2" }, text: "A" },
          { type: "paragraph", attrs: { id: "b" }, text: "B" },
        ],
        sequentialIds(),
      ),
    );
    expect(idsOf(untouched)).toEqual(["a", "b"]);
  });

  it("gives the second half of an Enter-split a fresh id", () => {
    // ProseMirror's split copies attrs onto both halves — this is the case the
    // plugin exists for.
    const initial = stateWith(
      [{ type: "paragraph", attrs: { id: "original" }, text: "abcdef" }],
      sequentialIds(),
    );
    const split = initial.apply(initial.tr.split(4));
    expect(idsOf(split)).toEqual(["original", "fresh-1"]);
    expect(split.doc.child(0).textContent).toBe("abc");
    expect(split.doc.child(1).textContent).toBe("def");
  });

});

/**
 * Undoing an Enter-split, driven through the real editor — the app's undo is
 * the Yjs UndoManager (`yUndoPlugin`), not ProseMirror history, so only the
 * editor can tell us the truth about it. The plugin's repair rides in the same
 * transaction as the split, so the two must be undone together and must never
 * leave a block without a unique id.
 */
describe("undoing a split in the real editor", () => {
  function texts(ydoc: Y.Doc): string[] {
    return getBlocks(ydoc).map((block) => block.text);
  }

  /** Every block has an id, no two the same, one per block in the editor. */
  function expectSoundIds(ydoc: Y.Doc, editor: Editor): void {
    const ids = getBlocks(ydoc).map((block) => block.id);
    expect(ids.every((id) => id !== "")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(editor.state.doc.childCount).toBe(ids.length);
  }

  /**
   * The UndoManager merges edits that land within its 500ms capture window into
   * one stack item, so a synchronous test has to stand in for the pause a human
   * takes between pressing Enter and typing.
   */
  function endUndoStep(editor: Editor): void {
    yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
  }

  function splitDoc(): { ydoc: Y.Doc; editor: Editor; original: string } {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "undo-doc", title: "Undo" });
    const original = appendBlock(ydoc, { type: "paragraph", text: "abcdef" });
    const { editor } = mountEditor(ydoc);
    editor.commands.setTextSelection(4);
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(texts(ydoc)).toEqual(["abc", "def"]);
    return { ydoc, editor, original };
  }

  it("reverts the split", () => {
    const { ydoc, editor, original } = splitDoc();
    try {
      expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);

      expect(texts(ydoc)).toEqual(["abcdef"]);
      expect(getBlocks(ydoc).map((block) => block.id)).toEqual([original]);
      expectSoundIds(ydoc, editor);
    } finally {
      editor.destroy();
    }
  });

  it("reverts typing, then the split", () => {
    const { ydoc, editor, original } = splitDoc();
    try {
      endUndoStep(editor);
      editor.commands.insertContent("X");
      expect(texts(ydoc)).toEqual(["abc", "Xdef"]);

      expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
      expect(texts(ydoc)).toEqual(["abc", "def"]);
      expectSoundIds(ydoc, editor);

      expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
      expect(texts(ydoc)).toEqual(["abcdef"]);
      expect(getBlocks(ydoc).map((block) => block.id)).toEqual([original]);
      expectSoundIds(ydoc, editor);
    } finally {
      editor.destroy();
    }
  });
});
