/**
 * The sidebar renders the `_sidebar` document (#115).
 *
 * One claim, and everything here is a way of asking it: **the sidebar on screen
 * is the sidebar document, and every gesture is a write to it.** So each test
 * asserts twice — once on what is drawn, and once on `readSidebar` over a *peer*
 * replica, which is what a second browser and an agent's `get_sidebar` read.
 * A rendering that agreed with the DOM but not with the document would be a
 * second copy of the ordering, which is the one thing curation cannot afford.
 *
 * The app is mounted whole over shared Y.Docs (the `doc-tags.test.tsx`
 * harness): `acquireRoom` is mocked so a room is a plain Y.Doc, because the
 * transport is not what is under test — the write path is.
 *
 * Drag and drop is dispatched as the native events the browser sends, in the
 * order it sends them. jsdom has no drag machinery, but there is none to test:
 * the feature is what the handlers do with the drop, and where the drop lands.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import * as Y from "yjs";
import {
  createGroup,
  directoryRoom,
  initDoc,
  appendBlock,
  pinDoc,
  readSidebar,
  restoreDirectoryEntry,
  roomForDoc,
  sidebarRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { SidebarGroup } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const ONE = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const TWO = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";
const THREE = "7c2e5a11-3f80-4d66-b1a9-8e4d2c6f0a55";

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  unsyncedChanges: 0,
  localReplicaLoaded: false,
  hasLocalCache: false,
  protocolMismatch: null,
  authFailed: false,
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

/**
 * A fresh in-memory Storage. Node's own experimental `localStorage` global
 * shadows jsdom's here and is unusable without `--localstorage-file`, so the
 * test provides the one thing `useStoredFlag` needs.
 */
function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
}

let mounted: { root: Root; host: HTMLElement } | null = null;

beforeEach(() => {
  installStorage();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
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

/** Render at `path`, and let the hub endpoint settle before anything is asserted. */
async function openApp(path: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  return await mount(<App />);
}

/** Three documents in the directory, so the sidebar has titles to show. */
function seedDirectory(): Y.Doc {
  const directory = room(directoryRoom(WORKSPACE)).ydoc;
  upsertDirectoryEntry(directory, { uuid: ONE, title: "Overview" });
  upsertDirectoryEntry(directory, { uuid: TWO, title: "Editing" });
  upsertDirectoryEntry(directory, { uuid: THREE, title: "Sync" });
  return directory;
}

function sidebarDoc(): Y.Doc {
  return room(sidebarRoom(WORKSPACE)).ydoc;
}

/** The sidebar as a second browser would read it: names, and what they pin. */
function stored(doc: Y.Doc): Array<[string, string[]]> {
  return readSidebar(doc).map((group: SidebarGroup) => [group.name, group.docs]);
}

function sections(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".ub-list .ub-group")];
}

/** The group names on screen, top to bottom. */
function groupNames(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".ub-group-label")].map(
    (node) => node.textContent ?? "",
  );
}

/** The document rows of the `index`-th group, top to bottom. */
function rows(host: HTMLElement, index: number): HTMLButtonElement[] {
  const section = sections(host)[index];
  return [...(section?.querySelectorAll<HTMLButtonElement>(".ub-group-body li button") ?? [])];
}

function rowTitles(host: HTMLElement, index: number): string[] {
  return rows(host, index).map((row) => row.textContent ?? "");
}

/** The `index`-th group's insertion points, top to bottom. */
function docSlots(host: HTMLElement, index: number): HTMLElement[] {
  const section = sections(host)[index];
  return [...(section?.querySelectorAll<HTMLElement>(".ub-drop-slot") ?? [])];
}

/** The insertion points between groups — the ones a dragged group can land in. */
function groupSlots(host: HTMLElement): HTMLElement[] {
  const list = host.querySelector(".ub-list");
  return [...(list?.children ?? [])].filter((child): child is HTMLElement =>
    child.classList.contains("ub-drop-slot"),
  );
}

function groupToggle(host: HTMLElement, index: number): HTMLButtonElement | null {
  return sections(host)[index]?.querySelector<HTMLButtonElement>(".ub-group-toggle") ?? null;
}

function pinControl(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(".ub-pin-toggle");
}

/** One native drag event, with the payload channel a browser would supply. */
function dragEvent(type: string): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { setData: () => {}, getData: () => "" },
  });
  return event;
}

/** Drag `from` and drop it on `to`, in the order the browser sequences it. */
function drag(from: Element | null, to: Element | null): void {
  if (from === null || to === null) throw new Error("test: nothing to drag");
  act(() => void from.dispatchEvent(dragEvent("dragstart")));
  act(() => void to.dispatchEvent(dragEvent("dragover")));
  act(() => void to.dispatchEvent(dragEvent("drop")));
  act(() => void from.dispatchEvent(dragEvent("dragend")));
}

function press(element: Element | null, key: string): void {
  element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("the sidebar is the _sidebar document", () => {
  it("renders groups and pins in stored order, and a drag lands where it was dropped", async () => {
    seedDirectory();
    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    const later = createGroup(sidebar, "Later");
    pinDoc(sidebar, reading, ONE);
    pinDoc(sidebar, reading, TWO);
    pinDoc(sidebar, later, THREE);
    // What the second browser reads, throughout.
    const peer = peerOf(sidebar);

    const host = await openApp(`/${WORKSPACE}`);
    // Stored order, not alphabetical and not the directory's: nothing sorts.
    expect(groupNames(host)).toEqual(["Reading", "Later"]);
    expect(rowTitles(host, 0)).toEqual(["Overview", "Editing"]);
    expect(rowTitles(host, 1)).toEqual(["Sync"]);

    // ---- within a group: "Editing" to the top ----
    drag(rows(host, 0)[1] ?? null, docSlots(host, 0)[0] ?? null);
    expect(rowTitles(host, 0)).toEqual(["Editing", "Overview"]);
    expect(stored(peer)).toEqual([
      ["Reading", [TWO, ONE]],
      ["Later", [THREE]],
    ]);

    // ---- across groups: "Overview" to the head of Later ----
    drag(rows(host, 0)[1] ?? null, docSlots(host, 1)[0] ?? null);
    expect(rowTitles(host, 0)).toEqual(["Editing"]);
    expect(rowTitles(host, 1)).toEqual(["Overview", "Sync"]);
    expect(stored(peer)).toEqual([
      ["Reading", [TWO]],
      ["Later", [ONE, THREE]],
    ]);

    // ---- and the groups themselves: Later above Reading ----
    drag(groupToggle(host, 1), groupSlots(host)[0] ?? null);
    expect(groupNames(host)).toEqual(["Later", "Reading"]);
    expect(stored(peer)).toEqual([
      ["Later", [ONE, THREE]],
      ["Reading", [TWO]],
    ]);

    // ---- a move *down*, which is where the arithmetic shows ----
    // Yjs has no move: a drop is a delete and an insert, and the slots below
    // the row being dragged are one place higher once it is gone. Counted
    // naively, dragging a row down by one leaves it exactly where it was.
    drag(rows(host, 1)[0] ?? null, docSlots(host, 0)[1] ?? null);
    expect(rowTitles(host, 0)).toEqual(["Overview", "Editing", "Sync"]);
    drag(rows(host, 0)[0] ?? null, docSlots(host, 0)[2] ?? null);
    expect(rowTitles(host, 0)).toEqual(["Editing", "Overview", "Sync"]);
    expect(stored(peer)).toEqual([
      ["Later", [TWO, ONE, THREE]],
      ["Reading", []],
    ]);
  });

  it("takes a second writer's pin live, and an empty group is somewhere to drop", async () => {
    seedDirectory();
    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    pinDoc(sidebar, reading, ONE);
    const peer = peerOf(sidebar);

    const host = await openApp(`/${WORKSPACE}`);
    expect(rowTitles(host, 0)).toEqual(["Overview"]);

    // ---- the two-writer test: an agent pins and groups on its own replica ----
    // The schema functions are the whole of what `pin_doc` does (#114), so
    // driving them on a peer doc is what an agent's write looks like from here.
    act(() => {
      pinDoc(peer, reading, TWO);
    });
    expect(rowTitles(host, 0)).toEqual(["Overview", "Editing"]);

    let empty = "";
    act(() => {
      empty = createGroup(peer, "Later");
    });
    expect(groupNames(host)).toEqual(["Reading", "Later"]);
    // An empty group is drawn, with the one insertion point that makes it a
    // target — a group nobody could drop into could never be filled.
    expect(rowTitles(host, 1)).toEqual([]);
    expect(docSlots(host, 1)).toHaveLength(1);

    drag(rows(host, 0)[0] ?? null, docSlots(host, 1)[0] ?? null);
    expect(rowTitles(host, 1)).toEqual(["Overview"]);
    expect(readSidebar(peer)).toEqual([
      { id: reading, name: "Reading", docs: [TWO] },
      { id: empty, name: "Later", docs: [ONE] },
    ]);
  });

  it("pins and unpins the open document from its header, with no drag", async () => {
    seedDirectory();
    const doc = room(roomForDoc(WORKSPACE, THREE)).ydoc;
    initDoc(doc, { uuid: THREE, title: "Sync" });
    appendBlock(doc, { type: "paragraph", text: "how sync behaves" });
    const peer = peerOf(sidebarDoc());

    // A deep link to a document nobody ever pinned: it opens, and the sidebar
    // says so by staying empty rather than by inventing an entry for it.
    const host = await openApp(`/${WORKSPACE}/${THREE}`);
    expect(host.querySelector(".ub-title")).toHaveProperty("value", "Sync");
    expect(sections(host)).toHaveLength(0);
    expect(host.querySelector(".ub-empty")?.textContent).toContain("Nothing pinned yet");

    // The keyboard path: a real control in the tab order, no pointer anywhere.
    const pin = pinControl(host);
    expect(pin?.getAttribute("aria-pressed")).toBe("false");
    act(() => pin?.focus());
    expect(document.activeElement).toBe(pin);
    act(() => pin?.click());

    // A pin with nowhere to go makes somewhere to go.
    expect(stored(peer)).toEqual([["Pinned", [THREE]]]);
    expect(rowTitles(host, 0)).toEqual(["Sync"]);
    expect(pinControl(host)?.getAttribute("aria-pressed")).toBe("true");

    // And the same control is the way back out.
    act(() => pinControl(host)?.click());
    expect(readSidebar(peer)[0]?.docs).toEqual([]);
    expect(rowTitles(host, 0)).toEqual([]);
    expect(pinControl(host)?.getAttribute("aria-pressed")).toBe("false");
    // Unpinned is not deleted: the document is still open and still editable.
    expect(host.querySelector(".ub-title")).toHaveProperty("value", "Sync");
  });

  it("makes, renames and deletes groups in place", async () => {
    seedDirectory();
    const peer = peerOf(sidebarDoc());
    const host = await openApp(`/${WORKSPACE}`);

    act(() => host.querySelector<HTMLButtonElement>(".ub-group-add")?.click());
    // Straight into its own name: the placeholder is not a decision.
    const field = host.querySelector<HTMLInputElement>(".ub-group-rename");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);

    act(() => {
      if (field !== null) field.value = "Reading";
    });

    // A sidebar update while somebody is typing must not touch the draft. The
    // field's focus-and-select runs once, when the field appears — re-running it
    // on a re-render would reselect the draft under the caret, and the next
    // keystroke would replace what had been typed.
    act(() => {
      createGroup(peer, "Elsewhere");
    });
    expect(field?.selectionStart).toBe("Reading".length);

    act(() => press(field, "Enter"));
    expect(groupNames(host)).toEqual(["Reading", "Elsewhere"]);
    expect(stored(peer)).toEqual([
      ["Reading", []],
      ["Elsewhere", []],
    ]);

    // Escape takes back the group the field itself made: cancelling is not a
    // decision to keep a group called "New group".
    act(() => host.querySelector<HTMLButtonElement>(".ub-group-add")?.click());
    act(() => press(host.querySelector(".ub-group-rename"), "Escape"));
    expect(stored(peer)).toEqual([
      ["Reading", []],
      ["Elsewhere", []],
    ]);

    // Deleting takes the group and its pins — never the documents, which the
    // sidebar only ever held the uuids of.
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Delete group Reading"]');
    act(() => remove?.click());
    expect(groupNames(host)).toEqual(["Elsewhere"]);
    expect(stored(peer)).toEqual([["Elsewhere", []]]);
  });

  it("collapses a group, and remembers it", async () => {
    seedDirectory();
    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    pinDoc(sidebar, reading, ONE);

    const host = await openApp(`/${WORKSPACE}`);
    const body = (): HTMLElement | null =>
      host.querySelector<HTMLElement>(".ub-group-body");
    expect(groupToggle(host, 0)?.getAttribute("aria-expanded")).toBe("true");
    expect(body()?.dataset.collapsed).toBe("false");

    act(() => groupToggle(host, 0)?.click());
    expect(groupToggle(host, 0)?.getAttribute("aria-expanded")).toBe("false");
    // Still in the DOM — the transition is a CSS animation (#110) — and inert,
    // so a collapsed group is out of the tab order all the same.
    expect(body()?.dataset.collapsed).toBe("true");
    expect(body()?.hasAttribute("inert")).toBe(true);

    // A fresh mount is what a reload looks like to the component.
    const open = mounted;
    mounted = null;
    if (open !== null) {
      act(() => open.root.unmount());
      open.host.remove();
    }
    const again = await openApp(`/${WORKSPACE}`);
    expect(groupToggle(again, 0)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("names an archived pin instead of showing its uuid, and takes it back", async () => {
    const directory = seedDirectory();
    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    pinDoc(sidebar, reading, ONE);
    pinDoc(sidebar, reading, TWO);
    // The pair an agent works over: `archive_doc` tombstones the directory
    // stub, `get_sidebar` reads that stub through the pins.
    const directoryPeer = peerOf(directory);
    const sidebarPeer = peerOf(sidebar);

    const host = await openApp(`/${WORKSPACE}`);
    expect(rowTitles(host, 0)).toEqual(["Overview", "Editing"]);

    // ---- archived elsewhere: the tombstone arrives over the wire ----
    act(() => {
      tombstoneDirectoryEntry(directoryPeer, ONE);
    });
    // The title the stub still carries, marked — never the eight characters of
    // uuid this used to fall back to (#287).
    expect(rowTitles(host, 0)).toEqual(["Overview \u00b7 archived", "Editing"]);
    expect(host.querySelector(".ub-list")?.textContent ?? "").not.toContain(
      ONE.slice(0, 8),
    );
    // The pin is untouched: archiving is not unpinning (#210).
    expect(stored(sidebarPeer)).toEqual([["Reading", [ONE, TWO]]]);

    // ---- restored: the ordinary row, in its place ----
    act(() => {
      restoreDirectoryEntry(directoryPeer, ONE);
    });
    expect(rowTitles(host, 0)).toEqual(["Overview", "Editing"]);
  });
});
