/**
 * The id-assignment plugin, tested against a plain ProseMirror state (no Yjs) so
 * failures point at the plugin rather than at the binding.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
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
  state.doc.forEach((node) => ids.push(node.attrs.id));
  return ids;
}

/** Apply an empty transaction so appendTransaction runs. */
function settle(state: EditorState): EditorState {
  return state.apply(state.tr.setMeta("settle", true));
}

describe("blockIdPlugin", () => {
  it("assigns an id to a block that has none", () => {
    const state = settle(
      stateWith([{ type: "paragraph", text: "hello" }], sequentialIds()),
    );
    expect(idsOf(state)).toEqual(["fresh-1"]);
  });

  it("leaves existing unique ids alone", () => {
    const state = settle(
      stateWith(
        [
          { type: "heading", attrs: { id: "a", level: "2" }, text: "A" },
          { type: "paragraph", attrs: { id: "b" }, text: "B" },
        ],
        sequentialIds(),
      ),
    );
    expect(idsOf(state)).toEqual(["a", "b"]);
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
  });

  it("treats the empty string as no id", () => {
    const state = settle(
      stateWith([{ type: "paragraph", attrs: { id: "" }, text: "x" }], sequentialIds()),
    );
    expect(idsOf(state)).toEqual(["fresh-1"]);
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

  it("does nothing when every id is already unique", () => {
    const initial = stateWith(
      [
        { type: "paragraph", attrs: { id: "a" }, text: "a" },
        { type: "code", attrs: { id: "b", language: "ts" }, text: "b" },
      ],
      sequentialIds(),
    );
    const plugin = initial.plugins[0];
    expect(plugin?.spec.appendTransaction?.([], initial, initial)).toBeNull();
  });
});

/**
 * The plugin's repair is bookkeeping, not a user edit, so undo must never leave
 * a block without an id. Driven through the real editor — the app's undo is the
 * Yjs UndoManager (`yUndoPlugin`), not ProseMirror history, so only the editor
 * can tell us the truth about it.
 */
describe("block ids across an undo in the real editor", () => {
  function idsInDoc(ydoc: Y.Doc): string[] {
    return getBlocks(ydoc).map((block) => block.id);
  }

  it("leaves every block with a present, unique id", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "undo-doc", title: "Undo" });
    const original = appendBlock(ydoc, { type: "paragraph", text: "abcdef" });
    const { editor } = mountEditor(ydoc, { newBlockId: sequentialIds() });
    try {
      // A split is where the repair fires: ProseMirror copies the attrs onto
      // both halves, so the second one gets a fresh id.
      editor.commands.setTextSelection(4);
      editor.commands.splitBlock();
      editor.commands.insertContent("X");
      expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["abc", "Xdef"]);
      expect(idsInDoc(ydoc)).toEqual([original, "fresh-1"]);

      expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);

      // The edit is undone, and both blocks still have their id.
      expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["abc", "def"]);
      const ids = idsInDoc(ydoc);
      expect(ids).toEqual([original, "fresh-1"]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(editor.state.doc.childCount).toBe(ids.length);
    } finally {
      editor.destroy();
    }
  });
});
