import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CARD_PARTS, appendBlock, cardPartElement, cardPartTexts, createAnnotation,
  getBlocks, getBlocksFragment, initDoc, listAnnotationRanges, writeCardButton,
} from "@uberblick/schema";
import type { CardPart } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { BLOCK_MENU_ENTRIES, convertBlockAtTrigger, insertBlockBelow, slashTriggerAt } from "../src/editor/block-menu.js";
import { findForeignBlocks, findLinkConflicts, LINK_CONFLICT } from "../src/editor/palette.js";
import { retypeSelectedBlock } from "../src/editor/retype.js";
import { commentTargetOf } from "../src/editor/selection.js";
import { bindGuardedEditor } from "../src/editor/guarded-binding.js";
import { threadsFromDoc } from "../src/ui/threads.js";
import { mountEditor } from "./helpers.js";
import { onTestCleanup } from "./test-cleanup.js";

const SOURCE = "label: Lever\ntitle: A title\nfooter: Metadata\n\nBody words";

function cardDoc(source = SOURCE): { ydoc: Y.Doc; id: string; card: Y.XmlElement } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "card-doc", title: "Cards" });
  const id = appendBlock(ydoc, { type: "card", text: source });
  return { ydoc, id, card: getBlocksFragment(ydoc).get(0) as Y.XmlElement };
}

function position(editor: Editor, part: CardPart): number {
  const name = `card${part[0]!.toUpperCase()}${part.slice(1)}`;
  let found = -1;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === name) found = pos + 2; });
  expect(found).toBeGreaterThan(0);
  return found;
}

describe("card editor", () => {
  it("binds four shared paragraphs without rewriting their CRDT shape or marks", () => {
    const { ydoc, card } = cardDoc("label: **Lever**\ntitle: *Title*\nfooter: [link](https://example.com)\n\nBody `code`");
    const before = Y.encodeStateAsUpdate(ydoc);
    let updates = 0;
    ydoc.on("update", () => { updates += 1; });
    const { editor } = mountEditor(ydoc);
    expect(editor.view.dom.querySelectorAll(".ub-card [data-card-part]")).toHaveLength(4);
    expect(editor.view.dom.querySelector(".ub-card-label strong")?.textContent).toBe("Lever");
    expect(editor.view.dom.querySelector(".ub-card-title em")?.textContent).toBe("Title");
    expect(editor.view.dom.querySelector(".ub-card-body .ub-inline-code")?.textContent).toBe("code");
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    for (const part of CARD_PARTS) expect(cardPartTexts(card, part)).toHaveLength(1);
  });

  it("preserves the atomic button through binding and prose edits and refuses invalid local button changes", () => {
    const button = "[Discuss in Codex](codex://new?prompt=Review%20this)";
    const { ydoc, card } = cardDoc(`title: A title\nfooter: Metadata\nbutton: ${button}\n\nBody words`);
    const before = Y.encodeStateAsUpdate(ydoc);
    const { editor } = mountEditor(ydoc);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(editor.state.doc.child(0).attrs.button).toBe(button);
    editor.view.dispatch(editor.state.tr.insertText(" more", position(editor, "title") + 7));
    expect(card.getAttribute("button")).toBe(button);
    const valid = writeCardButton({ text: "Reader's **literal** text", href: "claude-cli://open?q=Review" });
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...editor.state.doc.child(0).attrs, button: valid }));
    expect(card.getAttribute("button")).toBe(valid);
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...editor.state.doc.child(0).attrs, button: "[Settings](codex://settings)" }));
    expect(card.getAttribute("button")).toBe(valid);
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
  });

  it.each(CARD_PARTS)("edits, formats and anchors comments in the %s part", (part) => {
    const { ydoc, id, card } = cardDoc();
    const { editor } = mountEditor(ydoc);
    const text = cardPartTexts(card, part)[0]!;
    const before = getBlocks(ydoc)[0]!.rev;
    const at = position(editor, part);
    editor.commands.setTextSelection({ from: at, to: at + 4 });
    expect(editor.commands.toggleMark("bold")).toBe(true);
    expect(getBlocks(ydoc)[0]!.rev).not.toBe(before);
    const target = commentTargetOf(editor, ydoc);
    expect(target).toMatchObject({ blockId: id, part, start: 0, end: 4, clamped: false });
    const thread = createAnnotation(ydoc, id, 0, 4, "Reader", "Discuss this part", { part });
    expect(listAnnotationRanges(ydoc, id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: thread.id, part, start: 0, end: 4 }),
    ]));
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ blockRef: "Card 1", orphaned: false });
    editor.commands.setTextSelection(at + text.length);
    editor.view.dispatch(editor.state.tr.insertText(" changed"));
    expect(cardPartTexts(card, part)[0]).toBe(text);
    expect(text.toString()).toContain("changed");
    expect(getBlocks(ydoc)).toHaveLength(1);
  });

  it("inserts empty cards through both menus with shared empty text and the caret in the title", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "menu-cards", title: "Menus" });
    const id = appendBlock(ydoc, { type: "paragraph", text: "/card" });
    const { editor } = mountEditor(ydoc);
    const entry = BLOCK_MENU_ENTRIES.find((item) => item.type === "card")!;
    editor.commands.setTextSelection(6);
    expect(convertBlockAtTrigger(editor, slashTriggerAt(editor)!, entry)).toBe(true);
    expect(editor.state.selection.$from.node(2).type.name).toBe("cardTitle");
    expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "card" });
    expect(insertBlockBelow(editor, id, entry)).toBe(true);
    expect(editor.state.selection.$from.node(2).type.name).toBe("cardTitle");
    for (const card of getBlocksFragment(ydoc).toArray() as Y.XmlElement[]) {
      for (const part of CARD_PARTS) {
        expect(cardPartTexts(card, part)).toHaveLength(1);
        expect(cardPartTexts(card, part)[0]!.length).toBe(0);
      }
    }
    expect(getBlocks(ydoc)).toHaveLength(2);
    expect(retypeSelectedBlock(editor, "paragraph")).toBe(false);
  });

  it("keeps Enter inside the body paragraph and refuses header splits", () => {
    const { ydoc, card } = cardDoc();
    const { editor } = mountEditor(ydoc);
    editor.commands.setTextSelection(position(editor, "title") + 2);
    editor.commands.keyboardShortcut("Enter");
    expect(cardPartTexts(card, "title")[0]!.toString()).toBe("A title");
    editor.commands.setTextSelection(position(editor, "body") + 4);
    editor.commands.keyboardShortcut("Enter");
    expect(cardPartTexts(card, "body")[0]!.toString()).toBe("Body\n words");
    expect(getBlocks(ydoc)).toHaveLength(1);
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
  });

  it("moves and deletes all parts as one native selected block", () => {
    const { ydoc, id } = cardDoc();
    appendBlock(ydoc, { type: "paragraph", text: "Neighbor" });
    const { editor } = mountEditor(ydoc);
    const card = editor.state.doc.child(0);
    const tr = editor.state.tr.delete(0, card.nodeSize);
    tr.insert(tr.doc.content.size, card);
    editor.view.dispatch(tr);
    expect(getBlocks(ydoc).map((block) => block.type)).toEqual(["paragraph", "card"]);
    expect(getBlocks(ydoc)[1]).toMatchObject({ id, text: SOURCE });
    const pos = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)).deleteSelection());
    expect(getBlocks(ydoc).map((block) => block.type)).toEqual(["paragraph"]);
  });

  it("orders card threads by their part and offset in document order", () => {
    const { ydoc, id } = cardDoc();
    const threads = [...CARD_PARTS].reverse().map((part) =>
      createAnnotation(ydoc, id, 0, 2, "Reader", part, { part }));
    expect(threadsFromDoc(ydoc).map((thread) => thread.id)).toEqual(threads.reverse().map((thread) => thread.id));
  });

  it("gates unsupported card shape before binding and locates link conflicts in every part", () => {
    const { ydoc, card } = cardDoc();
    for (const part of CARD_PARTS) cardPartTexts(card, part)[0]!.format(0, 2, {
      link: { href: "https://example.com" }, docLink: { docId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    });
    expect(findForeignBlocks(getBlocksFragment(ydoc))[0]?.nodeName).toBe(LINK_CONFLICT);
    expect(findLinkConflicts(getBlocksFragment(ydoc)).map((conflict) => conflict.part)).toEqual(CARD_PARTS);
    cardPartElement(card, "title")!.setAttribute("future", "shape");
    const before = card.toJSON();
    expect(findForeignBlocks(getBlocksFragment(ydoc))[0]?.nodeName).toBe("#card-shape");
    expect(card.toJSON()).toEqual(before);
  });

  it("refuses malformed cards before binding and tears down before observing a later unsupported shape", () => {
    const { ydoc, card } = cardDoc();
    const element = document.createElement("div");
    document.body.appendChild(element);
    onTestCleanup(() => element.remove());
    cardPartElement(card, "title")!.setAttribute("future", "shape");
    const before = Y.encodeStateAsUpdate(ydoc);
    const refused = bindGuardedEditor({ element, fragment: getBlocksFragment(ydoc) });
    expect(refused).toMatchObject({ editor: null, refused: true });
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    cardPartElement(card, "title")!.removeAttribute("future");
    let unbound = false;
    const binding = bindGuardedEditor({ element, fragment: getBlocksFragment(ydoc), onUnbind: () => { unbound = true; } });
    onTestCleanup(() => binding.destroy());
    expect(binding.editor).not.toBeNull();
    cardPartElement(card, "body")!.insert(1, [new Y.XmlElement("futureBody")]);
    expect(unbound).toBe(true);
    expect(binding.editor?.isDestroyed).toBe(true);
    expect(cardPartElement(card, "body")!.toArray()).toHaveLength(2);
    expect(cardPartTexts(card, "body")[0]!.toString()).toBe("Body words");
  });
});
