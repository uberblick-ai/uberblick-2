import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import { COMMENT_MARK, appendBlock, createAnnotation, getBlocks, getBlockInline, getBlocksFragment, writeGfmTable } from "@uberblick/schema";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { addFootnoteAtTrigger, footnoteTriggerAt } from "../src/editor/footnote-menu.js";
import { BLOCK_MENU_ENTRIES, insertBlockBelow } from "../src/editor/block-menu.js";
import { startFigmaDraft } from "../src/editor/figma-creation.js";
import { retypeAtCaret, mountEditor, typeText, pastePlainText } from "./helpers.js";
import { FootnoteMenu } from "../src/ui/editor-controls/FootnoteMenu.js";
import { act, render } from "./react-render.js";
import { onTestCleanup } from "./test-cleanup.js";

type Block = Parameters<typeof appendBlock>[1];
function documentFor(block: Block = { type: "paragraph", text: "" }) {
  const ydoc = new Y.Doc();
  onTestCleanup(() => ydoc.destroy());
  const id = appendBlock(ydoc, block);
  return { ydoc, id };
}
function picker(ydoc: Y.Doc) {
  const { editor, element } = mountEditor(ydoc);
  const mounted = render(<FootnoteMenu editor={editor} host={{ current: element }} />);
  onTestCleanup(() => mounted.unmount());
  return {
    editor,
    type(text: string) { act(() => typeText(editor, text)); },
    press(key: string) { act(() => { editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); },
    pick() { act(() => screen.getByRole("option", { name: "Add footnote" }).click()); },
  };
}

describe("adding a footnote", () => {
  it("inserts the smallest unused label in reference order, syncing both parts in one edit and undo step", () => {
    const { ydoc } = documentFor({ type: "paragraph", inline: [{ text: "Before ", marks: {} }, { text: "[^1]", marks: { footnoteRef: true } }] });
    appendBlock(ydoc, { type: "paragraph", inline: [{ text: "[^3]", marks: { footnoteRef: true } }] });
    appendBlock(ydoc, { type: "footnote", label: "1", text: "First" });
    appendBlock(ydoc, { type: "footnote", label: "3", text: "Third" });
    appendBlock(ydoc, { type: "footnote", label: "4", text: "Unused" });
    const mounted = picker(ydoc);
    act(() => mounted.editor.commands.setTextSelection(11));
    mounted.type("[^");
    expect(screen.getByRole("option", { name: "Add footnote" })).toBeTruthy();
    const updates: Uint8Array[] = [];
    ydoc.on("update", (update: Uint8Array) => updates.push(update));
    mounted.pick();
    expect(updates).toHaveLength(1);
    expect(getBlocks(ydoc).map(({ type, label, text }) => ({ type, label, text }))).toEqual([
      { type: "paragraph", label: undefined, text: "Before [^1][^2]" },
      { type: "paragraph", label: undefined, text: "[^3]" },
      { type: "footnote", label: "1", text: "First" },
      { type: "footnote", label: "2", text: "" },
      { type: "footnote", label: "3", text: "Third" },
      { type: "footnote", label: "4", text: "Unused" },
    ]);
    expect(mounted.editor.state.selection.$from.parent.attrs.label).toBe("2");
    mounted.type("Written");
    expect(getBlockInline(ydoc, getBlocks(ydoc)[3]!.id)).toEqual([{ text: "Written", marks: {} }]);
    act(() => { undo(mounted.editor.state); undo(mounted.editor.state); });
    expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["Before [^1][^", "[^3]", "First", "Third", "Unused"]);
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
  });

  it.each(["paragraph", "heading", "list-item", "quote", "callout"] as const)("offers insertion inside %s", (type) => {
    const { ydoc } = documentFor({ type, text: "Before after" });
    const mounted = picker(ydoc);
    act(() => mounted.editor.commands.setTextSelection(8));
    mounted.type("[^");
    mounted.press("Enter");
    expect(getBlocks(ydoc)[0]?.text).toBe("Before [^1]after");
    expect(getBlocks(ydoc)[1]).toMatchObject({ type: "footnote", label: "1", text: "" });
  });

  it("places a new matched note before unused duplicate notes", () => {
    const { ydoc } = documentFor({ type: "paragraph", inline: [{ text: "[^1]", marks: { footnoteRef: true } }] });
    appendBlock(ydoc, { type: "footnote", label: "1", text: "First" });
    appendBlock(ydoc, { type: "footnote", label: "1", text: "Duplicate" });
    const mounted = picker(ydoc);
    act(() => mounted.editor.commands.setTextSelection(5));
    mounted.type("[^");
    mounted.pick();
    expect(getBlocks(ydoc).filter((block) => block.type === "footnote").map((block) => block.label)).toEqual(["1", "2", "1"]);
  });

  it.each(["Escape", "move", "typing"])("leaves the opener as text on %s and refuses stale picks", (action) => {
    const { ydoc } = documentFor();
    const mounted = picker(ydoc);
    mounted.type("[^");
    const trigger = footnoteTriggerAt(mounted.editor)!;
    if (action === "Escape") mounted.press("Escape");
    else if (action === "move") act(() => mounted.editor.commands.setTextSelection(1));
    else mounted.type("source]");
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
    if (action !== "Escape") expect(addFootnoteAtTrigger(mounted.editor, trigger)).toBe(false);
    expect(getBlocks(ydoc)).toHaveLength(1);
    expect(getBlocks(ydoc)[0]?.text).toBe(action === "typing" ? "[^source]" : "[^");
  });

  it("does not open from stored text, paste or undo, and closes immediately when editability changes", () => {
    const { ydoc } = documentFor({ type: "paragraph", text: "[^" });
    const mounted = picker(ydoc);
    act(() => mounted.editor.commands.setTextSelection(3));
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
    act(() => pastePlainText(mounted.editor, "[^"));
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
    mounted.type("[^");
    const trigger = footnoteTriggerAt(mounted.editor)!;
    act(() => mounted.editor.setEditable(false));
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
    expect(addFootnoteAtTrigger(mounted.editor, trigger)).toBe(false);
  });

  it("keeps the typed opener's formatting on the reference and starts the note without it", () => {
    const { ydoc, id } = documentFor({ type: "paragraph", text: "Before " });
    const thread = createAnnotation(ydoc, id, 0, 1, "Reader", "Keep on reference");
    const mounted = picker(ydoc);
    act(() => {
      mounted.editor.commands.setTextSelection(8);
      mounted.editor.commands.setMark("bold");
      mounted.editor.commands.setMark(COMMENT_MARK, { threadId: thread.id });
    });
    mounted.type("[^");
    mounted.pick();
    expect(getBlockInline(ydoc, getBlocks(ydoc)[0]!.id)).toEqual([
      { text: "Before ", marks: {} },
      { text: "[^1]", marks: { bold: true, footnoteRef: true } },
    ]);
    const referenceText = mounted.editor.state.doc.child(0).lastChild;
    expect(referenceText?.marks.find((mark) => mark.type.name === COMMENT_MARK)?.attrs.threadId).toBe(thread.id);
    mounted.type("Note");
    expect(getBlockInline(ydoc, getBlocks(ydoc)[1]!.id)).toEqual([{ text: "Note", marks: {} }]);
  });

  it.each(["stored", "peer"] as const)("dismisses an open picker after a %s change and refuses its stale pick", (origin) => {
    const { ydoc } = documentFor();
    const mounted = picker(ydoc);
    mounted.type("[^");
    const trigger = footnoteTriggerAt(mounted.editor)!;
    expect(screen.getByRole("option", { name: "Add footnote" })).toBeTruthy();
    act(() => {
      if (origin === "stored") mounted.editor.commands.insertContent("more");
      else {
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
        appendBlock(peer, { type: "paragraph", text: "Peer text" });
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
        peer.destroy();
      }
    });
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
    expect(addFootnoteAtTrigger(mounted.editor, trigger)).toBe(false);
    expect(getBlocks(ydoc).some((block) => block.type === "footnote")).toBe(false);
  });

  it.each(["inlineCode", "link", "docLink"])("leaves an opener in %s literal", (mark) => {
    const { ydoc } = documentFor();
    const mounted = picker(ydoc);
    act(() => mounted.editor.commands.setMark(mark, mark === "link" ? { href: "https://example.com" } : mark === "docLink" ? { docId: "11111111-1111-4111-8111-111111111111" } : {}));
    mounted.type("[^");
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
    expect(getBlocks(ydoc)[0]?.text).toBe("[^");
  });

  it.each([
    { type: "footnote", label: "note", text: "" },
    { type: "table", text: writeGfmTable([["Header"], [""]]) },
    { type: "card", text: "label: Label\ntitle: Title\n\nBody" },
    { type: "figma", text: "url: https://www.figma.com/design/key/Example\n\nCaption" },
  ] satisfies Block[])("does not offer insertion in $type", (block) => {
    const { ydoc } = documentFor(block);
    const mounted = picker(ydoc);
    let position = 1;
    mounted.editor.state.doc.descendants((node, pos) => { if (node.isTextblock) { position = pos + 1; return false; } return true; });
    act(() => mounted.editor.commands.setTextSelection(position));
    mounted.type("[^");
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
  });

  it("does not open in a decision editor", () => {
    const { ydoc } = documentFor();
    const element = document.createElement("div");
    document.body.append(element);
    const editor = createUberblickEditor({ element, fragment: getBlocksFragment(ydoc), decisionAnswer: () => true });
    const mounted = render(<FootnoteMenu editor={editor} host={{ current: element }} />);
    onTestCleanup(() => { mounted.unmount(); editor.destroy(); element.remove(); });
    act(() => typeText(editor, "[^"));
    expect(screen.queryByRole("option", { name: "Add footnote" })).toBeNull();
  });

  it("refuses body insertion, Figma drafts and retyping at notes", () => {
    const { ydoc, id } = documentFor({ type: "footnote", label: "source", text: "Kept" });
    const { editor } = mountEditor(ydoc);
    editor.commands.setTextSelection(1);
    expect(insertBlockBelow(editor, id, BLOCK_MENU_ENTRIES[0]!)).toBe(false);
    expect(startFigmaDraft(editor, id)).toBe(false);
    expect(retypeAtCaret(editor, "paragraph")).toBe(false);
    expect(getBlocks(ydoc)).toHaveLength(1);
  });
});
