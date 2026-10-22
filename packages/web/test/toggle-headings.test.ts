import { waitFor, within } from "@testing-library/dom";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { redo, undo, yUndoPluginKey } from "y-prosemirror";
import {
  appendBlock, docRev, editBlock, exportMarkdown, getBlocks, initDoc,
} from "@uberblick/schema";
import { revealFoldedTarget } from "../src/editor/toggle-headings.js";
import { mountEditor } from "./helpers.js";

function documentFixture(): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "toggle-headings", title: "Toggle headings" });
  return ydoc;
}

function blockPosition(editor: Editor, id: string): number {
  let found: number | undefined;
  editor.state.doc.forEach((node, pos) => { if (node.attrs.id === id) found = pos; });
  if (found === undefined) throw new Error(`Missing block ${id}`);
  return found;
}

function blockElement(element: HTMLElement, id: string): HTMLElement {
  const block = element.querySelector<HTMLElement>(`[id="${id}"]`);
  if (block === null) throw new Error(`Missing rendered block ${id}`);
  return block;
}

function isFolded(element: HTMLElement, id: string): boolean {
  return blockElement(element, id).closest('[data-toggle-folded="true"]') !== null;
}

async function toggle(element: HTMLElement, label: string): Promise<HTMLButtonElement> {
  const button = await waitFor(() => within(element).getByRole<HTMLButtonElement>("button", { name: label }));
  button.click();
  await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe(label.startsWith("Expand ") ? "true" : "false"));
  return button;
}

it.each([true, false])("toggles only the open view without document writes or undo steps (editable %s)", async (editable) => {
  const ydoc = documentFixture();
  const heading = appendBlock(ydoc, { type: "heading", level: 2, text: "> Help" });
  const body = appendBlock(ydoc, { type: "paragraph", text: "Exact help text" });
  appendBlock(ydoc, { type: "heading", level: 2, text: "Next" });
  const { editor, element } = mountEditor(ydoc);
  try {
    editor.commands.setTextSelection(blockPosition(editor, heading) + 1 + "> Help".length);
    editor.view.dispatch(editor.state.tr.insertText(" text"));
    editor.setEditable(editable);
    const button = await waitFor(() => within(element).getByRole<HTMLButtonElement>("button", { name: "Expand Help text" }));
    const undoManager = yUndoPluginKey.getState(editor.state)!.undoManager;
    const undoBefore = undoManager.undoStack.slice();
    expect(undoBefore.length).toBeGreaterThan(0);
    const before = Y.encodeStateAsUpdate(ydoc);
    const revision = docRev(ydoc);
    const markdown = exportMarkdown(ydoc);
    const blocks = getBlocks(ydoc);
    let writes = 0;
    ydoc.on("update", () => { writes += 1; });

    expect(isFolded(element, body)).toBe(true);
    button.focus();
    expect(await toggle(element, "Expand Help text")).toBe(button);
    expect(isFolded(element, body)).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(await toggle(element, "Collapse Help text")).toBe(button);
    expect(isFolded(element, body)).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(writes).toBe(0);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(docRev(ydoc)).toBe(revision);
    expect(exportMarkdown(ydoc)).toBe(markdown);
    expect(getBlocks(ydoc)).toEqual(blocks);
    expect(undoManager.undoStack).toEqual(undoBefore);
    expect(undo(editor.state)).toBe(true);
    expect(getBlocks(ydoc)[0]?.text).toBe("> Help");
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("folds flat source, card and table blocks within heading boundaries and reveals nested targets", async () => {
  const ydoc = documentFixture();
  appendBlock(ydoc, { type: "heading", level: 2, text: "> Parent" });
  const introduction = appendBlock(ydoc, { type: "paragraph", text: "Introduction" });
  const child = appendBlock(ydoc, { type: "heading", level: 3, text: "> Child" });
  const code = appendBlock(ydoc, { type: "code", text: "get_help(get_doc)" });
  const card = appendBlock(ydoc, { type: "card", text: "title: Help\n\nDetails" });
  const table = appendBlock(ydoc, { type: "table", text: "| Tool | Result |\n| --- | --- |\n| get_doc | All blocks |" });
  const ordinary = appendBlock(ydoc, { type: "heading", level: 3, text: "Ordinary child" });
  const ordinaryBody = appendBlock(ydoc, { type: "paragraph", text: "Still under Parent" });
  const next = appendBlock(ydoc, { type: "heading", level: 2, text: "Next section" });
  appendBlock(ydoc, { type: "heading", level: 1, text: "> Last" });
  const lastBody = appendBlock(ydoc, { type: "paragraph", text: "To the end" });
  const { editor, element } = mountEditor(ydoc);
  try {
    for (const id of [introduction, child, code, card, table, ordinary, ordinaryBody, lastBody]) {
      expect(isFolded(element, id), getBlocks(ydoc).find((block) => block.id === id)?.text).toBe(true);
    }
    expect(isFolded(element, next)).toBe(false);
    await toggle(element, "Expand Parent");
    for (const id of [introduction, child, ordinary, ordinaryBody]) expect(isFolded(element, id)).toBe(false);
    for (const id of [code, card, table]) expect(isFolded(element, id)).toBe(true);
    await toggle(element, "Expand Child");
    for (const id of [code, card, table]) expect(isFolded(element, id)).toBe(false);
    await toggle(element, "Collapse Parent");
    await toggle(element, "Expand Parent");
    for (const id of [code, card, table]) expect(isFolded(element, id)).toBe(false);
    await toggle(element, "Collapse Child");
    await toggle(element, "Collapse Parent");
    revealFoldedTarget(blockElement(element, code).querySelector("code")!);
    await waitFor(() => expect(within(element).getByRole("button", { name: "Collapse Child" }).getAttribute("aria-expanded")).toBe("true"));
    expect(within(element).getByRole("button", { name: "Collapse Parent" }).getAttribute("aria-expanded")).toBe("true");
    expect(isFolded(element, code)).toBe(false);
    expect(isFolded(element, lastBody)).toBe(true);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("recognizes only the exact heading prefix and reveals the marker at the editable caret", async () => {
  const ydoc = documentFixture();
  const toggleHeading = appendBlock(ydoc, { type: "heading", level: 2, inline: [
    { text: ">", marks: { bold: true } }, { text: " Help", marks: {} },
  ] });
  appendBlock(ydoc, { type: "paragraph", text: "> Paragraph" });
  appendBlock(ydoc, { type: "heading", level: 2, text: ">x" });
  appendBlock(ydoc, { type: "heading", level: 2, text: " > x" });
  const { editor, element } = mountEditor(ydoc);
  try {
    await waitFor(() => expect(within(element).getAllByRole("button", { name: "Expand Help" })).toHaveLength(1));
    expect(element.querySelectorAll("[data-toggle-heading]")).toHaveLength(1);
    const heading = blockElement(element, toggleHeading);
    expect(heading.querySelector(".ub-toggle-heading-marker")?.getAttribute("aria-hidden")).toBe("true");
    editor.view.focus();
    editor.commands.setTextSelection(blockPosition(editor, toggleHeading) + 4);
    expect(heading.querySelector(".ub-toggle-heading-marker")).toBeNull();
    expect(getBlocks(ydoc)[0]?.text).toBe("> Help");
    editor.view.dom.blur();
    expect(heading.querySelector(".ub-toggle-heading-marker")).not.toBeNull();
    editor.setEditable(false);
    editor.view.focus();
    expect(heading.querySelector(".ub-toggle-heading-marker")).not.toBeNull();
  } finally { editor.destroy(); ydoc.destroy(); }
});

it.each(["keydown", "beforeinput"])("deletes the marker after native Home before selectionchange (%s)", async (eventType) => {
  const ydoc = documentFixture();
  const headingId = appendBlock(ydoc, { type: "heading", level: 2, text: "> Help" });
  const body = appendBlock(ydoc, { type: "paragraph", text: "Details" });
  const { editor, element } = mountEditor(ydoc);
  try {
    await waitFor(() => within(element).getByRole("button", { name: "Expand Help" }));
    editor.view.focus();
    const start = blockPosition(editor, headingId) + 1;
    editor.commands.setTextSelection(start + "> Help".length);
    const heading = blockElement(element, headingId);
    expect(isFolded(element, body)).toBe(true);

    // Home moves the native caret before the widget; selectionchange has not run.
    document.getSelection()!.collapse(heading, 0);
    expect(editor.state.selection.head).toBe(start + "> Help".length);
    const event = eventType === "keydown"
      ? new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })
      : new InputEvent("beforeinput", { inputType: "deleteContentForward", bubbles: true, cancelable: true });
    heading.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(getBlocks(ydoc)[0]?.text).toBe(" Help");
    expect(editor.state.selection.head).toBe(start);
    expect(isFolded(element, body)).toBe(false);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it.each([
  { eventType: "keydown", forward: true }, { eventType: "keydown", forward: false },
  { eventType: "beforeinput", forward: true }, { eventType: "beforeinput", forward: false },
])("protects the current folded boundary before selectionchange ($eventType, forward $forward)", async ({ eventType, forward }) => {
  const ydoc = documentFixture();
  const heading = appendBlock(ydoc, { type: "heading", level: 2, text: "> Help" });
  const body = appendBlock(ydoc, { type: "paragraph", text: "Details" });
  const next = appendBlock(ydoc, { type: "heading", level: 2, text: "Next" });
  const { editor, element } = mountEditor(ydoc);
  try {
    await waitFor(() => within(element).getByRole("button", { name: "Expand Help" }));
    editor.view.focus();
    const id = forward ? heading : next;
    const start = blockPosition(editor, id) + 1;
    const end = start + (forward ? "> Help" : "Next").length;
    editor.commands.setTextSelection(forward ? start : end);
    const target = blockElement(element, id);
    const before = getBlocks(ydoc);
    document.getSelection()!.collapse(target, forward ? target.childNodes.length : 0);
    const event = eventType === "keydown"
      ? new KeyboardEvent("keydown", { key: forward ? "Delete" : "Backspace", bubbles: true, cancelable: true })
      : new InputEvent("beforeinput", { inputType: forward ? "deleteContentForward" : "deleteContentBackward", bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.selection.head).toBe(forward ? end : start);
    expect(getBlocks(ydoc)).toEqual(before);
    expect(isFolded(element, body)).toBe(true);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it.each([
  { eventType: "keydown", forward: true }, { eventType: "keydown", forward: false },
  { eventType: "beforeinput", forward: true }, { eventType: "beforeinput", forward: false },
])("leaves chart source unchanged with a native caret in noneditable chrome ($eventType, forward $forward)", async ({ eventType, forward }) => {
  const ydoc = documentFixture();
  appendBlock(ydoc, { type: "paragraph", text: "Before" });
  appendBlock(ydoc, { type: "chart", text: "not a chart" });
  const after = appendBlock(ydoc, { type: "paragraph", text: "After" });
  const { editor, element } = mountEditor(ydoc);
  try {
    const message = await waitFor(() => {
      const target = element.querySelector(".ub-chart-message");
      expect(target?.textContent).toContain("Invalid chart configuration");
      return target!;
    });
    editor.view.focus();
    editor.commands.setTextSelection(blockPosition(editor, after) + 1 + "After".length);
    const before = getBlocks(ydoc);
    const selection = editor.state.selection;
    const text = message.firstChild!;
    document.getSelection()!.collapse(text, 1);
    const event = eventType === "keydown"
      ? new KeyboardEvent("keydown", { key: forward ? "Delete" : "Backspace", bubbles: true, cancelable: true })
      : new InputEvent("beforeinput", { inputType: forward ? "deleteContentForward" : "deleteContentBackward", bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);

    expect(getBlocks(ydoc)).toEqual(before);
    expect(editor.state.selection.eq(selection)).toBe(true);
    expect(document.getSelection()!.focusNode).toBe(text);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("keeps expansion through position changes, resets a recreated toggle and isolates separate views", async () => {
  const ydoc = documentFixture();
  const preface = appendBlock(ydoc, { type: "paragraph", text: "Before" });
  const heading = appendBlock(ydoc, { type: "heading", level: 2, text: "> Help" });
  const body = appendBlock(ydoc, { type: "paragraph", text: "Details" });
  const first = mountEditor(ydoc);
  let second: ReturnType<typeof mountEditor> | undefined;
  try {
    await toggle(first.element, "Expand Help");
    first.editor.view.dispatch(first.editor.state.tr.insertText("Longer ", blockPosition(first.editor, preface) + 1));
    expect(isFolded(first.element, body)).toBe(false);
    await waitFor(() => expect(within(first.element).getByRole("button", { name: "Collapse Help" }).getAttribute("aria-expanded")).toBe("true"));
    second = mountEditor(ydoc);
    await waitFor(() => expect(within(second!.element).getByRole("button", { name: "Expand Help" }).getAttribute("aria-expanded")).toBe("false"));
    expect(isFolded(first.element, body)).toBe(false);
    expect(isFolded(second.element, body)).toBe(true);
    const at = blockPosition(first.editor, heading) + 1;
    first.editor.view.dispatch(first.editor.state.tr.delete(at, at + 2));
    expect(isFolded(first.element, body)).toBe(false);
    first.editor.view.dispatch(first.editor.state.tr.insertText("> ", at));
    await waitFor(() => expect(within(first.element).getByRole("button", { name: "Expand Help" }).getAttribute("aria-expanded")).toBe("false"));
    expect(isFolded(first.element, body)).toBe(true);
  } finally { second?.editor.destroy(); first.editor.destroy(); ydoc.destroy(); }
});

it("keeps expansion and the caret inside its section across a peer update", async () => {
  const ydoc = documentFixture();
  const preface = appendBlock(ydoc, { type: "paragraph", text: "Before" });
  appendBlock(ydoc, { type: "heading", level: 2, text: "> Help" });
  const body = appendBlock(ydoc, { type: "paragraph", text: "Details" });
  appendBlock(ydoc, { type: "heading", level: 2, text: "Next" });
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  const { editor, element } = mountEditor(ydoc);
  try {
    await toggle(element, "Expand Help");
    editor.view.focus();
    editor.commands.setTextSelection(blockPosition(editor, body) + 4);
    editBlock(peer, preface, "Before", "Before remote");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), "remote");

    expect(blockElement(element, preface).textContent).toBe("Before remote");
    expect(isFolded(element, body)).toBe(false);
    await waitFor(() => expect(within(element).getByRole("button", { name: "Collapse Help" }).getAttribute("aria-expanded")).toBe("true"));
    expect(editor.state.selection.head).toBe(blockPosition(editor, body) + 4);
    expect(editor.state.selection.empty).toBe(true);
  } finally { editor.destroy(); peer.destroy(); ydoc.destroy(); }
});

it("keeps expansion and the caret inside its section across actual undo and redo", async () => {
  const ydoc = documentFixture();
  appendBlock(ydoc, { type: "heading", level: 2, text: "> Help" });
  const body = appendBlock(ydoc, { type: "paragraph", text: "Details" });
  appendBlock(ydoc, { type: "heading", level: 2, text: "Next" });
  const { editor, element } = mountEditor(ydoc);
  try {
    await toggle(element, "Expand Help");
    editor.view.focus();
    editor.commands.setTextSelection(blockPosition(editor, body) + 1 + "Details".length);
    editor.view.dispatch(editor.state.tr.insertText(" more"));
    expect(blockElement(element, body).textContent).toBe("Details more");
    expect(undo(editor.state)).toBe(true);
    expect(blockElement(element, body).textContent).toBe("Details");
    expect(isFolded(element, body)).toBe(false);
    expect(editor.state.selection.head).toBe(blockPosition(editor, body) + 1 + "Details".length);
    expect(redo(editor.state)).toBe(true);
    expect(blockElement(element, body).textContent).toBe("Details more");
    expect(isFolded(element, body)).toBe(false);
    expect(editor.state.selection.head).toBe(blockPosition(editor, body) + 1 + "Details more".length);
    await waitFor(() => expect(within(element).getByRole("button", { name: "Collapse Help" }).getAttribute("aria-expanded")).toBe("true"));
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("moves text, node and cell selections out of a collapsed section and skips hidden endpoints", async () => {
  const ydoc = documentFixture();
  const heading = appendBlock(ydoc, { type: "heading", level: 2, text: "> Help" });
  const body = appendBlock(ydoc, { type: "paragraph", text: "Details" });
  const code = appendBlock(ydoc, { type: "code", text: "Exact source" });
  const table = appendBlock(ydoc, { type: "table", text: "| Tool |\n| --- |\n| get_doc |" });
  const next = appendBlock(ydoc, { type: "heading", level: 2, text: "Next" });
  const { editor, element } = mountEditor(ydoc);
  try {
    const headingEnd = blockPosition(editor, heading) + editor.state.doc.child(0).nodeSize - 1;
    await toggle(element, "Expand Help");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, blockPosition(editor, body) + 1, blockPosition(editor, body) + 5)));
    await toggle(element, "Collapse Help");
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.head).toBe(headingEnd);
    await toggle(element, "Expand Help");
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, blockPosition(editor, code))));
    await toggle(element, "Collapse Help");
    expect(editor.state.selection.head).toBe(headingEnd);
    await toggle(element, "Expand Help");
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, blockPosition(editor, table) + 2)));
    await toggle(element, "Collapse Help");
    expect(editor.state.selection.head).toBe(headingEnd);
    editor.commands.setTextSelection(blockPosition(editor, body) + 1);
    expect(editor.state.selection.head).toBe(blockPosition(editor, next) + 1);
    editor.commands.setTextSelection(blockPosition(editor, body) + 1);
    expect(editor.state.selection.head).toBe(headingEnd);
    editor.commands.setTextSelection(blockPosition(editor, next) + 1);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, blockPosition(editor, table))));
    expect(editor.state.selection.anchor).toBe(headingEnd);
    expect(editor.state.selection.head).toBe(headingEnd);
    editor.view.dispatch(editor.state.tr.delete(blockPosition(editor, next), editor.state.doc.content.size));
    editor.commands.setTextSelection(blockPosition(editor, body) + 1);
    expect(editor.state.selection.head).toBe(headingEnd);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, blockPosition(editor, table))));
    expect(editor.state.selection.anchor).toBe(headingEnd);
    expect(editor.state.selection.head).toBe(headingEnd);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("moves the caret out when a local heading-level edit folds its current block", async () => {
  const ydoc = documentFixture();
  appendBlock(ydoc, { type: "heading", level: 2, text: "> Parent" });
  appendBlock(ydoc, { type: "paragraph", text: "Folded body" });
  const boundary = appendBlock(ydoc, { type: "heading", level: 2, text: "Boundary" });
  appendBlock(ydoc, { type: "paragraph", text: "Boundary body" });
  const { editor, element } = mountEditor(ydoc);
  try {
    await waitFor(() => expect(within(element).getByRole("button", { name: "Expand Parent" }).getAttribute("aria-expanded")).toBe("false"));
    expect(isFolded(element, boundary)).toBe(false);
    const at = blockPosition(editor, boundary);
    editor.commands.setTextSelection(at + 3);
    const expectedBlocks = getBlocks(ydoc).map((block) => block.id === boundary
      ? { ...block, level: 3, rev: expect.any(String) } : block);
    const change = editor.state.tr.setNodeAttribute(at, "level", "3");
    expect(change.docChanged).toBe(true);
    expect(change.selectionSet).toBe(false);
    const expectedDocument = change.doc.toJSON();
    let writes = 0;
    ydoc.on("update", () => { writes += 1; });
    editor.view.dispatch(change);

    expect(isFolded(element, boundary)).toBe(true);
    const headingEnd = editor.state.doc.child(0).nodeSize - 1;
    expect(editor.state.selection.head).toBe(headingEnd);
    expect(editor.state.selection.anchor).toBe(headingEnd);
    expect(editor.state.doc.toJSON()).toEqual(expectedDocument);
    expect(getBlocks(ydoc)).toEqual(expectedBlocks);
    expect(writes).toBe(1);
  } finally { editor.destroy(); ydoc.destroy(); }
});

it("starts a remotely created toggle collapsed without additional document writes", async () => {
  const ydoc = documentFixture();
  const heading = appendBlock(ydoc, { type: "heading", level: 2, text: "Help" });
  const body = appendBlock(ydoc, { type: "paragraph", text: "Details" });
  appendBlock(ydoc, { type: "heading", level: 2, text: "Next" });
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  const { editor, element } = mountEditor(ydoc);
  try {
    editor.commands.setTextSelection(blockPosition(editor, body) + 3);
    let localWrites = 0;
    ydoc.on("update", (_update, origin) => { if (origin !== "remote-toggle") localWrites += 1; });
    editBlock(peer, heading, "Help", "> Help");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), "remote-toggle");
    await waitFor(() => expect(within(element).getByRole("button", { name: "Expand Help" }).getAttribute("aria-expanded")).toBe("false"));
    expect(isFolded(element, body)).toBe(true);
    expect(localWrites).toBe(0);
    expect(getBlocks(ydoc)[0]?.text).toBe("> Help");
  } finally { editor.destroy(); peer.destroy(); ydoc.destroy(); }
});
