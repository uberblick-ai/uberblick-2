/**
 * Re-typing a block from the editor.
 *
 * The invariant under test is the one from CLAUDE.md: a block-type change keeps
 * the block id and the text delta, marks included. That is what makes annotation
 * anchors and inbound references survive a user pressing "H2".
 *
 * The mark-survives-a-re-type half of that invariant is a schema property and is
 * pinned once, in `packages/schema/test/retype.test.ts`. What is left here is
 * what only the editor can answer: that the command re-types the SELECTED block
 * and writes the attributes the schema package expects.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlocks, initDoc } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { retypeSelectedBlock } from "../src/editor/retype.js";
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

    // Re-typing code → code with no language given keeps the existing one, and
    // reports the no-op — the same answer a re-type to the current type gives.
    expect(retypeSelectedBlock(editor, "code")).toBe(false);
    expect(getBlocks(ydoc)[0]?.language).toBe("ts");

    // Leaving `code` drops the language attribute entirely, in the document as
    // well as in the read.
    retypeSelectedBlock(editor, "mermaid");
    expect(getBlocks(ydoc)[0]?.type).toBe("mermaid");
    expect(getBlocks(ydoc)[0]?.language).toBeUndefined();
    const element = ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement;
    expect(element.getAttribute("language")).toBeUndefined();
    expect(retypeSelectedBlock(editor, "mermaid")).toBe(false);
  });
});
