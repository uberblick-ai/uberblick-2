import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, applyDocData, createAnnotation, deleteBlock, editBlock, getBlock, getBlocksFragment,
  tableRows,
} from "@uberblick/schema";
import { parseWireframe } from "@uberblick/wireframe";
import { AllSelection } from "@tiptap/pm/state";
import { createRevisionEditor, createRevisionInline, revisionViewModel } from "../src/editor/revision-view.js";
import { revisionSplitModel } from "../src/editor/revision-split.js";
import { findForeignBlocks } from "../src/editor/palette.js";
import { createUberblickEditor, uberblickSchema } from "../src/editor/create-editor.js";

vi.mock("@uberblick/wireframe", async (importOriginal) => {
  const original = await importOriginal<typeof import("@uberblick/wireframe")>();
  return { ...original, parseWireframe: vi.fn(original.parseWireframe) };
});

function clone(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

function firstColumnWidth(source: Y.Doc, width: number): void {
  for (const row of tableRows(getBlocksFragment(source).get(0) as Y.XmlElement)) {
    (row[0] as unknown as { setAttribute(name: string, value: unknown): void }).setAttribute("colwidth", [width]);
  }
}

function mount(before: Y.Doc | null, after: Y.Doc) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = createRevisionEditor({ element, before, after });
  return { element, editor, destroy: () => { editor.destroy(); element.remove(); } };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the detached revision view", () => {
  it("folds the same unchanged runs as Split and retains paired drawings through in-place expansion", async () => {
    const before = new Y.Doc();
    for (let index = 0; index < 5; index += 1) appendBlock(before, { type: index === 0 ? "heading" : "paragraph", text: `Opening ${index}` });
    const source = "dialog Before\n  text Earlier";
    const current = "dialog After\n  text Current";
    const drawing = appendBlock(before, { type: "code", language: "wireframe", text: source });
    for (let index = 0; index < 6; index += 1) appendBlock(before, { type: "paragraph", text: `Closing ${index}` });
    const after = clone(before);
    editBlock(after, drawing, source, current);
    const element = document.body.appendChild(document.createElement("div"));
    const view = createRevisionInline({ element, before, after, folding: { collapse: true, expanded: new Set() } });
    const oldState = Y.encodeStateAsUpdate(before);
    const newState = Y.encodeStateAsUpdate(after);
    try {
      await vi.dynamicImportSettled();
      expect(view.model.rows).toMatchObject(revisionSplitModel(before, after, { collapse: true, expanded: new Set() }).rows
        .map(({ before: _before, after: _after, ...row }) => row));
      expect(view.model.runs).toEqual([0, 7]);
      expect(view.model.rows.find((row) => row.at === 5)).toMatchObject({ changed: true, separateChange: true });
      const drawings = [...element.querySelectorAll(".wf-root")];
      const editor = view.editor;
      expect(drawings).toHaveLength(2);
      expect([...element.querySelectorAll(".ub-revision-row-start")].map((marker) => marker.getAttribute("data-key")))
        .toEqual(["fold-0", "row-4", "row-5", "row-6", "fold-7"]);
      (element.querySelector('[data-fold="0"]') as HTMLButtonElement).click();
      expect(view.model.rows[0]?.kind).toBe("unchanged");
      expect(element.querySelector('[data-fold="7"]')).not.toBeNull();
      view.expand(7);
      expect(element.querySelector(".ub-revision-fold")).toBeNull();
      view.setCollapse(true);
      expect(element.querySelectorAll(".ub-revision-fold-button")).toHaveLength(2);
      view.setCollapse(false);
      expect(view.editor).toBe(editor);
      expect([...element.querySelectorAll(".wf-root")]).toEqual(drawings);
      expect(view.model.rows).toHaveLength(12);
      expect(element.querySelectorAll(".ub-revision-row-start")).toHaveLength(12);
      expect(element.querySelectorAll(".ub-revision-row-end")).toHaveLength(12);
      view.editor.commands.insertContent("not authored");
      expect(Y.encodeStateAsUpdate(before)).toEqual(oldState);
      expect(Y.encodeStateAsUpdate(after)).toEqual(newState);
      view.editor.commands.selectAll();
      const copied = view.editor.view.serializeForClipboard(view.editor.state.selection.content());
      expect(copied.text).not.toContain("unchanged blocks");
      expect(copied.text).not.toContain("not authored");
    } finally { view.destroy(); element.remove(); before.destroy(); after.destroy(); }
  });

  it("keeps whole JSON versions and an ablauf viewer's paired sources on individual changed rows", () => {
    const before = new Y.Doc();
    const oldDrawing = "a: Earlier\nb: End\na -> b";
    const newDrawing = "a: Later\nb: End\na -> b";
    const drawing = appendBlock(before, { type: "code", language: "ablauf", text: oldDrawing });
    const tree = appendBlock(before, { type: "code", language: "json-tree", text: '{"value":1}' });
    const after = clone(before);
    editBlock(after, drawing, oldDrawing, newDrawing);
    editBlock(after, tree, '{"value":1}', '{"value":2}');
    try {
      const model = revisionViewModel(before, after);
      expect(model.rows.map((row) => ({ changed: row.changed, separateChange: row.separateChange }))).toEqual([
        { changed: true, separateChange: true }, { changed: true, separateChange: true },
      ]);
      expect(model.blocks.map((block) => ({ side: block.side, at: block.at, showSource: block.showSource }))).toEqual([
        { side: "before", at: 0, showSource: false }, { side: "after", at: 0, showSource: false },
        { side: "before", at: 1, showSource: false }, { side: "after", at: 1, showSource: false },
      ]);
      const content = model.content.content ?? [];
      expect(content[0]?.attrs).toMatchObject({ revisionSide: "before", revisionOtherSource: newDrawing, revisionSource: oldDrawing });
      expect(content[1]?.attrs).toMatchObject({ revisionSide: "after", revisionOtherSource: oldDrawing, revisionSource: newDrawing });
      expect(content.slice(2).map((node) => ({ type: node.type, text: node.content?.[0]?.text }))).toEqual([
        { type: "code", text: '{"value":1}' }, { type: "code", text: '{"value":2}' },
      ]);
    } finally { before.destroy(); after.destroy(); }
  });

  it.each([
    { field: "variant", options: { variant: "tip" as const }, label: "Tip", icon: "💡" },
    { field: "icon", options: { icon: ":claude:" }, label: "Note", icon: null },
  ])("shows a callout's changed $field above its After appearance", ({ field, options, label, icon }) => {
    const before = new Y.Doc();
    const id = appendBlock(before, { type: "callout", variant: "note", icon: "💡", text: "Unchanged body" });
    const after = clone(before);
    editBlock(after, id, "Unchanged body", "Unchanged body", options);
    const view = mount(before, after);
    try {
      expect(view.element.querySelector(".ub-revision-fields")?.textContent).toBe(`Changed: ${field}`);
      const callout = view.element.querySelector('[role="note"]');
      expect(callout?.getAttribute("aria-label")).toBe(label);
      expect(callout?.querySelector(".ub-block-caption")?.textContent).toContain(label);
      if (icon === null) expect(callout?.querySelector(".ub-block-caption .ub-inline-icon")).not.toBeNull();
      else expect(callout?.querySelector(".ub-block-caption")?.textContent).toContain(icon);
      expect(callout?.querySelector(".ub-callout-body")?.textContent).toBe("Unchanged body");
      expect(callout?.querySelector("[data-revision-change]")).toBeNull();
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it.each(["quote", "callout"] as const)("marks only changed callout words when the predecessor is a %s", (type) => {
    const before = new Y.Doc();
    const id = appendBlock(before, type === "quote" ? { type, text: "Keep old words." }
      : { type, variant: "note", text: "Keep old words." });
    ((getBlocksFragment(before).get(0) as Y.XmlElement).firstChild as Y.XmlText).format(0, 4, { bold: {} });
    createAnnotation(before, id, 0, 4, "Ben", "hidden comment");
    const after = clone(before);
    if (type === "quote") {
      const fragment = getBlocksFragment(after);
      const old = fragment.get(0) as Y.XmlElement;
      const callout = new Y.XmlElement("callout");
      callout.setAttribute("id", id);
      callout.setAttribute("variant", "note");
      callout.insert(0, [(old.firstChild as Y.XmlText).clone()]);
      after.transact(() => { fragment.delete(0, 1); fragment.insert(0, [callout]); });
    }
    editBlock(after, id, "Keep old words.", "Keep new words.");
    const oldState = Y.encodeStateAsUpdate(before);
    const newState = Y.encodeStateAsUpdate(after);
    const view = mount(before, after);
    try {
      const callout = view.element.querySelector('[role="note"]');
      expect(callout?.getAttribute("aria-label")).toBe("Note");
      expect(callout?.querySelector('[data-revision-change="removed"]')?.textContent).toBe("old");
      expect(callout?.querySelector('[data-revision-change="added"]')?.textContent).toBe("new");
      expect(callout?.querySelector("strong")?.textContent).toBe("Keep");
      expect(view.editor.state.doc.childCount).toBe(1);
      expect(view.editor.state.doc.firstChild?.textContent).toBe("Keep oldnew words.");
      expect(callout?.querySelector(".ub-comment, [data-comment-thread]")).toBeNull();
      expect(Y.encodeStateAsUpdate(before)).toEqual(oldState);
      expect(Y.encodeStateAsUpdate(after)).toEqual(newState);
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it("keeps selectable removed text and removed blocks in reading order without changing either revision", () => {
    const before = new Y.Doc();
    const sentence = appendBlock(before, { type: "paragraph", text: "Keep old words here." });
    const removed = appendBlock(before, { type: "quote", text: "Removed block" });
    appendBlock(before, { type: "paragraph", text: "Last" });
    createAnnotation(before, sentence, 0, 4, "Ben", "hidden comment");
    const after = clone(before);
    editBlock(after, sentence, "Keep old words here.", "Keep new words here.");
    deleteBlock(after, removed);
    const oldState = Y.encodeStateAsUpdate(before);
    const newState = Y.encodeStateAsUpdate(after);
    const view = mount(before, after);
    try {
      expect(view.element.querySelector('[data-revision-change="removed"]')?.textContent).toBe("old");
      expect(view.element.querySelector('[data-revision-change="added"]')?.textContent).toBe("new");
      expect(view.editor.state.doc.child(0).textContent).toBe("Keep oldnew words here.");
      expect(view.editor.state.doc.child(1).textContent).toBe("Removed block");
      expect(view.element.querySelector('[data-revision-block="removed"]')?.textContent).toBe("Removed block");
      expect(view.element.querySelector(".ub-comment, [data-comment-thread]")).toBeNull();
      const removedText = view.element.querySelector('[data-revision-change="removed"]');
      if (!removedText) throw new Error("Removed text did not render");
      const range = document.createRange();
      range.selectNodeContents(removedText);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      expect(document.getSelection()?.toString()).toBe("old");
      expect(Y.encodeStateAsUpdate(before)).toEqual(oldState);
      expect(Y.encodeStateAsUpdate(after)).toEqual(newState);
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it("rejects every document-changing transaction, including commands, paste, drop and remote-origin metadata", () => {
    const doc = new Y.Doc();
    appendBlock(doc, { type: "paragraph", text: "History" });
    const state = Y.encodeStateAsUpdate(doc);
    const view = mount(null, doc);
    try {
      const original = view.editor.getJSON();
      view.editor.commands.insertContent("command");
      view.editor.view.dispatch(view.editor.state.tr.insertText("typing", 1));
      view.editor.view.dispatch(view.editor.state.tr.insertText("paste", 1).setMeta("uiEvent", "paste"));
      view.editor.view.dispatch(view.editor.state.tr.insertText("drop", 1).setMeta("uiEvent", "drop"));
      view.editor.view.dispatch(view.editor.state.tr.delete(1, 3).setMeta("isChangeOrigin", true));
      view.editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "replace" }] }] });
      expect(view.editor.getJSON()).toEqual(original);
      view.editor.commands.setTextSelection({ from: 1, to: 4 });
      expect(view.editor.state.selection.to - view.editor.state.selection.from).toBe(3);
      expect(view.editor.isEditable).toBe(false);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
      expect(view.element.querySelector("[data-revision-change]")).toBeNull();
    } finally { view.destroy(); doc.destroy(); }
  });

  it("copies removed words into synced content without turning revision styling into authored strikethrough", () => {
    const before = new Y.Doc();
    const id = appendBlock(before, { type: "paragraph", text: "Keep old words." });
    const paragraph = getBlocksFragment(before).get(0) as Y.XmlElement;
    (paragraph.firstChild as Y.XmlText).format(5, 3, { bold: {} });
    const after = clone(before);
    editBlock(after, id, "Keep old words.", "Keep new words.");
    const view = mount(before, after);
    const live = new Y.Doc();
    appendBlock(live, { type: "paragraph", text: "Live " });
    const editor = createUberblickEditor({ element: document.createElement("div"), fragment: getBlocksFragment(live) });
    try {
      view.editor.commands.setTextSelection({ from: 6, to: 9 });
      const copied = view.editor.view.serializeForClipboard(view.editor.state.selection.content());
      expect(copied.text).toBe("old");
      editor.commands.setTextSelection(6);
      expect(editor.view.pasteHTML(copied.dom.innerHTML, new Event("paste") as ClipboardEvent)).toBe(true);
      const text = (getBlocksFragment(live).get(0) as Y.XmlElement).firstChild as Y.XmlText;
      expect(text.toDelta()).toEqual([{ insert: "Live " }, { insert: "old", attributes: { bold: {} } }]);
      expect(findForeignBlocks(getBlocksFragment(live))).toEqual([]);
    } finally { editor.destroy(); view.destroy(); before.destroy(); after.destroy(); live.destroy(); }
  });

  it("copies whole changed blocks with fresh live identities and only their authored formatting", () => {
    const before = new Y.Doc();
    const id = appendBlock(before, { type: "paragraph", text: "Old" });
    appendBlock(before, { type: "table", text: "| Header |\n| --- |\n| Removed cell |" });
    const paragraph = getBlocksFragment(before).get(0) as Y.XmlElement;
    (paragraph.firstChild as Y.XmlText).format(0, 3, { strike: {} });
    const after = clone(before);
    editBlock(after, id, "Old", "New");
    getBlocksFragment(after).delete(1, 1);
    const view = mount(before, after);
    const live = new Y.Doc();
    const editor = createUberblickEditor({ element: document.createElement("div"), fragment: getBlocksFragment(live) });
    try {
      view.editor.view.dispatch(view.editor.state.tr.setSelection(new AllSelection(view.editor.state.doc)));
      const copied = view.editor.view.serializeForClipboard(view.editor.state.selection.content());
      editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
      expect(editor.view.pasteHTML(copied.dom.innerHTML, new Event("paste") as ClipboardEvent)).toBe(true);
      const fragment = getBlocksFragment(live);
      const ids = fragment.toArray().map((block) => (block as Y.XmlElement).getAttribute("id"));
      expect(ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      const text = (fragment.get(0) as Y.XmlElement).firstChild as Y.XmlText;
      expect(text.toDelta()).toEqual([{ insert: "Old", attributes: { strike: {} } }, { insert: "New" }]);
      expect(fragment.toString()).toContain("Removed cell");
      let struck = "";
      editor.state.doc.descendants((node) => {
        if (node.isText && node.marks.some((mark) => mark.type.name === "strike")) struck += node.text;
      });
      expect(struck).toBe("Old");
      expect(fragment.toString()).not.toContain("revision-");
      expect(findForeignBlocks(fragment)).toEqual([]);
    } finally { editor.destroy(); view.destroy(); before.destroy(); after.destroy(); live.destroy(); }
  });

  it("leaves the synced editor schema and foreign-mark gate closed to revision marks", () => {
    expect(uberblickSchema.marks.removed).toBeUndefined();
    expect(uberblickSchema.marks.revisionAdded).toBeUndefined();
    const doc = new Y.Doc();
    appendBlock(doc, { type: "paragraph", text: "Forbidden in storage" });
    const paragraph = getBlocksFragment(doc).get(0) as Y.XmlElement;
    (paragraph.firstChild as Y.XmlText).format(0, 1, { removed: {} });
    expect(findForeignBlocks(getBlocksFragment(doc))).toMatchObject([{ nodeName: "#mark:removed" }]);
    expect(() => revisionViewModel(null, doc)).toThrow("unsupported content");
    doc.destroy();
  });

  it("shows formatting, list, card, Figma and chart fields, plus data changes on consuming blocks", () => {
    const before = new Y.Doc();
    const directory = new Y.Doc();
    const prose = appendBlock(before, { type: "paragraph", text: "Same words" });
    const list = appendBlock(before, { type: "list-item", text: "One", list: "bullet", indent: 0 });
    const card = appendBlock(before, { type: "card", text: "title: Before\n\nBody" });
    const figma = appendBlock(before, { type: "figma", text: "url: https://www.figma.com/design/abc/Example\ntitle: Before" });
    const chart = appendBlock(before, { type: "chart", text: '{"version":1,"type":"table","collection":"values","columns":[{"field":"value"}]}' });
    const after = clone(before);
    const first = getBlocksFragment(after).get(0) as Y.XmlElement;
    (first.firstChild as Y.XmlText).format(0, 4, { bold: {} });
    const item = getBlocksFragment(after).get(1) as Y.XmlElement;
    item.setAttribute("list", "ordered");
    item.setAttribute("indent", "1");
    editBlock(after, card, "title: Before\n\nBody", "title: After\n\nBody");
    editBlock(after, figma, getBlock(after, figma)?.text ?? "", "url: https://www.figma.com/design/abc/Example\ntitle: After");
    applyDocData(after, directory, [{ collection: "values", schema: { version: 1, schema: { type: "object", properties: { value: { type: "number" } } } }, upsert: [{ id: "one", value: { value: 7 } }] }]);
    const model = revisionViewModel(before, after);
    expect(model.comparison?.blocks).toMatchObject([
      { fields: ["formatting"] }, { fields: ["indent", "list"] }, { fields: ["title"] }, { fields: ["title"] }, { kind: "unchanged" },
    ]);
    expect(model.blocks[4]?.dataCollections).toEqual(["values"]);
    expect(model.content.content?.map((node) => node.attrs?.id)).toEqual([prose, list, card, figma, chart, chart].map((id, index) => `revision-${index}-${id}`));
    expect(model.blocks.slice(4).map((block) => block.side)).toEqual(["before", "after"]);
    before.destroy(); after.destroy(); directory.destroy();
  });

  it("projects table cells and removed rows at their earlier position", () => {
    const before = new Y.Doc();
    const id = appendBlock(before, { type: "table", text: "| Header |\n| --- |\n| old cell |\n| gone row |\n| tail |" });
    const after = clone(before);
    editBlock(after, id, getBlock(after, id)?.text ?? "", "| Header |\n| --- |\n| new cell |\n| tail |", { tableMapping: { rows: [0, 1, 3], columns: [0] } });
    const view = mount(before, after);
    try {
      const table = view.editor.state.doc.child(0);
      expect(table.child(1).textContent).toBe("oldnew cell");
      expect(table.child(2).textContent).toBe("gone row");
      expect(table.child(3).textContent).toBe("tail");
      expect(view.element.querySelectorAll('[data-revision-change="removed"]')).toHaveLength(2);
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it("puts an accessible width-only note above a changed table using its After widths", () => {
    const before = new Y.Doc();
    appendBlock(before, { type: "table", text: "| Header | Other |\n| --- | --- |\n| Same cell | Value |" });
    firstColumnWidth(before, 180);
    const after = clone(before);
    firstColumnWidth(after, 260);
    const originalBefore = Y.encodeStateAsUpdate(before);
    const originalAfter = Y.encodeStateAsUpdate(after);
    const view = mount(before, after);
    try {
      const note = view.element.querySelector(".ub-revision-fields.ub-revision-widths-only");
      const table = view.element.querySelector("table");
      expect(note?.textContent).toBe("Only column widths changed");
      expect(note?.closest('[aria-hidden="true"], [hidden]')).toBeNull();
      expect(note?.compareDocumentPosition(table!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(view.element.querySelector('[data-revision-block="changed"]')).not.toBeNull();
      expect(table?.querySelector("col")?.getAttribute("style")).toContain("width: 260px");
      expect(view.editor.state.doc.child(0).child(0).child(0).attrs.colwidth).toEqual([260]);
      expect(view.element.querySelector("[data-revision-change]")).toBeNull();
      expect(view.element.textContent).not.toContain("columnWidths");
      expect(Y.encodeStateAsUpdate(before)).toEqual(originalBefore);
      expect(Y.encodeStateAsUpdate(after)).toEqual(originalAfter);
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it.each(["cell text", "columns"] as const)("names widths alongside %s and keeps its existing marks", (change) => {
    const before = new Y.Doc();
    const source = "| Header | Other |\n| --- | --- |\n| old cell | Value |";
    const id = appendBlock(before, { type: "table", text: source });
    firstColumnWidth(before, 180);
    const after = clone(before);
    if (change === "cell text") editBlock(after, id, source, source.replace("old cell", "new cell"));
    else editBlock(after, id, source, "| Header |\n| --- |\n| old cell |", { tableMapping: { rows: [0, 1], columns: [0] } });
    firstColumnWidth(after, 260);
    const view = mount(before, after);
    try {
      const captions = [...view.element.querySelectorAll(".ub-revision-fields")].map((label) => label.textContent);
      expect(captions).toEqual(change === "cell text" ? ["Changed: column widths"]
        : ["Removed block · Changed: columns, column widths", "Added block · Changed: columns, column widths"]);
      expect(view.element.querySelector(".ub-revision-widths-only")).toBeNull();
      expect(view.element.textContent).not.toContain("columnWidths");
      expect(view.element.querySelector('[data-revision-change="removed"]')?.textContent).toBe(change === "cell text" ? "old" : "Header");
      expect(view.element.querySelector('[data-revision-change="added"]')?.textContent).toBe(change === "cell text" ? "new" : "Header");
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it("keeps removed trailing cells selectable when a stored table becomes ragged", () => {
    const before = new Y.Doc();
    appendBlock(before, { type: "table", text: "| First | Second |\n| --- | --- |\n| Keep | Removed trailing cell |" });
    const after = clone(before);
    const table = getBlocksFragment(after).get(0) as Y.XmlElement;
    (table.get(1) as Y.XmlElement).delete(1, 1);
    const oldState = Y.encodeStateAsUpdate(before);
    const newState = Y.encodeStateAsUpdate(after);
    const view = mount(before, after);
    try {
      expect(view.editor.state.doc.child(0).child(1).childCount).toBe(2);
      const removed = view.element.querySelector('[data-revision-change="removed"]');
      expect(removed?.textContent).toBe("Removed trailing cell");
      if (removed === null) throw new Error("Removed trailing cell did not render");
      const range = document.createRange();
      range.selectNodeContents(removed);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      expect(document.getSelection()?.toString()).toBe("Removed trailing cell");
      expect(Y.encodeStateAsUpdate(before)).toEqual(oldState);
      expect(Y.encodeStateAsUpdate(after)).toEqual(newState);
      view.editor.state.doc.check();
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it("highlights an added trailing cell when a stored ragged row gains a cell", () => {
    const before = new Y.Doc();
    appendBlock(before, { type: "table", text: "| First | Second |\n| --- | --- |\n| Keep | Added trailing cell |" });
    const after = clone(before);
    const table = getBlocksFragment(before).get(0) as Y.XmlElement;
    (table.get(1) as Y.XmlElement).delete(1, 1);
    const oldState = Y.encodeStateAsUpdate(before);
    const newState = Y.encodeStateAsUpdate(after);
    const view = mount(before, after);
    try {
      expect(view.element.querySelector('[data-revision-change="added"]')?.textContent).toBe("Added trailing cell");
      expect(Y.encodeStateAsUpdate(before)).toEqual(oldState);
      expect(Y.encodeStateAsUpdate(after)).toEqual(newState);
      view.editor.state.doc.check();
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it("keeps removed content selectable when a block changes containers or table columns", () => {
    const before = new Y.Doc();
    appendBlock(before, { type: "paragraph", text: "Old prose" });
    appendBlock(before, { type: "table", text: "| Keep | Remove |\n| --- | --- |\n| value | removed column |" });
    const after = clone(before);
    const fragment = getBlocksFragment(after);
    const first = fragment.get(0) as Y.XmlElement;
    const replacement = new Y.XmlElement("card");
    const temporary = new Y.Doc();
    appendBlock(temporary, { type: "card", text: "title: New card\n\nNew body" });
    const card = getBlocksFragment(temporary).get(0) as Y.XmlElement;
    replacement.setAttribute("id", first.getAttribute("id") ?? "");
    replacement.insert(0, card.toArray().filter((part): part is Y.XmlElement => part instanceof Y.XmlElement).map((part) => part.clone()));
    fragment.delete(0, 1);
    fragment.insert(0, [replacement]);
    const table = fragment.get(1) as Y.XmlElement;
    editBlock(after, table.getAttribute("id") ?? "", getBlock(after, table.getAttribute("id") ?? "")?.text ?? "", "| Keep |\n| --- |\n| value |", { tableMapping: { rows: [0, 1], columns: [0] } });
    const view = mount(before, after);
    try {
      expect(view.editor.state.doc.childCount).toBe(4);
      expect(view.editor.state.doc.child(0).textContent).toBe("Old prose");
      expect(view.editor.state.doc.child(1).textContent).toBe("New cardNew body");
      expect(view.editor.state.doc.child(2).textContent).toContain("removed column");
      expect(view.editor.state.doc.child(3).textContent).not.toContain("removed column");
      const identities: unknown[] = [];
      view.editor.state.doc.forEach((node) => { identities.push(node.attrs.id); });
      expect(new Set(identities).size).toBe(4);
      expect([...view.element.querySelectorAll('[data-revision-change="removed"]')].map((node) => node.textContent).join(" ")).toContain("removed column");
      expect(view.element.querySelector(".ub-revision-fields")?.textContent).toContain("type, content");
      expect(view.element.textContent).toContain("Changed: columns");
      view.editor.state.doc.check();
    } finally { view.destroy(); before.destroy(); after.destroy(); temporary.destroy(); }
  });

  it("allows revision marks throughout removed card parts, Figma captions and table cells", () => {
    const before = new Y.Doc();
    const card = appendBlock(before, { type: "card", text: "label: Label\ntitle: Title\nfooter: Footer\n\nBody" });
    const figma = appendBlock(before, { type: "figma", text: "url: https://www.figma.com/design/abc/Example\n\nCaption" });
    const table = appendBlock(before, { type: "table", text: "| Header |\n| --- |\n| Cell |" });
    appendBlock(before, { type: "paragraph", text: "Remaining" });
    const after = clone(before);
    deleteBlock(after, card);
    deleteBlock(after, figma);
    deleteBlock(after, table);
    const model = revisionViewModel(before, after);
    expect(model.blocks.map((block) => block.kind)).toEqual(["removed", "removed", "removed", "unchanged"]);
    const visit = (node: NonNullable<typeof model.content.content>[number]): void => {
      if (node.type === "text") expect(node.marks).toContainEqual({ type: "removed" });
      node.content?.forEach(visit);
    };
    model.content.content?.slice(0, 3).forEach(visit);
    before.destroy(); after.destroy();
  });

  it("names changes confined to a card's buttons", () => {
    const before = new Y.Doc();
    const id = appendBlock(before, { type: "card", text: "title: Title\nbutton: [Earlier](https://example.com/before)\n\nBody" });
    const after = clone(before);
    editBlock(after, id, getBlock(after, id)?.text ?? "", "title: Title\nbutton: [Now](https://example.com/after) filled blue\n\nBody");
    const view = mount(before, after);
    try {
      expect(view.element.querySelector(".ub-revision-fields")?.textContent).toBe("Changed: buttons");
      expect(view.element.querySelector('[data-revision-change]')).toBeNull();
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it("shows the whole earlier drawing above the later drawing without marked source", async () => {
    const before = new Y.Doc();
    const source = "dialog Before\n  text Earlier";
    const current = "dialog After\n  text Current";
    const id = appendBlock(before, { type: "code", language: "wireframe", text: source });
    const after = clone(before);
    editBlock(after, id, source, current);
    const view = mount(before, after);
    try {
      await vi.dynamicImportSettled();
      expect(parseWireframe).toHaveBeenLastCalledWith(current);
      const drawings = view.element.querySelectorAll(".wf-root");
      expect(drawings).toHaveLength(2);
      expect(drawings[0]?.textContent).toContain("Earlier");
      expect(drawings[0]?.textContent).not.toContain("Current");
      expect(drawings[1]?.textContent).toContain("Current");
      expect(drawings[1]?.textContent).not.toContain("Earlier");
      expect(view.element.querySelector(".ub-revision-source-changed")).toBeNull();
      expect([...view.element.querySelectorAll(".ub-revision-fields")].map((label) => label.textContent)).toEqual(["Before", "After"]);
      expect([...view.element.querySelectorAll(".ub-revision-row-start")].map((marker) => marker.getAttribute("data-key"))).toEqual(["row-0"]);
      expect(view.element.querySelectorAll(".ub-revision-row-end")).toHaveLength(1);
      expect(view.editor.state.doc.child(0).textContent).toBe(source);
      expect(view.editor.state.doc.child(1).textContent).toBe(current);
    } finally { view.destroy(); before.destroy(); after.destroy(); }
  });

  it("renders generated tables using the revision's data and marks data-only changes", async () => {
    const before = new Y.Doc();
    const directory = new Y.Doc();
    appendBlock(before, { type: "chart", text: '{"version":1,"type":"table","collection":"values","columns":[{"field":"value"}]}' });
    const schema = { version: 1 as const, schema: { type: "object" as const, properties: { value: { type: "number" as const } } } };
    applyDocData(before, directory, [{ collection: "values", schema, upsert: [{ id: "one", value: { value: 7 } }] }]);
    const after = clone(before);
    applyDocData(after, directory, [{ collection: "values", upsert: [{ id: "one", value: { value: 42 } }] }]);
    const view = mount(before, after);
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const charts = view.element.querySelectorAll(".ub-chart-panel");
      expect(charts).toHaveLength(2);
      expect(charts[0]?.textContent).toContain("7");
      expect(charts[0]?.textContent).not.toContain("42");
      expect(charts[1]?.textContent).toContain("42");
      expect([...view.element.querySelectorAll(".ub-revision-fields")].map((label) => label.textContent)).toEqual([
        "Before · Data changed: values", "After · Data changed: values",
      ]);
      expect(view.element.querySelector(".ub-revision-source-changed")).toBeNull();
    } finally { view.destroy(); before.destroy(); after.destroy(); directory.destroy(); }
  });

  it("draws wholly removed charts from the predecessor's collection while surviving charts retain the selected revision's data", async () => {
    const before = new Y.Doc();
    const directory = new Y.Doc();
    const mapping = '{"version":1,"type":"table","collection":"values","columns":[{"field":"value"}]}';
    const removed = appendBlock(before, { type: "chart", text: mapping });
    appendBlock(before, { type: "chart", text: mapping });
    applyDocData(before, directory, [{ collection: "values", schema: { version: 1, schema: { type: "object", properties: { value: { type: "number" } } } }, upsert: [{ id: "one", value: { value: 7 } }] }]);
    const after = clone(before);
    deleteBlock(after, removed);
    applyDocData(after, directory, [{ collection: "values", deleteCollection: true }]);
    const oldState = Y.encodeStateAsUpdate(before);
    const newState = Y.encodeStateAsUpdate(after);
    const view = mount(before, after);
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const charts = view.element.querySelectorAll(".ub-chart-panel");
      expect(charts).toHaveLength(3);
      expect(charts[0]?.textContent).toContain("7");
      expect(charts[0]?.getAttribute("data-state")).toBe("ready");
      expect(charts[1]?.textContent).toContain("7");
      expect(charts[2]?.getAttribute("data-state")).toBe("collection-absent");
      expect(Y.encodeStateAsUpdate(before)).toEqual(oldState);
      expect(Y.encodeStateAsUpdate(after)).toEqual(newState);
    } finally { view.destroy(); before.destroy(); after.destroy(); directory.destroy(); }
  });
});
