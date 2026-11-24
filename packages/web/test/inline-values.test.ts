import { waitFor } from "@testing-library/dom";
import { expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import { appendBlock, applyDocData, createAnnotation, getBlockInline, getBlocks, getBlocksFragment, getMetaMap, linkifyInline, referenceInline } from "@uberblick/schema";
import type { CollectionSchema, DataRecord } from "@uberblick/schema";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { inlineValueRanges } from "../src/editor/inline-values.js";
import { tableCellFormatter } from "../src/editor/table-data.js";
import { mountEditor, pastePlainText, typeText } from "./helpers.js";

const schema: CollectionSchema = { version: 1, schema: { type: "object" } };
const config = { collection: "results", filter: { system: "Whisper turbo" }, field: "wer", format: "number" as const, decimals: 1 };
const source = `:value${JSON.stringify(config)}`;
const record: DataRecord = { id: "whisper", value: { system: "Whisper turbo", wer: 10.01 } };

function fixture(text = `Before ${source} after`) {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "paragraph", text });
  const workspace = new Y.Doc();
  applyDocData(ydoc, workspace, [{ collection: "results", schema, upsert: [record] }]);
  const mounted = mountEditor(ydoc);
  return { ydoc, workspace, ...mounted, destroy: () => { mounted.editor.destroy(); workspace.destroy(); ydoc.destroy(); } };
}

function key(editor: Editor, name: string, shiftKey = false): boolean {
  return editor.view.someProp("handleKeyDown", (handler) =>
    handler(editor.view, new KeyboardEvent("keydown", { key: name, shiftKey }))) === true;
}

it.each([true, false])("reads live data using exactly the table formatter without prose writes (editable %s)", async (editable) => {
  const f = fixture();
  try {
    f.editor.setEditable(editable);
    const value = () => f.element.querySelector<HTMLElement>(".ub-inline-value");
    await waitFor(() => expect(value()?.textContent).toBe(tableCellFormatter(config)(record).text));
    expect(value()?.title).toBe('results › system = "Whisper turbo" › wer, number, 1 decimal');
    const blocks = getBlocks(f.ydoc);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(f.ydoc));
    let writes = 0;
    f.ydoc.on("update", (_update, origin) => { if (origin !== "peer") writes += 1; });
    try {
      applyDocData(peer, f.workspace, [{ collection: "results", upsert: [{ ...record, value: { ...record.value, wer: 7.43 } }] }]);
      Y.applyUpdate(f.ydoc, Y.encodeStateAsUpdate(peer), "peer");
      await waitFor(() => expect(value()?.textContent).toBe("7.4"));
      expect(getBlocks(f.ydoc)).toEqual(blocks);
      expect(writes).toBe(0);
    } finally { peer.destroy(); }
  } finally { f.destroy(); }
});

it.each([
  ["wer", { system: "Whisper turbo" }, "Absent", "absent"],
  ["wer", { system: "Whisper turbo", wer: null }, "Null", "null"],
  ["wer", { system: "Whisper turbo", wer: "10" }, "Invalid: 10", "invalid"],
] as const)("keeps the table cell's %s marker for %j", async (_field, value, text, state) => {
  const f = fixture();
  try {
    applyDocData(f.ydoc, f.workspace, [{ collection: "results", upsert: [{ id: record.id, value }] }]);
    await waitFor(() => {
      const widget = f.element.querySelector(".ub-inline-value");
      expect(widget?.textContent).toBe(text);
      expect(widget?.getAttribute("data-value-state")).toBe(state);
      expect(widget?.getAttribute("aria-label")).toContain(text);
    });
  } finally { f.destroy(); }
});

it("preserves source punctuation through typed and pasted formatting and address rules", async () => {
  const f = fixture("");
  const literal = `:value${JSON.stringify({ ...config, filter: { system: '*bold* _italic_ `code` [^note] [label](https://example.org) :claude: https://example.org next' } })}`;
  try {
    typeText(f.editor, literal);
    expect(getBlocks(f.ydoc)[0]?.text).toBe(literal);
    expect(getBlockInline(f.ydoc, getBlocks(f.ydoc)[0]!.id)).toEqual([{ text: literal, marks: {} }]);
    await waitFor(() => expect(f.element.querySelectorAll(".ub-inline-value")).toHaveLength(1));
    expect(f.element.querySelector(".ub-inline-icon")).toBeNull();
    expect(f.element.querySelector(".ub-footnote-reference")).toBeNull();
    f.editor.commands.selectAll();
    pastePlainText(f.editor, literal);
    expect(getBlocks(f.ydoc)[0]?.text).toBe(literal);
    expect(getBlockInline(f.ydoc, getBlocks(f.ydoc)[0]!.id)).toEqual([{ text: literal, marks: {} }]);
  } finally { f.destroy(); }
});

it("keeps formatting and address typing after an inline-code value opener", () => {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "paragraph", inline: [
    { text: ":value{", marks: { inlineCode: true } }, { text: " next ", marks: {} },
  ] });
  const { editor } = mountEditor(ydoc);
  try {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    typeText(editor, "*bold* https://example.org ");
    const inline = getBlockInline(ydoc, getBlocks(ydoc)[0]!.id)!;
    expect(inline.some((run) => run.text === "bold" && run.marks.italic)).toBe(true);
    expect(inline.some((run) => run.text === "https://example.org" && run.marks.link === "https://example.org")).toBe(true);
    const literal = `:value${JSON.stringify({ ...config, filter: { system: "*literal*" } })}`;
    typeText(editor, literal);
    expect(getBlocks(ydoc)[0]?.text).toContain(literal);
    expect(inlineValueRanges(editor.state.doc)).toHaveLength(1);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it.each(["inlineCode", "link"] as const)("retains ordinary link, footnote and icon rendering after a %s value opener", (mark) => {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "paragraph", inline: referenceInline(linkifyInline([
    { text: ":value{", marks: mark === "inlineCode" ? { inlineCode: true } : { link: "https://protected.example.com" } },
    { text: '"x":"text https://outside.example.com and [^outside] :claude:"}', marks: {} },
  ])) });
  appendBlock(ydoc, { type: "footnote", label: "outside", text: "Outside note" });
  const { editor, element } = mountEditor(ydoc);
  try {
    expect(element.querySelector(".ub-inline-value-source")).toBeNull();
    expect(element.querySelector('a[href="https://outside.example.com"]')?.textContent).toBe("https://outside.example.com");
    expect(element.querySelector(".ub-footnote-reference")?.textContent).toBe("1");
    expect(element.querySelector('.ub-inline-icon[data-icon="claude"]')).not.toBeNull();
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("keeps an icon inside a complete linked value source literal", () => {
  const ydoc = new Y.Doc();
  const literal = ':value{"collection":"results","filter":{"system":":claude:"},"field":"wer"}';
  appendBlock(ydoc, { type: "paragraph", inline: [{ text: literal, marks: { link: "https://example.org" } }] });
  const { editor, element } = mountEditor(ydoc);
  try {
    expect(element.querySelector(".ub-inline-value-source")).toBeNull();
    expect(element.querySelector(".ub-inline-icon")).toBeNull();
    expect(element.querySelector("a")?.textContent).toBe(literal);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("shows unreadable document data as an unusable collection and recovers without prose writes", async () => {
  const f = fixture();
  try {
    appendBlock(f.ydoc, { type: "paragraph", text: ":value{invalid}" });
    await waitFor(() => expect(f.element.querySelectorAll(".ub-inline-value")).toHaveLength(2));
    const blocks = getBlocks(f.ydoc);
    f.ydoc.getMap("data").set("malformed", Number.NaN);
    await waitFor(() => expect(f.element.querySelector(".ub-inline-value")?.getAttribute("data-value-state")).toBe("collection-unusable"));
    expect(f.element.querySelectorAll(".ub-inline-value")[1]?.getAttribute("data-value-state")).toBe("invalid-source");
    expect(getBlocks(f.ydoc)).toEqual(blocks);
    f.ydoc.getMap("data").delete("malformed");
    await waitFor(() => expect(f.element.querySelector(".ub-inline-value")?.textContent).toBe("10.0"));
    expect(getBlocks(f.ydoc)).toEqual(blocks);
  } finally { f.destroy(); }
});

it("steps over whole sources, extends partial selections, and isolates adjacent deletion in undo", () => {
  const f = fixture();
  try {
    const range = inlineValueRanges(f.editor.state.doc)[0]!;
    f.editor.commands.setTextSelection(range.from);
    expect(key(f.editor, "ArrowRight")).toBe(true);
    expect(f.editor.state.selection.head).toBe(range.to);
    expect(key(f.editor, "ArrowLeft")).toBe(true);
    expect(f.editor.state.selection.head).toBe(range.from);
    f.editor.commands.setTextSelection({ from: range.from + 5, to: range.to - 5 });
    expect(f.editor.state.selection.from).toBe(range.from);
    expect(f.editor.state.selection.to).toBe(range.to);
    f.editor.commands.setTextSelection(range.to);
    typeText(f.editor, "!");
    f.editor.commands.setTextSelection(range.to);
    expect(key(f.editor, "Backspace")).toBe(true);
    expect(getBlocks(f.ydoc)[0]?.text).toBe("Before ! after");
    expect(undo(f.editor.state)).toBe(true);
    expect(getBlocks(f.ydoc)[0]?.text).toBe(`Before ${source}! after`);
    expect(undo(f.editor.state)).toBe(true);
    expect(getBlocks(f.ydoc)[0]?.text).toBe(`Before ${source} after`);
  } finally { f.destroy(); }
});

it("cuts the whole stored source and restores it with one undo", () => {
  const f = fixture();
  try {
    const range = inlineValueRanges(f.editor.state.doc)[0]!;
    f.editor.commands.setTextSelection({ from: range.from + 2, to: range.to - 2 });
    const setData = vi.fn();
    const event = new Event("cut", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    f.editor.view.dom.dispatchEvent(event);
    expect(setData).toHaveBeenCalledWith("text/plain", source);
    expect(getBlocks(f.ydoc)[0]?.text).toBe("Before  after");
    expect(undo(f.editor.state)).toBe(true);
    expect(getBlocks(f.ydoc)[0]?.text).toBe(`Before ${source} after`);
  } finally { f.destroy(); }
});

it("selects the stored source for keyboard copy when a read-only value receives focus", async () => {
  const f = fixture();
  try {
    f.editor.setEditable(false);
    await waitFor(() => expect(f.element.querySelector(".ub-inline-value")?.textContent).toBe("10.0"));
    const before = Y.encodeStateAsUpdate(f.ydoc);
    f.element.querySelector<HTMLButtonElement>(".ub-inline-value")!.focus();
    const range = inlineValueRanges(f.editor.state.doc)[0]!;
    expect(f.editor.state.selection.from).toBe(range.from);
    expect(f.editor.state.selection.to).toBe(range.to);
    expect(f.editor.view.serializeForClipboard(f.editor.state.selection.content()).text).toBe(source);
    expect(Y.encodeStateAsUpdate(f.ydoc)).toEqual(before);
  } finally { f.destroy(); }
});

it("draws only the allowed prose and ordinary table contexts, retaining marks and comments", async () => {
  const ydoc = new Y.Doc();
  const id = appendBlock(ydoc, { type: "paragraph", inline: [
    { text: source.slice(0, 10), marks: { bold: true } }, { text: source.slice(10), marks: {} },
  ] });
  const annotation = createAnnotation(ydoc, id, 8, 15, "Reader", "Source");
  for (const type of ["heading", "list-item", "quote", "callout"] as const) appendBlock(ydoc, { type, text: source });
  appendBlock(ydoc, { type: "table", text: `| Value |\n| --- |\n| ${source} |` });
  appendBlock(ydoc, { type: "paragraph", inline: [{ text: source, marks: { inlineCode: true } }] });
  appendBlock(ydoc, { type: "paragraph", inline: [{ text: source, marks: { link: "https://example.org" } }] });
  appendBlock(ydoc, { type: "footnote", label: "note", text: source });
  appendBlock(ydoc, { type: "card", text: `title: Card\n\n${source}` });
  appendBlock(ydoc, { type: "code", text: source });
  const { editor, element } = mountEditor(ydoc);
  try {
    await waitFor(() => expect(element.querySelectorAll(".ub-inline-value")).toHaveLength(6));
    const first = element.querySelector(".ub-inline-value");
    expect(first?.closest("strong")).not.toBeNull();
    expect(first?.closest("[data-comment-thread]")?.getAttribute("data-comment-thread")).toBe(annotation.id);
    for (const span of element.querySelectorAll(".ub-inline-value-source")) expect(span.getAttribute("aria-hidden")).toBe("true");
    getMetaMap(ydoc).set("kind", "decision");
    editor.view.dispatch(editor.state.tr);
    expect(element.querySelectorAll(".ub-inline-value-source")).toHaveLength(0);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("keeps a detached decision answer literal even without decision metadata", () => {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "paragraph", text: source });
  const element = document.body.appendChild(document.createElement("div"));
  const editor = createUberblickEditor({ element, fragment: getBlocksFragment(ydoc), decisionAnswer: () => true });
  try { expect(element.querySelector(".ub-inline-value-source")).toBeNull(); }
  finally { editor.destroy(); element.remove(); ydoc.destroy(); }
});

it("shares a data observer with generated views and releases it after the last reader leaves", () => {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "paragraph", text: source });
  appendBlock(ydoc, { type: "chart", text: JSON.stringify({ version: 1, type: "table", collection: "results", columns: [{ field: "wer" }] }) });
  const observe = vi.spyOn(ydoc.getMap("data"), "observe");
  const unobserve = vi.spyOn(ydoc.getMap("data"), "unobserve");
  const { editor } = mountEditor(ydoc);
  try {
    expect(observe).toHaveBeenCalledTimes(1);
    const range = inlineValueRanges(editor.state.doc)[0]!;
    editor.commands.deleteRange({ from: range.from, to: range.to });
    expect(unobserve).not.toHaveBeenCalled();
    getBlocksFragment(ydoc).delete(1, 1);
    expect(unobserve).toHaveBeenCalledTimes(1);
    editor.commands.setTextSelection(1);
    editor.commands.insertContent(source);
    expect(observe).toHaveBeenCalledTimes(2);
    editor.commands.clearContent();
    expect(unobserve).toHaveBeenCalledTimes(2);
  } finally { editor.destroy(); ydoc.destroy(); observe.mockRestore(); unobserve.mockRestore(); }
});
