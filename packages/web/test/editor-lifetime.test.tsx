import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import type { ReactElement } from "react";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { appendBlock, findBlockElement, getBlocks, getBlocksFragment, initDoc, roomForDoc } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import * as guardedBinding from "../src/editor/guarded-binding.js";
import { EditorPane } from "../src/ui/document/EditorPane.js";
import { CalloutControl } from "../src/ui/editor-controls/CalloutControl.js";
import { CardButtonControls } from "../src/ui/editor-controls/CardButtonControls.js";
import { CodeLanguageControl } from "../src/ui/editor-controls/CodeLanguageControl.js";
import { act, renderSettled } from "./react-render.js";
import { onTestCleanup } from "./test-cleanup.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "946eae29-79d6-4598-bbf9-f08a1177eca4";
const PROSE = "Context stays intact.";
const LIVE: RoomStatus = {
  connected: true,
  synced: true,
  hasReceivedServerState: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  hasAnswered: true,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

function fixture(status = LIVE): RoomConnection {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: UUID, title: "Editor lifetime" });
  appendBlock(ydoc, { type: "paragraph", text: PROSE });
  appendBlock(ydoc, { type: "code", text: "const answer = 42;", language: "ts" });
  appendBlock(ydoc, { type: "callout", text: "Keep this note." });
  appendBlock(ydoc, { type: "card", text: "title: Answer\n\nKeep this card." });
  appendBlock(ydoc, { type: "table", text: "| A | B |\n| --- | --- |\n| alpha | one |" });
  return {
    room: roomForDoc(WORKSPACE, UUID),
    ydoc,
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (status: RoomStatus) => void) => {
      listener(status);
      return () => {};
    },
  } as unknown as RoomConnection;
}

const onSelectThread = (): void => {};

function pane(connection: RoomConnection, selectThread = onSelectThread, author = "Writer", archived = false): ReactElement {
  return <EditorPane connection={connection} segment={WORKSPACE} presence={[]} author={author}
    archived={archived} docLinks={null} onSelectThread={selectThread} />;
}

function editorFrom(binding: { mock: { results: readonly { value?: unknown }[] } }, index: number): Editor {
  const result = binding.mock.results[index]?.value as guardedBinding.GuardedBinding | undefined;
  const editor = result?.editor;
  if (editor == null) throw new Error("fixture editor did not bind");
  return editor;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  vi.stubGlobal("matchMedia", () => ({
    matches: false, addEventListener: () => {}, removeEventListener: () => {},
  }));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("editor lifetime in the document pane", () => {
  it("keeps controls safe through binding cleanup and edits with the replacement editor", async () => {
    const connection = fixture();
    onTestCleanup(() => connection.ydoc.destroy());
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const view = await renderSettled(pane(connection));
    const first = editorFrom(binding, 0);
    expect(first.isEditable).toBe(true);
    expect(view.container.querySelector('[aria-label="Callout variant"]')).not.toBeNull();
    expect(view.container.querySelector(".ub-card-button-edit")?.textContent).toBe("Add button");

    // React runs the binding cleanup before the controls' replacement effects.
    // A changed callback rebinds while those controls still hold the first editor.
    await act(async () => view.rerender(pane(connection, () => {})));

    expect(first.isDestroyed).toBe(true);
    expect(binding).toHaveBeenCalledTimes(2);
    const replacement = editorFrom(binding, 1);
    expect(replacement).not.toBe(first);
    expect(replacement.isDestroyed).toBe(false);
    expect(view.container.querySelector(".ub-editor .ProseMirror")?.getAttribute("contenteditable")).toBe("true");
    act(() => { replacement.commands.insertContentAt(PROSE.length + 1, " Edited."); });
    expect(getBlocks(connection.ydoc)[0]?.text).toBe(`${PROSE} Edited.`);
    expect(view.container.querySelector('[aria-label="Callout variant"]')).not.toBeNull();
  });

  it("keeps the editor and pending controls live when a block becomes unsupported", async () => {
    const connection = fixture();
    onTestCleanup(() => connection.ydoc.destroy());
    const dividerId = appendBlock(connection.ydoc, { type: "divider" });
    const divider = findBlockElement(connection.ydoc, dividerId);
    if (divider === null) throw new Error("fixture divider is missing");
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const original = getBlocks(connection.ydoc);

    function Arrival({ arrive }: { arrive: boolean }): ReactElement {
      useLayoutEffect(() => {
        // BoundEditor's changed author schedules control effects while the
        // layout effect replaces only the affected block with a placeholder.
        if (arrive) divider?.insert(0, [new Y.XmlText("Written by an older client")]);
      }, [arrive]);
      return pane(connection, onSelectThread, arrive ? "Writer renamed" : "Writer");
    }

    const view = await renderSettled(<Arrival arrive={false} />);
    const editor = editorFrom(binding, 0);
    expect(editor.isEditable).toBe(true);
    expect(view.container.querySelector('[aria-label="Callout variant"]')).not.toBeNull();
    expect(view.container.querySelector(".ub-card-button-edit")?.textContent).toBe("Add button");

    await act(async () => view.rerender(<Arrival arrive />));

    expect(editor.isDestroyed).toBe(false);
    expect(binding).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".ub-foreign")).toBeNull();
    expect(view.container.querySelector(".ub-unsupported-block")?.textContent).toBe("This block needs a newer version.");
    expect(view.container.querySelector(".ub-editor .ProseMirror")?.getAttribute("contenteditable")).toBe("true");
    expect(view.container.querySelector('[aria-label="Callout variant"]')).not.toBeNull();
    act(() => { editor.commands.insertContentAt(PROSE.length + 1, " Edited."); });
    expect(getBlocks(connection.ydoc)[0]?.text).toBe(`${PROSE} Edited.`);
    expect(getBlocks(connection.ydoc).slice(1, -1)).toEqual(original.slice(1, -1));
    expect(findBlockElement(connection.ydoc, dividerId)).toBe(divider);
    expect(divider.getAttributes()).toEqual({ id: dividerId });
    expect(divider.length).toBe(1);
    expect(divider.firstChild?.toString()).toBe("Written by an older client");

    await act(async () => divider.delete(0, divider.length));
    expect(editor.isDestroyed).toBe(false);
    expect(binding).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".ub-unsupported-block")).toBeNull();
    expect(view.container.querySelector(".ub-divider")).not.toBeNull();
  });

  it("tears down before pending controls observe a stray root and binds after its removal", async () => {
    const connection = fixture();
    onTestCleanup(() => connection.ydoc.destroy());
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const stray = new Y.XmlText("Unrepresentable top-level text");
    function Arrival({ arrive }: { arrive: boolean }): ReactElement {
      useLayoutEffect(() => {
        if (arrive) getBlocksFragment(connection.ydoc).insert(1, [stray]);
      }, [arrive]);
      return pane(connection, onSelectThread, arrive ? "Writer renamed" : "Writer");
    }
    const view = await renderSettled(<Arrival arrive={false} />);
    const editor = editorFrom(binding, 0);
    await act(async () => view.rerender(<Arrival arrive />));
    expect(editor.isDestroyed).toBe(true);
    expect(view.container.querySelector(".ub-foreign")?.textContent).toContain("Unrepresentable top-level text");
    expect(view.container.querySelector(".ub-editor .ProseMirror")).toBeNull();
    expect(getBlocksFragment(connection.ydoc).get(1)).toBe(stray);
    await act(async () => getBlocksFragment(connection.ydoc).delete(1, 1));
    expect(view.container.querySelector(".ub-foreign")).toBeNull();
    expect(view.container.querySelector(".ub-editor .ProseMirror")?.getAttribute("contenteditable")).toBe("true");
  });

  it.each([
    { name: "archived document", archived: true, writable: true },
    { name: "unwritable room", archived: false, writable: false },
  ])("renders supported blocks beside placeholders in an $name", async ({ archived, writable }) => {
    const connection = fixture({ ...LIVE, writable });
    onTestCleanup(() => connection.ydoc.destroy());
    const foreign = new Y.XmlElement("future-block");
    foreign.insert(0, [new Y.XmlText("Unrepresented content")]);
    getBlocksFragment(connection.ydoc).insert(1, [foreign]);
    const before = Y.encodeStateAsUpdate(connection.ydoc);
    const view = await renderSettled(pane(connection, onSelectThread, "Reader", archived));
    expect(view.container.querySelector(".ub-editor .ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect(view.container.querySelector(".ub-editor")?.textContent).toContain(PROSE);
    expect(view.container.querySelector(".ub-unsupported-block")?.textContent).toBe("This block needs a newer version.");
    expect(view.container.querySelector(".ub-foreign")).toBeNull();
    expect(view.container.querySelector('[aria-label="Callout variant"]')).toBeNull();
    expect(Y.encodeStateAsUpdate(connection.ydoc)).toEqual(before);
  });

  it.each(["text", "hook"] as const)("keeps nested hooks opaque while a stray top-level %s takes page precedence", async (kind) => {
    const connection = fixture();
    onTestCleanup(() => connection.ydoc.destroy());
    const fragment = getBlocksFragment(connection.ydoc);
    const block = fragment.get(0) as Y.XmlElement;
    const nested = new Y.XmlHook("future-inline");
    nested.set("payload", { shape: "unrepresented" });
    block.insert(1, [nested as unknown as Y.XmlElement]);
    const before = block.toJSON();
    const view = await renderSettled(pane(connection));
    expect(view.container.querySelectorAll(".ub-unsupported-block")).toHaveLength(1);
    expect(view.container.querySelector(".ub-foreign")).toBeNull();
    const root = kind === "text" ? new Y.XmlText("Stray root text") : new Y.XmlHook("future-root");
    await act(async () => fragment.insert(0, [root as unknown as Y.XmlElement]));
    expect(view.container.querySelector(".ub-foreign")).not.toBeNull();
    expect(view.container.querySelector(".ub-editor .ProseMirror")).toBeNull();
    expect(fragment.get(0)).toBe(root);
    await act(async () => fragment.delete(0, 1));
    expect(view.container.querySelector(".ub-foreign")).toBeNull();
    expect(view.container.querySelectorAll(".ub-unsupported-block")).toHaveLength(1);
    expect(block.get(1)).toBe(nested);
    expect(block.toJSON()).toEqual(before);
    expect(view.container.querySelector(".ub-editor .ProseMirror")?.getAttribute("contenteditable")).toBe("true");
  });

  it.each([
    { name: "code language", Control: CodeLanguageControl, selector: '[aria-label="Code language"]' },
    { name: "callout", Control: CalloutControl, selector: '[aria-label="Callout variant"]' },
    { name: "card buttons", Control: CardButtonControls, selector: ".ub-card-button-edit" },
  ])("renders mounted $name controls safely after their editor is destroyed", async ({ Control, selector }) => {
    const connection = fixture();
    const element = document.createElement("div");
    document.body.append(element);
    const binding = guardedBinding.bindGuardedEditor({
      element,
      fragment: getBlocksFragment(connection.ydoc),
      awareness: null,
      editable: true,
      canWrite: () => true,
    });
    onTestCleanup(() => {
      binding.destroy();
      element.remove();
      connection.ydoc.destroy();
    });
    const editor = binding.editor;
    if (editor === null) throw new Error("fixture editor did not bind");
    editor.commands.setTextSelection(PROSE.length + 3);
    const canWrite = (): boolean => true;
    const view = await renderSettled(<Control editor={editor} canWrite={canWrite} />);
    expect(element.querySelector(selector)).not.toBeNull();

    act(() => binding.destroy());
    expect(editor.isDestroyed).toBe(true);
    const viewReads = vi.spyOn(editor, "view", "get");
    await act(async () => view.rerender(<Control editor={editor} canWrite={canWrite} />));

    expect(viewReads).not.toHaveBeenCalled();
    expect(element.querySelector(selector)).toBeNull();
  });
});
