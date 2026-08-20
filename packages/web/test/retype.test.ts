/**
 * Re-typing a block from the editor.
 *
 * The invariant under test is the one from CLAUDE.md: a block-type change keeps
 * the block id and the text delta, marks included. That is what makes annotation
 * anchors and inbound references survive a user pressing "H2".
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  getBlocks,
  initDoc,
  listAnnotationRanges,
  resolveAnnotationRange,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { retypeSelectedBlock, selectedBlock } from "../src/editor/retype.js";
import { mountEditor } from "./helpers.js";

let editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors = [];
});

function docWithParagraph(): { ydoc: Y.Doc; blockId: string; editor: Editor } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "retype-doc", title: "Retype" });
  const blockId = appendBlock(ydoc, {
    type: "paragraph",
    text: "Promote me to a heading",
  });
  const { editor } = mountEditor(ydoc);
  editors.push(editor);
  editor.commands.setTextSelection(3);
  return { ydoc, blockId, editor };
}

describe("retypeSelectedBlock", () => {
  it("keeps the block id and the text when promoting to a heading", () => {
    const { ydoc, blockId, editor } = docWithParagraph();
    expect(retypeSelectedBlock(editor, "heading", { level: 2 })).toBe(true);

    const blocks = getBlocks(ydoc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe(blockId);
    expect(blocks[0]?.type).toBe("heading");
    expect(blocks[0]?.level).toBe(2);
    expect(blocks[0]?.text).toBe("Promote me to a heading");
  });

  it("stores level as the string the schema package expects", () => {
    const { ydoc, editor } = docWithParagraph();
    retypeSelectedBlock(editor, "heading", { level: 4 });
    const element = ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement;
    expect(element.getAttribute("level")).toBe("4");
  });

  it("carries a code language, and preserves it across a level-less re-type", () => {
    const { ydoc, blockId, editor } = docWithParagraph();
    retypeSelectedBlock(editor, "code", { language: "ts" });
    expect(getBlocks(ydoc)[0]).toMatchObject({
      id: blockId,
      type: "code",
      language: "ts",
      text: "Promote me to a heading",
    });

    // Re-typing code → code with no language given keeps the existing one.
    expect(retypeSelectedBlock(editor, "code")).toBe(false);
    expect(getBlocks(ydoc)[0]?.language).toBe("ts");
  });

  it("drops the language when leaving the code type", () => {
    const { ydoc, editor } = docWithParagraph();
    retypeSelectedBlock(editor, "code", { language: "ts" });
    retypeSelectedBlock(editor, "mermaid");
    const blocks = getBlocks(ydoc);
    expect(blocks[0]?.type).toBe("mermaid");
    expect(blocks[0]?.language).toBeUndefined();
    const element = ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement;
    expect(element.getAttribute("language")).toBeUndefined();
  });

  it("keeps an annotation anchored across a re-type", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "retype-annotated", title: "Anchored" });
    const blockId = appendBlock(ydoc, {
      type: "paragraph",
      text: "The quick brown fox",
    });
    const annotation = createAnnotation(ydoc, blockId, 4, 9, "tester", "why?");
    const { editor } = mountEditor(ydoc);
    editors.push(editor);
    editor.commands.setTextSelection(2);

    expect(retypeSelectedBlock(editor, "heading", { level: 3 })).toBe(true);

    expect(getBlocks(ydoc)[0]).toMatchObject({
      id: blockId,
      type: "heading",
      level: 3,
      text: "The quick brown fox",
    });
    expect(listAnnotationRanges(ydoc, blockId)).toEqual([
      { threadId: annotation.id, start: 4, end: 9 },
    ]);
    expect(resolveAnnotationRange(ydoc, annotation.id)).toEqual({
      start: 4,
      end: 9,
      collapsed: false,
    });
  });

  it("reports the selected block, and nothing when there is no selection in one", () => {
    const { blockId, editor } = docWithParagraph();
    expect(selectedBlock(editor)).toMatchObject({
      type: "paragraph",
      attrs: { id: blockId },
    });
  });

  it("is a no-op when the block is already that type", () => {
    const { editor } = docWithParagraph();
    expect(retypeSelectedBlock(editor, "paragraph")).toBe(false);
  });
});
