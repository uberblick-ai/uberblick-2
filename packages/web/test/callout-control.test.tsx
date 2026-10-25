import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import { appendBlock, createAnnotation, deleteBlock, findBlockElement, getBlockInline, getBlocks, insertBlock, isCalloutIcon, listAnnotationRanges } from "@uberblick/schema";
import { CalloutControl } from "../src/ui/editor-controls/CalloutControl.js";
import { findBlockById } from "../src/editor/blocks.js";
import { mountEditor, snapshotFragment } from "./helpers.js";
import { act, renderSettled } from "./react-render.js";

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
});

async function fixture(canWrite: () => boolean = () => true) {
  const ydoc = new Y.Doc();
  const id = appendBlock(ydoc, { type: "callout", variant: "tip", icon: ":claude:", inline: [
    { text: "Keep", marks: { bold: true } }, { text: " these words", marks: {} },
  ] });
  const annotation = createAnnotation(ydoc, id, 5, 10, "Reader", "Keep these");
  const other = appendBlock(ydoc, { type: "callout", variant: "warning", text: "Second callout" });
  const { editor, element } = mountEditor(ydoc);
  editor.commands.setTextSelection(3);
  const view = await renderSettled(<CalloutControl editor={editor} canWrite={canWrite} />);
  return { ydoc, id, other, annotation, editor, element, view };
}

async function open() {
  await act(async () => fireEvent.keyDown(screen.getAllByRole("button", { name: "Callout variant" })[0]!, { key: "ArrowDown" }));
  return screen.getByRole("menu", { name: "Callout variant" });
}

async function pick(name: string) {
  await act(async () => screen.getByRole("menuitem", { name }).click());
}

async function icons() {
  await open();
  await pick("Change icon…");
  const search = screen.getByRole<HTMLInputElement>("combobox", { name: "Search icons" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  await waitFor(() => expect(screen.queryByText("Loading icons…")).toBeNull());
  return search;
}

describe("callout caption controls", () => {
  it("makes every editable caption a menu button and supports Shift+F10 and Escape from the caret", async () => {
    const fix = await fixture();
    const buttons = screen.getAllByRole("button", { name: "Callout variant" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain("Tip");
    await act(async () => fix.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
    const menu = screen.getByRole("menu", { name: "Callout variant" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.replace("✓", "").trim()))
      .toEqual(["Note", "Tip", "Important", "Warning", "Caution", "Change icon…", "Quote", "Paragraph"]);
    await act(async () => fireEvent.keyDown(menu, { key: "Escape" }));
    await waitFor(() => expect(document.activeElement).toBe(fix.editor.view.dom));
    expect(fix.editor.state.selection.anchor).toBe(3);
  });

  it("changes variant independently from typing, preserves unknown stored icons, and reaches a peer", async () => {
    const fix = await fixture();
    act(() => findBlockElement(fix.ydoc, fix.id)!.setAttribute("icon", ":future:"));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(fix.ydoc));
    fix.ydoc.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
    const original = snapshotFragment(fix.ydoc);
    act(() => fix.editor.view.dispatch(fix.editor.state.tr.insertText("!", 16)));
    const typed = snapshotFragment(fix.ydoc);
    await open();
    await pick("Caution");
    expect(getBlocks(fix.ydoc)[0]).toMatchObject({ id: fix.id, variant: "caution" });
    expect(findBlockElement(fix.ydoc, fix.id)?.getAttribute("icon")).toBe(":future:");
    expect(getBlocks(peer)[0]).toEqual(getBlocks(fix.ydoc)[0]);
    expect(snapshotFragment(fix.ydoc)[0]?.delta).toEqual(typed[0]?.delta);
    act(() => { undo(fix.editor.state); });
    expect(snapshotFragment(fix.ydoc)).toEqual(typed);
    act(() => { undo(fix.editor.state); });
    expect(snapshotFragment(fix.ydoc)).toEqual(original);
    peer.destroy();
  });

  it.each(["Quote", "Paragraph"])("converts to %s in one undo step without losing marks, identity or comment anchors", async (name) => {
    const fix = await fixture();
    const before = snapshotFragment(fix.ydoc);
    const inline = getBlockInline(fix.ydoc, fix.id);
    const anchors = listAnnotationRanges(fix.ydoc, fix.id);
    await open();
    await pick(name);
    expect(getBlocks(fix.ydoc)[0]).toMatchObject({ id: fix.id, type: name.toLowerCase() });
    expect(getBlockInline(fix.ydoc, fix.id)).toEqual(inline);
    expect(listAnnotationRanges(fix.ydoc, fix.id)).toEqual(anchors);
    await waitFor(() => expect(document.activeElement).toBe(fix.editor.view.dom));
    act(() => { undo(fix.editor.state); });
    expect(snapshotFragment(fix.ydoc)).toEqual(before);
  });

  it("reuses the emoji and curated icon search, stores only valid picks and isolates reset in undo", async () => {
    const fix = await fixture();
    const search = await icons();
    expect(within(screen.getByRole("listbox", { name: "Callout icons" })).getAllByRole("option").length).toBeLessThanOrEqual(8);
    act(() => fireEvent.change(search, { target: { value: "smi" } }));
    await act(async () => screen.getByRole("option", { name: "smiley" }).click());
    expect(getBlocks(fix.ydoc)[0]?.icon).toBe("😃");
    expect(isCalloutIcon(getBlocks(fix.ydoc)[0]?.icon)).toBe(true);
    const next = await icons();
    act(() => fireEvent.change(next, { target: { value: "codex" } }));
    const codex = screen.getByRole("option", { name: "Codex" });
    expect(codex.querySelector('[data-icon="codex"]')).not.toBeNull();
    await act(async () => codex.click());
    expect(getBlocks(fix.ydoc)[0]?.icon).toBe(":codex:");
    await icons();
    await act(async () => screen.getByRole("button", { name: "Use default icon" }).click());
    expect(findBlockElement(fix.ydoc, fix.id)?.getAttribute("icon")).toBeUndefined();
    act(() => { undo(fix.editor.state); });
    expect(getBlocks(fix.ydoc)[0]?.icon).toBe(":codex:");
    act(() => { undo(fix.editor.state); });
    expect(getBlocks(fix.ydoc)[0]?.icon).toBe("😃");
    act(() => { undo(fix.editor.state); });
    expect(getBlocks(fix.ydoc)[0]?.icon).toBe(":claude:");
  });

  it("retains its original target after remote shifts and caret movement", async () => {
    const fix = await fixture();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(fix.ydoc));
    peer.on("update", (update: Uint8Array) => Y.applyUpdate(fix.ydoc, update));
    await open();
    act(() => {
      insertBlock(peer, null, { type: "paragraph", text: "Remote preface" });
      fix.editor.commands.setTextSelection(findBlockById(fix.editor.state.doc, fix.other)!.pos + 2);
    });
    await pick("Important");
    expect(getBlocks(fix.ydoc).find((block) => block.id === fix.id)?.variant).toBe("important");
    expect(getBlocks(fix.ydoc).find((block) => block.id === fix.other)?.variant).toBe("warning");
    expect(fix.editor.state.selection.anchor).toBe(findBlockById(fix.editor.state.doc, fix.id)!.pos + 3);
    peer.destroy();
  });

  it("removes controls in read-only states and refuses a stale selection after permission loss or deletion", async () => {
    let writable = true;
    const fix = await fixture(() => writable);
    await open();
    const caution = screen.getByRole("menuitem", { name: "Caution" });
    const before = snapshotFragment(fix.ydoc);
    writable = false;
    await act(async () => caution.click());
    expect(snapshotFragment(fix.ydoc)).toEqual(before);
    act(() => fix.editor.view.dispatch(fix.editor.state.tr));
    expect(screen.queryByRole("button", { name: "Callout variant" })).toBeNull();
    writable = true;
    act(() => fix.editor.view.dispatch(fix.editor.state.tr));
    await open();
    const stale = screen.getByRole("menuitem", { name: "Caution" });
    await act(async () => deleteBlock(fix.ydoc, fix.id));
    await act(async () => stale.click());
    expect(getBlocks(fix.ydoc)).toMatchObject([{ id: fix.other, variant: "warning" }]);
    act(() => fix.editor.setEditable(false));
    expect(screen.queryByRole("button", { name: "Callout variant" })).toBeNull();
  });
});
