/**
 * Tag editing in the doc header (#122).
 *
 * One claim, told twice: **the chips are a human front door to the write an
 * agent already makes.** `set_tags` replaces `meta.tags` wholesale; so does the
 * identity line. Everything that follows a retag today — the directory stub,
 * its group badge, `list_docs` on a second client — follows a chip for the same
 * reason and over the same path, with nothing in the UI told about any of it.
 *
 * Both tests mount the real app over shared Y.Docs (the `archived.test.tsx`
 * harness), because the interesting half of this feature is what the write
 * travels through: a chip that only proved a component re-renders its own state
 * would prove nothing about `meta.tags`, the stub, or the second client.
 *
 * `acquireRoom` is mocked: rooms here are plain shared Y.Docs, since the
 * transport is not what is under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import * as Y from "yjs";
import {
  appendBlock,
  directoryRoom,
  getDirectoryEntry,
  getMeta,
  initDoc,
  roomForDoc,
  setTags,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
/** Two other documents, so the workspace has tags to suggest. */
const REF = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";
const PROTOCOL = "7c2e5a11-3f80-4d66-b1a9-8e4d2c6f0a55";

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  unsyncedChanges: 0,
  localReplicaLoaded: false,
  hasLocalCache: false,
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
    status: OFFLINE,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(OFFLINE);
      return () => {};
    },
    whenLocalReplicaLoaded: Promise.resolve(),
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
}));

const { App } = await import("../src/ui/App.js");

/** A second client holding the same document: updates flow both ways. */
function peerOf(local: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  peer.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  return peer;
}

let mounted: { root: Root; host: HTMLElement } | null = null;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }),
  );
});

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
  rooms.clear();
  vi.restoreAllMocks();
});

/** Render, and let the hub endpoint settle before anything is asserted. */
async function mount(node: ReactNode): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(node);
  });
  return host;
}

async function openApp(path: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  return await mount(<App />);
}

/**
 * Change an input the way a keystroke does, so React's `onChange` runs.
 *
 * Assigning `.value` is not enough: React installs its own setter on the
 * prototype to track the last value it saw, so a plain assignment updates that
 * record too and the event that follows is dismissed as "nothing changed".
 */
function typeInto(input: HTMLInputElement | null, value: string): void {
  if (input === null) return;
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  native?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(
  element: Element | null,
  key: string,
  init: KeyboardEventInit = {},
): void {
  element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

function field(host: HTMLElement): HTMLInputElement | null {
  return host.querySelector<HTMLInputElement>(".ub-tag-add");
}

/** The tag words on screen, in the order the chips are drawn. */
function chips(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".ub-tag-name")].map(
    (node) => node.textContent ?? "",
  );
}

/** What the add field offers, straight out of the directory. */
function suggestions(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLOptionElement>("datalist option")].map(
    (option) => option.value,
  );
}

/** The identity line's group badge — where the document lives right now. */
function badge(host: HTMLElement): string {
  return host.querySelector(".ub-badge")?.textContent ?? "";
}

/** Type a word into the add field and commit it with Enter. */
function addTag(host: HTMLElement, word: string): void {
  act(() => typeInto(field(host), word));
  act(() => press(field(host), "Enter"));
}

describe("tags are editable in the document identity line", () => {
  it("writes meta.tags wholesale, and the stub and the sidebar follow", async () => {
    const directory = room(directoryRoom(WORKSPACE)).ydoc;
    const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
    initDoc(ydoc, { uuid: UUID, title: "Sync and offline" });
    appendBlock(ydoc, { type: "paragraph", text: "how sync behaves" });
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Sync and offline" });
    // Two documents nobody opens: the suggestions come from their *stubs*, which
    // is the whole point of asking the directory rather than the corpus.
    upsertDirectoryEntry(directory, {
      uuid: REF,
      title: "Schema API",
      tags: ["reference"],
    });
    upsertDirectoryEntry(directory, {
      uuid: PROTOCOL,
      title: "Sync protocol",
      tags: ["verify", "Reference"],
    });

    const peer = peerOf(directory);
    const host = await openApp(`/${WORKSPACE}/${UUID}`);

    // ---- suggestions are the workspace's tags, deduped and no doc opened ----
    // "Reference" and "reference" are one tag, offered in the spelling the
    // workspace used first.
    expect(suggestions(host)).toEqual(["reference", "verify"]);
    expect(chips(host)).toEqual([]);
    // No canonical tag, so the document is not filed under an invented group.
    expect(badge(host)).toBe("");

    // ---- adding a tag is the write set_tags makes ----
    act(() => typeInto(field(host), "Feature"));
    // An Enter that ends an IME composition belongs to the input method, not to
    // this field: nothing is committed, and the word is still being typed.
    act(() => press(field(host), "Enter", { isComposing: true }));
    expect(getMeta(ydoc).tags).toEqual([]);
    // The same word, committed for real — and stored in the spelling the
    // workspace already knows, because a "Feature" that never joined the
    // Features group would be a tag this editor and the sidebar disagree about.
    act(() => press(field(host), "Enter"));
    expect(chips(host)).toEqual(["feature"]);
    expect(getMeta(ydoc).tags).toEqual(["feature"]);
    // The stub is repaired from meta, so the second client sees it without
    // anyone telling it: this is what `list_docs` reads.
    expect(getDirectoryEntry(peer, UUID)?.tags).toEqual(["feature"]);
    // And the document has moved groups live.
    expect(badge(host)).toBe("Features");
    // A tag already on the document is not offered again.
    expect(suggestions(host)).toEqual(["reference", "verify"]);

    // ---- duplicates and blanks are rejected, quietly ----
    addTag(host, "Feature");
    expect(getMeta(ydoc).tags).toEqual(["feature"]);
    expect(field(host)?.value).toBe("");
    addTag(host, "   ");
    expect(getMeta(ydoc).tags).toEqual(["feature"]);
    expect(field(host)?.value).toBe("");
    // Nothing was said about either: rejection is silence, not an error.
    expect(chips(host)).toEqual(["feature"]);

    // ---- and the keyboard-only way back out ----
    const remove = host.querySelector<HTMLButtonElement>(".ub-tag-x");
    expect(remove?.getAttribute("aria-label")).toBe("Remove tag feature");
    act(() => remove?.focus());
    expect(document.activeElement).toBe(remove);
    act(() => press(remove, "Backspace"));
    // Focus went somewhere a keyboard reader can stand — the add field, since
    // that chip was the only one. Left on the unmounted button it would have
    // fallen to `<body>`, returning them to the top of the page mid-gesture.
    expect(document.activeElement).toBe(field(host));
    expect(chips(host)).toEqual([]);
    expect(getMeta(ydoc).tags).toEqual([]);
    expect(getDirectoryEntry(peer, UUID)?.tags).toEqual([]);
    // Removing the last canonical tag takes the group label away with it.
    expect(badge(host)).toBe("");
  });

  /**
   * The documented semantics are wholesale replace, last write wins. A header
   * open while an agent retags the same document is exactly where that could
   * turn into a crash or a resurrection of tags the agent removed — the chips
   * are rendered from a snapshot, and a stale snapshot written back would undo
   * the agent's write with the reader's own next click.
   */
  it("takes an agent's set_tags wholesale, and adds on top of the result", async () => {
    const directory = room(directoryRoom(WORKSPACE)).ydoc;
    const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
    initDoc(ydoc, { uuid: UUID, title: "Sync and offline", tags: ["feature"] });
    appendBlock(ydoc, { type: "paragraph", text: "how sync behaves" });
    upsertDirectoryEntry(directory, {
      uuid: UUID,
      title: "Sync and offline",
      tags: ["feature"],
    });

    const agent = peerOf(ydoc);
    const host = await openApp(`/${WORKSPACE}/${UUID}`);
    expect(chips(host)).toEqual(["feature"]);

    // The agent replaces the whole array, from its own replica.
    act(() => setTags(agent, ["reference", "verify"]));
    expect(chips(host)).toEqual(["reference", "verify"]);
    expect(getMeta(ydoc).tags).toEqual(["reference", "verify"]);
    expect(badge(host)).toBe("Verify");
    expect(getDirectoryEntry(directory, UUID)?.tags).toEqual([
      "reference",
      "verify",
    ]);

    // And the next chip is folded onto what the agent left, not onto what the
    // header was rendered from.
    addTag(host, "needs-love");
    expect(getMeta(ydoc).tags).toEqual(["reference", "verify", "needs-love"]);
    expect(getMeta(agent).tags).toEqual(["reference", "verify", "needs-love"]);
  });
});
