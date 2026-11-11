import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Editor } from "@tiptap/core";
import { appendBlock, editBlock, getBlockInline, getBlocks, initDoc } from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import { mountEditor, pastePlainText, typeText } from "./helpers.js";

const editors: Editor[] = [];
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  for (const doc of docs.splice(0)) doc.destroy();
});

function fixture(input: BlockInput = { type: "paragraph", text: "" }) {
  const doc = new Y.Doc();
  docs.push(doc);
  initDoc(doc, { uuid: "web-addresses", title: "Addresses" });
  const id = appendBlock(doc, input);
  const { editor, element } = mountEditor(doc);
  editors.push(editor);
  let first = 1;
  let found = false;
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock && !found) { first = pos + 1; found = true; }
  });
  editor.commands.setTextSelection(first);
  return { doc, id, editor, element };
}

function paste(editor: Editor, plain: string, html = ""): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => type === "text/html" ? html : plain, files: [] },
  });
  editor.view.dom.dispatchEvent(event);
}

describe("web addresses written in prose", () => {
  it.each([
    ["https://example.com.", "https://example.com"],
    ["http://example.com/a_(b)).", "http://example.com/a_(b)"],
    ["www.example.com", "https://www.example.com"],
  ])("links a typed %s only after it is finished, with a separate Undo step", (text, href) => {
    const { doc, id, editor } = fixture();
    typeText(editor, text);
    expect(getBlockInline(doc, id)?.some((run) => run.marks.link)).toBe(false);
    typeText(editor, " ");
    expect(getBlockInline(doc, id)?.find((run) => run.marks.link)?.marks.link).toBe(href);
    expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
    expect(getBlockInline(doc, id)).toEqual([{ text: `${text} `, marks: {} }]);
    typeText(editor, " another word ");
    expect(getBlockInline(doc, id)).toEqual([{ text: `${text}  another word `, marks: {} }]);
  });

  it("finishes an address on Enter using the normal paragraph split", () => {
    const { doc, id, editor } = fixture();
    typeText(editor, "https://example.com");
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(getBlocks(doc)).toHaveLength(2);
    expect(getBlockInline(doc, id)).toEqual([{ text: "https://example.com", marks: { link: "https://example.com" } }]);
    expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
    expect(getBlocks(doc)).toHaveLength(2);
    expect(getBlockInline(doc, id)).toEqual([{ text: "https://example.com", marks: {} }]);
  });

  it("links an address delivered with its finishing space in one text input", () => {
    const { doc, id, editor } = fixture();
    const text = "https://example.com ";
    const handled = editor.view.someProp("handleTextInput", (handler) => handler(
      editor.view, 1, 1, text, () => editor.state.tr.insertText(text, 1, 1),
    ));
    expect(handled).toBe(true);
    expect(getBlockInline(doc, id)).toEqual([
      { text: "https://example.com", marks: { link: "https://example.com" } },
      { text: " ", marks: {} },
    ]);
  });

  it("does not link stored plain addresses or an old address with a newly typed suffix", () => {
    const { doc, id, editor } = fixture({ type: "paragraph", text: "https://example.com" });
    editor.commands.setTextSelection(20);
    typeText(editor, "/new ");
    expect(getBlockInline(doc, id)).toEqual([{ text: "https://example.com/new ", marks: {} }]);
    typeText(editor, "https://fresh.example ");
    expect(getBlockInline(doc, id)?.filter((run) => run.marks.link)).toEqual([
      { text: "https://fresh.example", marks: { link: "https://fresh.example" } },
    ]);
  });

  it("does not link programmatic or remote writes on a later keystroke", () => {
    const { doc, id, editor } = fixture();
    typeText(editor, "some ");
    editBlock(doc, id, "some ", "https://example.com");
    editor.commands.setTextSelection(20);
    typeText(editor, " ");
    expect(getBlockInline(doc, id)).toEqual([{ text: "https://example.com ", marks: {} }]);
  });

  it("links addresses throughout a paste and Undo restores the pasted text", () => {
    const { doc, id, editor } = fixture();
    const text = "See https://example.com. Also www.example.org/a_(b)).";
    paste(editor, text);
    expect(getBlockInline(doc, id)).toEqual([
      { text: "See ", marks: {} },
      { text: "https://example.com", marks: { link: "https://example.com" } },
      { text: ". Also ", marks: {} },
      { text: "www.example.org/a_(b)", marks: { link: "https://www.example.org/a_(b)" } },
      { text: ").", marks: {} },
    ]);
    expect(editor.commands.keyboardShortcut("Mod-z")).toBe(true);
    expect(getBlockInline(doc, id)).toEqual([{ text, marks: {} }]);
    typeText(editor, " ");
    expect(getBlockInline(doc, id)).toEqual([{ text: `${text} `, marks: {} }]);
  });

  it("waits for paste formatting and preserves inline code", () => {
    const { doc, id, editor } = fixture();
    pastePlainText(editor, "**https://example.com** `https://source.example` www.example.org");
    expect(getBlockInline(doc, id)).toEqual([
      { text: "https://example.com", marks: { bold: true, link: "https://example.com" } },
      { text: " ", marks: {} },
      { text: "https://source.example", marks: { inlineCode: true } },
      { text: " ", marks: {} },
      { text: "www.example.org", marks: { link: "https://www.example.org" } },
    ]);
  });

  it("preserves the full prose boundary while matching only pasted characters", () => {
    const { doc, id, editor } = fixture({ type: "paragraph", text: "x" });
    editor.commands.setTextSelection(2);
    paste(editor, "https://example.com");
    expect(getBlockInline(doc, id)).toEqual([{ text: "xhttps://example.com", marks: {} }]);
    editor.commands.setTextSelection({ from: 1, to: 21 });
    paste(editor, "https://example.com");
    expect(getBlockInline(doc, id)).toEqual([{ text: "https://example.com", marks: { link: "https://example.com" } }]);
  });

  it("keeps HTML external and document link targets, and code, unchanged", () => {
    const { doc, id, editor } = fixture();
    const target = "11111111-2222-4333-8444-555555555555";
    paste(editor, "", `<p><a href="https://target.example">https://label.example</a> <a data-doc-id="${target}">www.document.example</a> <code>https://code.example</code> https://fresh.example</p>`);
    expect(getBlockInline(doc, id)).toEqual([
      { text: "https://label.example", marks: { link: "https://target.example" } },
      { text: " ", marks: {} },
      { text: "www.document.example", marks: { docLink: target } },
      { text: " ", marks: {} },
      { text: "https://code.example", marks: { inlineCode: true } },
      { text: " ", marks: {} },
      { text: "https://fresh.example", marks: { link: "https://fresh.example" } },
    ]);
  });

  it("links both sides of an HTML line break", () => {
    const { editor } = fixture();
    paste(editor, "", "<p>https://first.example<br>https://second.example</p>");
    expect([...editor.view.dom.querySelectorAll("a.ub-link")].map((link) => link.getAttribute("href"))).toEqual([
      "https://first.example", "https://second.example",
    ]);
  });

  it.each(["code", "terminal", "chart"] as const)("keeps typed and pasted addresses literal in %s source", (type) => {
    const input: BlockInput = type === "terminal" ? { type, text: "" } : type === "chart"
      ? { type, text: "type: line\nx: x\nseries: y\n\nx,y\n0,1" } : { type, text: "" };
    const { doc, editor, element } = fixture(input);
    let at = 1;
    editor.state.doc.descendants((node, pos) => { if (node.isTextblock) { at = pos + 1; return false; } return true; });
    editor.commands.setTextSelection(at);
    typeText(editor, "https://example.com ");
    pastePlainText(editor, "www.example.org");
    expect(element.querySelector("a.ub-link")).toBeNull();
    expect(getBlocks(doc)[0]?.text).toContain("https://example.com www.example.org");
  });

  it("links a plain paste in a table cell without changing cell paste normalization", () => {
    const { doc, id, editor } = fixture({ type: "table", text: "| Header |\n| --- |\n| |" });
    editor.commands.setTextSelection(4);
    paste(editor, "See\nwww.example.org ");
    expect(getBlocks(doc).find((block) => block.id === id)?.type).toBe("table");
    expect(editor.view.dom.querySelector("th")?.textContent).toBe("See www.example.org Header");
    expect(editor.view.dom.querySelector("th a.ub-link")?.getAttribute("href")).toBe("https://www.example.org");
  });

  it("retains the lone GitHub and empty-line Figma paste shortcuts", () => {
    const github = fixture();
    paste(github.editor, "https://github.com/owner/repo/issues/12");
    expect(getBlockInline(github.doc, github.id)).toEqual([
      { text: "owner/repo#12", marks: { link: "https://github.com/owner/repo/issues/12" } },
    ]);
    const figma = fixture();
    paste(figma.editor, "https://www.figma.com/design/key/Checkout");
    expect(getBlocks(figma.doc)[0]?.type).toBe("figma");
  });
});
