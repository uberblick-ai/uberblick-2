/** The language picker owns one block across focus, sync and permission changes. */
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { common, createLowlight } from "lowlight";
import { redo, undo } from "y-prosemirror";
import * as Y from "yjs";
import { appendBlock, deleteBlock, insertBlock, setBlockType } from "@uberblick/schema";
import { CodeLanguageControl } from "../src/ui/CodeLanguageControl.js";
import { mountEditor, snapshotFragment } from "./helpers.js";
import { act, renderSettled } from "./react-render.js";

const SOURCE = "const answer = 42;";

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
});

function block(editor: Editor, id: string): { pos: number; node: PMNode } {
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.forEach((node, pos) => {
    if (node.attrs.id === id) found = { pos, node };
  });
  if (found === null) throw new Error("fixture block is missing");
  return found;
}

async function fixture(language = "unknown", canWrite: () => boolean = () => true): Promise<{
  ydoc: Y.Doc; editor: Editor; element: HTMLElement; id: string; other: string;
}> {
  const ydoc = new Y.Doc();
  const id = appendBlock(ydoc, { type: "code", text: SOURCE, language });
  const other = appendBlock(ydoc, { type: "code", text: "print('second')", language: "python" });
  const { editor, element } = mountEditor(ydoc);
  editor.commands.setTextSelection(4);
  await renderSettled(<CodeLanguageControl editor={editor} canWrite={canWrite} />);
  return { ydoc, editor, element, id, other };
}

function trigger(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Code language" });
}

async function open(): Promise<HTMLInputElement> {
  await act(async () => trigger().click());
  return screen.getByRole<HTMLInputElement>("combobox", { name: "Search languages" });
}

function options(): HTMLButtonElement[] {
  return within(screen.getByRole("listbox", { name: "Code languages" }))
    .getAllByRole<HTMLButtonElement>("option");
}

function option(name: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("option", { name });
}

function typeInto(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function pick(name: string): Promise<void> {
  await act(async () => option(name).click());
}

function peerOf(local: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  peer.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  return peer;
}

describe("code block language", () => {
  it("attaches to the selected block and lists the highlighter registry with one Plain text choice", async () => {
    const fix = await fixture("ts");
    const caption = fix.element.querySelector(".ub-code-caption");
    expect(caption?.contains(trigger())).toBe(true);
    expect(trigger().textContent).toContain("ts");
    const search = await open();
    expect(document.activeElement).toBe(search);
    const labels = options().map((item) => item.textContent?.replace("✓", "").trim());
    expect(labels).toEqual(["Plain text", ...createLowlight(common).listLanguages()
      .filter((name) => name !== "plaintext").sort()]);
    expect(screen.queryByRole("option", { name: "plaintext" })).toBeNull();
    expect(screen.queryByRole("option", { name: "ts" })).toBeNull();

    act(() => typeInto(search, " JAVA "));
    expect(options().map((item) => item.textContent?.trim())).toEqual(["java", "javascript"]);
    act(() => typeInto(search, "no such language"));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching languages.")).not.toBeNull();
    expect(block(fix.editor, fix.id).node.attrs.language).toBe("ts");
  });

  it.each(["ts", "not-supported"])("preserves stored %s on open and Escape, then returns focus to its block", async (language) => {
    const fix = await fixture(language);
    const before = snapshotFragment(fix.ydoc);
    const selection = fix.editor.state.selection;
    const search = await open();
    expect(trigger().textContent).toContain(language);
    act(() => typeInto(search, "python"));
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    })));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(snapshotFragment(fix.ydoc)).toEqual(before);
    expect(fix.editor.state.selection.anchor).toBe(selection.anchor);
    expect(fix.editor.state.selection.head).toBe(selection.head);
    await waitFor(() => expect(document.activeElement).toBe(fix.editor.view.dom));
  });

  it("changes only language, highlights immediately, and keeps each pick separate from typing in undo", async () => {
    const fix = await fixture();
    const original = snapshotFragment(fix.ydoc);
    expect(fix.element.querySelector(".hljs-keyword")).toBeNull();
    act(() => fix.editor.view.dispatch(fix.editor.state.tr.insertText(" // note", SOURCE.length + 1)));
    const typed = snapshotFragment(fix.ydoc);
    let writes = 0;
    fix.editor.on("transaction", ({ transaction }) => { if (transaction.docChanged) writes += 1; });

    await open();
    await pick("javascript");
    expect(writes).toBe(1);
    const changed = snapshotFragment(fix.ydoc);
    expect(changed[0]).toEqual({ ...typed[0], attributes: { ...typed[0]?.attributes, language: "javascript" } });
    expect(changed[1]).toEqual(typed[1]);
    expect(fix.element.querySelector(".hljs-keyword")?.textContent).toBe("const");
    await waitFor(() => expect(document.activeElement).toBe(fix.editor.view.dom));

    act(() => { undo(fix.editor.state); });
    expect(snapshotFragment(fix.ydoc)).toEqual(typed);
    act(() => { undo(fix.editor.state); });
    expect(snapshotFragment(fix.ydoc)).toEqual(original);
    act(() => { redo(fix.editor.state); redo(fix.editor.state); });
    expect(snapshotFragment(fix.ydoc)).toEqual(changed);

    await open();
    await pick("Plain text");
    expect(block(fix.editor, fix.id).node.attrs.language).toBe("");
    expect(fix.element.querySelector(`#${CSS.escape(fix.id)} .hljs-keyword`)).toBeNull();
    expect(block(fix.editor, fix.id).node.textContent).toBe(`${SOURCE} // note`);
  });

  it("resolves its original block after a remote insertion shifts positions and the caret moves elsewhere", async () => {
    const fix = await fixture("ts");
    const peer = peerOf(fix.ydoc);
    const before = block(fix.editor, fix.id).pos;
    await open();
    act(() => {
      insertBlock(peer, null, { type: "paragraph", text: "Remote preface" });
      fix.editor.commands.setTextSelection(block(fix.editor, fix.other).pos + 2);
    });
    expect(block(fix.editor, fix.id).pos).toBeGreaterThan(before);
    await pick("javascript");
    expect(block(fix.editor, fix.id).node.attrs.language).toBe("javascript");
    expect(block(fix.editor, fix.id).node.textContent).toBe(SOURCE);
    expect(block(fix.editor, fix.other).node.attrs.language).toBe("python");
    expect(fix.editor.state.selection.anchor).toBe(block(fix.editor, fix.id).pos + 4);
    peer.destroy();
  });

  it.each(["deleted", "retyped"])("closes when its block is %s and never retargets a stale pick", async (change) => {
    const fix = await fixture("ts");
    const peer = peerOf(fix.ydoc);
    await open();
    const stale = option("javascript");
    await act(async () => {
      if (change === "deleted") deleteBlock(peer, fix.id);
      else setBlockType(peer, fix.id, "paragraph");
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    const before = snapshotFragment(fix.ydoc);
    await act(async () => stale.click());
    expect(snapshotFragment(fix.ydoc)).toEqual(before);
    expect(block(fix.editor, fix.other).node.attrs.language).toBe("python");
    peer.destroy();
  });

  it("rereads permission for the caret shortcut and at pick time", async () => {
    let writable = false;
    const fix = await fixture("ts", () => writable);
    const shortcut = (): boolean => fix.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", {
      key: "F10", shiftKey: true, bubbles: true, cancelable: true,
    }));
    await act(async () => { expect(shortcut()).toBe(true); });
    expect(screen.queryByRole("listbox")).toBeNull();
    writable = true;
    await act(async () => { expect(shortcut()).toBe(false); });
    expect(screen.getByRole("combobox", { name: "Search languages" })).not.toBeNull();
    const before = snapshotFragment(fix.ydoc);
    writable = false;
    await pick("javascript");
    expect(snapshotFragment(fix.ydoc)).toEqual(before);
  });
});
