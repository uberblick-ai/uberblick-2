import { screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import {
  appendBlock, cardButtons, cardPartTexts, createAnnotation, deleteBlock, editBlock, getBlocks,
  getBlocksFragment, insertBlock, listAnnotations, resolveAnnotationRange,
} from "@uberblick/schema";
import { openCardButton } from "../src/editor/card-button.js";
import { cardTitleOffset } from "../src/editor/card.js";
import { CardButtonControls } from "../src/ui/editor-controls/CardButtonControls.js";
import { mountEditor } from "./helpers.js";
import { act, renderSettled } from "./react-render.js";

async function fixture(source = "title: Action\n\nBody", options: {
  before?: string; after?: string; canWrite?: () => boolean;
} = {}): Promise<{
  ydoc: Y.Doc; card: Y.XmlElement; editor: ReturnType<typeof mountEditor>["editor"];
}> {
  const ydoc = new Y.Doc();
  if (options.before !== undefined) appendBlock(ydoc, { type: "paragraph", text: options.before });
  appendBlock(ydoc, { type: "card", text: source });
  const card = getBlocksFragment(ydoc).get(options.before === undefined ? 0 : 1) as Y.XmlElement;
  if (options.after !== undefined) appendBlock(ydoc, { type: "paragraph", text: options.after });
  const { editor } = mountEditor(ydoc);
  await renderSettled(<CardButtonControls editor={editor} canWrite={options.canWrite ?? (() => true)} />);
  return { ydoc, card, editor };
}

async function click(name: string): Promise<void> {
  await act(async () => screen.getByRole<HTMLButtonElement>("button", { name }).click());
}

function fill(text: string, href: string): void {
  fireEvent.change(screen.getByLabelText("Button text"), { target: { value: text } });
  fireEvent.change(screen.getByLabelText("Button destination"), { target: { value: href } });
}

describe("card action controls", () => {
  it("removes the whole rich card and restores its highlights and buttons in an undo step isolated from typing", async () => {
    const { ydoc, card, editor } = await fixture(
      "label: **Release**\ntitle: *Ship v0.5*\nfooter: [Details](https://example.invalid/details)\nbutton: [First](codex://new) filled violet\nbutton: [Second](https://example.invalid/second) outline green\n\nBody with `code` and **formatting**",
      { before: "Before", after: "After" },
    );
    const id = card.getAttribute("id")!;
    let threadId = "";
    act(() => {
      threadId = createAnnotation(ydoc, id, 0, 4, "Reader", "Discuss this card", { part: "body" }).id;
    });
    const original = editor.state.doc.toJSON();
    const originalRange = resolveAnnotationRange(ydoc, threadId);
    const beforeCard = editor.state.doc.child(0).nodeSize;
    act(() => {
      editor.commands.setTextSelection(beforeCard + cardTitleOffset(editor.state.doc.child(1)));
      editor.view.dispatch(editor.state.tr.insertText("Updated "));
    });
    const typedBefore = editor.state.doc.toJSON();
    const neighbours = [getBlocksFragment(ydoc).get(0), getBlocksFragment(ydoc).get(2)];
    act(() => screen.getByRole<HTMLButtonElement>("button", { name: "Remove card" }).focus());
    await click("Remove card");
    expect(getBlocksFragment(ydoc).toArray()).toEqual(neighbours);
    expect(editor.view.hasFocus()).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe("After");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    expect(resolveAnnotationRange(ydoc, threadId)).toBeNull();
    expect(listAnnotations(ydoc).map((thread) => thread.id)).toContain(threadId);
    expect(editor.view.dom.querySelector(`[data-comment-thread="${threadId}"]`)).toBeNull();
    const removed = editor.state.doc.toJSON();
    act(() => editor.view.dispatch(editor.state.tr.insertText("after ")));
    expect(editor.state.doc.lastChild?.textContent).toBe("after After");
    act(() => { expect(undo(editor.state)).toBe(true); });
    expect(editor.state.doc.toJSON()).toEqual(removed);
    act(() => { expect(undo(editor.state)).toBe(true); });
    expect(editor.state.doc.toJSON()).toEqual(typedBefore);
    expect(resolveAnnotationRange(ydoc, threadId)).toEqual(originalRange);
    expect(editor.view.dom.querySelector(`[data-comment-thread="${threadId}"]`)?.textContent).toBe("Body");
    act(() => { expect(undo(editor.state)).toBe(true); });
    expect(editor.state.doc.toJSON()).toEqual(original);
  });

  it.each([
    { name: "first", after: "Next", expected: "Next", offset: 0 },
    { name: "middle", before: "Previous", after: "Next", expected: "Next", offset: 0 },
    { name: "last", before: "Previous", expected: "Previous", offset: 8 },
    { name: "only", expected: "", offset: 0 },
  ])("moves the caret to the correct paragraph when removing the $name block", async ({ expected, offset, ...options }) => {
    const { before, after } = options;
    const { editor } = await fixture(undefined, options);
    const original = editor.state.doc.toJSON();
    await click("Remove card");
    expect(editor.state.doc.childCount).toBe(before !== undefined && after !== undefined ? 2 : 1);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe(expected);
    expect(editor.state.selection.$from.parentOffset).toBe(offset);
    expect(editor.view.hasFocus()).toBe(true);
    if (before === undefined && after === undefined) expect(editor.state.doc.firstChild?.attrs.id).toEqual(expect.any(String));
    act(() => { expect(undo(editor.state)).toBe(true); });
    expect(editor.state.doc.toJSON()).toEqual(original);
  });

  it("resolves the card by id after remote insertion and shares removal without changing other blocks", async () => {
    const { ydoc, card, editor } = await fixture(undefined, { after: "Next" });
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
      act(() => {
        insertBlock(peer, null, { type: "paragraph", text: "Remote preface" });
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
      });
      const others = editor.state.doc.content.content.filter((node) => node.attrs.id !== card.getAttribute("id"))
        .map((node) => node.toJSON());
      await click("Remove card");
      expect(editor.state.doc.content.content.map((node) => node.toJSON())).toEqual(others);
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
      expect(getBlocks(peer)).toEqual(getBlocks(ydoc));
      expect(getBlocks(peer).map((block) => block.text)).toEqual(["Remote preface", "Next"]);
    } finally { peer.destroy(); }
  });

  it("ignores a stale activation after another client removed the card", async () => {
    const { ydoc, card, editor } = await fixture(undefined, { before: "Previous", after: "Next" });
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
      const remove = screen.getByRole<HTMLButtonElement>("button", { name: "Remove card" });
      act(() => {
        deleteBlock(peer, card.getAttribute("id")!);
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
        const before = editor.state.doc.toJSON();
        remove.click();
        expect(editor.state.doc.toJSON()).toEqual(before);
      });
      expect(getBlocks(ydoc).map((block) => block.text)).toEqual(["Previous", "Next"]);
    } finally { peer.destroy(); }
  });

  it.each(["permission", "editable"])("rechecks %s at activation before removing a card", async (guard) => {
    let writable = true;
    const { editor } = await fixture(undefined, { canWrite: () => writable });
    const remove = screen.getByRole<HTMLButtonElement>("button", { name: "Remove card" });
    const original = editor.state.doc.toJSON();
    act(() => {
      if (guard === "permission") writable = false;
      else editor.setEditable(false);
      remove.click();
    });
    expect(editor.state.doc.toJSON()).toEqual(original);
  });

  it("adds literal author text, refuses unsafe destinations visibly, edits and removes without changing prose", async () => {
    const { card } = await fixture();
    const body = cardPartTexts(card, "body")[0]!;
    await click("Add button");
    expect(document.activeElement).toBe(screen.getByLabelText("Button text"));
    act(() => fill("Discuss in **Codex**", "codex://settings"));
    await click("Save button");
    expect(screen.getByRole("alert").textContent).toContain("codex://new");
    expect(card.getAttribute("button")).toBeUndefined();
    act(() => fill("Discuss in **Codex**", "codex://new?prompt=Review%20this"));
    await click("Save button");
    expect(cardButtons(card)).toEqual([{ text: "Discuss in **Codex**", href: "codex://new?prompt=Review%20this" }]);
    expect(screen.getByRole("button", { name: "Discuss in **Codex**" }).textContent).toBe("Discuss in **Codex**");
    await click("Edit buttons");
    expect(screen.getByLabelText<HTMLInputElement>("Button text").value).toBe("Discuss in **Codex**");
    act(() => fill("Read report", "https://example.invalid/report"));
    await click("Save button");
    expect(cardButtons(card)).toEqual([{ text: "Read report", href: "https://example.invalid/report" }]);
    await click("Edit buttons");
    await click("Remove button");
    expect(card.getAttribute("button")).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Read report" })).toBeNull();
    expect(cardPartTexts(card, "body")[0]).toBe(body);
    expect(body.toString()).toBe("Body");
  });

  it("appends buttons and changes or removes one without changing its neighbours or prose", async () => {
    const { card } = await fixture("title: Action\nbutton: [First](https://example.invalid/first) filled violet\nbutton: [Second](claude-cli://open?q=Second) outline green\n\nBody");
    const original = cardButtons(card);
    const body = cardPartTexts(card, "body")[0]!;
    await click("Edit buttons");
    await click("Add button");
    act(() => fill("Third", "codex://new?prompt=Third"));
    await click("filled");
    await click("blue");
    await click("Save button");
    expect(cardButtons(card)).toEqual([...original, { text: "Third", href: "codex://new?prompt=Third", style: "filled", color: "blue" }]);
    await click("Edit buttons");
    await click("2. Second");
    expect(screen.getByRole("button", { name: "outline" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "green" }).getAttribute("aria-pressed")).toBe("true");
    act(() => fill("Second changed", "https://example.invalid/second"));
    await click("filled");
    await click("neutral");
    await click("Save button");
    const changed = cardButtons(card);
    expect(changed[0]).toEqual(original[0]);
    expect(changed[1]).toEqual({ text: "Second changed", href: "https://example.invalid/second", style: "filled" });
    expect(changed[2]).toEqual({ text: "Third", href: "codex://new?prompt=Third", style: "filled", color: "blue" });
    expect([...document.querySelectorAll(".ub-card-button")].map((button) => button.textContent)).toEqual(["First", "Second changed", "Third"]);
    await click("Edit buttons");
    await click("2. Second changed");
    await click("Remove button");
    expect(cardButtons(card)).toEqual([changed[0], changed[2]]);
    expect(cardPartTexts(card, "body")[0]).toBe(body);
    expect(body.toString()).toBe("Body");
  });

  it("preserves newer remote buttons when saving an open form", async () => {
    const { ydoc, card } = await fixture("title: Action\nbutton: [First](https://example.invalid/first)\nbutton: [Second](codex://new) filled blue\n\nBody");
    await click("Edit buttons");
    act(() => fill("First changed", "https://example.invalid/changed"));
    act(() => editBlock(ydoc, card.getAttribute("id")!, getBlocks(ydoc)[0]!.text,
      "title: Action\nbutton: [First](https://example.invalid/first)\nbutton: [Second remote](claude://code/new) filled green\nbutton: [Third remote](codex://new) violet\n\nBody"));
    await click("Save button");
    expect(cardButtons(card)).toEqual([
      { text: "First changed", href: "https://example.invalid/changed" },
      { text: "Second remote", href: "claude://code/new", style: "filled", color: "green" },
      { text: "Third remote", href: "codex://new", color: "violet" },
    ]);
  });

  it("refuses to retarget an open form when a remote removal shifts its button", async () => {
    const { ydoc, card } = await fixture("title: Action\nbutton: [First](https://example.invalid/first)\nbutton: [Second](codex://new)\nbutton: [Third](claude-cli://open)\n\nBody");
    await click("Edit buttons");
    await click("2. Second");
    act(() => fill("Second changed", "https://example.invalid/changed"));
    act(() => editBlock(ydoc, card.getAttribute("id")!, getBlocks(ydoc)[0]!.text,
      "title: Action\nbutton: [Second](codex://new)\nbutton: [Third](claude-cli://open)\n\nBody"));
    const before = card.getAttribute("button");
    await click("Save button");
    expect(screen.getByRole("alert").textContent).toContain("changed while you were editing");
    expect(card.getAttribute("button")).toBe(before);
  });

  it("keeps its original card while remote insertion shifts positions and syncs the button to another client", async () => {
    const { ydoc, card, editor } = await fixture();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    ydoc.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
    peer.on("update", (update: Uint8Array) => Y.applyUpdate(ydoc, update));
    const peerEditor = mountEditor(peer).editor;
    await click("Add button");
    act(() => insertBlock(peer, null, { type: "paragraph", text: "Remote preface" }));
    act(() => fill("Open Claude", "claude://code/new?q=Opaque%20query"));
    await click("Save button");
    expect(cardButtons(card)).toEqual([{ text: "Open Claude", href: "claude://code/new?q=Opaque%20query" }]);
    const remoteCard = getBlocksFragment(peer).get(1) as Y.XmlElement;
    expect(remoteCard.getAttribute("button")).toBe(card.getAttribute("button"));
    expect(peerEditor.state.doc.child(1).attrs.button).toBe(editor.state.doc.child(1).attrs.button);
    expect(editor.state.doc.child(0).attrs.button).toBeUndefined();
    peerEditor.destroy();
    peer.destroy();
  });

  it("keeps the action active in read-only mode and withholds author controls", async () => {
    const { editor } = await fixture("title: Action\nbutton: [Read report](https://example.invalid/report)\n\nBody");
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      act(() => editor.setEditable(false));
      expect(screen.queryByRole("button", { name: "Edit buttons" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove card" })).toBeNull();
      await click("Read report");
      expect(opened).toHaveBeenCalledWith("https://example.invalid/report", "_blank", "noopener,noreferrer");
    } finally { opened.mockRestore(); }
  });
});

describe("card action navigation boundary", () => {
  it("opens https safely and dispatches only exact app routes with no new tab", () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const destinations: string[] = [];
    const activated = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.target).toBe("_self");
      destinations.push(this.getAttribute("href") ?? "");
    });
    try {
      openCardButton("https://example.invalid/report");
      const app = ["claude://code/new", "claude-cli://open?q=Opaque", "codex://new?prompt=Review%20this"];
      for (const href of app) openCardButton(href);
      for (const href of ["codex://settings", "codex://new/else", "claude://code/new#other", "javascript:alert(1)", "http://example.invalid", "/relative", null]) openCardButton(href);
      expect(opened.mock.calls).toEqual([["https://example.invalid/report", "_blank", "noopener,noreferrer"]]);
      expect(destinations).toEqual(app);
      expect(document.querySelector("[data-card-button-navigation]")).toBeNull();
    } finally { opened.mockRestore(); activated.mockRestore(); }
  });
});
