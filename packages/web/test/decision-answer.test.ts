import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import { appendBlock, getBlocks, getBlocksFragment, initDoc, setKind, setStatus } from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import { DECISION_ANSWER_MENU_ENTRIES } from "../src/editor/block-menu.js";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { onTestCleanup } from "./test-cleanup.js";

function fixture(blocks: BlockInput[]) {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "answer", title: "Answer" });
  setKind(ydoc, "decision");
  setStatus(ydoc, "open");
  for (const block of blocks) appendBlock(ydoc, block);
  const element = document.createElement("div");
  document.body.append(element);
  const editor = createUberblickEditor({ element, fragment: getBlocksFragment(ydoc),
    blockMenuEntries: DECISION_ANSWER_MENU_ENTRIES, decisionAnswer: () => true });
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  onTestCleanup(() => { editor.destroy(); element.remove(); ydoc.destroy(); peer.destroy(); });
  return { ydoc, editor, peer };
}

const paragraphs: BlockInput[] = ["First", "Second", "Third"].map((text) => ({ type: "paragraph", text }));

describe("live decision answer shape", () => {
  it.each(["typing", "paste", "drop"])("refuses a fourth block atomically for %s", (source) => {
    const { ydoc, editor } = fixture(paragraphs);
    const before = getBlocks(ydoc);
    const selection = editor.state.selection;
    const tr = editor.state.tr.insertText("Also refused", 1).insert(editor.state.doc.content.size + 12,
      editor.schema.nodes.paragraph!.create(null, editor.schema.text("Fourth")));
    editor.view.dispatch(tr.setMeta("uiEvent", source));
    expect(getBlocks(ydoc)).toEqual(before);
    expect(editor.state.selection).toEqual(selection);
  });

  it.each(["heading", "quote", "callout", "divider", "card", "chart", "figma"])("refuses inserted %s blocks", (type) => {
    const { ydoc, editor } = fixture(paragraphs.slice(0, 1));
    const before = getBlocks(ydoc);
    const forbidden = editor.schema.nodes[type]!.createAndFill();
    if (forbidden === null) throw new Error(`Missing fixture for ${type}`);
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, forbidden).setMeta("uiEvent", "paste"));
    expect(getBlocks(ydoc)).toEqual(before);
  });

  it("counts adjacent list items once and rejects a move that splits the list past three blocks", () => {
    const { ydoc, editor } = fixture([
      { type: "list-item", text: "One", list: "bullet" },
      { type: "list-item", text: "Two", list: "ordered", indent: 1 },
      ...paragraphs.slice(0, 2),
    ]);
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.child(0).nodeSize,
      editor.schema.nodes["list-item"]!.create({ list: "bullet", indent: "0" }, editor.schema.text("Three"))));
    expect(getBlocks(ydoc)).toHaveLength(5);
    const before = getBlocks(ydoc);
    const moved = editor.state.doc.child(1);
    const start = editor.state.doc.child(0).nodeSize;
    const tr = editor.state.tr.delete(start, start + moved.nodeSize);
    editor.view.dispatch(tr.insert(tr.doc.content.size, moved).setMeta("uiEvent", "drop"));
    expect(getBlocks(ydoc)).toEqual(before);
  });

  it("allows repairs to an answer made too long by a peer, without adding blocks or forbidden types", () => {
    const { ydoc, editor, peer } = fixture(paragraphs);
    appendBlock(peer, { type: "paragraph", text: "Concurrent fourth" });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    editor.view.dispatch(editor.state.tr.insertText("Edited ", 1));
    expect(getBlocks(ydoc)[0]?.text).toBe("Edited First");
    const before = getBlocks(ydoc);
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "Fifth" }] });
    expect(getBlocks(ydoc)).toEqual(before);
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, editor.schema.nodes.heading, { level: "2" }));
    expect(getBlocks(ydoc)).toEqual(before);
    const last = editor.state.doc.lastChild!;
    editor.view.dispatch(editor.state.tr.delete(editor.state.doc.content.size - last.nodeSize, editor.state.doc.content.size));
    expect(getBlocks(ydoc)).toHaveLength(3);
  });

  it("checks the shape before the bound collaboration undo writes shared content", () => {
    const { ydoc, editor, peer } = fixture(paragraphs);
    const last = editor.state.doc.lastChild!;
    editor.view.dispatch(editor.state.tr.delete(editor.state.doc.content.size - last.nodeSize, editor.state.doc.content.size));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    appendBlock(peer, { type: "paragraph", text: "Remote third" });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    const before = getBlocks(ydoc);
    undo(editor.state);
    expect(getBlocks(ydoc)).toEqual(before);
    expect(editor.state.doc.childCount).toBe(3);
  });
});
