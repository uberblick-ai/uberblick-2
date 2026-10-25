/**
 * Re-typing a block from the editor.
 *
 * The invariant under test: a block-type change keeps
 * the block id and the text delta, marks included. That is what makes annotation
 * anchors and inbound references survive a user pressing "H2".
 *
 * `retypeBlockInTransaction` uses ProseMirror `setNodeMarkup`, and
 * y-prosemirror then replaces the Y.XmlElement and re-converts its marks. The
 * first test here pins that the annotation mark survives that bridge.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  COMMENT_MARK,
  appendBlock,
  createAnnotation,
  getBlockInline,
  getBlocks,
  initDoc,
  listAnnotationRanges,
  resolveAnnotationRange,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor, retypeAtCaret } from "./helpers.js";

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

describe("retypeBlockInTransaction", () => {
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

    expect(retypeAtCaret(editor, "heading", { level: 2 })).toBe(true);

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
    retypeAtCaret(editor, "heading", { level: 4 });
    const element = ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement;
    expect(element.getAttribute("level")).toBe("4");
  });

  it.each(["quote", "paragraph"] as const)("keeps callout text, inline marks and comment anchors when retyping to %s, including undo", (type) => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "callout-retype", title: "Callout retype" });
    const id = appendBlock(ydoc, { type: "callout", variant: "tip", icon: ":claude:", text: "Keep these words" });
    const thread = createAnnotation(ydoc, id, 5, 10, "reviewer", "These");
    const text = (ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement).firstChild as Y.XmlText;
    text.format(0, 4, { bold: true });
    const original = getBlockInline(ydoc, id);
    const { editor } = mountEditor(ydoc);
    editors.push(editor);
    editor.commands.setTextSelection(1);
    expect(retypeAtCaret(editor, type)).toBe(true);
    expect(getBlocks(ydoc)).toMatchObject([{ id, type, text: "Keep these words" }]);
    expect(getBlockInline(ydoc, id)).toEqual(original);
    expect(listAnnotationRanges(ydoc, id)).toEqual([{ threadId: thread.id, start: 5, end: 10 }]);
    expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
    expect(getBlocks(ydoc)).toMatchObject([{ id, type: "callout", variant: "tip", icon: ":claude:", text: "Keep these words" }]);
    expect(getBlockInline(ydoc, id)).toEqual(original);
  });

  it("creates a valid callout and preserves stored raw attributes across callout changes", () => {
    const { ydoc, blockId, editor } = docWithParagraph();
    expect(retypeAtCaret(editor, "callout", { variant: "tip", icon: "💡" })).toBe(true);
    expect(getBlocks(ydoc)[0]).toMatchObject({ id: blockId, type: "callout", variant: "tip", icon: "💡" });
    expect(retypeAtCaret(editor, "callout")).toBe(false);
    expect(retypeAtCaret(editor, "callout", { icon: ":unknown:" })).toBe(false);
    const element = ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement;
    element.setAttribute("icon", ":unknown:");
    expect(retypeAtCaret(editor, "callout", { variant: "warning" })).toBe(true);
    expect((ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement).getAttribute("icon")).toBe(":unknown:");
    expect(retypeAtCaret(editor, "callout", { icon: null })).toBe(true);
    expect(getBlocks(ydoc)[0]).toMatchObject({ variant: "warning" });
    expect(getBlocks(ydoc)[0]?.icon).toBeUndefined();
  });

  it("carries a code language, and preserves it across a level-less re-type", () => {
    const { ydoc, blockId, editor } = docWithParagraph();
    retypeAtCaret(editor, "code", { language: "ts" });
    expect(getBlocks(ydoc)[0]).toMatchObject({
      id: blockId,
      type: "code",
      language: "ts",
      text: "Promote me to a heading",
    });

    // Re-typing code → code with no language given keeps the existing one, and
    // reports the no-op — the same answer a re-type to the current type gives.
    expect(retypeAtCaret(editor, "code")).toBe(false);
    expect(getBlocks(ydoc)[0]?.language).toBe("ts");

    // Leaving `code` drops the language attribute entirely, in the document as
    // well as in the read.
    retypeAtCaret(editor, "terminal");
    expect(getBlocks(ydoc)[0]?.type).toBe("terminal");
    expect(getBlocks(ydoc)[0]?.language).toBeUndefined();
    const element = ydoc.getXmlFragment("blocks").get(0) as Y.XmlElement;
    expect(element.getAttribute("language")).toBeUndefined();
    expect(retypeAtCaret(editor, "terminal")).toBe(false);
  });

  /**
   * The one transition that has no honest outcome: a source block holds only the
   * `comment` mark, so formatted prose cannot become one. Refusing beats both
   * alternatives — stripping the marks loses content, and forcing it through
   * writes a block the palette gate then refuses to bind.
   */
  it("refuses to make formatted prose into a source block, without throwing", () => {
    const { ydoc, blockId, editor } = docWithParagraph();
    editor.commands.setTextSelection({ from: 1, to: 8 });
    expect(editor.commands.toggleMark("bold")).toBe(true);

    for (const type of ["code", "terminal", "chart"] as const) {
      expect(retypeAtCaret(editor, type), type).toBe(false);
    }
    expect(getBlocks(ydoc)[0]).toMatchObject({
      id: blockId,
      type: "paragraph",
      text: "Promote me to a heading",
    });
    expect(getBlockInline(ydoc, blockId)).toEqual([
      { text: "Promote", marks: { bold: true } },
      { text: " me to a heading", marks: {} },
    ]);

    // Clearing the formatting makes the same re-type work, which is the whole
    // point of refusing rather than mangling.
    expect(editor.commands.toggleMark("bold")).toBe(true);
    expect(retypeAtCaret(editor, "code", { language: "ts" })).toBe(true);
    expect(getBlocks(ydoc)[0]?.type).toBe("code");
  });
});
