/** The catalog-backed tag picker in the document identity line. */

import { act, renderSettled, type RenderResult } from "./react-render.js";
import { screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createTagCatalogEntry,
  directoryRoom,
  getDirectoryEntry,
  getMeta,
  isTagDeleted,
  initDoc,
  deleteTagCatalogEntry,
  roomForDoc,
  settingsRoom,
  setTags,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import * as config from "../src/config.js";

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

vi.mock("../src/collab/rooms.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/collab/rooms.js")>(),
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

let mounted: RenderResult | null = null;

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
  mounted = null;
  rooms.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  mounted = await renderSettled(node);
  return mounted.container;
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
  return within(host).queryByRole<HTMLButtonElement>("button", { name: "Edit tags" });
}

function search(): HTMLInputElement | null {
  return screen.queryByRole<HTMLInputElement>("searchbox", { name: "Search tags" });
}

function options(): HTMLButtonElement[] {
  const list = screen.queryByRole("listbox", { name: "Available tags" });
  return list === null ? [] : within(list).queryAllByRole<HTMLButtonElement>("option");
}

function option(name: string): HTMLButtonElement | undefined {
  const list = screen.queryByRole("listbox", { name: "Available tags" });
  return list === null ? undefined : within(list).queryByRole<HTMLButtonElement>("option", {
    name,
  }) ?? undefined;
}

describe("the document tag picker", () => {
  it.each([true, false])("keeps retired cache data read-only in a locally served browser, writable=%s", async (writable) => {
    const fix = documentFixture([TAGS.legacy]);
    fix.catalog.ydoc.getMap<string>("tag-identities").set(TAGS.legacy, "legacy");
    fix.catalog.ydoc.getMap<number>("tag-retired").set("legacy#old-client", 1);
    fix.catalog.status.writable = writable;
    vi.spyOn(config, "localServing").mockReturnValue({ workspace: WORKSPACE, remoteHubUrl: "wss://hub.example.test/ws", localOnly: false, rebound: false });
    const before = Y.encodeStateAsUpdate(fix.catalog.ydoc);
    const host = await openApp();
    expect(host.textContent).not.toContain("legacy (retired)");
    expect(Y.encodeStateAsUpdate(fix.catalog.ydoc)).toEqual(before);
    expect(isTagDeleted(fix.catalog.ydoc, TAGS.legacy)).toBe(false);
  });

  it.each([false, true])("a direct hub browser migrates only a writable hydrated catalog, writable=%s", async (writable) => {
    const fix = documentFixture([TAGS.legacy]);
    fix.catalog.ydoc.getMap<string>("tag-identities").set(TAGS.legacy, "legacy");
    fix.catalog.ydoc.getMap<number>("tag-retired").set("legacy#old-client", 1);
    fix.catalog.status.writable = writable;
    const before = Y.encodeStateAsUpdate(fix.document.ydoc);
    await openApp();
    expect(isTagDeleted(fix.catalog.ydoc, TAGS.legacy)).toBe(writable);
    expect(Y.encodeStateAsUpdate(fix.document.ydoc)).toEqual(before);
  });

  it("cleans deleted references on an explicit permitted title write, never on attachment or a synthetic local update", async () => {
    const fix = documentFixture([TAGS.legacy]);
    addCatalogTags(fix.catalog.ydoc, ["legacy"]);
    deleteTagCatalogEntry(fix.catalog.ydoc, TAGS.legacy);
    const before = Y.encodeStateAsUpdate(fix.document.ydoc);
    const host = await openApp();
    expect(Y.encodeStateAsUpdate(fix.document.ydoc)).toEqual(before);
    act(() => appendBlock(fix.document.ydoc, { type: "paragraph", text: "Synthetic local repair" }));
    expect(getMeta(fix.document.ydoc).tags).toEqual([TAGS.legacy]);
    const title = within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => { setter?.call(title, "A person changed this title"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(getMeta(fix.document.ydoc).tags).toEqual([]);
  });

  it("keeps deleted references when the directory archives before the title handler rerenders", async () => {
    const fix = documentFixture([TAGS.legacy]);
    addCatalogTags(fix.catalog.ydoc, ["legacy"]);
    deleteTagCatalogEntry(fix.catalog.ydoc, TAGS.legacy);
    const host = await openApp();
    const title = within(host).getByRole<HTMLTextAreaElement>("textbox", { name: "Document title" });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      tombstoneDirectoryEntry(fix.directory.ydoc, UUID);
      setter?.call(title, "A stale title control");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(getMeta(fix.document.ydoc).tags).toEqual([TAGS.legacy]);
  });

  it("renders assigned tags as pills and lists a short catalog with no search field", async () => {
    const fix = documentFixture([TAGS.sync]);
    addCatalogTags(fix.catalog.ydoc, ["sync", "billing", "mcp"]);
    const host = await openApp();

    expect(picker(host)?.textContent).toContain("sync");
    // Pill wrappers have no role/name; count all of them, including unexpected labels.
    expect(host.querySelectorAll(".ub-tag")).toHaveLength(1);
    expect(within(host).queryByRole("button", { name: "Remove tag sync" })).toBeNull();
    expect(within(host).queryByText(/^(?:Product|Decision)(?: · .+)?$/)).toBeNull();
    // With no group tag on this fixture, neither lifecycle nor group badges
    // have any visible label to draw.
    expect(within(host).queryByText(/^(?:Product|Decision|Features)(?: · .+)?$/)).toBeNull();
    // The decorative chevron has no accessible handle; witness its presence
    // with the same query used by the read-only absence assertions below.
    expect(host.querySelector(".ub-tag-chevron")).not.toBeNull();

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

  it("offers search from ten existing entries and stops filtering when the count falls", async () => {
    const fix = documentFixture([TAGS.legacy]);
    addManyTags(fix.catalog.ydoc, 9);
    addCatalogTags(fix.catalog.ydoc, ["legacy"]);
    const host = await openApp();
    click(picker(host));
    expect(options()).toHaveLength(10);
    expect(document.activeElement).toBe(search());
    act(() => typeInto(search(), "topic-03"));
    expect(options().map((entry) => entry.textContent?.trim())).toEqual(["topic-03"]);
    act(() => deleteTagCatalogEntry(fix.catalog.ydoc, TAGS.legacy));
    expect(search()).toBeNull();
    expect(options()).toHaveLength(9);
    expect(getMeta(fix.document.ydoc).tags).toEqual([TAGS.legacy]);
  });

  it("distinguishes a hydrated empty catalog from a catalog that has not arrived", async () => {
    documentFixture();
    const host = await openApp();
    expect(picker(host)?.textContent).toContain("Add tags");
    expect(picker(host)?.querySelector(".ub-tag-placeholder svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".ub-tag-chevron")).toBeNull();
    click(picker(host));
    expect(screen.getByText("No tags available.").textContent).toBe(
      "No tags available.",
    );
    // Nothing in the panel can take the keyboard, so the trigger keeps it
    // rather than letting focus fall to the page body.
    expect(document.activeElement).toBe(picker(host));

    mounted?.unmount();
    mounted = null;
    rooms.clear();

    const waiting = documentFixture();
    waiting.catalog.status.hasReceivedServerState = false;
    const waitingHost = await openApp();
    expect(within(waitingHost).getByText("Loading tags…").textContent).toContain(
      "Loading tags…",
    );
    expect(picker(waitingHost)).toBeNull();
  });

  it("preserves delayed references and concurrent tags while a permitted toggle cleans deletions", async () => {
    const unseen = "90000000-0000-4000-8000-000000000009";
    const fix = documentFixture([TAGS.sync, TAGS.legacy, unseen]);
    addCatalogTags(fix.catalog.ydoc, ["auth", "billing", "legacy", "sync"]);
    deleteTagCatalogEntry(fix.catalog.ydoc, TAGS.legacy);
    const documentPeer = peerOf(fix.document.ydoc);
    const directoryPeer = peerOf(fix.directory.ydoc);
    const before = Y.encodeStateAsUpdate(fix.document.ydoc);
    const host = await openApp();
    expect(picker(host)?.textContent).not.toContain("legacy");
    expect(Y.encodeStateAsUpdate(fix.document.ydoc)).toEqual(before);
    click(picker(host));
    expect(option("legacy")).toBeUndefined();
    const auth = option("auth");
    act(() => {
      setTags(documentPeer, [TAGS.billing, TAGS.legacy, TAGS.sync, unseen]);
      auth?.click();
    });
    expect(getMeta(fix.document.ydoc).tags).toEqual([TAGS.auth, TAGS.billing, TAGS.sync, unseen].sort());
    expect(getMeta(documentPeer).tags).toEqual(getMeta(fix.document.ydoc).tags);
    expect(getDirectoryEntry(directoryPeer, UUID)?.tags).toEqual(getMeta(fix.document.ydoc).tags);
    const tagsBeforeRefusal = getMeta(fix.document.ydoc).tags;
    fix.document.status.writable = false;
    click(option("auth"));
    expect(getMeta(fix.document.ydoc).tags).toEqual(tagsBeforeRefusal);
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
    expect(screen.queryByRole("listbox", { name: "Available tags" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows only existing archived assignments without cleaning stored references", async () => {
    const fix = documentFixture([TAGS.legacy, TAGS.sync]);
    addCatalogTags(fix.catalog.ydoc, ["legacy", "sync"]);
    deleteTagCatalogEntry(fix.catalog.ydoc, TAGS.legacy);
    tombstoneDirectoryEntry(fix.directory.ydoc, UUID);
    const host = await openApp();

    expect(within(host).queryByText(/legacy/)).toBeNull();
    expect(getMeta(fix.document.ydoc).tags).toContain(TAGS.legacy);
    expect(within(host).getByText("sync").textContent).toContain("sync");
    // The same pills as the writable header draws, and nothing to open.
    // Pill wrappers have no role/name; count all of them, including unexpected labels.
    expect(host.querySelectorAll(".ub-tag")).toHaveLength(1);
    expect(picker(host)).toBeNull();
    expect(host.querySelector(".ub-tag-chevron")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("leaves a read-only header with no tags non-interactive", async () => {
    const fix = documentFixture();
    addCatalogTags(fix.catalog.ydoc, ["auth", "sync"]);
    tombstoneDirectoryEntry(fix.directory.ydoc, UUID);
    const host = await openApp();

    // No "Add tags" fallback and no chevron: an edit this header would refuse.
    expect(within(host).getByText("No tags").textContent).toBe("No tags");
    expect(host.querySelector(".ub-tag-chevron")).toBeNull();
    expect(picker(host)).toBeNull();
  });
});
