import { screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, cardButton, cardPartTexts, getBlocksFragment, insertBlock,
} from "@uberblick/schema";
import { openCardButton } from "../src/editor/card-button.js";
import { CardButtonControls } from "../src/ui/CardButtonControls.js";
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
    expect(cardButton(card)).toEqual({ text: "Discuss in **Codex**", href: "codex://new?prompt=Review%20this" });
    expect(screen.getByRole("button", { name: "Discuss in **Codex**" }).textContent).toBe("Discuss in **Codex**");
    await click("Edit button");
    expect(screen.getByLabelText<HTMLInputElement>("Button text").value).toBe("Discuss in **Codex**");
    act(() => fill("Read report", "https://example.invalid/report"));
    await click("Save button");
    expect(cardButton(card)).toEqual({ text: "Read report", href: "https://example.invalid/report" });
    await click("Edit button");
    await click("Remove button");
    expect(card.getAttribute("button")).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Read report" })).toBeNull();
    expect(cardPartTexts(card, "body")[0]).toBe(body);
    expect(body.toString()).toBe("Body");
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
    expect(cardButton(card)).toEqual({ text: "Open Claude", href: "claude://code/new?q=Opaque%20query" });
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
      expect(screen.queryByRole("button", { name: "Edit button" })).toBeNull();
      await click("Read report");
      expect(opened).toHaveBeenCalledWith("https://example.invalid/report", "_blank", "noopener,noreferrer");
    } finally { opened.mockRestore(); }
  });
});

describe("card action navigation boundary", () => {
  it("opens https safely and dispatches only exact app routes with no new tab", () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const activated = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.target).toBe("_self");
    });
    try {
      openCardButton("https://example.invalid/report");
      const app = ["claude://code/new", "claude-cli://open?q=Opaque", "codex://new?prompt=Review%20this"];
      for (const href of app) openCardButton(href);
      for (const href of ["codex://settings", "codex://new/else", "claude://code/new#other", "javascript:alert(1)", "http://example.invalid", "/relative", null]) openCardButton(href);
      expect(opened.mock.calls).toEqual([["https://example.invalid/report", "_blank", "noopener,noreferrer"]]);
      expect(activated.mock.instances.map((anchor) => anchor.getAttribute("href"))).toEqual(app);
      expect(document.querySelector("[data-card-button-navigation]")).toBeNull();
    } finally { opened.mockRestore(); activated.mockRestore(); }
  });
});
