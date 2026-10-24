import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import { appendBlock, createAnnotation, editBlock, exportMarkdown, importMarkdown, parseJsonSource } from "@uberblick/schema";
import type { JsonSourceNode } from "@uberblick/schema";
import { children, firstView, itemCount, jsonTreeRows, rootItem, subtreePaths } from "../src/editor/json-tree-rows.js";
import { mountEditor, snapshotFragment, typeText } from "./helpers.js";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function parsed(text: string): JsonSourceNode {
  const result = parseJsonSource(text);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

// Literal text, so the big integer and 1.50 stay as written.
const SETTINGS = '{"name":"planner","limits":{"tokens":9007199254740993,"price":1.50},'
  + '"steps":[{"id":"read","needs":[]},{"id":"write","needs":["read"]}]}';

describe("JSON tree rows", () => {
  it("opens the root, then containers breadth-first while 20 rows fit", () => {
    const root = rootItem(parsed(SETTINGS));
    expect([...firstView(root)].sort()).toEqual(["", ".limits", ".steps", ".steps[0]", ".steps[1]", ".steps[1].needs"]);
    const wide = rootItem(parsed(JSON.stringify({ a: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], b: { c: 1 } })));
    // The root always opens; `.a` would push the view past 20 rows, `.b` still fits.
    expect([...firstView(wide)].sort()).toEqual(["", ".b"]);
  });

  it("groups long arrays, numbers repeated keys and pages rows", () => {
    const long = rootItem(parsed(JSON.stringify(Array.from({ length: 250 }, (_, index) => index))));
    expect(children(long).map((item) => item.path)).toEqual(["[0…99]", "[100…199]", "[200…249]"]);
    expect(itemCount(children(long)[2] as never)).toBe("50 items");
    const group = children(long)[1];
    expect(group === undefined ? [] : children(group).slice(0, 2).map((item) => item.path)).toEqual(["[100]", "[101]"]);

    const repeated = rootItem(parsed('{"a": {"x": 1}, "a": {"x": 2}}'));
    expect(children(repeated).map((item) => item.path)).toEqual([".a", ".a#2"]);
    expect(subtreePaths(repeated)).toEqual(["", ".a", ".a#2"]);

    const rows = jsonTreeRows(long, () => true, 10);
    expect(rows).toHaveLength(11);
    expect(rows.at(-1)?.form).toBe("more");
  });
});

function fixture(text = SETTINGS, language = "json-tree") {
  const doc = new Y.Doc();
  appendBlock(doc, { type: "paragraph", text: "Before" });
  const id = appendBlock(doc, { type: "code", language, text });
  const { editor, element } = mountEditor(doc);
  return { doc, id, editor, element };
}

function tree(element: HTMLElement): HTMLElement {
  const node = element.querySelector<HTMLElement>(".ub-json-tree");
  if (node === null) throw new Error("JSON tree did not mount");
  return node;
}

function rowTexts(element: HTMLElement): string[] {
  return [...tree(element).querySelectorAll<HTMLElement>(".ub-json-row")].map((row) =>
    [...row.children].filter((child) => !child.matches(".ub-json-toggle, .ub-json-copy-value")).map((child) => child.textContent).join(""));
}

function row(element: HTMLElement, path: string): HTMLElement {
  const found = tree(element).querySelector<HTMLElement>(`.ub-json-row[data-path="${path}"]`);
  if (found === null) throw new Error(`no row for ${path}`);
  return found;
}

function blockText(editor: Editor, id: string): string {
  let text = "";
  editor.state.doc.forEach((node) => { if (node.attrs.id === id) text = node.textContent; });
  return text;
}

function button(element: HTMLElement, label: string): HTMLButtonElement {
  const found = tree(element).querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`no ${label} button`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
});
afterEach(() => { vi.useRealTimers(); });

describe("JSON tree block", () => {
  it("keeps a first-block tree closed to source until a local edit, across remote updates", () => {
    const doc = new Y.Doc();
    const id = appendBlock(doc, { type: "code", language: "json-tree", text: '{"a":1}' });
    const { editor, element } = mountEditor(doc);
    expect(tree(element).classList.contains("ub-json-tree-editing")).toBe(false);
    editBlock(doc, id, '{"a":1}', '{"a":2}');
    vi.advanceTimersByTime(200);
    expect(tree(element).classList.contains("ub-json-tree-editing")).toBe(false);
    button(element, "Edit JSON").click();
    expect(tree(element).classList.contains("ub-json-tree-editing")).toBe(true);
    editBlock(doc, id, '{\n  "a": 2\n}', '{\n  "a": 3\n}');
    vi.advanceTimersByTime(200);
    expect(tree(element).classList.contains("ub-json-tree-editing")).toBe(true);
    button(element, "Done editing JSON").click();
    expect(tree(element).classList.contains("ub-json-tree-editing")).toBe(false);
    editor.destroy();
  });

  it("opens invalid stored first-block source when typing at the default caret", () => {
    const doc = new Y.Doc();
    appendBlock(doc, { type: "code", language: "json-tree", text: '{"a":}' });
    const { editor, element } = mountEditor(doc);
    const note = tree(element).querySelector<HTMLElement>(".ub-json-tree-validity");
    expect(note?.textContent).toContain("Not valid JSON");
    typeText(editor, " ");
    expect(tree(element).classList.contains("ub-json-tree-editing")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(note?.textContent).toBe("");
    vi.advanceTimersByTime(1300);
    expect(note?.textContent).toContain("Not valid JSON");
    editor.destroy();
  });

  it("draws json-tree code as rows with literals as written and leaves json code alone", () => {
    const fix = fixture();
    expect(tree(fix.element).dataset.json).toBe("valid");
    expect(rowTexts(fix.element)).toEqual([
      "{",
      '"name": "planner",',
      '"limits": {',
      '"tokens": 9007199254740993,',
      '"price": 1.50',
      "},",
      '"steps": [',
      "{",
      '"id": "read",',
      '"needs": []',
      "},",
      "{",
      '"id": "write",',
      '"needs": [',
      '"read"',
      "]",
      "}",
      "]",
      "}",
    ]);
    fix.editor.destroy();

    const plain = fixture(SETTINGS, "json");
    expect(plain.element.querySelector(".ub-json-tree")).toBeNull();
    expect(plain.element.querySelector("pre.ub-code code")?.textContent).toBe(SETTINGS);
    plain.editor.destroy();
  });

  it("folds on click, keeps fold choices across a remote edit and drops a vanished path", () => {
    const fix = fixture();
    row(fix.element, ".limits").click();
    expect(row(fix.element, ".limits").getAttribute("aria-expanded")).toBe("false");
    expect(rowTexts(fix.element)).toContain('"limits": { … },2 keys');
    editBlock(fix.doc, fix.id, SETTINGS, SETTINGS.replace('"planner"', '"writer"'));
    vi.advanceTimersByTime(200);
    expect(rowTexts(fix.element)).toContain('"name": "writer",');
    expect(row(fix.element, ".limits").getAttribute("aria-expanded")).toBe("false");
    const without = SETTINGS.replace('"planner"', '"writer"').replace(/,"limits":\{[^}]*\}/, "");
    editBlock(fix.doc, fix.id, SETTINGS.replace('"planner"', '"writer"'), without);
    vi.advanceTimersByTime(200);
    expect(tree(fix.element).querySelector('[data-path=".limits"]')).toBeNull();
    fix.editor.destroy();
  });

  it("notes duplicate keys and previews a folded object's first scalar", () => {
    const fix = fixture('[{"id": "a", "id": "b", "deep": {"x": 1}}]');
    expect(tree(fix.element).querySelector<HTMLElement>(".ub-json-tree-note")?.hidden).toBe(false);
    row(fix.element, "[0]").click();
    expect(rowTexts(fix.element)[1]).toBe('{ "id": "a", … }3 keys');
    fix.editor.destroy();
  });

  it("formats on Edit and on Done, each as its own undo step, and leaves annotated text alone", () => {
    const fix = fixture();
    const before = snapshotFragment(fix.doc);
    button(fix.element, "Edit JSON").click();
    expect(tree(fix.element).classList.contains("ub-json-tree-editing")).toBe(true);
    expect(blockText(fix.editor, fix.id)).toBe(JSON.stringify(JSON.parse(SETTINGS), null, 2)
      .replace("9007199254740992", "9007199254740993").replace('"price": 1.5', '"price": 1.50'));
    undo(fix.editor.state);
    expect(snapshotFragment(fix.doc)).toEqual(before);
    fix.editor.destroy();

    const noted = fixture('{"a":1}');
    createAnnotation(noted.doc, noted.id, 1, 4, "reader", "Why one?");
    button(noted.element, "Edit JSON").click();
    expect(blockText(noted.editor, noted.id)).toBe('{"a":1}');
    noted.editor.destroy();
  });

  it("keeps the last tree and stays quiet until typing pauses, then clears the note when valid", () => {
    const fix = fixture('{"a": 1}');
    button(fix.element, "Edit JSON").click();
    const note = tree(fix.element).querySelector<HTMLElement>(".ub-json-tree-validity");
    fix.editor.commands.setTextSelection(fix.editor.state.selection.from + '{\n  "a": 1'.length);
    typeText(fix.editor, ",");
    vi.advanceTimersByTime(1000);
    typeText(fix.editor, " ");
    vi.advanceTimersByTime(1000);
    expect(tree(fix.element).dataset.json).toBe("stale");
    expect(note?.textContent).toBe("");
    vi.advanceTimersByTime(600);
    expect(tree(fix.element).dataset.json).toBe("stale");
    expect(tree(fix.element).classList.contains("ub-json-tree-editing")).toBe(true);
    expect(note?.textContent).toMatch(/^Not valid JSON: line 3, column 1/);
    typeText(fix.editor, '"b": 2');
    vi.advanceTimersByTime(200);
    expect(tree(fix.element).dataset.json).toBe("valid");
    expect(note?.textContent).toBe("");

    button(fix.element, "Done editing JSON").click();
    expect(blockText(fix.editor, fix.id)).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(tree(fix.element).classList.contains("ub-json-tree-editing")).toBe(false);
    fix.editor.destroy();
  });

  it.each([true, false])("keeps the last tree during remote typing, then shows invalid source when editable=%s", (editable) => {
    const valid = '{\n  "a": 1\n}';
    const firstInvalid = '{\n  "a": 1,\n}';
    const secondInvalid = '{\n  "a": 1, \n}';
    const thirdInvalid = '{\n  "a": 1,  \n}';
    const fix = fixture(valid);
    fix.editor.setEditable(editable);
    const before = rowTexts(fix.element);
    const note = tree(fix.element).querySelector<HTMLElement>(".ub-json-tree-validity");
    editBlock(fix.doc, fix.id, valid, firstInvalid);
    vi.advanceTimersByTime(200);
    expect(tree(fix.element).dataset.json).toBe("stale");
    expect(tree(fix.element).classList.contains("ub-json-tree-editing")).toBe(false);
    expect(rowTexts(fix.element)).toEqual(before);
    expect(note?.textContent).toBe("");

    vi.advanceTimersByTime(800);
    editBlock(fix.doc, fix.id, firstInvalid, secondInvalid);
    vi.advanceTimersByTime(1499);
    expect(tree(fix.element).dataset.json).toBe("stale");
    expect(rowTexts(fix.element)).toEqual(before);
    expect(note?.textContent).toBe("");
    vi.advanceTimersByTime(1);
    expect(tree(fix.element).dataset.json).toBe("invalid");
    expect(tree(fix.element).querySelector(".ub-json-tree-source")?.textContent).toBe(secondInvalid);
    if (editable) expect(note?.textContent).toMatch(/^Not valid JSON: line 3, column 1/);
    else expect(note?.textContent).toBe("");

    editBlock(fix.doc, fix.id, secondInvalid, thirdInvalid);
    expect(tree(fix.element).dataset.json).toBe("stale");
    expect(note?.textContent).toBe("");
    vi.advanceTimersByTime(1499);
    expect(tree(fix.element).dataset.json).toBe("stale");
    expect(rowTexts(fix.element)).toEqual(before);
    expect(note?.textContent).toBe("");
    vi.advanceTimersByTime(1);
    expect(tree(fix.element).dataset.json).toBe("invalid");
    expect(tree(fix.element).querySelector(".ub-json-tree-source")?.textContent).toBe(thirdInvalid);
    if (editable) expect(note?.textContent).toMatch(/^Not valid JSON: line 3, column 1/);
    else expect(note?.textContent).toBe("");
    vi.advanceTimersByTime(10_000);
    expect(tree(fix.element).dataset.json).toBe("invalid");

    editBlock(fix.doc, fix.id, thirdInvalid, '{\n  "a": 2\n}');
    vi.advanceTimersByTime(200);
    expect(tree(fix.element).dataset.json).toBe("valid");
    expect(rowTexts(fix.element)).toContain('"a": 2');
    expect(note?.textContent).toBe("");
    fix.editor.destroy();
  });

  it.each(["Done", "selection leaving"])("shows invalid source after %s ends local editing", (exit) => {
    const fix = fixture('{"a": 1}');
    button(fix.element, "Edit JSON").click();
    fix.editor.commands.setTextSelection(fix.editor.state.selection.from + '{\n  "a": 1'.length);
    typeText(fix.editor, ",");
    vi.advanceTimersByTime(200);
    expect(tree(fix.element).dataset.json).toBe("stale");
    if (exit === "Done") button(fix.element, "Done editing JSON").click();
    else fix.editor.commands.setTextSelection(1);
    expect(tree(fix.element).classList.contains("ub-json-tree-editing")).toBe(false);
    expect(tree(fix.element).dataset.json).toBe("invalid");
    expect(tree(fix.element).querySelector(".ub-json-tree-source")?.textContent).toBe('{\n  "a": 1,\n}');
    expect(blockText(fix.editor, fix.id)).toBe('{\n  "a": 1,\n}');
    fix.editor.destroy();
  });

  it.each([true, false])("shows invalid stored text as code with an editor-only note when editable=%s", (editable) => {
    const fix = fixture('{"a": }');
    fix.editor.setEditable(editable);
    expect(tree(fix.element).dataset.json).toBe("invalid");
    expect(rowTexts(fix.element)).toEqual([]);
    expect(tree(fix.element).querySelector(".ub-json-tree-source")?.textContent).toBe('{"a": }');
    const note = tree(fix.element).querySelector<HTMLElement>(".ub-json-tree-validity");
    if (editable) expect(note?.textContent).toMatch(/^Not valid JSON: line 1, column 7/);
    else expect(note?.textContent).toBe("");
    vi.advanceTimersByTime(1500);
    if (editable) expect(note?.textContent).toMatch(/^Not valid JSON: line 1, column 7/);
    else expect(note?.textContent).toBe("");
    fix.editor.destroy();
  });

  it("copies a subtree as two-space JSON", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } },
    });
    const fix = fixture();
    row(fix.element, ".limits").focus();
    row(fix.element, ".limits").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    tree(fix.element).querySelector<HTMLButtonElement>(".ub-json-copy-value")?.click();
    await vi.waitFor(() => expect(written).toEqual(['{\n  "tokens": 9007199254740993,\n  "price": 1.50\n}']));
    fix.editor.destroy();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("drops Copy value when focus leaves the tree", async () => {
    const fix = fixture();
    const limits = row(fix.element, ".limits");
    limits.focus();
    limits.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tree(fix.element).querySelector(".ub-json-copy-value")).not.toBeNull();
    row(fix.element, ".name").focus();
    await Promise.resolve();
    expect(tree(fix.element).querySelector(".ub-json-copy-value")).not.toBeNull();
    button(fix.element, "Edit JSON").focus();
    await Promise.resolve();
    expect(tree(fix.element).querySelector(".ub-json-copy-value")).toBeNull();
    fix.editor.destroy();
  });

  it("moves and folds with the keyboard", () => {
    const fix = fixture();
    const rootRow = row(fix.element, "");
    rootRow.focus();
    const key = (name: string) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    key("ArrowDown");
    key("ArrowDown");
    expect((document.activeElement as HTMLElement).dataset.path).toBe(".limits");
    key("ArrowLeft");
    expect(row(fix.element, ".limits").getAttribute("aria-expanded")).toBe("false");
    key("ArrowLeft");
    expect((document.activeElement as HTMLElement).dataset.path).toBe("");
    fix.editor.destroy();
  });

  it("keeps the json-tree fence and text through Markdown", () => {
    expect(importMarkdown("```json-tree\n{\"a\":1}\n```\n").blocks[0]).toMatchObject({ type: "code", language: "json-tree", text: '{"a":1}' });
    const doc = new Y.Doc();
    appendBlock(doc, { type: "code", language: "json-tree", text: '{"a":1}' });
    expect(exportMarkdown(doc)).toContain("```json-tree\n{\"a\":1}\n```");
  });
});
