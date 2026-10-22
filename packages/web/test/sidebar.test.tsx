/**
 * The sidebar renders the `_sidebar` document.
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
import { screen, waitFor, within } from "@testing-library/react";
import { act, renderSettled, type RenderResult } from "./react-render.js";
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
  settingsRoom,
  sidebarRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { SidebarGroup } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { AccessAction } from "../src/shell/workspace-access.js";

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
 * rooms are made, which is how the direct hub's readings are exercised;
 * reset after each test with the rooms that were handed it.
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

vi.mock("../src/collab/rooms.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/collab/rooms.js")>(),
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
  mintHubAuthMessage: async () => "local-browser-bearer",
}));

const { App } = await import("../src/ui/App.js");
const { rereadClientConfigForTesting } = await import("../src/config.js");

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
 * test provides the one thing `useStoredFlag` needs, and the page's ub open
 * session.
 */
function installStorage(): void {
  const store = new Map<string, string>([["uberblick:ub-open-session", "s".repeat(43)]]);
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
  rereadClientConfigForTesting();
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

function settingsHub(ownRole: () => Promise<Record<string, unknown>>,
  hubAdmin: boolean | (() => Promise<Record<string, unknown>>) = false, signedIn = true) {
  const calls: AccessAction[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (input === "/api/access") {
      const action = JSON.parse(init?.body as string) as AccessAction;
      calls.push(action);
      const body = action.operation === "own-role" ? await ownRole()
        : action.operation === "own-hub-role" ? typeof hubAdmin === "function" ? await hubAdmin()
          : hubAdmin ? { status: "ok", role: "admin" } : { status: "forbidden" }
        : action.operation === "list-devices" ? { status: "ok", handle: "hub-person", devices: [] }
        : action.operation === "list-members" ? { status: "ok", members: [] }
        : action.operation === "list-hub-admins" ? { status: "ok", admins: [], nextCursor: null }
        : { status: "forbidden" };
      return Response.json({ ...body, hub: "https://hub.example.test" });
    }
    if (input === "/api/device-login") return Response.json(signedIn
      ? { state: "signed-in", handle: "hub-person" } : { state: "signed-out" });
    if (input === "/api/account") return Response.json({ state: "unavailable" });
    if (input === "/uberblick-config.json") return Response.json({
      hubUrl: "ws://127.0.0.1:4321", workspaces: [WORKSPACE],
      servedWorkspaces: { [WORKSPACE]: { remoteHubUrl: "wss://hub.example.test/ws" } },
    });
    return new Response("", { status: 404 });
  });
  return calls;
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

function documentsPane(host: HTMLElement): HTMLElement {
  // Label queries keep finding this mounted navigation while aria-hidden.
  return within(host).getByLabelText("Documents");
}

function sidebarControls(host: HTMLElement) {
  return within(documentsPane(host));
}

function groupToggles(host: HTMLElement): HTMLButtonElement[] {
  // Enumerate every mounted disclosure in DOM order, including empty names
  // and controls hidden by a modal. aria-expanded without aria-haspopup is
  // the group disclosure contract; accessible names are empty while hidden.
  return sidebarControls(host).queryAllByRole<HTMLButtonElement>("button", { hidden: true })
    .filter((button) => button.hasAttribute("aria-expanded") && !button.hasAttribute("aria-haspopup"));
}

function sections(host: HTMLElement): HTMLElement[] {
  // A group wrapper has no accessible name of its own. Keep the structural
  // ancestor check, anchored by its accessible disclosure or rename field.
  const controls = [...groupToggles(host), ...sidebarControls(host).queryAllByLabelText("Group name")];
  return controls.map((control) => control.closest("section") as HTMLElement)
    .sort((first, second) => first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
}

/** The group names on screen, top to bottom. */
function groupNames(host: HTMLElement): string[] {
  return groupToggles(host).map(
    (node) => node.textContent ?? "",
  );
}

/** The document rows of the `index`-th group, top to bottom. */
function rows(host: HTMLElement, index: number): HTMLButtonElement[] {
  const section = sections(host)[index];
  // Enumerate every mounted row, including an empty title or one hidden when
  // the document menu opens. Order/current-row proofs inspect mounted nodes.
  const list = section === undefined ? null : within(section).queryByRole("list", { hidden: true });
  return list === null ? [] : within(list).queryAllByRole<HTMLButtonElement>("button", { hidden: true });
}

function rowTitles(host: HTMLElement, index: number): string[] {
  return rows(host, index).map((row) => row.textContent ?? "");
}

/** What each row offers on hover — the `title` attribute, top to bottom. */
function rowTooltips(host: HTMLElement, index: number): Array<string | null> {
  return rows(host, index).map((row) => row.getAttribute("title"));
}

function groupToggle(host: HTMLElement, index: number): HTMLButtonElement | null {
  return groupToggles(host)[index] ?? null;
}

function expectNoExtraGroupChrome(host: HTMLElement): void {
  for (const toggle of groupToggles(host)) {
    // Heading siblings are controls, with no separate count or drag marker.
    // Decorations inside the disclosure may change without affecting this.
    const head = toggle.parentElement as HTMLElement;
    expect(head.children).toHaveLength(within(head).queryAllByRole("button", { hidden: true }).length);
    expect(toggle.closest("section")?.children).toHaveLength(2);
  }
}

function actionsTrigger(host: HTMLElement): HTMLButtonElement | null {
  return within(host).queryByRole<HTMLButtonElement>("button", { name: "Document actions" });
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
  return screen.queryByRole("menuitem", { name: label }) ?? undefined;
}

function press(element: Element | null, key: string): void {
  element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function columnOrder(host: HTMLElement): string[] {
  const controls = sidebarControls(host);
  const creation = controls.getByRole("button", { name: "+ New page" }).parentElement;
  const navigation = controls.getByRole("button", { name: "All documents" }).closest("section");
  const empty = controls.queryByText(/Nothing pinned yet/);
  const groups = sections(host);
  // These unnamed layout wrappers have no roles; compare their identities to
  // accessible descendants so a restyle cannot erase an order assertion.
  return [...(creation?.parentElement?.children ?? [])].flatMap((child) => {
    if (child === creation) return ["creation"];
    if (child === navigation) return ["navigation"];
    if (child === empty) return ["empty"];
    return groups.includes(child as HTMLElement) ? ["group"] : [];
  });
}

/** The navigation rows, top to bottom. */
function navRows(host: HTMLElement): HTMLButtonElement[] {
  const navigation = sidebarControls(host).getByRole("button", { name: "All documents" }).closest("section") as HTMLElement;
  // Ordering covers every mounted row, even if its name or visibility regresses.
  return within(navigation).getAllByRole<HTMLButtonElement>("button", { hidden: true });
}

describe("the sidebar is the _sidebar document", () => {
  it("skips malformed synced pins while valid pins still navigate", async () => {
    seedDirectory();
    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    pinDoc(sidebar, reading, ONE);
    sidebar.getArray(`pins:${reading}`).push([
      { uuid: "..", since: 0 },
      { uuid: "a/record/b", since: 0 },
      { uuid: ONE.toUpperCase(), since: 0 },
      { uuid: null, since: 0 },
    ]);
    initDoc(room(roomForDoc(WORKSPACE, ONE)).ydoc, { uuid: ONE, title: "Overview" });
    const host = await openApp(`/${WORKSPACE}`);
    const navigation = documentsPane(host);
    expect(navigation.querySelectorAll('button[title=".."], button[title="a/record/b"]')).toHaveLength(0);
    expect(navigation.querySelectorAll(`button[title="${ONE.toUpperCase()}"]`)).toHaveLength(0);
    expect(stored(sidebar)).toEqual([["Reading", [ONE]]]);
    await act(async () => within(navigation).getByRole("button", { name: "Overview" }).click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/${ONE}`);
    expect(within(host).getByRole("textbox", { name: "Document title" })).toHaveProperty("value", "Overview");
  });

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
    expect(other?.textContent).toBe("Editing");
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
    // Move controls have names; the inventories below also rule out decorative
    // handles without relying on a styling marker that could be renamed.
    expect(sidebarControls(host).queryAllByLabelText(/^Move (document|group)/)).toHaveLength(0);
    expectNoExtraGroupChrome(host);
    for (const row of [current, other]) {
      // The navigation button is the whole row, with no separate handle.
      // Its exact text above also rules out a grip added inside the button.
      expect(row?.parentElement?.children).toHaveLength(1);
    }

    act(() => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle?.click());
    act(() => other?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/${TWO}`);
    expect(rows(host, 0)[1]?.getAttribute("aria-current")).toBe("page");
    expect(rows(host, 0)[0]?.getAttribute("aria-current")).toBeNull();
    expect(stored(peer)).toEqual([["Reading", [ONE, TWO]]]);
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
    expect(within(host).getByPlaceholderText("Untitled")).toHaveProperty("value", "Sync");
    expect(sections(host)).toHaveLength(0);
    expect(sidebarControls(host).getByText(/Nothing pinned yet/).textContent).toContain("Nothing pinned yet");

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

    // The open document's row shares the All-docs entry's `aria-current` state,
    // reaching the styling and a screen reader together. The navigation
    // entry is the discriminator: "current" has to mean the thing that is
    // open, not every row in the column.
    expect(rows(host, 0)[0]?.getAttribute("aria-current")).toBe("page");
    expect(
      // The still-open menu hides the shell; visible text identifies the
      // mounted navigation button even while its role/name is suppressed.
      sidebarControls(host).getByText("All documents").getAttribute("aria-current"),
    ).toBeNull();

    // And the same control is the way back out.
    act(() => documentAction("Unpin from sidebar")?.click());
    expect(readSidebar(peer)[0]?.docs).toEqual([]);
    expect(rowTitles(host, 0)).toEqual([]);
    openActions(host);
    expect(documentAction("Pin to sidebar")).not.toBeUndefined();
    // Unpinned is not deleted: the document is still open and still editable.
    expect(within(host).getByPlaceholderText("Untitled")).toHaveProperty("value", "Sync");
  });

  it("makes, renames and deletes groups in place", async () => {
    seedDirectory();
    const peer = peerOf(sidebarDoc());
    const host = await openApp(`/${WORKSPACE}`);

    act(() => sidebarControls(host).getByRole("button", { name: "+ New group" }).click());
    // Straight into its own name: the placeholder is not a decision.
    const field = sidebarControls(host).getByRole<HTMLInputElement>("textbox", { name: "Group name" });
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    // Replacing the sortable heading with a field must not make its section
    // an inherited disabled/pressed control containing editable descendants.
    // The unnamed section is the sortable wrapper whose inherited state matters.
    for (const element of [field, field.closest("section")]) {
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
    act(() => sidebarControls(host).getByRole("button", { name: "+ New group" }).click());
    act(() => press(sidebarControls(host).getByRole("textbox", { name: "Group name" }), "Escape"));
    expect(stored(peer)).toEqual([
      ["Reading", []],
      ["Elsewhere", []],
    ]);

    // Deleting takes the group and its pins — never the documents, which the
    // sidebar only ever held the uuids of.
    const remove = sidebarControls(host).getByRole<HTMLButtonElement>("button", { name: "Delete group Reading" });
    act(() => remove?.click());
    expect(groupNames(host)).toEqual(["Reading", "Elsewhere"]);
    act(() => within(screen.getByRole("alertdialog", { name: "Delete group Reading?" })).getByRole("button", { name: "Delete group" }).click());
    expect(groupNames(host)).toEqual(["Elsewhere"]);
    expect(stored(peer)).toEqual([["Elsewhere", []]]);
    await waitFor(() => expect(document.activeElement).toBe(sidebarControls(host).getByRole("button", { name: "+ New group" })));
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
    act(() => sidebarControls(host).getByRole("button", { name: "Delete group Reading" }).click());
    expect(stored(peer)).toEqual([["Reading", [ONE, TWO]], ["Elsewhere", [THREE]]]);
    act(() => within(screen.getByRole("alertdialog", { name: "Delete group Reading?" })).getByRole("button", { name: "Delete group" }).click());
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
    act(() => sidebarControls(host).getByRole("button", { name: "Delete group Reading" }).click());
    const writes = vi.fn();
    sidebar.ydoc.on("update", writes);
    act(() => {
      sidebar.status = { ...LIVE, writable: false };
    });
    act(() => within(screen.getByRole("alertdialog", { name: "Delete group Reading?" })).getByRole("button", { name: "Delete group" }).click());
    const dialog = screen.getByRole("alertdialog", { name: "Delete group Reading?" });
    expect(dialog?.textContent).toContain("Delete unavailable");
    expect(dialog?.textContent).toContain("Nothing has been deleted");
    expect(stored(peer)).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    // Once the room publishes the loss, its delete trigger retires. Closing
    // must reach live navigation even though the first row is unavailable.
    act(() => {
      for (const listener of statusListeners.get(sidebar.room) ?? []) listener(sidebar.status);
    });
    await act(async () => {
      within(dialog).getByRole("button", { name: "Cancel" }).click();
    });
    expect(screen.queryByRole("alertdialog", { name: "Delete group Reading?" })).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(sidebarControls(host).getByRole("button", { name: "All documents" })));
  });

  it("collapses a group, and remembers it", async () => {
    seedDirectory();
    const sidebar = sidebarDoc();
    const reading = createGroup(sidebar, "Reading");
    pinDoc(sidebar, reading, ONE);

    const host = await openApp(`/${WORKSPACE}`);
    // This unnamed animation boundary remains mounted while its list is inert.
    const body = (): HTMLElement | null =>
      sections(host)[0]?.querySelector<HTMLElement>(".ub-group-body") ?? null;
    expect(groupToggle(host, 0)?.getAttribute("aria-expanded")).toBe("true");
    expect(body()?.dataset.collapsed).toBe("false");

    act(() => groupToggle(host, 0)?.click());
    expect(groupToggle(host, 0)?.getAttribute("aria-expanded")).toBe("false");
    expect(groupToggle(host, 0)?.textContent).toBe("Reading");
    expectNoExtraGroupChrome(host);
    // Still in the DOM — the transition is a CSS animation — and inert,
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
    // archive would take the pin with it.
    const directoryPeer = peerOf(directory);
    const sidebarPeer = peerOf(sidebar);

    const host = await openApp(`/${WORKSPACE}`);
    expect(rowTitles(host, 0)).toEqual(["Overview", "Editing"]);

    // ---- archived elsewhere: the tombstone arrives over the wire ----
    act(() => {
      tombstoneDirectoryEntry(directoryPeer, ONE);
    });
    // The title the stub still carries, marked — never an eight-character uuid.
    expect(rowTitles(host, 0)).toEqual(["Overviewarchived", "Editing"]);
    expect(host.querySelector(".ub-pin-label .ub-badge.ub-archived")?.textContent).toBe("archived");
    expect(within(host).getByLabelText("Sidebar").textContent ?? "").not.toContain(
      ONE.slice(0, 8),
    );
    // The pin is untouched. Local archiving unpins, but this archive came
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
    // A 34px row ellipsises anything longer than the 16rem column, so
    // the tooltip must offer the name rather than the uuid.
    // All four things a row can say, in one group.
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
      "Editingarchived",
      "Untitled",
      unknown.slice(0, 8),
    ]);
    // The tooltip retains the archived state and recovers the stub's whole UUID.
    expect(rowTooltips(host, 0)).toEqual([
      "Overview",
      "Editing · archived",
      "Untitled",
      unknown,
    ]);
  });
});

describe("settings areas follow the selected page and independent authority", () => {
  it.each(["general", "tags", "members"] as const)("keeps a pasted %s address while admin authority is pending", async (page) => {
    let confirm: (() => void) | undefined;
    const role = new Promise<void>((resolve) => { confirm = resolve; });
    settingsHub(async () => { await role; return { status: "ok", role: "admin" }; });
    const address = `/${WORKSPACE}/settings${page === "general" ? "" : `/${page}`}`;
    const host = await openApp(address);
    expect(window.location.pathname).toBe(address);
    expect(within(host).queryByRole("region", { name: "Workspace" })).toBeNull();
    expect(within(host).queryByRole("textbox")).toBeNull();
    await act(async () => confirm?.());
    await waitFor(() => expect(within(host).getByRole("heading", { level: 1 }).textContent)
      .toBe(page === "general" ? "General" : page === "tags" ? "Tags" : "Members"));
    expect(window.location.pathname).toBe(address);
    expect(within(host).getByRole("region", { name: "Workspace" })).toBeTruthy();
  });

  it.each(["", "/tags", "/members"])("sends a member's direct Workspace address %s to Preferences", async (suffix) => {
    let confirm: (() => void) | undefined;
    const role = new Promise<void>((resolve) => { confirm = resolve; });
    const calls = settingsHub(async () => { await role; return { status: "ok", role: "member" }; });
    const address = `/${WORKSPACE}/settings${suffix}`;
    const host = await openApp(address);
    expect(window.location.pathname).toBe(address);
    expect(within(host).queryByRole("heading", { level: 1 })).toBeNull();
    await act(async () => confirm?.());
    await waitFor(() => expect(window.location.pathname).toBe(`/${WORKSPACE}/settings/preferences`));
    expect(within(host).getByRole("heading", { level: 1, name: "Preferences" })).toBeTruthy();
    expect(within(host).getByRole("navigation", { name: "Personal settings" })).toBeTruthy();
    expect(within(host).queryByRole("region", { name: "Workspace" })).toBeNull();
    expect(within(host).queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(within(host).queryByRole("textbox", { name: "Main repository" })).toBeNull();
    expect(within(host).queryByRole("textbox", { name: "Create a tag" })).toBeNull();
    expect(calls.some((action) => action.operation === "list-members")).toBe(false);
  });

  it("groups Workspace before Hub without personal pages or its own footer entry", async () => {
    settingsHub(async () => ({ status: "ok", role: "admin" }), true);
    const host = await openApp(`/${WORKSPACE}/settings`);
    const settings = within(host).getByRole("navigation", { name: "Workspace settings" });
    const groups = within(settings).getAllByRole("region");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Workspace", "Hub"]);
    const entries = groups.flatMap((group) => within(group).getAllByRole("button"));
    expect(entries.map((entry) => entry.textContent)).toEqual(["General", "Tags", "Members", "Admins", "Workspaces"]);
    const icons = entries.map((entry) => entry.querySelector("svg")?.innerHTML);
    expect(icons.every((icon) => icon !== undefined)).toBe(true);
    expect(new Set(icons).size).toBe(5);
    expect(within(host).queryByRole("button", { name: "Workspace settings" })).toBeNull();
  });

  function openUserMenu(host: HTMLElement): void {
    act(() => within(host).getByRole("button", { name: /; preferences$/ })
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  }

  it("lets a member open personal pages and returns focus to the account menu", async () => {
    settingsHub(async () => ({ status: "ok", role: "member" }));
    const host = await openApp(`/${WORKSPACE}`);
    expect(within(host).queryByRole("button", { name: "Workspace settings" })).toBeNull();
    openUserMenu(host);
    act(() => screen.getByRole("menuitem", { name: "Devices" }).click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings/devices`);
    const personal = within(host).getByRole("navigation", { name: "Personal settings" });
    expect(within(personal).getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["User"]);
    expect(within(within(personal).getByRole("region", { name: "User" })).getAllByRole("button")
      .map((entry) => entry.textContent)).toEqual(["Preferences", "Devices"]);
    expect(within(personal).getByRole("button", { name: "Devices" }).getAttribute("aria-current")).toBe("page");
    expect(within(host).queryByRole("navigation", { name: "Workspace settings" })).toBeNull();
    expect(within(host).queryByRole("button", { name: "Workspace settings" })).toBeNull();
    act(() => within(personal).getByRole("button", { name: "Preferences" }).click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings/preferences`);
    act(() => within(personal).getByRole("button", { name: "Unnamed workspace" }).click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}`);
    expect(document.activeElement).toBe(within(host).getByRole("button", { name: /; preferences$/ }));
  });

  it.each(["local", "signed-out"] as const)("opens Preferences without Devices for a %s account", async (account) => {
    if (account === "signed-out") settingsHub(async () => ({ status: "forbidden" }), false, false);
    const host = await openApp(`/${WORKSPACE}`);
    openUserMenu(host);
    expect(screen.queryByRole("menuitem", { name: "Devices" })).toBeNull();
    act(() => screen.getByRole("menuitem", { name: "Preferences" }).click());
    const personal = within(host).getByRole("navigation", { name: "Personal settings" });
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings/preferences`);
    expect(within(personal).getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["User"]);
    expect(within(within(personal).getByRole("region", { name: "User" })).getAllByRole("button")
      .map((entry) => entry.textContent)).toEqual(["Preferences"]);
  });

  it("shows a member's workspace entry only after independent hub administration confirms it", async () => {
    let confirm: (() => void) | undefined;
    const role = new Promise<void>((resolve) => { confirm = resolve; });
    settingsHub(async () => ({ status: "ok", role: "member" }),
      async () => { await role; return { status: "ok", role: "admin" }; });
    const host = await openApp(`/${WORKSPACE}`);
    expect(within(host).queryByRole("button", { name: "Workspace settings" })).toBeNull();
    await act(async () => confirm?.());
    await act(async () => within(host).getByRole("button", { name: "Workspace settings" }).click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings/hub-admins`);
    const settings = within(host).getByRole("navigation", { name: "Workspace settings" });
    expect(within(settings).getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Hub"]);
    expect(within(settings).getByRole("button", { name: "Admins" }).getAttribute("aria-current")).toBe("page");
    expect(within(host).queryByRole("button", { name: "Workspace settings" })).toBeNull();
  });

  it("keeps an admin's Workspace settings entry in personal settings and switches areas", async () => {
    settingsHub(async () => ({ status: "ok", role: "admin" }), true);
    const host = await openApp(`/${WORKSPACE}/settings/preferences`);
    const personal = within(host).getByRole("navigation", { name: "Personal settings" });
    expect(within(personal).getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["User"]);
    act(() => within(host).getByRole("button", { name: "Workspace settings" }).click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings`);
    const settings = within(host).getByRole("navigation", { name: "Workspace settings" });
    expect(document.activeElement).toBe(within(settings).getByRole("button", { name: "Unnamed workspace" }));
    expect(within(settings).getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(within(settings).queryByRole("region", { name: "User" })).toBeNull();
  });

  function pane(host: HTMLElement, label: string): HTMLElement {
    return within(host).getByLabelText(label);
  }

  function expectDead(offscreen: HTMLElement): void {
    expect(offscreen.hasAttribute("inert")).toBe(true);
    expect(offscreen.getAttribute("aria-hidden")).toBe("true");
    // The controls, draggable rows and drop targets remain mounted for the CSS
    // transition, but every one is beneath the inert boundary for its whole
    // duration — transform and opacity are never the interaction boundary.
    // Hidden roles intentionally enumerate every mounted control, without a
    // name filter: aria-hidden suppresses accessible names on this boundary.
    const reachable = [
      ...within(offscreen).queryAllByRole("button", { hidden: true }),
      ...within(offscreen).queryAllByRole("textbox", { hidden: true }),
    ];
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
    const documents = pane(host, "Documents");
    const settings = pane(host, "Workspace settings");
    const settingsEntry = within(host).getByRole<HTMLButtonElement>("button", { name: "Workspace settings" });

    expectLive(documents);
    expectDead(settings);
    // Label queries count the mounted account controls, including hidden ones.
    expect(within(host).queryAllByLabelText(/; preferences$/)).toHaveLength(1);
    const accountControl = within(host).getByLabelText(/; preferences$/);
    expect(documents.contains(accountControl)).toBe(false);
    expect(settings.contains(accountControl)).toBe(false);

    settingsEntry?.focus();
    act(() => settingsEntry?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings`);
    // This assertion runs in the same task as the route change, while the
    // 180ms CSS transition is still in flight.
    expect(within(host).getByLabelText("Sidebar").getAttribute("data-mode")).toBe(
      "settings",
    );
    expectDead(documents);
    expectLive(settings);
    expect(within(host).queryAllByLabelText(/; preferences$/)).toHaveLength(1);
    expect(document.activeElement).toBe(
      within(settings).getByRole("button", { name: "Unnamed workspace" }),
    );
    expect(settings.textContent).toContain("Unnamed workspace");
    expect(within(settings).getByText("Workspace").textContent).toBe(
      "Workspace",
    );
    expect(within(settings).getByRole("button", { name: /./, current: "page" }).textContent).toContain(
      "General",
    );
    expect(within(host).getByRole("heading", { name: "General" }).textContent).toBe("General");
    expect(
      within(host).getByRole("button", { name: "Hide sidebar" }).getAttribute("aria-label"),
    ).toBe("Hide sidebar");

    const tags = within(settings).getByRole<HTMLButtonElement>("button", { name: "Tags" });
    act(() => tags?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/settings/tags`);
    expect(within(settings).getByRole("button", { name: /./, current: "page" }).textContent).toContain(
      "Tags",
    );
    expect(within(host).getByRole("heading", { name: "Tags" }).textContent).toBe("Tags");
    expect(rooms.has(settingsRoom(WORKSPACE))).toBe(true);

    act(() => within(settings).getByRole("button", { name: "Unnamed workspace" }).click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}`);
    expectDead(settings);
    expectLive(documents);
    expect(document.activeElement).toBe(within(host).getByRole("button", { name: "Workspace settings" }));
  });

  it("offers no settings destination when the address names no workspace", async () => {
    const host = await openApp("/not-a-workspace");
    expect(within(host).queryByRole("button", { name: "Workspace settings" })).toBeNull();
  });
});

/**
 * The fixed navigation section. Everything here asks one question: is it
 * chrome? Curation moves, is stored in `_sidebar` and can be dropped into;
 * chrome is in the same place on every page, and the destination that does
 * not exist yet is shown as an absent affordance rather than a broken link.
 */
describe("the sidebar's fixed navigation", () => {
  it("stands above the curation, pinned or not, and is not a drop target", async () => {
    seedDirectory();
    const host = await openApp(`/${WORKSPACE}`);

    // Nothing pinned yet: the section is already there, above the line that
    // says so — an empty sidebar still opens with somewhere to go.
    expect(columnOrder(host)).toEqual([
      "navigation",
      "empty",
      "creation",
    ]);
    expect(navRows(host).map((row) => row.textContent)).toEqual([
      "Dashboard",
      "All documents",
    ]);
    const creation = sidebarControls(host).getByRole("button", { name: "+ New page" }).parentElement as HTMLElement;
    expect(within(creation).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "+ New page",
      "+ New group",
    ]);
    expect(sidebarControls(host).queryByText("Navigation")).toBeNull();
    expect(sidebarControls(host).queryByRole("button", { name: "+ new doc" })).toBeNull();

    // A pin arrives and the groups appear under it; the section has not moved,
    // and the footer keeps the settings entry and account control.
    act(() => {
      const sidebar = sidebarDoc();
      pinDoc(sidebar, createGroup(sidebar, "Reading"), ONE);
    });
    expect(columnOrder(host)).toEqual([
      "navigation",
      "group",
      "creation",
    ]);
    // The footer is an unnamed layout wrapper. Its structural marker sets the
    // original absence scope; the named control and non-null check prove it exists.
    const footer = within(host).getByRole("button", { name: "Workspace settings" }).closest('[data-slot="sidebar-footer"]') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(within(footer).queryByRole("button", { name: "All documents" })).toBeNull();
    expect(within(footer).getByRole("button", { name: "Workspace settings" })).not.toBeNull();
    expect(within(footer).getByLabelText(/; preferences$/)).not.toBeNull();

    // Chrome, not curation: nothing in it can be dragged, and no drag of any
    // kind can land in it.
    const nav = sidebarControls(host).getByRole("button", { name: "All documents" }).closest("section");
    // Native draggable attributes are the interaction contract under test.
    expect(nav?.querySelectorAll("[draggable]")).toHaveLength(0);
  });

  it("shows Dashboard as unavailable, not as a link", async () => {
    seedDirectory();
    const doc = room(roomForDoc(WORKSPACE, THREE)).ydoc;
    initDoc(doc, { uuid: THREE, title: "Sync" });
    appendBlock(doc, { type: "paragraph", text: "how sync behaves" });

    const host = await openApp(`/${WORKSPACE}/${THREE}`);
    const dashboard = sidebarControls(host).getByRole<HTMLButtonElement>("button", { name: "Dashboard" });
    expect(dashboard.getAttribute("aria-disabled")).toBe("true");
    expect(dashboard.textContent).toBe("Dashboard");
    expect(dashboard.title).toBe("Coming soon");
    // Focusable on purpose: aria-disabled announces the unavailable page.
    expect(dashboard.disabled).toBe(false);
    act(() => dashboard.focus());
    expect(document.activeElement).toBe(dashboard);
    act(() => dashboard.click());

    expect(window.location.pathname).toBe(`/${WORKSPACE}/${THREE}`);
    expect(within(host).getByPlaceholderText("Untitled")).toHaveProperty("value", "Sync");
  });
});

describe("the sidebar's direct hub status", () => {
  async function directoryState(status: Partial<RoomStatus>, path = `/${WORKSPACE}`): Promise<HTMLElement> {
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
    return await openApp(path);
  }

  it.each([
    { protocolMismatch: { hub: 2, client: 1 } },
    { tokenMissing: true },
    { authFailed: true },
    { storeRefused: true },
  ])("shows a decorative dot for a refusal even while connected: %s", async (refusal) => {
    const host = await directoryState({ connected: true, synced: true, ...refusal });
    const dot = host.querySelector<HTMLElement>(".ub-workspace-location .ub-hub-problem");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("data-state")).toBe("offline");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.closest("[title]")).toBeNull();
    expect(dot?.matches("[tabindex], [role], [aria-label], [aria-labelledby]")).toBe(false);
    expect(dot?.textContent).toBe("");
    expect(dot?.previousElementSibling?.textContent).toBe("localhost:1234");
    expect(host.querySelector(".ub-directory-status")).toBeNull();
    const footer = host.querySelector('[data-slot="sidebar-footer"]');
    expect(footer?.firstElementChild?.textContent).toBe("Workspace settings");
    expect(footer?.children).toHaveLength(2);
  });

  it.each([
    { connected: true, synced: true },
    { connected: true, synced: false },
    { connected: true, synced: true, unsyncedChanges: 1 },
    { connected: false, synced: false, hasAnswered: false },
  ])("stays quiet during normal or initial connection: %s", async (status) => {
    const host = await directoryState(status);
    expect(host.querySelector(".ub-hub-problem")).toBeNull();
    expect(host.querySelector(".ub-directory-status")).toBeNull();
    expect(sidebarControls(host).queryByText(/^(directory synced|syncing…|offline)$/)).toBeNull();
  });

  it("shows an answered disconnect beside the host without save wording", async () => {
    const host = await directoryState({});
    const selector = sidebarControls(host).getByRole("button", { name: "Unnamed workspace localhost:1234" });
    expect(selector.querySelector(".ub-hub-problem")).not.toBeNull();
    expect(host.querySelector(".ub-directory-status")).toBeNull();
    expect(selector.textContent).not.toMatch(/Offline|saved|refused/);
  });

  it("does not turn the no-workspace fallback into an offline workspace", async () => {
    const host = await directoryState({}, "/not-a-workspace");
    expect(host.querySelector(".ub-hub-problem")).toBeNull();
    expect(host.querySelector(".ub-directory-status")).toBeNull();
  });

  it("tracks directory reconnect and refusal immediately", async () => {
    const host = await directoryState({ connected: true, synced: true });
    const directory = room(directoryRoom(WORKSPACE));
    function updateDirectory(patch: Partial<RoomStatus>): void {
      directory.status = { ...directory.status, ...patch };
      for (const listener of statusListeners.get(directory.room) ?? []) listener(directory.status);
    }
    expect(host.querySelector(".ub-hub-problem")).toBeNull();
    act(() => updateDirectory({ connected: false, synced: false, writable: false }));
    expect(host.querySelector(".ub-hub-problem")).not.toBeNull();
    act(() => updateDirectory({ authFailed: true }));
    expect(host.querySelector(".ub-hub-problem")).not.toBeNull();
    act(() => updateDirectory({ connected: true, authFailed: false }));
    expect(host.querySelector(".ub-hub-problem")).toBeNull();
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
    const pin = within(host).getAllByRole<HTMLButtonElement>("button", { name: /^Pin .+ to the sidebar unavailable while sidebar is not ready to write$/ })[0];

    expect(pin?.disabled).toBe(true);
    expect(pin?.getAttribute("aria-label")).toContain(
      "unavailable while sidebar is not ready to write",
    );
    expect(pin?.title).toContain("sidebar is not ready to write");
    act(() => pin?.click());
    expect(writes).not.toHaveBeenCalled();
    expect(stored(sidebar.ydoc)).toEqual([]);
    // Group creation retains its admission-only gate.
    expect(sidebarControls(host).getByRole<HTMLButtonElement>("button", { name: "+ New group" }).disabled).toBe(false);
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
        ? within(host).getAllByRole<HTMLButtonElement>("button", { name: /^Pin .+ to the sidebar$/ })[0]
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
  it("keeps page creation available and the footer quiet for a sidebar-only refusal", async () => {
    seedDirectory();
    const sidebar = room(sidebarRoom(WORKSPACE));
    createGroup(sidebar.ydoc, "Reading");
    sidebar.status = { ...LIVE, writable: false, storeRefused: true };
    const host = await openApp(`/${WORKSPACE}`);

    expect(sidebarControls(host).getByRole<HTMLButtonElement>("button", { name: "+ New page" }).disabled).toBe(false);
    const addGroup = sidebarControls(host).getByRole<HTMLButtonElement>("button", { name: "+ New group" });
    expect(addGroup.disabled).toBe(true);
    expect(addGroup.title).toBe("Group changes unavailable while the sidebar is offline");
    expect(sidebarControls(host).queryAllByLabelText(/^(Rename|Delete) group /)).toHaveLength(0);
    expect(sidebarControls(host).queryByText(/Sidebar changes unavailable/)).toBeNull();
    expect(host.querySelector(".ub-directory-status")).toBeNull();
  });

  it("makes directory creation and sidebar curation unavailable", async () => {
    roomStatus = { ...LIVE, connected: false, synced: false, writable: false };
    seedDirectory();
    createGroup(sidebarDoc(), "Reading");
    const host = await openApp(`/${WORKSPACE}`);
    const before = rooms.size;

    const create = sidebarControls(host).getByRole<HTMLButtonElement>("button", { name: "+ New page" });
    expect(create?.disabled).toBe(true);
    expect(create?.title).toContain("directory is read-only");
    expect(create?.textContent).toBe("+ New page");
    const listPin = within(host).getAllByRole<HTMLButtonElement>("button", { name: /^Pin .+ to the sidebar unavailable while sidebar is not ready to write$/ })[0];
    expect(listPin?.disabled).toBe(true);
    expect(listPin?.getAttribute("aria-label")).toContain(
      "unavailable while sidebar is not ready to write",
    );
    expect(sidebarControls(host).queryByText(/Sidebar changes unavailable/)).toBeNull();
    expect(sidebarControls(host).queryAllByLabelText(/^(Rename|Delete) group /)).toHaveLength(0);
    const addGroup = sidebarControls(host).getByRole<HTMLButtonElement>("button", { name: "+ New group" });
    expect(addGroup.disabled).toBe(true);
    expect(addGroup.title).toBe("Group changes unavailable while the sidebar is offline");

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
