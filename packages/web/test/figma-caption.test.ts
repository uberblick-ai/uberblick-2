import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, createAnnotation, figmaCaptionTexts, getBlocks, getBlocksFragment,
  initDoc, listAnnotationRanges,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { findForeignBlocks, findLinkConflicts, LINK_CONFLICT } from "../src/editor/palette.js";
import { commentTargetOf } from "../src/editor/selection.js";
import { threadsFromDoc } from "../src/ui/comments/threads.js";
import { mountEditor, retypeAtCaret } from "./helpers.js";
import { onTestCleanup } from "./test-cleanup.js";

function figmaDoc(caption = "Caption words") {
  const ydoc = new Y.Doc();
  onTestCleanup(() => ydoc.destroy());
  initDoc(ydoc, { uuid: "figma-caption-doc", title: "Design reference" });
  const id = appendBlock(ydoc, {
    type: "figma",
    text: `url: https://www.figma.com/design/key/Checkout-flow?node-id=12-345\ntitle: Payment\nheight: 560\n\n${caption}`,
  });
  const figma = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
  return { ydoc, id, figma };
}

function captionPosition(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "figmaCaption") found = pos + 2;
  });
  expect(found).toBeGreaterThan(0);
  return found;
}

describe("Figma caption integration", () => {
  it("binds supported Figma prose and attributes without rewriting the CRDT", () => {
    const { ydoc, figma } = figmaDoc("A **marked** design with a [link](https://example.com).");
    const before = Y.encodeStateAsUpdate(ydoc);
    const { editor } = mountEditor(ydoc);
    expect(editor.isEditable).toBe(true);
    expect(editor.state.doc.firstChild?.attrs).toMatchObject({
      url: figma.getAttribute("url"), title: "Payment", height: "560",
    });
    expect(editor.view.dom.querySelector(".ub-figma-caption strong")?.textContent).toBe("marked");
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
  });

  it("anchors selected caption prose and restores pre-existing threads in document order", () => {
    const { ydoc, id, figma } = figmaDoc();
    const existing = createAnnotation(ydoc, id, 8, 13, "Reader", "Existing caption comment", { part: "caption" });
    const { editor } = mountEditor(ydoc);
    const at = captionPosition(editor);
    editor.commands.setTextSelection({ from: at, to: at + 7 });
    expect(commentTargetOf(editor, ydoc)).toMatchObject({
      kind: "figma", blockType: "figma", part: "caption", blockId: id,
      start: 0, end: 7, text: "Caption", contentStart: at, clamped: false,
    });
    editor.commands.toggleMark("bold");
    const created = createAnnotation(ydoc, id, 0, 7, "Reader", "New caption comment", { part: "caption" });
    expect(listAnnotationRanges(ydoc, id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: created.id, part: "caption", start: 0, end: 7 }),
      expect.objectContaining({ threadId: existing.id, part: "caption", start: 8, end: 13 }),
    ]));
    expect(threadsFromDoc(ydoc).map(({ id, excerpt, orphaned, anchorBlockId }) => ({ id, excerpt, orphaned, anchorBlockId }))).toEqual([
      { id: created.id, excerpt: "Caption", orphaned: false, anchorBlockId: id },
      { id: existing.id, excerpt: "words", orphaned: false, anchorBlockId: id },
    ]);
    expect(figmaCaptionTexts(figma)[0]?.toDelta()).toEqual(expect.arrayContaining([
      expect.objectContaining({ insert: "Caption", attributes: expect.objectContaining({ bold: {} }) }),
    ]));
  });

  it("clamps a cross-block selection to the caption and refuses empty and node selections", () => {
    const { ydoc, id } = figmaDoc();
    appendBlock(ydoc, { type: "paragraph", text: "Following prose" });
    const { editor } = mountEditor(ydoc);
    const at = captionPosition(editor);
    editor.commands.setTextSelection({ from: at + 8, to: editor.state.doc.content.size - 1 });
    expect(commentTargetOf(editor, ydoc)).toMatchObject({
      blockId: id, part: "caption", start: 8, end: 13, text: "words", clamped: true,
    });
    editor.commands.setTextSelection(at);
    expect(commentTargetOf(editor, ydoc)).toBeNull();
    editor.commands.setNodeSelection(0);
    expect(commentTargetOf(editor, ydoc)).toBeNull();
  });

  it("gates caption link conflicts while retaining the live text handle for repair", () => {
    const { ydoc, id, figma } = figmaDoc();
    const text = figmaCaptionTexts(figma)[0]!;
    text.format(0, 7, {
      link: { href: "https://example.com" }, docLink: { docId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    });
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toMatchObject([{ nodeName: LINK_CONFLICT }]);
    expect(findLinkConflicts(getBlocksFragment(ydoc))).toMatchObject([
      { part: "caption", blockId: id, textIndex: 0, start: 0, end: 7, label: "Caption", text },
    ]);
    text.format(0, 7, { docLink: null });
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
    expect(findLinkConflicts(getBlocksFragment(ydoc))).toEqual([]);
  });

  it("refuses conversions to and from Figma without changing the stored block", () => {
    const { ydoc } = figmaDoc();
    appendBlock(ydoc, { type: "paragraph", text: "Plain prose" });
    const { editor } = mountEditor(ydoc);
    const before = getBlocks(ydoc);
    editor.commands.setTextSelection(captionPosition(editor));
    expect(retypeAtCaret(editor, "paragraph")).toBe(false);
    editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1);
    expect(retypeAtCaret(editor, "figma")).toBe(false);
    expect(getBlocks(ydoc)).toEqual(before);
  });

  it("refuses invalid local attributes and nested caption shapes before they reach Yjs", () => {
    const { ydoc } = figmaDoc();
    const { editor } = mountEditor(ydoc);
    const node = editor.state.doc.firstChild!;
    const before = Y.encodeStateAsUpdate(ydoc);
    for (const attrs of [
      { url: "https://example.com/design/key" },
      { url: "https://figma.com/design/key/Checkout-flow?t=tracking" },
      { height: "239" },
      { height: "961" },
      { height: "480.5" },
    ]) {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...node.attrs, ...attrs }));
      expect(editor.state.doc.firstChild).toBe(node);
      expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    }
    const paragraph = editor.schema.nodes.paragraph!;
    const caption = editor.schema.nodes.figmaCaption!.create(null, [paragraph.create(), paragraph.create()]);
    const malformed = node.type.create(node.attrs, caption);
    editor.view.dispatch(editor.state.tr.replaceWith(0, node.nodeSize, malformed));
    expect(editor.state.doc.firstChild).toBe(node);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
  });
});
