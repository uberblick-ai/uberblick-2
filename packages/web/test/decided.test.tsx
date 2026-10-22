/**
 * Decision records protect their text while keeping discussion and metadata open.
 * Shared Y.Docs exercise the document metadata authority and live pane wiring;
 * native pointer/touch selection belongs to the browser suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderSettled } from "./react-render.js";
import { screen } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  createTagCatalogEntry,
  directoryRoom,
  getAnnotation,
  getBlocks,
  getBlocksFragment,
  getMeta,
  initDoc,
  listAnnotations,
  roomForDoc,
  setKind,
  setStatus,
  settingsRoom,
  setTldr,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DecisionStatus } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import * as guardedBinding from "../src/editor/guarded-binding.js";
import { findLinkConflicts } from "../src/editor/palette.js";
import { plainText } from "../src/editor/ytext.js";
import { EditorPane } from "../src/ui/document/EditorPane.js";
import { threadCardId } from "../src/ui/comments/threads.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "d4ee98ac-9a9c-4a81-a68d-d8ecc09ca509";
const TAG = "234768ab-f733-466c-b637-311c8e33c1a9";
const TARGET = "4c4d863f-1eec-4f3b-8abf-bf9df3c9c2fa";
const PROSE = "The quick brown fox jumps.";
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

const rooms = new Map<string, RoomConnection>();
function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: LIVE,
    onStatusChange: (listener: (status: RoomStatus) => void) => {
      listener(LIVE);
      return () => {};
    },
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

vi.mock("../src/collab/rooms.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/collab/rooms.js")>(),
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
}));
const { App } = await import("../src/ui/App.js");

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
  vi.stubGlobal("matchMedia", () => ({
    matches: false, addEventListener: () => {}, removeEventListener: () => {},
  }));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
});

afterEach(() => {
  rooms.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stage(status: DecisionStatus = "decided"): Y.Doc {
  const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
  initDoc(ydoc, { uuid: UUID, title: "Chosen protocol" });
  setKind(ydoc, "decision");
  setStatus(ydoc, status);
  setTldr(ydoc, "Keep one shared protocol.");
  appendBlock(ydoc, { type: "paragraph", text: PROSE });
  // Deliberately stale: editability comes from the record, not this cache.
  upsertDirectoryEntry(room(directoryRoom(WORKSPACE)).ydoc, {
    uuid: UUID, title: "Chosen protocol", kind: "decision", status: "open", topic: UUID,
  });
  createTagCatalogEntry(room(settingsRoom(WORKSPACE)).ydoc, "sync", TAG);
  return ydoc;
}

async function openApp(): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/${WORKSPACE}/${UUID}`);
  return (await renderSettled(<App />)).container;
}

function editorElement(host: HTMLElement): HTMLElement {
  const element = host.querySelector<HTMLElement>(".ub-editor .ProseMirror");
  if (element === null) throw new Error("fixture editor did not bind");
  return element;
}

function button(host: ParentNode, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

function openActions(host: HTMLElement): void {
  host.querySelector('button[aria-label="Document actions"]')?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
}

function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]")].find(
    (item) => item.textContent === label,
  );
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLInputElement
    ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function textAt(ydoc: Y.Doc): Y.XmlText {
  return (getBlocksFragment(ydoc).get(0) as Y.XmlElement).firstChild as Y.XmlText;
}

function card(host: HTMLElement, id: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`#${CSS.escape(threadCardId(id))}`);
  if (element === null) throw new Error("no thread card");
  return element;
}

describe("read-only decision records", () => {
  it("never binds an editable frame when a decision route precedes room kind metadata", async () => {
    const connection = room(roomForDoc(WORKSPACE, UUID));
    initDoc(connection.ydoc, { uuid: UUID, title: "Known topic" });
    appendBlock(connection.ydoc, { type: "paragraph", text: PROSE });
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const { container: host } = await renderSettled(<EditorPane
      connection={connection}
      segment={WORKSPACE}
      presence={[]}
      author="Reader"
      archived={false}
      decisionView
      docLinks={null}
      actions={{ onRestore: null }}
      onSelectThread={() => {}}
    />);
    expect(binding.mock.calls[0]?.[0].editable).toBe(false);
    const prose = editorElement(host);
    expect(prose.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector<HTMLTextAreaElement>(".ub-title")?.readOnly).toBe(true);
    expect(host.querySelector('[aria-label="Insert block below"]')).toBeNull();
    act(() => typeInto(host.querySelector<HTMLTextAreaElement>(".ub-title")!, "Changed"));
    expect(getMeta(connection.ydoc).title).toBe("Known topic");
    await act(async () => setKind(connection.ydoc, "decision"));
    expect(binding).toHaveBeenCalledOnce();
    expect(editorElement(host)).toBe(prose);
    expect(prose.getAttribute("contenteditable")).toBe("false");
  });

  it("shows a code caption without a language control when first opened decided", async () => {
    const ydoc = stage();
    appendBlock(ydoc, { type: "code", text: "const answer = 42;", language: "ts" });
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const host = await openApp();
    const editor: Editor | null = binding.mock.results[0]?.value.editor ?? null;
    if (editor == null) throw new Error("fixture document did not bind");
    act(() => editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 3));
    expect(host.querySelector(".ub-code-caption-text")?.textContent).toBe("TypeScript");
    expect(screen.queryByRole("button", { name: "Code language" })).toBeNull();
    expect(editorElement(host).getAttribute("contenteditable")).toBe("false");
  });

  it("keeps open-record code read-only across every decision status", async () => {
    const ydoc = stage("open");
    const id = appendBlock(ydoc, { type: "code", text: "const answer = 42;", language: "ts" });
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    peer.on("update", (update: Uint8Array) => Y.applyUpdate(ydoc, update));
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const host = await openApp();
    const editor: Editor | null = binding.mock.results[0]?.value.editor ?? null;
    if (editor == null) throw new Error("fixture document did not bind");
    let pos = 0;
    editor.state.doc.forEach((node, offset) => { if (node.attrs.id === id) pos = offset; });
    act(() => editor.commands.setTextSelection(pos + 3));
    const prose = editorElement(host);
    for (const status of ["open", "decided", "rejected", "withdrawn"] as const) {
      await act(async () => setStatus(peer, status));
      expect(screen.queryByRole("button", { name: "Code language" })).toBeNull();
      expect(screen.queryByRole("combobox", { name: "Search languages" })).toBeNull();
      expect(host.querySelector(".ub-code-caption-text")?.textContent).toBe("TypeScript");
      expect(getBlocks(ydoc).find((node) => node.id === id)?.language).toBe("ts");
      expect(editorElement(host)).toBe(prose);
      expect(prose.getAttribute("contenteditable")).toBe("false");
      expect(host.querySelector(".ub-toolbar")).toBeNull();
      expect(binding).toHaveBeenCalledOnce();
    }
    peer.destroy();
  });

  it("keeps card links active without author controls across every decision status", async () => {
    const ydoc = stage("open");
    appendBlock(ydoc, { type: "card", text: "title: Answer\nbutton: [Read details](https://example.invalid/answer)\n\nStored answer." });
    appendBlock(ydoc, { type: "card", text: "title: Earlier answer\n\nStored history." });
    const original = getBlocks(ydoc);
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const host = await openApp();
    const prose = editorElement(host);

    for (const status of ["open", "decided", "rejected", "withdrawn"] as const) {
      await act(async () => setStatus(ydoc, status));
      expect(editorElement(host)).toBe(prose);
      expect(prose.getAttribute("contenteditable")).toBe("false");
      expect(screen.queryByRole("button", { name: "Add button" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit button" })).toBeNull();
      const before = Y.encodeStateVector(ydoc);
      await act(async () => screen.getByRole<HTMLButtonElement>("button", { name: "Read details" }).click());
      expect(opened).toHaveBeenLastCalledWith("https://example.invalid/answer", "_blank", "noopener,noreferrer");
      expect(Y.encodeStateVector(ydoc)).toEqual(before);
      expect(getBlocks(ydoc)).toEqual(original);
    }
    expect(opened).toHaveBeenCalledTimes(4);
  });

  for (const status of ["open", "decided", "rejected", "withdrawn"] as const) it(`binds ${status} content read-only immediately and keeps tags, pin and archive available`, async () => {
    const ydoc = stage(status);
    const originalBind = guardedBinding.bindGuardedEditor;
    const initialTitles: boolean[] = [];
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor").mockImplementation((options) => {
      const title = document.querySelector<HTMLElement>(".ub-title");
      initialTitles.push(title instanceof HTMLTextAreaElement && title.readOnly);
      return originalBind(options);
    });
    const host = await openApp();

    expect(binding).toHaveBeenCalledOnce();
    expect(binding.mock.calls[0]?.[0].editable).toBe(false);
    expect(initialTitles).toEqual([false]);
    expect(editorElement(host).getAttribute("contenteditable")).toBe("false");
    expect(editorElement(host).getAttribute("aria-readonly")).toBe("true");
    expect(host.querySelector('[aria-label="Insert block below"]')).toBeNull();
    const title = host.querySelector<HTMLTextAreaElement>(".ub-title")!;
    expect(title.readOnly).toBe(false);
    act(() => typeInto(title, "A wording fix"));
    expect(getMeta(ydoc).title).toBe("A wording fix");
    expect(host.querySelector(".ub-tldr")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit TL;DR" })).toBeNull();
    expect(host.querySelector(".ub-tldr-form")).toBeNull();

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Edit tags"]')?.click());
    const tag = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(tag?.textContent).toContain("sync");
    act(() => tag?.click());
    expect(getMeta(ydoc).tags).toEqual([TAG]);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    act(() => openActions(host));
    expect(menuItem("Pin to sidebar")?.getAttribute("data-disabled")).toBeNull();
    expect(menuItem("Archive topic")?.getAttribute("aria-disabled")).toBe("false");
    expect(menuItem("Edit TL;DR")).toBeUndefined();
  });

  it("follows live status without rebinding or losing scroll while legacy TL;DR stays hidden", async () => {
    const ydoc = stage("open");
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    peer.on("update", (update: Uint8Array) => Y.applyUpdate(ydoc, update));
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const host = await openApp();
    const prose = editorElement(host);
    const pane = host.querySelector<HTMLElement>(".ub-document-pane")!;
    pane.scrollTop = 173;
    expect(screen.queryByRole("button", { name: "Edit TL;DR" })).toBeNull();
    expect(host.querySelector(".ub-tldr-form")).toBeNull();
    const editor = binding.mock.results[0]?.value.editor;
    if (editor == null) throw new Error("fixture editor did not bind");
    act(() => editor.commands.setTextSelection({ from: 5, to: 16 }));
    expect(prose.getAttribute("contenteditable")).toBe("false");
    expect(document.querySelector('[data-slot="selection-composer"] button[aria-label="External link"]')).toBeNull();
    const beforeText = textAt(ydoc).toDelta();

    const updates = vi.fn();
    ydoc.on("update", updates);
    let updatesAtDecision = 0;
    act(() => {
      setStatus(peer, "decided");
      updatesAtDecision = updates.mock.calls.length;
    });
    expect(updates).toHaveBeenCalledTimes(updatesAtDecision);
    expect(binding).toHaveBeenCalledOnce();
    expect(editorElement(host)).toBe(prose);
    expect(pane.scrollTop).toBe(173);
    expect(prose.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector(".ub-tldr-form")).toBeNull();
    const composer = document.querySelector<HTMLElement>('[data-slot="selection-composer"]')!;
    expect(composer).not.toBeNull();
    expect(composer.querySelector('[aria-label="External link URL"]')).toBeNull();
    expect(composer.querySelector('form[aria-label="External link"]')).toBeNull();
    for (const label of ["Bold", "Italic", "Strikethrough", "Inline code", "External link"]) {
      expect(composer.querySelector(`button[aria-label="${label}"]`)).toBeNull();
    }
    expect(button(composer, "Comment")).toBeDefined();
    expect(textAt(ydoc).toDelta()).toEqual(beforeText);
    expect(getMeta(ydoc).tldr).toBeNull();
    expect(ydoc.getMap("meta").get("tldr")).toBe("Keep one shared protocol.");
    expect(updates).toHaveBeenCalledTimes(updatesAtDecision);

    for (const status of ["open", "rejected", "withdrawn"] as const) {
      act(() => setStatus(peer, status));
      expect(binding).toHaveBeenCalledOnce();
      expect(editorElement(host)).toBe(prose);
      expect(pane.scrollTop).toBe(173);
      expect(prose.getAttribute("contenteditable")).toBe("false");
      expect(host.querySelector(".ub-tldr-form")).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit TL;DR" })).toBeNull();
      expect(host.querySelector('[aria-label="Insert block below"]')).toBeNull();
    }
    peer.destroy();
  });

  for (const status of ["open", "rejected", "withdrawn"] as const) it(`keeps comments available on ${status} content`, async () => {
    const ydoc = stage(status);
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const host = await openApp();
    const editor = binding.mock.results[0]?.value.editor;
    if (editor == null) throw new Error("fixture editor did not bind");
    act(() => editor.commands.setTextSelection({ from: 5, to: 16 }));
    const composer = document.querySelector<HTMLElement>('[data-slot="selection-composer"]')!;
    expect(composer).not.toBeNull();
    for (const label of ["Bold", "Italic", "Strikethrough", "Inline code", "External link"]) {
      expect(composer.querySelector(`button[aria-label="${label}"]`)).toBeNull();
    }
    expect(composer.querySelector('[role="toolbar"]')).toBeNull();
    await act(async () => button(composer, "Comment").click());
    expect(composer.querySelector('[data-slot="selection-excerpt"]')?.textContent).toBe("quick brown");
    const field = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => typeInto(field, "Why this protocol?"));
    await act(async () => button(composer, "Comment").click());
    const [thread] = listAnnotations(ydoc);
    expect(thread?.comments.map((comment) => comment.text)).toEqual(["Why this protocol?"]);
    if (thread === undefined) throw new Error("thread was not created");
    expect(plainText(textAt(ydoc))).toBe(PROSE);
    expect(editorElement(host).getAttribute("contenteditable")).toBe("false");

    const highlight = host.querySelector<HTMLElement>(`[data-comment-thread="${thread.id}"]`)!;
    expect(highlight.tabIndex).toBe(0);
    expect(highlight.getAttribute("role")).toBe("button");
    highlight.focus();
    await act(async () => highlight.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const item = card(host, thread.id);
    expect(document.activeElement).toBe(item.querySelector(".ub-thread"));
    await act(async () => button(item, "Reply").click());
    act(() => typeInto(item.querySelector<HTMLTextAreaElement>("textarea")!, "The compatibility constraint."));
    act(() => button(item, "Reply").click());
    expect(getAnnotation(ydoc, thread.id)?.comments.map((comment) => comment.text)).toEqual([
      "Why this protocol?", "The compatibility constraint.",
    ]);
    await act(async () => button(item, "Resolve").click());
    expect(getAnnotation(ydoc, thread.id)?.resolved).toBe(true);
    await act(async () => card(host, thread.id).querySelector<HTMLButtonElement>(".ub-thread")?.click());
    await act(async () => button(card(host, thread.id), "Reopen").click());
    expect(getAnnotation(ydoc, thread.id)?.resolved).toBe(false);
    expect(plainText(textAt(ydoc))).toBe(PROSE);
  });

  it("offers no link-conflict repair while existing threads stay open in the rail", async () => {
    const ydoc = stage();
    const thread = createAnnotation(ydoc, getBlocks(ydoc)[0]!.id, 20, 25, "Reader", "Why jumps?");
    textAt(ydoc).format(4, 11, {
      link: { href: "https://example.com/protocol" }, docLink: { docId: TARGET },
    });
    const before = Y.encodeStateAsUpdate(ydoc);
    const host = await openApp();
    expect(host.querySelector(".ub-editor .ProseMirror")).toBeNull();
    expect(host.querySelector(".ub-link-repair")).toBeNull();
    const fallback = host.querySelector(".ub-foreign-banner")?.textContent ?? "";
    expect(fallback).toMatch(/decision content is read-only in the web/i);
    expect(fallback).not.toMatch(/restore|choose below/i);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    const item = card(host, thread.id);
    expect(button(item, "Reply")).toBeDefined();
    await act(async () => button(item, "Resolve").click());
    expect(getAnnotation(ydoc, thread.id)?.resolved).toBe(true);
    await act(async () => card(host, thread.id).querySelector<HTMLButtonElement>(".ub-thread")?.click());
    expect(button(card(host, thread.id), "Reopen")).toBeDefined();
    expect(findLinkConflicts(getBlocksFragment(ydoc))).toHaveLength(1);
  });

  it("archive closes comments and restore preserves the decided content rule", async () => {
    const ydoc = stage();
    const thread = createAnnotation(ydoc, getBlocks(ydoc)[0]!.id, 4, 15, "Reader", "Why quick?");
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const host = await openApp();
    const prose = editorElement(host);
    act(() => openActions(host));
    act(() => menuItem("Archive topic")?.click());
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    act(() => button(dialog, "Archive").click());
    const item = card(host, thread.id);
    expect(item.querySelector(".ub-thread-actions")).toBeNull();
    const archivedTitle = host.querySelector<HTMLTextAreaElement>(".ub-title")!;
    expect(archivedTitle.readOnly).toBe(true);
    act(() => typeInto(archivedTitle, "Archived rename"));
    expect(getMeta(ydoc).title).toBe("Chosen protocol");
    const editor = binding.mock.results[0]?.value.editor;
    act(() => editor.commands.setTextSelection({ from: 17, to: 20 }));
    expect(document.querySelector('[data-slot="selection-composer"]')).toBeNull();
    expect(host.querySelector('[aria-label="Edit tags"]')).toBeNull();

    act(() => button(host, "Restore").click());
    expect(binding).toHaveBeenCalledOnce();
    expect(editorElement(host)).toBe(prose);
    expect(prose.getAttribute("contenteditable")).toBe("false");
    const title = host.querySelector<HTMLTextAreaElement>(".ub-title");
    expect(title?.readOnly).toBe(false);
    expect(button(item, "Reply")).toBeDefined();
    expect(host.querySelector('[aria-label="Edit tags"]')).not.toBeNull();
    expect(getMeta(ydoc).status).toBe("decided");
  });
});
