import { screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, cardButtons, cardPartTexts, editBlock, getBlocks, getBlocksFragment, insertBlock,
} from "@uberblick/schema";
import { openCardButton } from "../src/editor/card-button.js";
import { CardButtonControls } from "../src/ui/editor-controls/CardButtonControls.js";
import { mountEditor } from "./helpers.js";
import { act, renderSettled } from "./react-render.js";

async function fixture(source = "title: Action\n\nBody"): Promise<{
  ydoc: Y.Doc; card: Y.XmlElement; editor: ReturnType<typeof mountEditor>["editor"];
}> {
  const ydoc = new Y.Doc();
  appendBlock(ydoc, { type: "card", text: source });
  const card = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
  const { editor } = mountEditor(ydoc);
  await renderSettled(<CardButtonControls editor={editor} canWrite={() => true} />);
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
