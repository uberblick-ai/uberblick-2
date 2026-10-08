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
 * jsdom proves rendering and live schema updates. Event translation, pointer,
 * keyboard and touch gestures, and cancellation are covered in browser tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderSettled, type RenderResult } from "./react-render.js";
import type { ReactNode } from "react";
import * as Y from "yjs";
import {
  createGroup,
  directoryRoom,
  initDoc,
  appendBlock,
  pinDoc,
  moveDoc,
  moveGroup,
  readSidebar,
  restoreDirectoryEntry,
  roomForDoc,
  settingsRoom,
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

/**
 * What every stubbed room reports. Live unless a test sets it before the
 * rooms are made, which is how the directory line's readings are exercised
 * (#448); reset after each test with the rooms that were handed it.
 */
let roomStatus: RoomStatus = LIVE;

const rooms = new Map<string, RoomConnection>();
const statusListeners = new Map<string, Set<(next: RoomStatus) => void>>();

function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const listeners = new Set<(next: RoomStatus) => void>();
  statusListeners.set(name, listeners);
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: roomStatus,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listeners.add(listener);
      listener(connection.status);
      return () => listeners.delete(listener);
    },
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

let mounted: RenderResult | null = null;

beforeEach(() => {
  installStorage();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

afterEach(() => {
  mounted = null;
  rooms.clear();
  statusListeners.clear();
  roomStatus = LIVE;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  mounted = await renderSettled(node);
  return mounted.container;
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
  return [...(section?.querySelectorAll<HTMLButtonElement>(".ub-group-body li > button:first-child") ?? [])];
}

function rowTitles(host: HTMLElement, index: number): string[] {
  return rows(host, index).map((row) => row.textContent ?? "");
}

/** What each row offers on hover — the `title` attribute, top to bottom. */
function rowTooltips(host: HTMLElement, index: number): Array<string | null> {
  return rows(host, index).map((row) => row.getAttribute("title"));
}

function groupToggle(host: HTMLElement, index: number): HTMLButtonElement | null {
  return sections(host)[index]?.querySelector<HTMLButtonElement>(".ub-group-toggle") ?? null;
}

function actionsTrigger(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(".ub-actions-trigger");
}

function openActions(host: HTMLElement): void {
  act(() => {
    const trigger = actionsTrigger(host);
    trigger?.focus();
    trigger?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

function documentAction(label: string): HTMLElement | undefined {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]"),
  ].find((item) => item.textContent === label);
}

function press(element: Element | null, key: string): void {
  element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

/** The landmarks the sidebar column is made of, in the order they are drawn. */
const LANDMARKS = ["ub-list-head", "ub-nav", "ub-empty", "ub-group"];

function columnOrder(host: HTMLElement): string[] {
  const list = host.querySelector('.ub-document-sidebar [data-slot="sidebar-content"]');
  return [...(list?.children ?? [])].flatMap((child) =>
    LANDMARKS.filter((mark) => child.classList.contains(mark)),
  );
}

/** The navigation rows, top to bottom. */
function navRows(host: HTMLElement): HTMLButtonElement[] {
  return [
    ...host.querySelectorAll<HTMLButtonElement>(
      ".ub-document-sidebar .ub-nav li button",
    ),
  ];
}

describe("the sidebar is the _sidebar document", () => {
  // Not writable is the stricter reading: sortability must not disable or
  // re-role the rows even when the room cannot accept a reorder.
  it("keeps row navigation and disclosure semantics when the sidebar is not writable", async () => {
    seedDirectory();
    const doc = room(roomForDoc(WORKSPACE, ONE)).ydoc;
    initDoc(doc, { uuid: ONE, title: "Overview" });
    const sidebar = room(sidebarRoom(WORKSPACE));
    const reading = createGroup(sidebar.ydoc, "Reading");
    pinDoc(sidebar.ydoc, reading, ONE);
    pinDoc(sidebar.ydoc, reading, TWO);
    sidebar.status = { ...LIVE, writable: false };
    const peer = peerOf(sidebar.ydoc);
    const host = await openApp(`/${WORKSPACE}/${ONE}`);
    const [current, other] = rows(host, 0);
    const toggle = groupToggle(host, 0);

    // The same native buttons open/toggle and pick up the row. Sortability
    // must not turn their resting state into a pressed or disabled control,
    // even while the sidebar room cannot accept reordering writes.
    expect(current).toBeInstanceOf(HTMLButtonElement);
    expect(current?.textContent).toBe("Overview");
    expect(current?.getAttribute("aria-current")).toBe("page");
    expect(other?.getAttribute("aria-current")).toBeNull();
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.textContent).toBe("Reading");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    for (const button of [current, other, toggle]) {
      expect(button?.disabled).toBe(false);
      expect(button?.getAttribute("role")).toBeNull();
      expect(button?.hasAttribute("aria-pressed")).toBe(false);
      expect(button?.hasAttribute("aria-grabbed")).toBe(false);
      expect(button?.hasAttribute("aria-disabled")).toBe(false);
    }
    expect(host.querySelectorAll('.ub-drag-handle, [aria-label^="Move document"], [aria-label^="Move group"]')).toHaveLength(0);

    act(() => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle?.click());
    act(() => other?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/${TWO}`);
    expect(rows(host, 0)[1]?.getAttribute("aria-current")).toBe("page");
    expect(rows(host, 0)[0]?.getAttribute("aria-current")).toBeNull();
    expect(stored(peer)).toEqual([["Reading", [ONE, TWO]]]);
  });

  it("renders stored order and live moves from another replica", async () => {
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
    expect(host.querySelectorAll(".ub-group-count")).toHaveLength(0);

    // ---- within a group: "Editing" to the top ----
    act(() => moveDoc(peer, TWO, reading, 0));
    expect(rowTitles(host, 0)).toEqual(["Editing", "Overview"]);
    expect(stored(peer)).toEqual([
      ["Reading", [TWO, ONE]],
      ["Later", [THREE]],
    ]);

    // ---- across groups: "Overview" to the head of Later ----
    act(() => moveDoc(peer, ONE, later, 0));
    expect(rowTitles(host, 0)).toEqual(["Editing"]);
    expect(rowTitles(host, 1)).toEqual(["Overview", "Sync"]);
    expect(stored(peer)).toEqual([
      ["Reading", [TWO]],
      ["Later", [ONE, THREE]],
    ]);

    // ---- and the groups themselves: Later above Reading ----
    act(() => moveGroup(peer, later, 0));
    expect(groupNames(host)).toEqual(["Later", "Reading"]);
    expect(stored(peer)).toEqual([
      ["Later", [ONE, THREE]],
      ["Reading", [TWO]],
    ]);
  });

  it("takes a second writer's pins and groups live", async () => {
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
    // Empty groups are rendered, and a peer can populate them without reloading.
    expect(rowTitles(host, 1)).toEqual([]);

    act(() => moveDoc(peer, ONE, empty, 0));
    expect(rowTitles(host, 1)).toEqual(["Overview"]);
    expect(readSidebar(peer)).toEqual([
      { id: reading, name: "Reading", docs: [TWO] },
      { id: empty, name: "Later", docs: [ONE] },
    ]);
  });

  it("pins and unpins the open document from its actions menu, with no drag", async () => {
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
    const trigger = actionsTrigger(host);
    expect(trigger?.getAttribute("aria-label")).toBe("Document actions");
    openActions(host);
    act(() => documentAction("Pin to sidebar")?.click());

    // A pin with nowhere to go makes somewhere to go.
    expect(stored(peer)).toEqual([["Pinned", [THREE]]]);
    expect(rowTitles(host, 0)).toEqual(["Sync"]);
    openActions(host);
    expect(documentAction("Unpin from sidebar")).not.toBeUndefined();

    // The open document's row says so the way the All-docs entry always has
    // (#481): one state, `aria-current`, reaching the styling and a screen
    // reader together — where a class reached only the styling. The navigation
    // entry is the discriminator: "current" has to mean the thing that is
    // open, not every row in the column.
    expect(rows(host, 0)[0]?.getAttribute("aria-current")).toBe("page");
    expect(
      host.querySelector(".ub-all-open-entry")?.getAttribute("aria-current"),
    ).toBeNull();

    // And the same control is the way back out.
    act(() => documentAction("Unpin from sidebar")?.click());
    expect(readSidebar(peer)[0]?.docs).toEqual([]);
    expect(rowTitles(host, 0)).toEqual([]);
    openActions(host);
    expect(documentAction("Pin to sidebar")).not.toBeUndefined();
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
    // Replacing the sortable heading with a field must not make its section
    // an inherited disabled/pressed control containing editable descendants.
    for (const element of [field, field?.closest(".ub-group")]) {
      expect(element?.hasAttribute("aria-disabled")).toBe(false);
      expect(element?.hasAttribute("aria-pressed")).toBe(false);
      expect(element?.hasAttribute("aria-grabbed")).toBe(false);
      expect(element?.getAttribute("role")).toBeNull();
    }
    expect(field?.disabled).toBe(false);

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

    // jsdom has no implicit Enter submission; the browser suite exercises that
    // native key path. Here the form's submit must reach the same blur commit.
    act(() => field?.form?.requestSubmit());
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
    expect(groupNames(host)).toEqual(["Reading", "Elsewhere"]);
    act(() => document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')?.click());
    expect(groupNames(host)).toEqual(["Elsewhere"]);
    expect(stored(peer)).toEqual([["Elsewhere", []]]);
  });

  it("writes nothing when group deletion is cancelled", async () => {
    seedDirectory();
    const sidebar = sidebarDoc();
    pinDoc(sidebar, createGroup(sidebar, "Reading"), ONE);
    const peer = peerOf(sidebar);
    const before = stored(peer);
    const host = await openApp(`/${WORKSPACE}`);
    const writes = vi.fn();
    sidebar.on("update", writes);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Delete group Reading"]')?.click());
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Delete group Reading?");
    expect(writes).not.toHaveBeenCalled();
    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]')?.click();
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(stored(peer)).toEqual(before);
  });

  it("confirmed group deletion removes its pins and preserves every document", async () => {
    const directory = seedDirectory();
    const documents = [ONE, TWO].map((uuid) => {
      const doc = room(roomForDoc(WORKSPACE, uuid)).ydoc;
      initDoc(doc, { uuid, title: "Preserved" });
      appendBlock(doc, { type: "paragraph", text: "Preserved content" });
      return doc;
    });
    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    pinDoc(sidebar, reading, ONE);
    pinDoc(sidebar, reading, TWO);
    pinDoc(sidebar, createGroup(sidebar, "Elsewhere"), THREE);
    const peer = peerOf(sidebar);
    const host = await openApp(`/${WORKSPACE}`);
    const before = [directory, ...documents].map((doc) => Y.encodeStateAsUpdate(doc));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Delete group Reading"]')?.click());
    expect(stored(peer)).toEqual([["Reading", [ONE, TWO]], ["Elsewhere", [THREE]]]);
    act(() => document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')?.click());
    expect(stored(peer)).toEqual([["Elsewhere", [THREE]]]);
    expect([directory, ...documents].map((doc) => Y.encodeStateAsUpdate(doc))).toEqual(before);
  });

  // Unnotified: the dialog was opened while writable and nothing re-rendered
  // it, so only the click-time check stands between it and a write.
  it("refuses deletion in place when writability is lost", async () => {
    seedDirectory();
    const sidebar = room(sidebarRoom(WORKSPACE));
    pinDoc(sidebar.ydoc, createGroup(sidebar.ydoc, "Reading"), ONE);
    const peer = peerOf(sidebar.ydoc);
    const before = stored(peer);
    const host = await openApp(`/${WORKSPACE}`);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Delete group Reading"]')?.click());
    const writes = vi.fn();
    sidebar.ydoc.on("update", writes);
    act(() => {
      sidebar.status = { ...LIVE, writable: false };
    });
    act(() => document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')?.click());
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Delete unavailable");
    expect(dialog?.textContent).toContain("Nothing has been deleted");
    expect(stored(peer)).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    act(() => dialog?.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]')?.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(writes).not.toHaveBeenCalled();
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
    expect(host.querySelectorAll(".ub-group-count")).toHaveLength(0);
    // Still in the DOM — the transition is a CSS animation (#110) — and inert,
    // so a collapsed group is out of the tab order all the same.
    expect(body()?.dataset.collapsed).toBe("true");
    expect(body()?.hasAttribute("inert")).toBe(true);

    // A fresh mount is what a reload looks like to the component.
    mounted?.unmount();
    mounted = null;
    const again = await openApp(`/${WORKSPACE}`);
    expect(groupToggle(again, 0)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("names an archived pin instead of showing its uuid, and takes it back", async () => {
    const directory = seedDirectory();
    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    pinDoc(sidebar, reading, ONE);
    pinDoc(sidebar, reading, TWO);
    // The pair an agent works over: a tombstoned directory stub, and the pins
    // `get_sidebar` reads through it. The tombstone arrives over the wire from
    // a peer rather than from this client's own archive, because a local
    // archive would take the pin with it (#957).
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
    // The pin is untouched. Archiving unpins now (#957), but this archive came
    // from another replica, so nothing here removed the pin — which is exactly
    // the race that leaves an archived pin to render.
    expect(stored(sidebarPeer)).toEqual([["Reading", [ONE, TWO]]]);

    // ---- restored: the ordinary row, in its place ----
    act(() => {
      restoreDirectoryEntry(directoryPeer, ONE);
    });
    expect(rowTitles(host, 0)).toEqual(["Overview", "Editing"]);
  });

  it("offers the whole name a clipped row can only show part of", async () => {
    // A 34px row ellipsises anything longer than the 16rem column (#481), so
    // the tooltip is the only way back to the name — and it used to offer the
    // uuid instead (#529). All four things a row can say, in one group.
    const directory = seedDirectory();
    upsertDirectoryEntry(directory, { uuid: THREE, title: "" });
    tombstoneDirectoryEntry(directory, TWO);
    const unknown = "3a9d5c17-0e64-4b28-8f31-6d2a7c40b9e5";

    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    for (const uuid of [ONE, TWO, THREE, unknown]) pinDoc(sidebar, reading, uuid);

    const host = await openApp(`/${WORKSPACE}`);
    expect(rowTitles(host, 0)).toEqual([
      "Overview",
      "Editing · archived",
      "Untitled",
      unknown.slice(0, 8),
    ]);
    // The same words, with the suffix — and for the stub the whole uuid, since
    // the eight characters on the row are what there is to recover from.
    expect(rowTooltips(host, 0)).toEqual([
      "Overview",
      "Editing · archived",
      "Untitled",
      unknown,
    ]);
  });
});

describe("workspace settings is a route-driven sidebar mode", () => {
  function pane(host: HTMLElement, selector: string): HTMLElement {
    return host.querySelector<HTMLElement>(selector) as HTMLElement;
  }

  function expectDead(offscreen: HTMLElement): void {
    expect(offscreen.hasAttribute("inert")).toBe(true);
    expect(offscreen.getAttribute("aria-hidden")).toBe("true");
    // The controls, draggable rows and drop targets remain mounted for the CSS
    // transition, but every one is beneath the inert boundary for its whole
    // duration — transform and opacity are never the interaction boundary.
    const reachable = offscreen.querySelectorAll("button, input");
    expect(reachable.length).toBeGreaterThan(0);
    for (const node of reachable) expect(node.closest("[inert]")).toBe(offscreen);
  }

  function expectLive(onscreen: HTMLElement): void {
    expect(onscreen.hasAttribute("inert")).toBe(false);
    expect(onscreen.getAttribute("aria-hidden")).toBe("false");
  }

  it("drills in from the footer, makes the document pane inert immediately, and goes back", async () => {
    seedDirectory();
    const sidebar = sidebarDoc();
    pinDoc(sidebar, createGroup(sidebar, "Reading"), ONE);
    const host = await openApp(`/${WORKSPACE}`);
    const documents = pane(host, ".ub-document-sidebar");
    const settings = pane(host, ".ub-settings-sidebar");
    const settingsEntry = host.querySelector<HTMLButtonElement>(
      ".ub-settings-entry",
    );

    expectLive(documents);
    expectDead(settings);
    expect(host.querySelectorAll('[data-testid="account-menu"]')).toHaveLength(1);
    const accountControl = host.querySelector('[data-testid="account-menu"]');
    expect(accountControl?.closest(".ub-sidebar-pane")).toBeNull();

    settingsEntry?.focus();
    act(() => settingsEntry?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings`);
    // This assertion runs in the same task as the route change, while the
    // 180ms CSS transition is still in flight.
    expect(host.querySelector(".ub-list")?.getAttribute("data-mode")).toBe(
      "settings",
    );
    expectDead(documents);
    expectLive(settings);
    expect(host.querySelectorAll('[data-testid="account-menu"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="account-menu"]')).toBe(accountControl);
    expect(document.activeElement).toBe(
      settings.querySelector(".ub-settings-back"),
    );
    expect(settings.textContent).toContain(`Back to Unnamed workspace · ${WORKSPACE.slice(0, 8)}`);
    expect(settings.querySelector(".ub-nav-label")?.textContent).toBe(
      "Workspace settings",
    );
    expect(settings.querySelector('[aria-current="page"]')?.textContent).toContain(
      "General",
    );
    expect(host.querySelector("#ub-settings-title")?.textContent).toBe("General");
    expect(
      host.querySelector(".ub-sidebar-toggle")?.getAttribute("aria-label"),
    ).toBe("Hide sidebar");

    const tags = [
      ...settings.querySelectorAll<HTMLButtonElement>(".ub-settings-nav button"),
    ].find((button) => button.textContent?.includes("Tags"));
    act(() => tags?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings/tags`);
    expect(settings.querySelector('[aria-current="page"]')?.textContent).toContain(
      "Tags",
    );
    expect(host.querySelector("#ub-settings-title")?.textContent).toBe("Tags");
    expect(rooms.has(settingsRoom(WORKSPACE))).toBe(true);

    act(() => settings.querySelector<HTMLButtonElement>(".ub-settings-back")?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}`);
    expectDead(settings);
    expectLive(documents);
    expect(document.activeElement).toBe(settingsEntry);
  });

  it("opens a pasted settings address directly", async () => {
    seedDirectory();
    const host = await openApp(`/${WORKSPACE}/settings`);
    expect(host.querySelector(".ub-list")?.getAttribute("data-mode")).toBe(
      "settings",
    );
    expect(host.querySelector("#ub-settings-title")?.textContent).toBe("General");
    expect(host.querySelector(".ub-document-sidebar")?.hasAttribute("inert")).toBe(
      true,
    );
  });

  it("opens the pasted Tags settings address directly", async () => {
    const host = await openApp(`/${WORKSPACE}/settings/tags`);
    expect(host.querySelector("#ub-settings-title")?.textContent).toBe("Tags");
    expect(
      host.querySelector(".ub-settings-sidebar [aria-current=page]")?.textContent,
    ).toContain("Tags");
    expect(rooms.has(settingsRoom(WORKSPACE))).toBe(true);
  });

  it("offers no settings destination when the address names no workspace", async () => {
    const host = await openApp("/not-a-workspace");
    expect(host.querySelector(".ub-settings-entry")).toBeNull();
  });
});

/**
 * The fixed navigation section (#483). Everything here asks one question: is it
 * chrome? Curation moves, is stored in `_sidebar` and can be dropped into;
 * chrome is in the same place on every page, and the two destinations that do
 * not exist yet are shown as absent affordances rather than as broken links.
 */
describe("the sidebar's fixed navigation", () => {
  it("stands above the curation, pinned or not, and is not a drop target", async () => {
    seedDirectory();
    const host = await openApp(`/${WORKSPACE}`);

    // Nothing pinned yet: the section is already there, above the line that
    // says so — an empty sidebar still opens with somewhere to go.
    expect(columnOrder(host)).toEqual([
      "ub-list-head",
      "ub-nav",
      "ub-empty",
    ]);
    expect(navRows(host).map((row) => row.textContent)).toEqual([
      "All docs",
      "Dashboard Coming soon",
      "Product requirements Coming soon",
    ]);

    // A pin arrives and the groups appear under it; the section has not moved,
    // and the footer keeps the settings entry and account control.
    act(() => {
      const sidebar = sidebarDoc();
      pinDoc(sidebar, createGroup(sidebar, "Reading"), ONE);
    });
    expect(columnOrder(host)).toEqual([
      "ub-list-head",
      "ub-nav",
      "ub-group",
    ]);
    expect(host.querySelector('[data-slot="sidebar-footer"] .ub-all-open-entry')).toBeNull();
    expect(host.querySelector('[data-slot="sidebar-footer"] .ub-settings-entry')).not.toBeNull();
    expect(host.querySelector('[data-slot="sidebar-footer"] [data-testid="account-menu"]')).not.toBeNull();

    // Chrome, not curation: nothing in it can be dragged, and no drag of any
    // kind can land in it.
    const nav = host.querySelector(".ub-nav");
    expect(nav?.querySelectorAll("[draggable]")).toHaveLength(0);
  });

  it("shows the two destinations it does not have as unavailable, not as links", async () => {
    seedDirectory();
    const doc = room(roomForDoc(WORKSPACE, THREE)).ydoc;
    initDoc(doc, { uuid: THREE, title: "Sync" });
    appendBlock(doc, { type: "paragraph", text: "how sync behaves" });

    const host = await openApp(`/${WORKSPACE}/${THREE}`);
    const [, ...soon] = navRows(host);
    expect(soon.map((row) => row.getAttribute("aria-disabled"))).toEqual([
      "true",
      "true",
    ]);
    expect(soon.map((row) => row.textContent)).toEqual([
      "Dashboard Coming soon",
      "Product requirements Coming soon",
    ]);

    for (const row of soon) {
      // Focusable on purpose. `disabled` would take the row out of the tab
      // order, and a destination nobody can reach is a destination nobody is
      // told about — `aria-disabled` announces it instead.
      expect(row.disabled).toBe(false);
      act(() => row.focus());
      expect(document.activeElement).toBe(row);
      // A button's Enter and Space are this click, so activating it either way
      // is this call: the row has no handler, so nothing happens.
      act(() => row.click());
    }

    expect(window.location.pathname).toBe(`/${WORKSPACE}/${THREE}`);
    expect(host.querySelector(".ub-title")).toHaveProperty("value", "Sync");
  });
});

/**
 * The directory line — the line the owner actually read on a freshly joined
 * machine, where a refused page said `syncing…` and left no way to tell why
 * without opening a document (#448).
 *
 * It now takes a refusal's word from the shared derivation, whose precedence
 * and wording `status-reading.test.ts` pins; what is asked here is only that
 * this line shows it, and that its own three readings are otherwise untouched —
 * uncalmed, and still saying "directory", because this line is about the
 * directory room and normalizing it is a different change.
 */
describe("the sidebar's directory line reads a refusal", () => {
  /** The line under the head, for a directory room in the given state. */
  async function directoryLine(status: Partial<RoomStatus>): Promise<string> {
    // A fresh mount per reading, the way the collapse test remounts: the rooms
    // are cached, so a new status has to be in place before they are made.
    mounted?.unmount();
    mounted = null;
    rooms.clear();
    roomStatus = {
      ...LIVE,
      connected: false,
      synced: false,
      writable: false,
      ...status,
    };
    const host = await openApp(`/${WORKSPACE}`);
    return host.querySelector(".ub-list-head .ub-muted")?.textContent ?? "";
  }

  it("names which refusal it is, rather than calling a refused page busy", async () => {
    // Connected and synced underneath throughout, so each refusal is outranking
    // the ordinary reading rather than standing in for a missing one.
    const live = { connected: true, synced: true };
    expect(
      await directoryLine({ ...live, protocolMismatch: { hub: 2, client: 1 } }),
    ).toBe("update required");
    expect(await directoryLine({ ...live, tokenMissing: true })).toBe("no hub token");
    expect(await directoryLine({ ...live, authFailed: true })).toBe("not authorized");
    expect(await directoryLine({ ...live, storeRefused: true })).toBe(
      "edit refused",
    );
  });

  it("keeps its own three readings when nothing is refused", async () => {
    expect(await directoryLine({ connected: true, synced: true })).toBe(
      "directory synced",
    );
    expect(await directoryLine({ connected: true, synced: false })).toBe("syncing…");
    expect(await directoryLine({})).toBe("offline");
  });
});

describe("pinning waits for the current sidebar state", () => {
  it("disables list pins before sync", async () => {
    seedDirectory();
    const sidebar = room(sidebarRoom(WORKSPACE));
    // Received server state once and then lost sync: the case a gate on
    // "has ever answered" alone would wrongly let through.
    sidebar.status = { ...LIVE, synced: false, hasReceivedServerState: true };
    const host = await openApp(`/${WORKSPACE}`);
    const writes = vi.fn();
    sidebar.ydoc.on("update", () => writes());
    const pin = host.querySelector<HTMLButtonElement>(".ub-docs-pin");

    expect(pin?.disabled).toBe(true);
    expect(pin?.getAttribute("aria-label")).toContain(
      "unavailable while sidebar is not ready to write",
    );
    expect(pin?.title).toContain("sidebar is not ready to write");
    act(() => pin?.click());
    expect(writes).not.toHaveBeenCalled();
    expect(stored(sidebar.ydoc)).toEqual([]);
    // Group creation retains its admission-only gate.
    expect(host.querySelector<HTMLButtonElement>(".ub-group-add")?.disabled).toBe(false);
  });

  it("disables the open document's pin before sync", async () => {
    seedDirectory();
    const doc = room(roomForDoc(WORKSPACE, THREE)).ydoc;
    initDoc(doc, { uuid: THREE, title: "Sync" });
    const sidebar = room(sidebarRoom(WORKSPACE));
    // Received server state once and then lost sync: the case a gate on
    // "has ever answered" alone would wrongly let through.
    sidebar.status = { ...LIVE, synced: false, hasReceivedServerState: true };
    const host = await openApp(`/${WORKSPACE}/${THREE}`);
    const writes = vi.fn();
    sidebar.ydoc.on("update", () => writes());
    openActions(host);
    const pin = documentAction("Pin unavailable — sidebar is not ready to write");

    expect(pin?.getAttribute("aria-disabled")).toBe("true");
    act(() => pin?.click());
    expect(writes).not.toHaveBeenCalled();
    expect(stored(sidebar.ydoc)).toEqual([]);
  });

  it.each([
    ["list", false],
    ["document", true],
  ] as const)(
    "refuses a stale %s gesture at click time (pinned: %s)",
    async (surface, pinned) => {
      seedDirectory();
      const doc = room(roomForDoc(WORKSPACE, ONE)).ydoc;
      initDoc(doc, { uuid: ONE, title: "Overview" });
      const sidebar = room(sidebarRoom(WORKSPACE));
      if (pinned) pinDoc(sidebar.ydoc, createGroup(sidebar.ydoc, "Reading"), ONE);
      const peer = peerOf(sidebar.ydoc);
      const before = stored(peer);
      const host = await openApp(`/${WORKSPACE}${surface === "document" ? `/${ONE}` : ""}`);
      if (surface === "document") openActions(host);
      const pin = surface === "list"
        ? host.querySelector<HTMLButtonElement>(".ub-docs-pin")
        : documentAction(pinned ? "Unpin from sidebar" : "Pin to sidebar");
      expect(pin).toBeTruthy();
      expect(pin?.getAttribute("aria-disabled")).not.toBe("true");
      expect(pin?.hasAttribute("disabled")).toBe(false);
      const writes = vi.fn();
      sidebar.ydoc.on("update", () => writes());

      // No notification: the rendered gesture stays enabled while the live
      // connection has lost sync, as can happen between paint and activation.
      sidebar.status = { ...LIVE, synced: false };
      act(() => pin?.click());
      expect(writes).not.toHaveBeenCalled();
      expect(stored(peer)).toEqual(before);
    },
  );
});

describe("unwritable workspace rooms", () => {
  it("makes directory creation and sidebar curation unavailable", async () => {
    roomStatus = { ...LIVE, connected: false, synced: false, writable: false };
    seedDirectory();
    createGroup(sidebarDoc(), "Reading");
    const host = await openApp(`/${WORKSPACE}`);
    const before = rooms.size;

    const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("new doc"),
    );
    expect(create?.disabled).toBe(true);
    expect(create?.title).toContain("directory is read-only");
    expect(create?.textContent).toContain("unavailable");
    const listPin = host.querySelector<HTMLButtonElement>(".ub-docs-pin");
    expect(listPin?.disabled).toBe(true);
    expect(listPin?.getAttribute("aria-label")).toContain(
      "unavailable while sidebar is not ready to write",
    );
    expect(host.querySelector(".ub-sidebar-unwritable")?.textContent).toContain(
      "Sidebar changes unavailable",
    );
    expect(host.querySelectorAll(".ub-group-act")).toHaveLength(0);
    expect(host.querySelector<HTMLButtonElement>(".ub-group-add")?.disabled).toBe(
      true,
    );

    act(() => create?.click());
    expect(rooms.size).toBe(before);
  });

  it("names an unavailable pin in the open document's action surface", async () => {
    roomStatus = { ...LIVE, connected: false, synced: false, writable: false };
    seedDirectory();
    const doc = room(roomForDoc(WORKSPACE, THREE)).ydoc;
    initDoc(doc, { uuid: THREE, title: "Sync" });
    appendBlock(doc, { type: "paragraph", text: "how sync behaves" });
    const host = await openApp(`/${WORKSPACE}/${THREE}`);

    openActions(host);
    expect(
      documentAction("Pin unavailable — sidebar is not ready to write"),
    ).not.toBeUndefined();
  });
});
