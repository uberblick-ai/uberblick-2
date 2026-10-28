import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlockInline, getBlocks, getBlocksFragment, initDoc } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { AllSelection } from "@tiptap/pm/state";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { DECISION_ANSWER_MENU_ENTRIES } from "../src/editor/block-menu.js";
import { mountEditor } from "./helpers.js";

function paste(editor: Editor, text: string, html = ""): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => type === "text/plain" ? text : type === "text/html" ? html : "" },
  });
  editor.view.dom.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

function documentWith(type: "paragraph" | "quote" | "code" | "table" = "paragraph"): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "divider-paste", title: "Divider paste" });
  appendBlock(ydoc, { type, text: type === "table" ? "| Cell |\n| --- |" : "" });
  return ydoc;
}

describe("divider clipboard integration", () => {
  it("keeps a divider between paragraphs through text-only clipboard serialization", () => {
    const ydoc = documentWith();
    const { editor } = mountEditor(ydoc);
    try {
      paste(editor, "Before\n\n---\n\nAfter");
      editor.commands.selectAll();
      const copied = editor.view.serializeForClipboard(new AllSelection(editor.state.doc).content());
      expect(copied.text).toBe("Before\n\n---\n\nAfter");
      editor.commands.selectAll();
      paste(editor, copied.text);
      expect(getBlocks(ydoc).map(({ type, text }) => [type, text])).toEqual([
        ["paragraph", "Before"], ["divider", ""], ["paragraph", "After"],
      ]);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it.each(["\n", "\r\n", "\r"])("converts only a literal rule with a blank line above and keeps ordinary line paste (%j)", (newline) => {
    const ydoc = documentWith();
    const { editor } = mountEditor(ydoc);
    try {
      paste(editor, ["# Heading", "", "---", "", "After", "---", "***", "___", "  spaces  "].join(newline));
      expect(getBlocks(ydoc).map(({ type, text }) => [type, text])).toEqual([
        ["paragraph", "# Heading"], ["divider", ""], ["paragraph", "After"],
        ["paragraph", "---"], ["paragraph", "***"], ["paragraph", "___"], ["paragraph", "  spaces  "],
      ]);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("keeps surrounding text and inherited formatting when pasting into prose", () => {
    const ydoc = documentWith();
    const { editor } = mountEditor(ydoc);
    try {
      editor.commands.insertContent("<strong>Ke</strong>ep");
      editor.commands.setTextSelection(3);
      paste(editor, "first\n\n---\n\nlast");
      const blocks = getBlocks(ydoc);
      expect(blocks.map(({ type, text }) => [type, text])).toEqual([
        ["paragraph", "Kefirst"], ["divider", ""], ["paragraph", "lastep"],
      ]);
      expect(getBlockInline(ydoc, blocks[0]?.id ?? "")).toEqual([
        { text: "Kefirst", marks: { bold: true } },
      ]);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it.each(["quote", "code", "table"] as const)("leaves plain hyphens inside %s content", (type) => {
    const ydoc = documentWith(type);
    const { editor } = mountEditor(ydoc);
    try {
      if (type === "table") editor.commands.setTextSelection(4);
      paste(editor, "Before\n\n---\n\nAfter");
      expect(getBlocks(ydoc).some(block => block.type === "divider")).toBe(false);
      expect(editor.view.dom.textContent).toContain("---");
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("keeps rules as text in a decision answer draft", () => {
    const ydoc = documentWith();
    const element = document.createElement("div");
    document.body.appendChild(element);
    const editor = createUberblickEditor({ element, fragment: getBlocksFragment(ydoc), blockMenuEntries: DECISION_ANSWER_MENU_ENTRIES });
    try {
      paste(editor, "Before\n\n---\n\nAfter");
      expect(getBlocks(ydoc).map(({ type, text }) => [type, text])).toEqual([
        ["paragraph", "Before"], ["paragraph", "---"], ["paragraph", "After"],
      ]);
    } finally { editor.destroy(); element.remove(); ydoc.destroy(); }
  });

  it("keeps a rich pasted separator as a childless divider", () => {
    const ydoc = documentWith();
    const { editor } = mountEditor(ydoc);
    try {
      paste(editor, "Before\nAfter", "<p>Before</p><hr><p>After</p>");
      expect(getBlocks(ydoc).map(({ type, text }) => [type, text])).toEqual([
        ["paragraph", "Before"], ["divider", ""], ["paragraph", "After"],
      ]);
      expect((getBlocksFragment(ydoc).get(1) as Y.XmlElement).length).toBe(0);
    } finally { editor.destroy(); ydoc.destroy(); }
  });
});
