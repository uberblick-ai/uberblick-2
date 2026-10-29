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

function fixture(): RoomConnection {
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
    status: LIVE,
    onStatusChange: (listener: (status: RoomStatus) => void) => {
      listener(LIVE);
      return () => {};
    },
  } as unknown as RoomConnection;
}

const onSelectThread = (): void => {};

function pane(connection: RoomConnection, selectThread = onSelectThread, author = "Writer"): ReactElement {
  return <EditorPane connection={connection} segment={WORKSPACE} presence={[]} author={author}
    archived={false} docLinks={null} onSelectThread={selectThread} />;
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

  it("shows intact unsupported content when the guard tears down before pending control effects", async () => {
    const connection = fixture();
    onTestCleanup(() => connection.ydoc.destroy());
    const dividerId = appendBlock(connection.ydoc, { type: "divider" });
    const divider = findBlockElement(connection.ydoc, dividerId);
    if (divider === null) throw new Error("fixture divider is missing");
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const original = getBlocks(connection.ydoc);

    function Arrival({ arrive }: { arrive: boolean }): ReactElement {
      useLayoutEffect(() => {
        // BoundEditor's changed author schedules control effects. Arrival in
        // this layout effect destroys it before those passive effects run.
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

    expect(editor.isDestroyed).toBe(true);
    const fallback = view.container.querySelector(".ub-foreign");
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain("unsupported type (#divider-shape)");
    expect(fallback?.textContent).toContain(PROSE);
    expect(fallback?.textContent).toContain("Written by an older client");
    expect(view.container.querySelector(".ub-editor .ProseMirror")).toBeNull();
    expect(view.container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(getBlocks(connection.ydoc).slice(0, -1)).toEqual(original.slice(0, -1));
    expect(findBlockElement(connection.ydoc, dividerId)).toBe(divider);
    expect(divider.getAttributes()).toEqual({ id: dividerId });
    expect(divider.length).toBe(1);
    expect(divider.firstChild?.toString()).toBe("Written by an older client");
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
