import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlock, getBlockInline, getBlocksFragment } from "@uberblick/schema";
import { findForeignBlocks } from "../src/editor/palette.js";
import { mountEditor } from "./helpers.js";

describe("plain editable footnotes", () => {
  it.each([false, true])("keeps labels and reference marks through edits and moves, arriving while bound: %s", (arrivesWhileBound) => {
    const ydoc = new Y.Doc();
    appendBlock(ydoc, { type: "paragraph", text: "Opening context" });
    let mounted: ReturnType<typeof mountEditor> | undefined;
    if (arrivesWhileBound) mounted = mountEditor(ydoc);
    const reference = appendBlock(ydoc, {
      type: "paragraph", inline: [{ text: "Read ", marks: {} }, { text: "[^Source]", marks: { footnoteRef: true } }],
    });
    const note = appendBlock(ydoc, {
      type: "footnote", label: "Source", inline: [{ text: "Kept ", marks: { bold: true } }, { text: "note", marks: {} }],
    });
    mounted ??= mountEditor(ydoc);
    const { editor, element } = mounted;
    try {
      expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
      expect(element.querySelector(".ub-unsupported-block")).toBeNull();
      expect(element.querySelector("[data-footnote-ref]")?.textContent).toBe("[^Source]");
      expect(element.querySelector("[data-block-type=footnote]")?.textContent).toBe("Kept note");

      const referenceIndex = 1;
      const referencePos = editor.state.doc.child(0).nodeSize;
      editor.commands.insertContentAt(referencePos + editor.state.doc.child(referenceIndex).nodeSize - 1, " afterward");
      const notePos = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize;
      editor.commands.insertContentAt(notePos + editor.state.doc.child(2).nodeSize - 1, " amended");
      const moved = editor.state.doc.child(1);
      const transaction = editor.state.tr.delete(referencePos, referencePos + moved.nodeSize).insert(0, moved);
      editor.view.dispatch(transaction);

      expect(getBlock(ydoc, note)).toMatchObject({ type: "footnote", label: "Source", text: "Kept note amended" });
      expect(getBlockInline(ydoc, note)?.[0]).toEqual({ text: "Kept ", marks: { bold: true } });
      expect(getBlockInline(ydoc, reference)).toEqual([
        { text: "Read ", marks: {} },
        { text: "[^Source]", marks: { footnoteRef: true } },
        { text: " afterward", marks: {} },
      ]);
      expect(editor.state.doc.firstChild?.attrs.id).toBe(reference);
      expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
    } finally { editor.destroy(); ydoc.destroy(); }
  });
});
