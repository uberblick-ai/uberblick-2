import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Editor } from "@tiptap/core";
import { AllSelection, NodeSelection } from "@tiptap/pm/state";
import { appendBlock, createAnnotation, getBlockInline, getBlocks } from "@uberblick/schema";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { getBlocksFragment } from "@uberblick/schema";
import { mountEditor } from "./helpers.js";

function key(editor: Editor, name: string, shiftKey = false): boolean {
  return editor.view.someProp("handleKeyDown", (handler) =>
    handler(editor.view, new KeyboardEvent("keydown", { key: name, shiftKey }))) === true;
}

function paste(editor: Editor, html: string): void {
  const content = document.createElement("div");
  content.innerHTML = html;
  const event = new Event("paste") as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: {
    getData: (type: string) => type === "text/plain" ? content.textContent ?? "" : html,
  } });
  expect(editor.view.pasteHTML(html, event)).toBe(true);
}

function fixture(noteText = "Before after") {
  const ydoc = new Y.Doc();
  const body = appendBlock(ydoc, { type: "paragraph", inline: [
    { text: "Read ", marks: {} }, { text: "[^source]", marks: { footnoteRef: true } }, { text: " next", marks: {} },
  ] });
  const note = appendBlock(ydoc, { type: "footnote", label: "source", text: noteText });
  const mounted = mountEditor(ydoc);
  const notePos = (): number => mounted.editor.state.doc.firstChild?.nodeSize ?? 0;
  return { ydoc, body, note, notePos, ...mounted };
}

describe("footnote editing boundaries", () => {
  it("crosses a formatted reference as one caret unit and deletes it as one unit from either side", () => {
    const { editor, ydoc, body } = fixture();
    try {
      editor.commands.setTextSelection(6);
      expect(key(editor, "ArrowRight")).toBe(true);
      expect(editor.state.selection.from).toBe(15);
      expect(key(editor, "ArrowLeft")).toBe(true);
      expect(editor.state.selection.from).toBe(6);
      expect(key(editor, "Delete")).toBe(true);
      expect(getBlocks(ydoc)[0]?.text).toBe("Read  next");
      expect(getBlockInline(ydoc, body)?.some((run) => run.marks.footnoteRef)).toBe(false);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("expands a selection touching reference characters before deleting it", () => {
    const { editor, ydoc } = fixture();
    try {
      editor.commands.setTextSelection({ from: 8, to: 11 });
      expect(editor.state.selection.from).toBe(6);
      expect(editor.state.selection.to).toBe(15);
      editor.commands.deleteSelection();
      expect(getBlocks(ydoc)[0]?.text).toBe("Read  next");
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("keeps atomic reference ranges when comment and formatting marks divide their characters", () => {
    const ydoc = new Y.Doc();
    const id = appendBlock(ydoc, { type: "paragraph", inline: [{ text: "[^source]", marks: { footnoteRef: true } }] });
    createAnnotation(ydoc, id, 2, 6, "Reader", "Within the reference");
    const { editor } = mountEditor(ydoc);
    try {
      const bold = editor.schema.marks.bold;
      if (bold === undefined) throw new Error("The editor needs the bold mark");
      editor.view.dispatch(editor.state.tr.addMark(1, 5, bold.create()));
      editor.commands.setTextSelection(10);
      expect(key(editor, "Backspace")).toBe(true);
      expect(getBlocks(ydoc)[0]?.text).toBe("");
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("blocks splitting and joining notes and removes an empty note whole", () => {
    const { editor, ydoc, note, notePos } = fixture("Written");
    try {
      editor.commands.setTextSelection(notePos() + 4);
      expect(key(editor, "Enter")).toBe(true);
      editor.commands.setTextSelection(notePos() + 1);
      expect(key(editor, "Backspace")).toBe(true);
      editor.commands.setTextSelection(notePos() + 8);
      expect(key(editor, "Delete")).toBe(true);
      editor.commands.setTextSelection(notePos() - 1);
      expect(key(editor, "Delete")).toBe(true);
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, notePos())));
      expect(key(editor, "Enter")).toBe(true);
      expect(getBlocks(ydoc)).toHaveLength(2);
      expect(getBlocks(ydoc)[1]).toMatchObject({ id: note, label: "source", text: "Written" });
      editor.commands.setTextSelection({ from: notePos() + 1, to: notePos() + 8 });
      editor.commands.deleteSelection();
      expect(key(editor, "Backspace")).toBe(true);
      expect(getBlocks(ydoc)).toHaveLength(1);
      expect(getBlocks(ydoc)[0]?.text).toContain("[^source]");
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it.each([
    ["two paragraphs", "<p>first</p><p>second</p>", "first second", false],
    ["two formatted paragraphs", "<p><strong>first</strong></p><p><em>second</em></p>", "first second", false],
    ["one list item", "<ul><li><strong>first</strong></li></ul>", "first", true],
    ["one heading", "<h2><em>first</em></h2>", "first", true],
    ["embedded line breaks", "<p><strong>first\nsecond</strong></p>", "first second", false],
    ["a whole note", '<p data-block-type="footnote" data-footnote-label="other"><strong>first</strong></p>', "first", true],
  ] as const)("keeps %s pasted in the middle inside the same note", (_name, html, inserted, formatted) => {
    const { editor, ydoc, note, notePos } = fixture();
    try {
      editor.commands.setTextSelection(notePos() + 8);
      paste(editor, html);
      expect(getBlocks(ydoc).map(({ type, label, text }) => ({ type, label, text }))).toEqual([
        { type: "paragraph", label: undefined, text: "Read [^source] next" },
        { type: "footnote", label: "source", text: `Before ${inserted}after` },
      ]);
      expect(getBlocks(ydoc)[1]?.id).toBe(note);
      const marked = getBlockInline(ydoc, note)?.some((run) => run.marks.bold || run.marks.italic);
      expect(marked).toBe(formatted);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("retains a copied whole note and its label when pasted into an empty body paragraph", () => {
    const { editor: source, ydoc: sourceDoc, notePos } = fixture();
    const destination = new Y.Doc();
    appendBlock(destination, { type: "paragraph", text: "" });
    const { editor } = mountEditor(destination);
    try {
      source.view.dispatch(source.state.tr.setSelection(NodeSelection.create(source.state.doc, notePos())));
      const copied = source.view.serializeForClipboard(source.state.selection.content());
      editor.commands.setTextSelection(1);
      paste(editor, copied.dom.innerHTML);
      expect(getBlocks(destination)).toMatchObject([{ type: "footnote", label: "source", text: "Before after" }]);
    } finally { source.destroy(); editor.destroy(); sourceDoc.destroy(); destination.destroy(); }
  });

  it("replaces a selection crossing into a note by removing that note whole", () => {
    const { editor, ydoc, notePos } = fixture();
    try {
      editor.commands.setTextSelection({ from: 16, to: notePos() + 5 });
      paste(editor, "<p>replacement</p>");
      expect(getBlocks(ydoc)).toMatchObject([{ type: "paragraph", text: "Read [^source] replacement" }]);
      expect(getBlocks(ydoc)).toHaveLength(1);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it.each([
    ["table", "| Header |\n| --- |\n| Cell |"],
    ["card", "title: Title\n\nBody"],
  ] as const)("keeps a reference pasted into %s prose as literal characters", (type, text) => {
    const ydoc = new Y.Doc();
    appendBlock(ydoc, { type, text });
    const { editor } = mountEditor(ydoc);
    try {
      let paragraph = -1;
      editor.state.doc.descendants((node, pos) => {
        if (paragraph === -1 && node.type.name === "paragraph") paragraph = pos + 1;
      });
      expect(paragraph).toBeGreaterThan(0);
      editor.commands.setTextSelection(paragraph);
      paste(editor, '<p><span data-footnote-ref>[^other]</span></p>');
      const textNodes: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.isText && node.text?.includes("other")) {
          textNodes.push(node.text);
          expect(node.marks.some((mark) => mark.type.name === "footnoteRef")).toBe(false);
        }
      });
      expect(textNodes.join("")).toContain("[^other]");
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it.each(["inlineCode", "link"])("pastes a reference into %s as literal text", (mark) => {
    const { editor, ydoc, body } = fixture();
    try {
      editor.commands.setTextSelection(2);
      editor.commands.setMark(mark, mark === "link" ? { href: "https://example.org" } : {});
      paste(editor, '<p><span data-footnote-ref>[^other]</span></p>');
      expect(getBlocks(ydoc)[0]?.text).toContain("[^other]");
      expect(getBlockInline(ydoc, body)?.filter((run) => run.text.includes("other")).every((run) => !run.marks.footnoteRef)).toBe(true);
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it("strips pasted reference marks in a decision answer", () => {
    const ydoc = new Y.Doc();
    const id = appendBlock(ydoc, { type: "paragraph", text: "Answer " });
    const element = document.createElement("div");
    document.body.append(element);
    const editor = createUberblickEditor({ element, fragment: getBlocksFragment(ydoc), decisionAnswer: () => true });
    try {
      editor.commands.setTextSelection(8);
      paste(editor, '<p><span data-footnote-ref>[^other]</span></p>');
      expect(getBlocks(ydoc)[0]?.text).toBe("Answer [^other]");
      expect(getBlockInline(ydoc, id)?.every((run) => !run.marks.footnoteRef)).toBe(true);
    } finally { editor.destroy(); element.remove(); ydoc.destroy(); }
  });

  it("keeps references and notes through whole-document HTML copy", () => {
    const { editor: source, ydoc: sourceDoc } = fixture();
    const ydoc = new Y.Doc();
    appendBlock(ydoc, { type: "paragraph", text: "" });
    const { editor } = mountEditor(ydoc);
    try {
      const copied = source.view.serializeForClipboard(new AllSelection(source.state.doc).content());
      editor.commands.setTextSelection(1);
      paste(editor, copied.dom.innerHTML);
      expect(getBlocks(ydoc)).toMatchObject([
        { type: "paragraph", text: "Read [^source] next" }, { type: "footnote", label: "source", text: "Before after" },
      ]);
      const id = getBlocks(ydoc)[0]?.id;
      expect(id === undefined ? [] : getBlockInline(ydoc, id)?.filter((run) => run.marks.footnoteRef).map((run) => run.text)).toEqual(["[^source]"]);
    } finally { source.destroy(); editor.destroy(); sourceDoc.destroy(); ydoc.destroy(); }
  });
});
