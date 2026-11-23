import { Editor } from "@tiptap/core";
import { expect, it } from "vitest";
import { appendBlock, createAnnotation, getBlockInline } from "@uberblick/schema";
import * as Y from "yjs";
import { Footnotes } from "../src/editor/footnotes.js";
import { paletteExtensions } from "../src/editor/nodes.js";
import { createRevisionInline } from "../src/editor/revision-view.js";
import { createRevisionSplit } from "../src/editor/revision-split.js";
import { mountEditor } from "./helpers.js";

function fixture() {
  const ydoc = new Y.Doc();
  const reference = appendBlock(ydoc, { type: "paragraph", inline: [
    { text: "Read ", marks: {} },
    { text: "[^Source]", marks: { footnoteRef: true } },
    { text: " twice ", marks: {} },
    { text: "[^source]", marks: { footnoteRef: true } },
    { text: " then ", marks: {} },
    { text: "[^absent]", marks: { footnoteRef: true } },
  ] });
  const note = appendBlock(ydoc, { type: "footnote", label: "SOURCE", text: "Note text" });
  appendBlock(ydoc, { type: "footnote", label: "source", text: "Duplicate" });
  appendBlock(ydoc, { type: "footnote", label: "unused", text: "Unused" });
  return { ydoc, reference, note };
}

it("numbers marked references by reading order and labels only the first matching note", () => {
  const { ydoc } = fixture();
  const { editor, element } = mountEditor(ydoc);
  try {
    expect([...element.querySelectorAll(".ub-footnote-reference")].map((item) => item.textContent)).toEqual(["1", "1", "2?"]);
    expect(element.querySelectorAll("a.ub-footnote-reference")).toHaveLength(2);
    expect(element.querySelector(".ub-footnote-unmatched")?.getAttribute("aria-label")).toBe("Footnote 2: note missing");
    expect(element.querySelectorAll(".ub-footnote-number")).toHaveLength(1);
    expect([...element.querySelectorAll(".ub-footnote-backlink")].map((item) => item.textContent)).toEqual(["↩ a", "↩ b"]);
    expect([...element.querySelectorAll(".ub-footnote-unused")].map((item) => item.textContent)).toEqual(["source · unused ", "unused · unused "]);
    expect(element.querySelector("[data-block-type=footnote]")?.classList.contains("ub-footnotes-start")).toBe(true);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("shows a note in stored position and separates only the trailing note run", () => {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "footnote", label: "early", text: "Early" });
  appendBlock(ydoc, { type: "paragraph", inline: [{ text: "[^early]", marks: { footnoteRef: true } }] });
  appendBlock(ydoc, { type: "footnote", label: "orphan", text: "Last" });
  const { editor, element } = mountEditor(ydoc);
  try {
    expect(element.querySelector("[data-block-type=footnote]")?.querySelector(".ub-footnote-number")?.textContent).toBe("1 ");
    expect(element.querySelector(".ub-footnotes-start")?.textContent).toContain("Last");
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("keeps comment marks on the drawn reference without changing stored characters", () => {
  const { ydoc, reference } = fixture();
  const thread = createAnnotation(ydoc, reference, 7, 10, "Reader", "Reference comment");
  const before = getBlockInline(ydoc, reference);
  const { editor, element } = mountEditor(ydoc);
  try {
    const widget = element.querySelector(".ub-footnote-reference");
    expect(widget?.closest("[data-comment-thread]")?.getAttribute("data-comment-thread")).toBe(thread.id);
    expect(getBlockInline(ydoc, reference)).toEqual(before);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("follows both references and returns to the reference followed, with permissions changing in place", () => {
  const { ydoc, note } = fixture();
  const { editor, element } = mountEditor(ydoc);
  try {
    const reference = element.querySelectorAll<HTMLAnchorElement>("a.ub-footnote-reference")[1]!;
    expect(reference.title).toBe("Footnote 1 · Ctrl+Enter beside the reference");
    expect(reference.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    reference.click();
    expect(editor.state.selection.$head.parent.attrs.id).toBe(note);
    editor.commands.insertContentAt(1, "Inserted ");
    const notePosition = editor.state.doc.child(0).nodeSize + 1;
    editor.commands.setTextSelection(notePosition);
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);
    expect(editor.state.doc.textBetween(editor.state.selection.head - 9, editor.state.selection.head)).toBe("[^source]");
    editor.setEditable(false);
    const readonlyReference = element.querySelectorAll<HTMLAnchorElement>("a.ub-footnote-reference")[1]!;
    expect(readonlyReference.tabIndex).toBe(0);
    expect(readonlyReference.title).toBe("Footnote 1");
    expect(readonlyReference.hasAttribute("aria-keyshortcuts")).toBe(false);
    readonlyReference.click();
    expect(document.activeElement).toBe(element.querySelectorAll(".ub-footnote-backlink")[1]);
    (document.activeElement as HTMLAnchorElement).click();
    expect(document.activeElement).toBe(readonlyReference);
    editor.setEditable(true);
    expect(element.querySelector<HTMLAnchorElement>(".ub-footnote-backlink")?.tabIndex).toBe(-1);
    expect(element.querySelector(".ub-footnote-reference")?.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("does not draw literal syntax, unsupported destinations or protected marks", () => {
  const element = document.body.appendChild(document.createElement("div"));
  const editor = new Editor({ element, extensions: [...paletteExtensions, Footnotes], injectCSS: false,
    content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "[^literal]" }] },
      { type: "paragraph", content: [{ type: "text", text: "[^code]", marks: [{ type: "footnoteRef" }, { type: "inlineCode" }] }] },
      { type: "card", content: [{ type: "card-title", content: [{ type: "paragraph", content: [{ type: "text", text: "[^card]", marks: [{ type: "footnoteRef" }] }] }] }] },
    ] } });
  try { expect(element.querySelector(".ub-footnote-reference")).toBeNull(); }
  finally { editor.destroy(); element.remove(); }
});

it("keeps an explicitly marked reference after a literal backslash", () => {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "paragraph", inline: [
    { text: "Literal \\", marks: {} }, { text: "[^source]", marks: { footnoteRef: true } },
  ] });
  appendBlock(ydoc, { type: "footnote", label: "source", text: "Note" });
  const { editor, element } = mountEditor(ydoc);
  try { expect(element.querySelector("a.ub-footnote-reference")?.textContent).toBe("1"); }
  finally { editor.destroy(); ydoc.destroy(); }
});

it("returns to the followed reference after a peer inserts preceding text", () => {
  const { ydoc } = fixture();
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  const { editor, element } = mountEditor(ydoc);
  try {
    element.querySelectorAll<HTMLAnchorElement>("a.ub-footnote-reference")[1]!.click();
    const text = (peer.getXmlFragment("blocks").get(0) as Y.XmlElement).firstChild as Y.XmlText;
    text.insert(0, "Peer ");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(editor.state.doc.textBetween(editor.state.selection.head - 9, editor.state.selection.head)).toBe("[^source]");
  } finally { editor.destroy(); ydoc.destroy(); peer.destroy(); }
});

it.each(["inline", "split"] as const)("follows a reference into an unchanged folded note in %s history", (mode) => {
  const before = new Y.Doc();
  appendBlock(before, { type: "paragraph", text: "Before" });
  appendBlock(before, { type: "paragraph", text: "Unchanged middle" });
  appendBlock(before, { type: "paragraph", text: "More unchanged text" });
  appendBlock(before, { type: "paragraph", text: "More unchanged context" });
  appendBlock(before, { type: "paragraph", text: "Last unchanged context" });
  appendBlock(before, { type: "footnote", label: "source", text: "Unchanged note" });
  const after = new Y.Doc();
  Y.applyUpdate(after, Y.encodeStateAsUpdate(before));
  const first = after.getXmlFragment("blocks").get(0) as Y.XmlElement;
  const text = first.firstChild as Y.XmlText;
  text.delete(0, text.length);
  text.insert(0, "Read ");
  text.insert(5, "[^source] twice [^source]", { footnoteRef: true });
  const left = document.body.appendChild(document.createElement("div"));
  const right = document.body.appendChild(document.createElement("div"));
  const history = mode === "inline"
    ? createRevisionInline({ element: left, before, after, folding: { collapse: true, expanded: new Set() } })
    : createRevisionSplit({ beforeElement: left, afterElement: right, before, after, folding: { collapse: true, expanded: new Set() } });
  try {
    const host = mode === "inline" ? left : right;
    expect(host.querySelector("[data-block-type=footnote]")).toBeNull();
    const reference = host.querySelectorAll<HTMLAnchorElement>(".ub-footnote-reference")[1]!;
    expect(reference.title).toBe("Footnote 1");
    expect(reference.hasAttribute("aria-keyshortcuts")).toBe(false);
    reference.click();
    expect(host.querySelector("[data-block-type=footnote]")).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelectorAll(".ub-footnote-backlink")[1]);
    (document.activeElement as HTMLAnchorElement).click();
    expect(document.activeElement).toBe(host.querySelectorAll(".ub-footnote-reference")[1]);
  } finally { history.destroy(); left.remove(); right.remove(); before.destroy(); after.destroy(); }
});
