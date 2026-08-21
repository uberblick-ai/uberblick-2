/**
 * Re-typing a block from the editor.
 *
 * The invariant under test is the one from CLAUDE.md: a block-type change keeps
 * the block id and the text delta, marks included. That is what makes annotation
 * anchors and inbound references survive a user pressing "H2".
 *
 * The UI re-type is an INDEPENDENT path to that invariant, not a caller of the
 * schema one: `retypeSelectedBlock` dispatches ProseMirror `setNodeMarkup`, and
 * y-prosemirror then replaces the Y.XmlElement and re-converts its marks, where
 * `schema.setBlockType` replaces the element and replays the delta itself. So
 * the mark has to be asserted on both paths — `packages/schema/test/retype.test.ts`
 * pins the schema one, and the first test here pins this bridge. Deleting either
 * leaves a way for annotations to be orphaned with the suite green.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  COMMENT_MARK,
  appendBlock,
  createAnnotation,
  getBlocks,
  initDoc,
  listAnnotationRanges,
  resolveAnnotationRange,
} from "@uberblick/schema";
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
  it("keeps the block id, the text and the annotation mark when promoting to a heading", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "retype-doc", title: "Retype" });
    const blockId = appendBlock(ydoc, {
      type: "paragraph",
      text: "Promote me to a heading",
    });
    // Annotate "me" before the editor binds, so the mark is in the Y.XmlText
    // that y-prosemirror converts on load and rebuilds on the re-type.
    const thread = createAnnotation(ydoc, blockId, 8, 10, "reviewer", "who?");
    const { editor } = mountEditor(ydoc);
    editors.push(editor);
    editor.commands.setTextSelection(3);

    expect(retypeSelectedBlock(editor, "heading", { level: 2 })).toBe(true);

    const blocks = getBlocks(ydoc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe(blockId);
    expect(blocks[0]?.type).toBe("heading");
    expect(blocks[0]?.level).toBe(2);
    expect(blocks[0]?.text).toBe("Promote me to a heading");

    // The UI re-type is its own path to the invariant: `setNodeMarkup` plus
    // y-prosemirror rebuilding the Y.XmlElement and re-converting its marks.
    // The schema-level test cannot see this bridge, so the mark is asserted
    // here — as the raw comment mark, and as the range it anchors.
    const text = (
      ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement
    ).firstChild as Y.XmlText;
    expect(
      (text.toDelta() as Array<{ insert: string; attributes?: unknown }>).map(
        (op) => [op.insert, op.attributes ?? null],
      ),
    ).toEqual([
      ["Promote ", null],
      ["me", { [COMMENT_MARK]: { threadId: thread.id } }],
      [" to a heading", null],
    ]);
    expect(listAnnotationRanges(ydoc, blockId)).toEqual([
      { threadId: thread.id, start: 8, end: 10 },
    ]);
    expect(resolveAnnotationRange(ydoc, thread.id)).toEqual({
      start: 8,
      end: 10,
      collapsed: false,
    });
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
