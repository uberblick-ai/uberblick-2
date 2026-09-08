/** The catalog-backed tag picker in the document identity line (#509). */

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createTagCatalogEntry,
  directoryRoom,
  getDirectoryEntry,
  getMeta,
  initDoc,
  retireTagCatalogEntry,
  roomForDoc,
  settingsRoom,
  setTags,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";

const TAGS = {
  auth: "10000000-0000-4000-8000-000000000001",
  billing: "10000000-0000-4000-8000-000000000002",
  legacy: "10000000-0000-4000-8000-000000000003",
  mcp: "10000000-0000-4000-8000-000000000004",
  sync: "10000000-0000-4000-8000-000000000005",
} as const;

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
    status: { ...LIVE },
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(connection.status);
      return () => {};
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

let mounted: { root: Root; host: HTMLElement } | null = null;

beforeEach(() => {
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
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
  rooms.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(node));
  return host;
}

async function openApp(): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/${WORKSPACE}/${UUID}`);
  return await mount(<App />);
}

function documentFixture(tags: readonly string[] = []): {
  document: RoomConnection;
  directory: RoomConnection;
  catalog: RoomConnection;
} {
  const document = room(roomForDoc(WORKSPACE, UUID));
  const directory = room(directoryRoom(WORKSPACE));
  const catalog = room(settingsRoom(WORKSPACE));
  initDoc(document.ydoc, { uuid: UUID, title: "Sync and offline", tags: [...tags] });
  appendBlock(document.ydoc, { type: "paragraph", text: "how sync behaves" });
  upsertDirectoryEntry(directory.ydoc, {
    uuid: UUID,
    title: "Sync and offline",
    tags: [...tags],
  });
  return { document, directory, catalog };
}

function addCatalogTags(
  catalog: Y.Doc,
  names: ReadonlyArray<keyof typeof TAGS>,
): void {
  for (const name of names) createTagCatalogEntry(catalog, name, TAGS[name]);
}

/**
 * `count` further active entries, named and identified deterministically, so a
 * test can stand either side of the panel's ten-entry search threshold.
 */
function addManyTags(catalog: Y.Doc, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(2, "0");
    createTagCatalogEntry(
      catalog,
      `topic-${suffix}`,
      `20000000-0000-4000-8000-0000000000${suffix}`,
    );
  }
}

function click(element: Element | null | undefined): void {
  act(() => (element as HTMLElement | null | undefined)?.click());
}

function typeInto(input: HTMLInputElement | null, value: string): void {
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  native?.call(input, value);
  input?.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(
  element: Element | null,
  key: string,
  init: KeyboardEventInit = {},
): void {
  element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

function picker(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('button[aria-label="Edit tags"]');
}

function search(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search tags"]');
}

function options(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".ub-tag-option")];
}

function option(name: string): HTMLButtonElement | undefined {
  return options().find((candidate) => candidate.textContent?.includes(name));
}

describe("the document tag picker", () => {
  it("renders assigned tags as pills and lists a short catalog with no search field", async () => {
    const fix = documentFixture([TAGS.sync]);
    addCatalogTags(fix.catalog.ydoc, ["sync", "billing", "mcp"]);
    const host = await openApp();

    expect(picker(host)?.textContent).toContain("sync");
    expect(host.querySelectorAll(".ub-tag")).toHaveLength(1);
    expect(host.querySelector(".ub-tag-x")).toBeNull();
    expect(host.querySelector(".ub-lifecycle-badge")).toBeNull();
    expect(host.querySelector(".ub-badge")).toBeNull();

    click(picker(host));
    // Three entries is below the threshold, so the panel is a list and nothing
    // else — there is no field to type into and none to filter through.
    expect(search()).toBeNull();
    expect(options().map((entry) => entry.textContent?.trim())).toEqual([
      "billing",
      "mcp",
      "✓sync",
    ]);
    expect(option("sync")?.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).not.toContain("Create");
  });

  it("offers the search field only from ten entries, and takes its filter away with it", async () => {
    const fix = documentFixture([TAGS.legacy]);
    addManyTags(fix.catalog.ydoc, 9);
    addCatalogTags(fix.catalog.ydoc, ["legacy"]);
    retireTagCatalogEntry(fix.catalog.ydoc, TAGS.legacy);
    const host = await openApp();

    // Nine active entries plus the one assigned retired entry: ten.
    click(picker(host));
    expect(options()).toHaveLength(10);
    expect(document.activeElement).toBe(search());
    expect(document.querySelector(".ub-tag-search-icon")).not.toBeNull();

    // Composition keystrokes are not navigation; a real ArrowDown enters the list.
    act(() => press(search(), "Enter"));
    expect(getMeta(fix.document.ydoc).tags).toEqual([TAGS.legacy]);
    act(() => press(search(), "ArrowDown", { isComposing: true }));
    expect(document.activeElement).toBe(search());
    act(() => press(search(), "ArrowDown"));
    expect(document.activeElement?.textContent).toContain("legacy");

    act(() => typeInto(search(), "topic-03"));
    expect(options().map((entry) => entry.textContent?.trim())).toEqual([
      "topic-03",
    ]);
    act(() => typeInto(search(), "missing"));
    expect(options()).toEqual([]);
    expect(document.querySelector(".ub-tag-empty")?.textContent).toBe(
      "No matching tags.",
    );

    // The 10-to-9 case: searching out the retired entry and removing it drops
    // the count below the threshold. The field goes, the text left in it stops
    // hiding the other nine, and the focus its option held lands in the list.
    act(() => typeInto(search(), "legacy"));
    click(option("legacy"));
    expect(getMeta(fix.document.ydoc).tags).toEqual([]);
    expect(search()).toBeNull();
    expect(options().map((entry) => entry.textContent?.trim())).toEqual([
      "topic-00",
      "topic-01",
      "topic-02",
      "topic-03",
      "topic-04",
      "topic-05",
      "topic-06",
      "topic-07",
      "topic-08",
    ]);
    expect(document.activeElement).toBe(options()[0]);
  });

  it("distinguishes a hydrated empty catalog from a catalog that has not arrived", async () => {
    documentFixture();
    const host = await openApp();
    expect(picker(host)?.textContent).toContain("Add tags");
    click(picker(host));
    expect(document.querySelector(".ub-tag-empty")?.textContent).toBe(
      "No tags available.",
    );
    // Nothing in the panel can take the keyboard, so the trigger keeps it
    // rather than letting focus fall to the page body.
    expect(document.activeElement).toBe(picker(host));

    act(() => mounted?.root.unmount());
    mounted?.host.remove();
    mounted = null;
    rooms.clear();

    const waiting = documentFixture();
    waiting.catalog.status.hasReceivedServerState = false;
    const waitingHost = await openApp();
    expect(waitingHost.querySelector(".ub-tags")?.textContent).toContain(
      "Loading tags…",
    );
    expect(picker(waitingHost)).toBeNull();
  });

  it("toggles identities on live state, preserves concurrent tags, and removes retired tags", async () => {
    const fix = documentFixture([TAGS.sync, TAGS.legacy]);
    addCatalogTags(fix.catalog.ydoc, ["auth", "billing", "legacy", "sync"]);
    retireTagCatalogEntry(fix.catalog.ydoc, TAGS.legacy);
    const documentPeer = peerOf(fix.document.ydoc);
    const directoryPeer = peerOf(fix.directory.ydoc);
    const host = await openApp();

    expect(picker(host)?.textContent).toContain("legacy (retired)");
    click(picker(host));
    expect(option("legacy")?.getAttribute("aria-selected")).toBe("true");
    expect(option("legacy")?.textContent).toContain("retired");

    // One act keeps the render stale while the Y.Doc is already current.
    const auth = option("auth");
    act(() => {
      setTags(documentPeer, [TAGS.billing, TAGS.legacy, TAGS.sync]);
      auth?.click();
    });
    expect(getMeta(fix.document.ydoc).tags).toEqual(
      [TAGS.auth, TAGS.billing, TAGS.legacy, TAGS.sync].sort(),
    );
    expect(getMeta(documentPeer).tags).toEqual(getMeta(fix.document.ydoc).tags);
    expect(getDirectoryEntry(directoryPeer, UUID)?.tags).toEqual(
      getMeta(fix.document.ydoc).tags,
    );

    option("legacy")?.focus();
    expect(document.activeElement).toBe(option("legacy"));
    click(option("legacy"));
    expect(getMeta(fix.document.ydoc).tags).not.toContain(TAGS.legacy);
    expect(option("legacy")).toBeUndefined();
    // The option that held focus has unmounted; below the threshold there is no
    // search field to fall back to, so the list's first option takes it.
    expect(document.activeElement).toBe(options()[0]);

    // The button can be stale too; the write boundary reads live writability.
    const before = getMeta(fix.document.ydoc).tags;
    fix.document.status.writable = false;
    click(option("auth"));
    expect(getMeta(fix.document.ydoc).tags).toEqual(before);
  });

  it("is operable from the keyboard with no field to enter the list through", async () => {
    const fix = documentFixture();
    addCatalogTags(fix.catalog.ydoc, ["auth", "billing", "mcp"]);
    const host = await openApp();
    const trigger = picker(host);
    click(trigger);

    // Opening lands on the first option, because there is nothing else to land on.
    expect(search()).toBeNull();
    expect(document.activeElement?.textContent).toContain("auth");
    act(() => press(document.activeElement, "ArrowDown"));
    expect(document.activeElement?.textContent).toContain("billing");
    act(() => press(document.activeElement, "End"));
    expect(document.activeElement?.textContent).toContain("mcp");
    act(() => press(document.activeElement, "Home"));
    expect(document.activeElement?.textContent).toContain("auth");
    act(() => press(document.activeElement, "ArrowUp"));
    expect(document.activeElement?.textContent).toContain("mcp");
    click(document.activeElement);
    expect(getMeta(fix.document.ydoc).tags).toContain(TAGS.mcp);

    await act(async () => press(document.activeElement, "Escape"));
    expect(document.querySelector(".ub-tag-picker-panel")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows archived assignments read-only, including retired names", async () => {
    const fix = documentFixture([TAGS.legacy, TAGS.sync]);
    addCatalogTags(fix.catalog.ydoc, ["legacy", "sync"]);
    retireTagCatalogEntry(fix.catalog.ydoc, TAGS.legacy);
    tombstoneDirectoryEntry(fix.directory.ydoc, UUID);
    const host = await openApp();

    expect(host.querySelector(".ub-tags")?.textContent).toContain("legacy (retired)");
    expect(host.querySelector(".ub-tags")?.textContent).toContain("sync");
    // The same pills as the writable header draws, and nothing to open.
    expect(host.querySelectorAll(".ub-tag")).toHaveLength(2);
    expect(picker(host)).toBeNull();
    expect(host.querySelector(".ub-tag-chevron")).toBeNull();
    expect(document.querySelector(".ub-tag-option")).toBeNull();
  });

  it("leaves a read-only header with no tags non-interactive", async () => {
    const fix = documentFixture();
    addCatalogTags(fix.catalog.ydoc, ["auth", "sync"]);
    tombstoneDirectoryEntry(fix.directory.ydoc, UUID);
    const host = await openApp();

    // No "Add tags" fallback and no chevron: an edit this header would refuse.
    expect(host.querySelector(".ub-tags")?.textContent).toBe("No tags");
    expect(host.querySelector(".ub-tag-chevron")).toBeNull();
    expect(picker(host)).toBeNull();
  });
});
