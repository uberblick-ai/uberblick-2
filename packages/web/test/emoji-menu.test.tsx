import { beforeAll, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { redo, undo } from "y-prosemirror";
import {
  CARD_PARTS, appendBlock, deleteBlock, editBlock, getBlocks, getBlocksFragment,
  initDoc, tableCellText, tableRows, writeGfmTable,
} from "@uberblick/schema";
import { emojiTriggerAt, pickEmojiAtTrigger } from "../src/editor/emoji-menu.js";
import { filterEmoji, loadEmojiData } from "../src/editor/emoji-data.js";
import { EmojiMenu } from "../src/ui/editor-controls/EmojiMenu.js";
import { mountEditor, pastePlainText, typeText } from "./helpers.js";
import { act, render } from "./react-render.js";
import { onTestCleanup } from "./test-cleanup.js";

type Block = Parameters<typeof appendBlock>[1];

function documentFor(block: Block = { type: "paragraph", text: "" }) {
  const ydoc = new Y.Doc();
  onTestCleanup(() => ydoc.destroy());
  initDoc(ydoc, { uuid: "emoji-document", title: "Emoji" });
  const id = appendBlock(ydoc, block);
  return { ydoc, id };
}

function mountPicker(ydoc: Y.Doc) {
  const { editor, element } = mountEditor(ydoc);
  const frame = document.createElement("div");
  document.body.appendChild(frame);
  frame.appendChild(element);
  const container = document.createElement("div");
  frame.appendChild(container);
  const mounted = render(<EmojiMenu editor={editor} host={{ current: frame }} />, { container });
  onTestCleanup(() => { mounted.unmount(); frame.remove(); });
  return {
    editor,
    card: () => document.body.querySelector('[data-slot="caret-menu-content"]'),
    labels: () => screen.queryAllByRole("option").map((row) => row.getAttribute("aria-label")),
    press(key: string, init: KeyboardEventInit = {}) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      act(() => { editor.view.dom.dispatchEvent(event); });
      return event;
    },
    pick(label: string) {
      act(() => { screen.getByRole("option", { name: label }).click(); });
    },
  };
}

async function type(editor: Editor, text: string): Promise<void> {
  await act(async () => {
    typeText(editor, text);
    await loadEmojiData();
  });
}

function caret(editor: Editor, position: number): void {
  act(() => { editor.commands.setTextSelection(position); });
}

function partPosition(editor: Editor, name: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === name) found = pos + 2;
  });
  expect(found).toBeGreaterThan(0);
  return found;
}

function peerOf(local: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  peer.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  onTestCleanup(() => peer.destroy());
  return peer;
}

function cell(ydoc: Y.Doc, row = 1, column = 0): Y.XmlText {
  const table = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
  return tableCellText(tableRows(table)[row]![column]!)!;
}

beforeAll(async () => { await loadEmojiData(); });

describe("emoji and icon picking", () => {
  it("ranks names before keywords, caps rows at eight, and inserts the first emoji as text", async () => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, "Thanks :smi");
    expect(mounted.labels()[0]).toBe("smiley");
    expect(mounted.labels()).toEqual(expect.arrayContaining(["smile", "smirk"]));
    expect(mounted.labels().length).toBeLessThanOrEqual(8);
    expect(screen.getByRole("option", { name: "smiley" }).textContent).toContain("😃");
    expect(mounted.press("Enter").defaultPrevented).toBe(true);
    expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["Thanks 😃"]);
    expect(mounted.card()).toBeNull();
    act(() => { undo(mounted.editor.state); });
    expect(getBlocks(ydoc)[0]?.text).toBe("Thanks :smi");
    expect(mounted.card()).toBeNull();
  });

  it("finds smiley through its happy keyword", async () => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, ":hap");
    expect(mounted.labels()).toContain("smiley");
    expect(mounted.labels().length).toBeLessThanOrEqual(8);
    mounted.pick("smiley");
    expect(getBlocks(ydoc)[0]?.text).toBe("😃");
  });

  it("moves the highlight with both arrows and picks with Tab", async () => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, ":smi");
    mounted.press("ArrowDown");
    expect(screen.getByRole("option", { name: "smile" }).getAttribute("aria-selected")).toBe("true");
    mounted.press("ArrowUp");
    expect(screen.getByRole("option", { name: "smiley" }).getAttribute("aria-selected")).toBe("true");
    mounted.press("ArrowDown");
    expect(mounted.press("Tab").defaultPrevented).toBe(true);
    expect(getBlocks(ydoc)[0]?.text).toBe("😄");
  });

  it("clicks the Claude mark in a cell, preserving the shortcode through sync, reload and undo", async () => {
    const { ydoc } = documentFor({ type: "table", text: writeGfmTable([["Header", "Other"], ["", "Body"]]) });
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc);
    let position = -1;
    mounted.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.textContent === "") position = pos + 1;
    });
    caret(mounted.editor, position);
    await type(mounted.editor, ":cla");
    mounted.pick("Claude");
    expect(cell(ydoc).toDelta()).toEqual([{ insert: ":claude:" }]);
    expect(cell(peer).toDelta()).toEqual([{ insert: ":claude:" }]);
    expect(mounted.editor.view.dom.querySelector('td [data-icon="claude"]')).not.toBeNull();
    const restored = new Y.Doc();
    onTestCleanup(() => restored.destroy());
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(ydoc));
    const reloaded = mountEditor(restored).editor;
    expect(reloaded.view.dom.querySelector('td [data-icon="claude"]')).not.toBeNull();
    expect(getBlocks(restored)).toEqual(getBlocks(ydoc));
    act(() => { undo(mounted.editor.state); });
    expect(cell(ydoc).toDelta()).toEqual([{ insert: ":cla" }]);
    expect(mounted.card()).toBeNull();
  });

  it.each(["paragraph", "heading", "list-item", "quote"] as const)("opens in %s prose", async (blockType) => {
    const block: Block = blockType === "heading" ? { type: blockType, text: "", level: 2 }
      : blockType === "list-item" ? { type: blockType, text: "", list: "bullet", indent: 0 }
      : { type: blockType, text: "" };
    const { ydoc } = documentFor(block);
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, ":smi");
    expect(mounted.labels()[0]).toBe("smiley");
    mounted.press("Enter");
    expect(getBlocks(ydoc)[0]).toMatchObject({ type: blockType, text: "😃" });
  });

  it.each(CARD_PARTS)("opens and inserts in the card %s", async (part) => {
    const { ydoc } = documentFor({ type: "card", text: "label: Label\ntitle: Title\nfooter: Footer\n\nBody" });
    const mounted = mountPicker(ydoc);
    const name = `card${part[0]!.toUpperCase()}${part.slice(1)}`;
    caret(mounted.editor, partPosition(mounted.editor, name));
    await type(mounted.editor, ":smi");
    expect(mounted.labels()[0]).toBe("smiley");
    mounted.press("Enter");
    expect(getBlocks(ydoc)[0]?.text).toContain("😃");
  });

  it("opens and inserts in a Figma caption", async () => {
    const { ydoc } = documentFor({ type: "figma", text: "url: https://www.figma.com/design/key/Checkout-flow\n\nCaption" });
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, partPosition(mounted.editor, "figmaCaption"));
    await type(mounted.editor, ":smi");
    expect(mounted.labels()[0]).toBe("smiley");
    mounted.press("Enter");
    expect(getBlocks(ydoc)[0]?.text).toContain("😃Caption");
  });

  it.each(["code", "terminal", "chart"] as const)("leaves %s source literal", async (blockType) => {
    const { ydoc } = documentFor({ type: blockType, text: "" });
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, ":smiley:");
    expect(emojiTriggerAt(mounted.editor)).toBeNull();
    expect(mounted.card()).toBeNull();
    expect(getBlocks(ydoc)[0]?.text).toBe(":smiley:");
  });

  it("leaves inline code literal and refuses a read-only editor", async () => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    act(() => { mounted.editor.commands.setMark("inlineCode"); });
    await type(mounted.editor, ":smiley:");
    expect(mounted.card()).toBeNull();
    expect(getBlocks(ydoc)[0]?.text).toBe(":smiley:");
    expect(mounted.editor.view.dom.querySelector("code")?.textContent).toBe(":smiley:");
    act(() => { mounted.editor.commands.unsetMark("inlineCode"); });
    await type(mounted.editor, " :smi");
    const trigger = emojiTriggerAt(mounted.editor)!;
    expect(trigger).not.toBeNull();
    act(() => { mounted.editor.setEditable(false); });
    expect(emojiTriggerAt(mounted.editor)).toBeNull();
    expect(mounted.card()).toBeNull();
    const before = getBlocks(ydoc);
    const smiley = filterEmoji(await loadEmojiData(), "smiley")[0]!;
    expect(pickEmojiAtTrigger(mounted.editor, trigger, smiley)).toBe(false);
    expect(getBlocks(ydoc)).toEqual(before);
  });

  it.each(["Meet at 10:30", "Note: see below", ":s", "https://example.com"])("does not offer a menu for %j", async (text) => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, text);
    expect(mounted.card()).toBeNull();
    expect(getBlocks(ydoc)[0]?.text).toBe(text);
  });

  it.each(["Escape", "space", "caret", "no match"])("dismisses on %s and preserves typed text", async (gesture) => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, ":smi");
    expect(mounted.card()).not.toBeNull();
    if (gesture === "Escape") mounted.press("Escape");
    else if (gesture === "space") await type(mounted.editor, " ");
    else if (gesture === "caret") caret(mounted.editor, 1);
    else await type(mounted.editor, "zzzz");
    expect(mounted.card()).toBeNull();
    expect(getBlocks(ydoc)[0]?.text).toBe(gesture === "space" ? ":smi " : gesture === "no match" ? ":smizzzz" : ":smi");
    if (gesture === "Escape") {
      await type(mounted.editor, "l");
      expect(mounted.card()).toBeNull();
      await type(mounted.editor, " :smi");
      expect(mounted.card()).not.toBeNull();
    }
  });

  it("gives Enter back to paragraph editing while closed", async () => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, ":smi");
    mounted.press("Escape");
    mounted.press("Enter");
    expect(getBlocks(ydoc).map((block) => block.text)).toEqual([":smi", ""]);
  });

  it("never opens from existing text, a paste, undo, redo or a collaborator edit", async () => {
    const { ydoc, id } = documentFor({ type: "paragraph", text: ":smi" });
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 5);
    expect(emojiTriggerAt(mounted.editor)).not.toBeNull();
    expect(mounted.card()).toBeNull();
    act(() => { pastePlainText(mounted.editor, " :smi"); });
    expect(mounted.card()).toBeNull();
    act(() => { undo(mounted.editor.state); });
    expect(mounted.card()).toBeNull();
    act(() => { redo(mounted.editor.state); });
    expect(mounted.card()).toBeNull();
    act(() => { editBlock(peer, id, ":smi :smi", ":smi :smi :smi"); });
    expect(mounted.card()).toBeNull();
  });

  it("refuses a saved pick after the query changed or its block disappeared", async () => {
    const { ydoc, id } = documentFor();
    appendBlock(ydoc, { type: "paragraph", text: "Neighbour" });
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, ":smi");
    const trigger = emojiTriggerAt(mounted.editor)!;
    const smiley = filterEmoji(await loadEmojiData(), "smiley")[0]!;
    await type(mounted.editor, "l");
    const before = getBlocks(ydoc);
    expect(pickEmojiAtTrigger(mounted.editor, trigger, smiley)).toBe(false);
    expect(getBlocks(ydoc)).toEqual(before);
    act(() => { deleteBlock(peer, id); });
    expect(pickEmojiAtTrigger(mounted.editor, trigger, smiley)).toBe(false);
    expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["Neighbour"]);
  });

  it.each(["caret", "peer"])("refuses an old rendered callback before the %s update commits", async (change) => {
    const { ydoc } = documentFor();
    const peer = peerOf(ydoc);
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, ":smi");
    const row = screen.getByRole("option", { name: "smiley" });
    act(() => {
      if (change === "caret") mounted.editor.commands.setTextSelection(1);
      else peer.transact(() => {
        const text = (getBlocksFragment(peer).get(0) as Y.XmlElement).firstChild as Y.XmlText;
        text.delete(0, 4);
        text.insert(0, ":smi");
      });
      row.click();
    });
    expect(getBlocks(ydoc)[0]?.text).toBe(":smi");
    expect(mounted.card()).toBeNull();
  });
});

describe("typed emoji conversion", () => {
  it.each([[":smiley:", "😃"], ["Thanks :rocket:", "Thanks 🚀"]])("converts %s and one undo restores the complete literal", async (text, converted) => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, text);
    expect(getBlocks(ydoc)[0]?.text).toBe(converted);
    expect(mounted.card()).toBeNull();
    act(() => { undo(mounted.editor.state); });
    expect(getBlocks(ydoc)[0]?.text).toBe(text);
    expect(mounted.card()).toBeNull();
  });

  it.each([":claude:", ":codex:", ":github:", ":not-an-emoji:", "word:smiley:"])("keeps %s literal", async (text) => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    await type(mounted.editor, text);
    expect(getBlocks(ydoc)[0]?.text).toBe(text);
  });

  it("keeps pasted complete emoji names literal", () => {
    const { ydoc } = documentFor();
    const mounted = mountPicker(ydoc);
    caret(mounted.editor, 1);
    act(() => { pastePlainText(mounted.editor, ":rocket: :smiley:"); });
    expect(getBlocks(ydoc)[0]?.text).toBe(":rocket: :smiley:");
    expect(mounted.card()).toBeNull();
  });
});
