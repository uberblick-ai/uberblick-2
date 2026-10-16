/**
 * The document list: the corpus journey's one surface.
 *
 * One claim: **the list is the directory doc, rendered.** So the rows are
 * asserted against what a *peer* replica of the `_directory` room holds — the
 * same reading `list_docs` produces — rather than against anything this client
 * did, and a remote create, rename or description is driven by writing to that
 * peer. A listing that agreed with local history but not with the directory
 * would be a second corpus, which is the one thing discovery cannot be.
 *
 * Type and topic-state filters derive from directory caches. Text searches
 * supply ranked record UUIDs through an injected local search client; the list
 * still reads row content from the directory without opening document rooms.
 *
 * The app is mounted whole over shared Y.Docs (the `sidebar.test.tsx`
 * harness): a room is a plain Y.Doc, because the transport is not what is
 * under test.
 *
 * Timestamp structure is asserted through each row's `<time dateTime>`; where
 * a label comes from `Intl`, the expectation uses the same locale-sensitive
 * formatter rather than hard-coding one locale's punctuation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { act, renderSettled, type RenderResult } from "./react-render.js";
import type { ReactNode } from "react";
import * as Y from "yjs";
import {
  appendBlock,
  createGroup,
  createTagCatalogEntry,
  directoryRoom,
  getDirectoryMap,
  initDoc,
  listDirectory,
  pinDoc,
  readSidebar,
  restoreDirectoryEntry,
  roomForDoc,
  sidebarRoom,
  settingsRoom,
  setKind,
  setStatus,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { allPath, canonicalPath, parseRoute } from "../src/ui/route.js";
import { DocumentList, INITIAL_DOCUMENT_LIST_STATE, sortDirectory } from "../src/shell/DocumentList.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { formatTimestamp } from "../src/ui/timestamps.js";
import * as config from "../src/config.js";
import * as documentSearch from "../src/shell/document-search.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const ONE = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const TWO = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";
const THREE = "7c2e5a11-3f80-4d66-b1a9-8e4d2c6f0a55";
const GONE = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const FOUR = "3b8a52d4-12c7-4c8f-9a61-9f18e35d7c2a";

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
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(LIVE);
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

/** A fresh in-memory Storage — see `sidebar.test.tsx` for why jsdom's is not it. */
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
});

afterEach(() => {
  mounted = null;
  rooms.clear();
  vi.restoreAllMocks();
});

function unmount(): void {
  mounted?.unmount();
  mounted = null;
}

async function mount(node: ReactNode): Promise<HTMLElement> {
  mounted = await renderSettled(node);
  return mounted.container;
}

async function openApp(path: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  return await mount(<App />);
}

function directoryDoc(): Y.Doc {
  return room(directoryRoom(WORKSPACE)).ydoc;
}

function sidebarDoc(): Y.Doc {
  return room(sidebarRoom(WORKSPACE)).ydoc;
}

function documentTable(host: HTMLElement): HTMLElement {
  return within(host).getByRole("table", { hidden: true });
}

function openButtons(host: HTMLElement): HTMLButtonElement[] {
  // Inventories include every mounted row, including hidden rows.
  return within(documentTable(host)).queryAllByRole("rowheader", { hidden: true }).map(
    (header) => within(header).getByRole<HTMLButtonElement>("button", { hidden: true }),
  );
}

/** The title is the first child; the button's full name also carries metadata. */
function rowTitles(host: HTMLElement): string[] {
  return openButtons(host).map((button) => button.firstChild?.textContent ?? "");
}

/** The uuid each row opens, which is what a row is when two share a title. */
function rowUuids(host: HTMLElement): string[] {
  return openButtons(host).map(
    (node) => node.getAttribute("title") ?? "",
  );
}

function lifecycleBadges(host: HTMLElement): HTMLElement[] {
  return within(documentTable(host)).queryAllByText(/^(?:Product|Decision)(?: · .+)?$/);
}

function pinUnavailable(host: HTMLElement): HTMLElement | null {
  return within(host).queryByText(
    "Pin changes unavailable while the sidebar is not ready to write.",
  );
}

/** Change a controlled input through the native setter, like a keystroke. */
function typeInto(input: HTMLInputElement, value: string): void {
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  native?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function filter(host: HTMLElement): HTMLInputElement {
  return within(host).getByRole<HTMLInputElement>("searchbox", {
    name: "Search",
  });
}

function localSearch(answers: Readonly<Record<string, readonly string[]>>) {
  const serving = { workspace: WORKSPACE, remoteHubUrl: null, rebound: false };
  const client = {
    search: vi.fn(async (query: string) => [...(answers[query] ?? [])]),
    status: async () => ({ caughtUp: true, rooms: {} }),
  };
  vi.spyOn(config, "localServing").mockReturnValue(serving);
  vi.spyOn(documentSearch, "createDocumentSearchClient").mockReturnValue(client);
  return client.search;
}

async function traverseHistory(direction: "back" | "forward"): Promise<void> {
  await act(async () => {
    const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true }));
    window.history[direction]();
    await popped;
  });
}

function entry(over: Partial<DirectoryEntry> & { uuid: string }): DirectoryEntry {
  return { title: "", tags: [], ...over };
}

describe("the All documents count", () => {
  function countLine(host: HTMLElement): string | null | undefined {
    return within(host).getByRole("heading", { name: "All documents" }).nextElementSibling?.textContent;
  }

  it("counts live regular documents and follows create, archive and restore", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Cache choice", kind: "decision", status: "open" });
    upsertDirectoryEntry(peer, { uuid: GONE, title: "Archived" });
    tombstoneDirectoryEntry(peer, GONE);
    const host = await openApp(allPath(WORKSPACE));
    expect(countLine(host)).toBe("1 document");

    await act(async () => upsertDirectoryEntry(peer, { uuid: THREE, title: "New document" }));
    expect(countLine(host)).toBe("2 documents");
    await act(async () => tombstoneDirectoryEntry(peer, ONE));
    expect(countLine(host)).toBe("1 document");
    await act(async () => restoreDirectoryEntry(peer, ONE));
    expect(countLine(host)).toBe("2 documents");
    await act(async () => {
      tombstoneDirectoryEntry(peer, ONE);
      tombstoneDirectoryEntry(peer, THREE);
    });
    expect(countLine(host)).toBe("0 documents");
  });

  it("keeps the workspace count when search, type, tag and state filters change", async () => {
    const entries = [
      entry({ uuid: ONE, title: "Overview" }),
      entry({ uuid: TWO, title: "Editing" }),
      entry({ uuid: THREE, title: "Cache choice", kind: "decision", status: "open" }),
    ];
    const props = {
      connection: room(directoryRoom(WORKSPACE)), entries, groups: [],
      searchClient: { search: async () => [ONE, THREE] },
      onSelect: () => {}, onTogglePin: null,
    };
    const host = await mount(<DocumentList {...props} />);
    expect(countLine(host)).toBe("2 documents");
    await act(async () => typeInto(filter(host), "overview"));
    expect(rowTitles(host)).toEqual(["Overview"]);
    expect(countLine(host)).toBe("2 documents");
    await act(async () => within(host).getByRole("button", { name: "Decisions" }).click());
    expect(rowTitles(host)).toEqual(["Cache choice"]);
    expect(countLine(host)).toBe("2 documents");
    await act(async () => mounted?.rerender(<DocumentList {...props} state={{
      ...INITIAL_DOCUMENT_LIST_STATE, mode: "decision", stateFilter: "conflict", selectedTags: ["missing-tag"],
    }} />));
    expect(rowTitles(host)).toEqual([]);
    expect(countLine(host)).toBe("2 documents");
  });

  it("shows no number until directory state arrives and keeps it after disconnect", async () => {
    const waiting = { ...LIVE, connected: false, synced: false, hasReceivedServerState: false, hasAnswered: false };
    let publishStatus = (_next: RoomStatus): void => {};
    const connection = {
      ...room(directoryRoom(WORKSPACE)), status: waiting,
      onStatusChange: (listener: (next: RoomStatus) => void) => {
        publishStatus = listener;
        listener(waiting);
        return () => {};
      },
    } as unknown as RoomConnection;
    const host = await mount(<DocumentList
      connection={connection} entries={[entry({ uuid: ONE, title: "Overview" })]} groups={[]}
      searchClient={{ search: async () => [] }} onSelect={() => {}} onTogglePin={null}
    />);
    expect(countLine(host)).toBe("");
    await act(async () => publishStatus({ ...waiting, hasAnswered: true, storeRefused: true }));
    expect(countLine(host)).toBe("");
    await act(async () => publishStatus(LIVE));
    expect(countLine(host)).toBe("1 document");
    await act(async () => publishStatus({ ...LIVE, connected: false, synced: false }));
    expect(countLine(host)).toBe("1 document");
  });
});

describe("the shared timestamp rule", () => {
  const NOW = Date.UTC(2026, 7, 27, 12);
  const DAY = 24 * 60 * 60_000;
  const ago = (milliseconds: number): string =>
    new Date(NOW - milliseconds).toISOString();

  it.each([
    ["just now", new Date(NOW + 60_000).toISOString()],
    ["20 minutes ago", ago(20 * 60_000)],
    ["1 hour ago", ago(60 * 60_000)],
    ["1 day ago", ago(24 * 60 * 60_000)],
    ["2 days ago", ago(2 * 24 * 60 * 60_000)],
    ["1 week ago", ago(7 * 24 * 60 * 60_000)],
    ["4 weeks ago", ago(30 * DAY - 60_000)],
  ])("formats %s", (expected, iso) => {
    expect(formatTimestamp(iso, NOW)?.label).toBe(expected);
  });

  it("switches to a localized date at exactly 30 days", () => {
    const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
    for (const iso of [ago(30 * DAY), ago(90 * DAY)]) {
      expect(formatTimestamp(iso, NOW)).toEqual({
        label: format.format(Date.parse(iso)),
        dateTime: iso,
      });
    }
  });

  it.each([
    ["1 month ago", ago(30 * DAY)],
    ["3 months ago", ago(90 * DAY)],
    ["1 year ago", ago(365 * DAY)],
    ["6 years ago", ago(6 * 365 * DAY)],
  ])("keeps timeline dates relative as %s with exact hover", (label, iso) => {
    expect(formatTimestamp(iso, NOW, true)).toEqual({
      label,
      dateTime: iso,
      title: new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(Date.parse(iso)),
    });
  });

  it("keeps a recent absolute value on hover and refuses an unusable value", () => {
    const iso = ago(20 * 60_000);
    expect(formatTimestamp(iso, NOW)).toEqual({
      label: "20 minutes ago",
      dateTime: iso,
      title: new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(Date.parse(iso)),
    });
    expect(formatTimestamp("not-a-date", NOW)).toBeNull();
  });

  /**
   * The label is a function of the clock, and nothing moves the clock. A row
   * whose only change is getting older would otherwise still read "just now"
   * an hour later, because no directory update arrives to re-render it — so
   * the list repaints on its own, once a minute.
   */
  it("ages a row's label without anything else changing", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const host = await mount(
        <DocumentList
          connection={null}
          entries={[entry({ uuid: ONE, title: "Overview", updatedAt: NOW })]}
          groups={[]}
          onSelect={() => {}}
          onTogglePin={null}
        />,
      );
      const row = within(documentTable(host)).getByRole("row", { name: /^Overview / });
      // The time element and its machine value are the timestamp contract.
      const stamp = within(row).getByRole("time", { hidden: true });
      expect(stamp.tagName).toBe("TIME");
      const changed = (): string | undefined =>
        stamp.textContent ?? undefined;
      expect(changed()).toBe("just now");
      expect(stamp.getAttribute("dateTime")).toBe(
        new Date(NOW).toISOString(),
      );
      expect(stamp.getAttribute("title")).toBe(
        new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(NOW),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(changed()).toBe("1 minute ago");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the order", () => {
  it("puts the most recently changed first", () => {
    const titles = sortDirectory(
      [
        entry({ uuid: ONE, title: "Beta", updatedAt: 100 }),
        entry({ uuid: TWO, title: "Alpha", updatedAt: 300 }),
        entry({ uuid: THREE, title: "Gamma", updatedAt: 200 }),
      ],
      "changed",
      "descending",
    ).map((row) => row.title);
    expect(titles).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("puts documents with no usable stamp last in either changed direction", () => {
    // The stamps are optional by construction: a stub written before they
    // existed carries none, and "no answer" is not "very old". A stamp no
    // `Date` can hold is the same kind of no-answer — the stubs are written by
    // whichever replica had the clock, so a finite absurdity is a real state.
    const titles = sortDirectory(
      [
        entry({ uuid: ONE, title: "Beta", updatedAt: 100 }),
        entry({ uuid: GONE, title: "Zeta" }),
        entry({ uuid: "aaaa1111-2222-4333-8444-555566667777", title: "Aardvark" }),
        entry({
          uuid: "bbbb2222-3333-4444-8555-666677778888",
          title: "Skewed",
          updatedAt: Number.MAX_VALUE,
        }),
      ],
      "changed",
      "descending",
    ).map((row) => row.title);
    expect(titles).toEqual(["Beta", "Aardvark", "Skewed", "Zeta"]);

    const ascending = sortDirectory(
      [
        entry({ uuid: ONE, title: "Beta", updatedAt: 200 }),
        entry({ uuid: TWO, title: "Alpha", updatedAt: 100 }),
        entry({ uuid: THREE, title: "Gamma" }),
      ],
      "changed",
      "ascending",
    ).map((row) => row.title);
    expect(ascending).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("breaks ties by title, so a re-render never reshuffles the rows", () => {
    const tied = [
      entry({ uuid: ONE, title: "Second", updatedAt: 500 }),
      entry({ uuid: TWO, title: "First", updatedAt: 500 }),
    ];
    expect(sortDirectory(tied, "changed", "descending").map((row) => row.title)).toEqual(
      ["First", "Second"],
    );
  });

  /**
   * Unstamped-last is a rule about last changed alone. Title order that swept
   * the unstamped into a wall at the bottom would not be title order, and the
   * "no answer" the stamps are missing is carried by the row's dash in either.
   */
  it("uses the schema's replica-stable code-unit order for every row", () => {
    const entries = [
      entry({ uuid: ONE, title: "Same", updatedAt: 100 }),
      entry({ uuid: TWO, title: "Same" }),
      entry({ uuid: THREE, title: "Zebra", updatedAt: 300 }),
      entry({ uuid: GONE, title: "" }),
      entry({ uuid: "aaaa1111-2222-4333-8444-555566667777", title: "alpha" }),
      entry({ uuid: "bbbb2222-3333-4444-8555-666677778888", title: "Éclair" }),
    ];
    const directory = new Y.Doc();
    for (const row of entries) upsertDirectoryEntry(directory, row);

    const ordered = sortDirectory(entries, "title", "ascending");
    expect(ordered.map((row) => row.uuid)).toEqual([
      GONE,
      TWO,
      ONE,
      THREE,
      "aaaa1111-2222-4333-8444-555566667777",
      "bbbb2222-3333-4444-8555-666677778888",
    ]);
    expect(ordered).toEqual(listDirectory(directory));
    expect(sortDirectory(entries, "title", "descending").map((row) => row.uuid)).toEqual(
      [...ordered].reverse().map((row) => row.uuid),
    );
  });
});

/**
 * Column order applies to the complete directory when the search is empty.
 */
describe("choosing the order", () => {
  /** The order option that is on, read the way the screen shows it. */
  function activeOrder(host: HTMLElement): string | undefined {
    const column = within(documentTable(host)).getAllByRole("columnheader", { hidden: true })
      .find((header) => header.hasAttribute("aria-sort"));
    const button = column === undefined ? undefined : within(column).getByRole("button", { hidden: true });
    return button?.firstChild?.textContent ?? undefined;
  }

  function chooseOrder(host: HTMLElement, label: string): HTMLButtonElement {
    return within(documentTable(host)).getByRole<HTMLButtonElement>("button", { name: label });
  }

  function heading(host: HTMLElement, label: string): HTMLTableCellElement {
    return within(documentTable(host)).getByRole<HTMLTableCellElement>("columnheader", { name: label });
  }

  async function seeded(): Promise<{ host: HTMLElement; peer: Y.Doc }> {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Zebra", updatedAt: 300 });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Alpha", updatedAt: 100 });
    // No stamp at all: last in one order, alphabetical in the other, and a
    // dash in its row either way.
    upsertDirectoryEntry(peer, { uuid: THREE, title: "Middle" });
    return { host: await openApp(`/${WORKSPACE}`), peer };
  }

  it("is one sorted table and toggles either column without a second chooser", async () => {
    const { host } = await seeded();
    const table = documentTable(host);
    expect(table).not.toBeNull();
    expect(table.tagName).toBe("TABLE");
    // The semantic queries also verify the native table structure.
    expect(table.querySelectorAll("thead th")).toHaveLength(5);
    expect(table.querySelectorAll('tbody th[scope="row"]')).toHaveLength(3);
    expect(within(table).getAllByRole("columnheader", { hidden: true })).toHaveLength(5);
    expect(within(table).getAllByRole("rowheader", { hidden: true })).toHaveLength(3);
    expect(within(host).queryByRole("group", { name: "Order", hidden: true })).toBeNull();

    const title = heading(host, "Title");
    const changed = heading(host, "Changed");
    expect(rowTitles(host)).toEqual(["Zebra", "Alpha", "Middle"]);
    expect(activeOrder(host)).toBe("Changed");
    expect(changed.getAttribute("aria-sort")).toBe("descending");
    expect(within(changed).getByText("↓").textContent).toBe("↓");
    expect(title.hasAttribute("aria-sort")).toBe(false);
    expect(within(table).getAllByRole("columnheader", { hidden: true }).filter((header) => header.hasAttribute("aria-sort"))).toHaveLength(1);

    await act(async () => chooseOrder(host, "Title").click());
    expect(rowTitles(host)).toEqual(["Alpha", "Middle", "Zebra"]);
    expect(activeOrder(host)).toBe("Title");
    expect(title.getAttribute("aria-sort")).toBe("ascending");
    expect(within(title).getByText("↑").textContent).toBe("↑");
    expect(changed.hasAttribute("aria-sort")).toBe(false);

    // The unstamped row still says "no answer" rather than reading as a date.
    const middle = within(table).getByRole("row", { name: /^Middle / });
    expect(within(table).getAllByRole("time", { hidden: true })).toHaveLength(2);
    expect(within(middle).queryAllByRole("time", { hidden: true })).toHaveLength(0);
    expect(middle?.textContent).toContain("—");

    await act(async () => chooseOrder(host, "Title").click());
    expect(rowTitles(host)).toEqual(["Zebra", "Middle", "Alpha"]);
    expect(title.getAttribute("aria-sort")).toBe("descending");
    expect(within(title).getByText("↓").textContent).toBe("↓");

    await act(async () => chooseOrder(host, "Changed").click());
    expect(rowTitles(host)).toEqual(["Zebra", "Alpha", "Middle"]);
    expect(activeOrder(host)).toBe("Changed");
    expect(changed.getAttribute("aria-sort")).toBe("descending");

    await act(async () => chooseOrder(host, "Changed").click());
    expect(rowTitles(host)).toEqual(["Alpha", "Zebra", "Middle"]);
    expect(changed.getAttribute("aria-sort")).toBe("ascending");
    expect(within(changed).getByText("↑").textContent).toBe("↑");
  });

  it("keeps the chosen order when the directory changes", async () => {
    const { host, peer } = await seeded();
    await act(async () => chooseOrder(host, "Title").click());
    expect(rowTitles(host)).toEqual(["Alpha", "Middle", "Zebra"]);

    // The chosen order is the reader's; another client writing to the
    // directory does not reset it.
    await act(async () => {
      upsertDirectoryEntry(peer, { uuid: GONE, title: "Beta", updatedAt: 900 });
    });
    expect(activeOrder(host)).toBe("Title");
    expect(rowTitles(host)).toEqual(["Alpha", "Beta", "Middle", "Zebra"]);
  });

  it("reorders for a greater concurrent stamp whose whole entry loses", async () => {
    const directory = directoryDoc();
    directory.clientID = 2;
    upsertDirectoryEntry(directory, {
      uuid: ONE,
      title: "One",
      updatedAt: 100,
    });
    upsertDirectoryEntry(directory, {
      uuid: TWO,
      title: "Two",
      updatedAt: 500,
    });

    const peer = new Y.Doc();
    peer.clientID = 1;
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(directory));
    const host = await openApp(`/${WORKSPACE}`);
    expect(rowTitles(host)).toEqual(["Two", "One"]);

    // Keep the replicas apart while both stamp the same entry. Client 2's
    // whole object wins, but client 1 carries the greater timestamp candidate.
    await act(async () => {
      upsertDirectoryEntry(directory, {
        uuid: ONE,
        title: "One",
        updatedAt: 200,
      });
      upsertDirectoryEntry(peer, {
        uuid: ONE,
        title: "One",
        updatedAt: 900,
      });
    });
    expect(rowTitles(host)).toEqual(["Two", "One"]);

    await act(async () => {
      Y.applyUpdate(
        directory,
        Y.encodeStateAsUpdate(peer, Y.encodeStateVector(directory)),
      );
    });
    expect(
      (getDirectoryMap(directory).get(ONE) as { updatedAt?: number }).updatedAt,
    ).toBe(200);
    expect(rowTitles(host)).toEqual(["One", "Two"]);
  });
});

describe("the list", () => {
  it("is the directory's non-deleted set, at both corpus addresses", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Editing" });
    upsertDirectoryEntry(peer, { uuid: GONE, title: "Archived" });
    tombstoneDirectoryEntry(peer, GONE);

    // The first screen of a session: the workspace's own address.
    const first = await openApp(`/${WORKSPACE}`);
    expect(rowTitles(first)).toEqual(["Editing", "Overview"]);
    expect(window.location.pathname).toBe(`/${WORKSPACE}`);
    unmount();

    // And the listing's reserved address, which is a link somebody may hold.
    const host = await openApp(allPath(WORKSPACE));
    expect(rowTitles(host)).toEqual(["Editing", "Overview"]);
    // Discovery is the directory doc, and the list is that doc: rendering the
    // whole corpus opens no document room. (`_sidebar` is the shell's, for the
    // group a row is pinned in; `_settings` supplies the workspace name.)
    expect([...rooms.keys()].sort()).toEqual(
      [directoryRoom(WORKSPACE), sidebarRoom(WORKSPACE), settingsRoom(WORKSPACE)].sort(),
    );
    expect(parseRoute(`/${WORKSPACE}/all`, null)).toEqual({
      kind: "all",
      workspace: { uuid: WORKSPACE, segment: WORKSPACE },
    });
    expect(canonicalPath(parseRoute(`/${WORKSPACE}/ALL/`, null))).toBe(
      `/${WORKSPACE}/all`,
    );
  });

  it("shows the title, pinned group, catalog tags and age while leaving descriptions out", async () => {
    const peer = peerOf(directoryDoc());
    const catalog = room(settingsRoom(WORKSPACE)).ydoc;
    const product = createTagCatalogEntry(catalog, "product");
    const reference = createTagCatalogEntry(catalog, "reference");
    upsertDirectoryEntry(peer, {
      uuid: ONE,
      title: "Overview",
      tags: [product.id, reference.id],
      description: "What uberblick is, and what it deliberately is not.",
      updatedAt: Date.UTC(2026, 0, 3),
    });
    // Pinned by a second writer — an agent's `pin_doc` is these same calls.
    const sidebarPeer = peerOf(sidebarDoc());
    const reading = createGroup(sidebarPeer, "Reading");
    pinDoc(sidebarPeer, reading, ONE);

    const host = await openApp(`/${WORKSPACE}`);
    const row = within(documentTable(host)).getByRole("row", { name: /^Overview / });
    expect(within(row).getByText("Overview").textContent).toBe("Overview");
    expect(within(row).getByText("Reading").textContent).toBe("Reading");
    expect(within(row).getByRole("time", { hidden: true }).getAttribute("dateTime")).toBe(
      "2026-01-03T00:00:00.000Z",
    );
    expect(row?.textContent).not.toContain("deliberately is not");
    expect(within(row).getByRole("button", { name: "product" }).textContent).toBe("product");
    expect(within(row).getByRole("button", { name: "reference" }).textContent).toBe("reference");
    expect(within(row).getByText("Reading").closest("td")?.cellIndex).toBe(1);
    expect(within(row).getByRole("button", { name: "Overview" }).textContent).not.toContain("Reading");
  });

  it("names the group a document is pinned into while the list is open", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    const sidebarPeer = peerOf(sidebarDoc());
    const later = createGroup(sidebarPeer, "Later");

    const host = await openApp(`/${WORKSPACE}`);
    const row = within(documentTable(host)).getByRole("button", { name: "Overview" }).closest("tr")!;
    const group = (): string | null =>
      within(row).queryByText("Later")?.textContent ?? null;
    expect(group()).toBeNull();

    await act(async () => {
      pinDoc(sidebarPeer, later, ONE);
    });
    expect(group()).toBe("Later");
  });

  it("follows a remote create and a remote rename with nobody telling it", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });

    const host = await openApp(allPath(WORKSPACE));
    expect(rowTitles(host)).toEqual(["Overview"]);

    // A second client — another browser, or an agent's `create_doc` — writes to
    // the directory room. Nothing here is told anything.
    await act(async () => {
      upsertDirectoryEntry(peer, { uuid: TWO, title: "Annotations" });
    });
    expect(rowTitles(host)).toEqual(["Annotations", "Overview"]);

    await act(async () => {
      upsertDirectoryEntry(peer, { uuid: ONE, title: "Zebra" });
    });
    expect(rowTitles(host)).toEqual(["Annotations", "Zebra"]);
  });

  it("shows an age where the directory has a stamp and a dash where it has none", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, {
      uuid: ONE,
      title: "Stamped",
      updatedAt: Date.UTC(2026, 0, 3),
    });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Unstamped" });
    // One stub no `Date` can hold. Formatting it would throw, and a throw in a
    // cell would take the whole list with it.
    upsertDirectoryEntry(peer, {
      uuid: THREE,
      title: "Zskewed",
      updatedAt: Number.MAX_VALUE,
    });

    const host = await openApp(allPath(WORKSPACE));
    expect(rowTitles(host)).toEqual(["Stamped", "Unstamped", "Zskewed"]);
    const rows = within(documentTable(host)).getAllByRole("row", { hidden: true }).slice(1);
    expect(within(rows[0]!).getByRole("time", { hidden: true }).getAttribute("dateTime")).toBe(
      "2026-01-03T00:00:00.000Z",
    );
    expect(within(rows[0]!).getAllByRole("time", { hidden: true })).toHaveLength(1);
    expect(within(rows[1]!).queryAllByRole("time", { hidden: true })).toHaveLength(0);
    expect(rows[1]?.textContent).toContain("—");
    expect(within(rows[2]!).queryAllByRole("time", { hidden: true })).toHaveLength(0);
    expect(rows[2]?.textContent).toContain("—");
  });
});

describe("decision topics in the list", () => {
  const OTHER = "a8611441-cf83-4f59-8e44-b3ce5a9f571d";
  const ANOTHER = "a3b75cc9-c880-4511-9ac5-e2305788b5f4";

  function decision(uuid: string, title: string, over: Partial<DirectoryEntry> = {}): DirectoryEntry {
    return entry({ uuid, title, kind: "decision", status: "decided", ...over });
  }

  async function chooseDecisions(host: HTMLElement): Promise<void> {
    await act(async () => {
      within(within(host).getByRole("group", { name: "Document type" }))
        .getByRole<HTMLButtonElement>("button", { name: "Decisions" }).click();
    });
  }

  function topicRow(host: HTMLElement, uuid: string): HTMLElement {
    const row = openButtons(host).find((button) => button.title === uuid)?.closest("tr");
    if (row === undefined || row === null) throw new Error(`No topic row ${uuid}`);
    return row;
  }

  function stateFilter(host: HTMLElement): HTMLSelectElement {
    return within(host).getByRole<HTMLSelectElement>("combobox", { name: "Decision state" });
  }

  async function chooseState(host: HTMLElement, value: string): Promise<void> {
    await act(async () => {
      const select = stateFilter(host);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function open(entries: DirectoryEntry[], answers: Readonly<Record<string, readonly string[]>> = {}): Promise<HTMLElement> {
    const host = await mount(<DocumentList connection={room("decision-list")}
      searchClient={{ search: async (query) => [...(answers[query] ?? [])] }}
      entries={entries} groups={[]} onSelect={() => {}} onTogglePin={null} />);
    await chooseDecisions(host);
    return host;
  }

  it("lists one current answer per topic using the whole history's caches without joining records", async () => {
    const search = localSearch({ "pending proposal": [THREE], "stable answer": [TWO] });
    const peer = peerOf(directoryDoc());
    const records = [
      decision(ONE, "Original answer title", {
        createdAt: 1, updatedAt: 100, answerPreview: "The superseded answer.", commentCount: 2,
      }),
      decision(TWO, "Stable answer title", {
        topic: ONE, supersedes: ONE, createdAt: 2, updatedAt: 200,
        answerPreview: "Keep the current answer.", commentCount: 3,
      }),
      decision(THREE, "Pending proposal title", {
        topic: ONE, supersedes: TWO, status: "open", createdAt: 3, updatedAt: 300,
        answerPreview: "The unapproved replacement.", commentCount: 5,
      }),
      decision(FOUR, "Rejected proposal title", {
        topic: ONE, supersedes: TWO, status: "rejected", createdAt: 4, updatedAt: 400, commentCount: 7,
      }),
      decision(GONE, "Withdrawn proposal title", {
        topic: ONE, supersedes: FOUR, status: "withdrawn", createdAt: 5, updatedAt: 1000, commentCount: 11,
      }),
      decision(OTHER, "Alpha answer", { updatedAt: 900, commentCount: 0 }),
    ];
    for (const record of records) upsertDirectoryEntry(peer, record);

    const host = await openApp(allPath(WORKSPACE));
    await chooseDecisions(host);
    expect(rowTitles(host)).toEqual(["Stable answer title", "Alpha answer"]);
    expect(rowUuids(host)).toEqual([ONE, OTHER]);
    const row = topicRow(host, ONE);
    expect(within(row).getByText("Under review").textContent).toBe("Under review");
    expect(within(row).getByText("Keep the current answer.").textContent).toBe("Keep the current answer.");
    expect(row.textContent).not.toContain("unapproved replacement");
    expect(row.textContent).not.toContain("superseded answer");
    expect(within(row).getByText("28 comments").textContent).toBe("28 comments");
    expect(within(row).getByRole("time").getAttribute("dateTime")).toBe("1970-01-01T00:00:01.000Z");
    expect([...rooms.keys()].sort()).toEqual(
      [directoryRoom(WORKSPACE), sidebarRoom(WORKSPACE), settingsRoom(WORKSPACE)].sort(),
    );

    await act(async () => within(documentTable(host)).getByRole("button", { name: "Title" }).click());
    expect(rowTitles(host)).toEqual(["Alpha answer", "Stable answer title"]);
    await act(async () => typeInto(filter(host), "pending proposal"));
    expect(rowTitles(host)).toEqual(["Stable answer title"]);
    await act(async () => typeInto(filter(host), "stable answer"));
    expect(rowUuids(host)).toEqual([ONE]);
    expect(search.mock.calls.map(([query]) => query)).toEqual(["pending proposal", "stable answer"]);
    expect([...rooms.keys()].sort()).toEqual(
      [directoryRoom(WORKSPACE), sidebarRoom(WORKSPACE), settingsRoom(WORKSPACE)].sort(),
    );
  });

  it("omits unknown or null answer caches and an incomplete history count", async () => {
    const host = await open([
      decision(ONE, "No answer cached", { answerPreview: null, commentCount: 0 }),
      decision(TWO, "Older client", { commentCount: 1 }),
      decision(THREE, "Complete answer", { answerPreview: "Known answer.", commentCount: 2, createdAt: 1 }),
      decision(FOUR, "Uncounted history", {
        topic: THREE, supersedes: THREE, status: "withdrawn", createdAt: 2,
      }),
      decision(GONE, "Undecided topic", {
        status: "open", answerPreview: "An unapproved preview.", commentCount: 0,
      }),
    ]);
    expect(within(topicRow(host, ONE)).getByText("0 comments").textContent).toBe("0 comments");
    expect(within(topicRow(host, TWO)).getByText("1 comment").textContent).toBe("1 comment");
    expect(topicRow(host, THREE).textContent).toContain("Known answer.");
    expect(topicRow(host, THREE).textContent).not.toMatch(/\d+ comments?/);
    expect(documentTable(host).textContent).not.toContain("An unapproved preview.");
    expect(topicRow(host, GONE).textContent).toContain("Not yet decided");
  });

  it("uses the newest usable history stamp and places topics without one last", async () => {
    const host = await open([
      decision(ONE, "Alpha", { updatedAt: Number.MAX_VALUE, createdAt: 1 }),
      decision(TWO, "Pending title", {
        topic: ONE, supersedes: ONE, status: "open", updatedAt: 500, createdAt: 2,
      }),
      decision(THREE, "Zebra", { updatedAt: 400 }),
      decision(FOUR, "Before Alpha", { updatedAt: Number.NaN }),
      decision(GONE, "Absent stamp"),
    ]);
    expect(rowTitles(host)).toEqual(["Alpha", "Zebra", "Absent stamp", "Before Alpha"]);
    expect(within(topicRow(host, ONE)).getByRole("time").getAttribute("dateTime")).toBe("1970-01-01T00:00:00.500Z");
    expect(within(topicRow(host, FOUR)).queryByRole("time")).toBeNull();
    expect(within(topicRow(host, GONE)).queryByRole("time")).toBeNull();
    await act(async () => within(documentTable(host)).getByRole("button", { name: "Changed" }).click());
    expect(rowTitles(host)).toEqual(["Zebra", "Alpha", "Absent stamp", "Before Alpha"]);
  });

  it("filters shared states and changed approvals while combining with record search hits", async () => {
    const host = await open([
      decision(ONE, "Undecided", { status: "open", answerPreview: "Pending answer." }),
      decision(TWO, "Approved", { approvalChanged: true, answerPreview: "Approved answer." }),
      decision(THREE, "Agent recommendation", { agentStance: true, answerPreview: "Agent answer." }),
      decision(FOUR, "Answer under review", { agentStance: true, createdAt: 1, answerPreview: "Current stance." }),
      decision(OTHER, "Proposal under review", {
        topic: FOUR, supersedes: FOUR, status: "open", createdAt: 2,
        answerPreview: "Proposed stance.", approvalChanged: true,
      }),
      decision(GONE, "First conflicting title", {
        createdAt: 1, approvalChanged: true, answerPreview: "First conflicting answer.",
      }),
      decision(ANOTHER, "Latest conflicting title", {
        topic: GONE, createdAt: 2, answerPreview: "Second conflicting answer.",
      }),
    ], { "latest conflicting": [ANOTHER], "no such title": [], approved: [TWO] });
    expect(stateFilter(host).value).toBe("all");
    expect(within(stateFilter(host)).getAllByRole<HTMLOptionElement>("option").map((option) => [option.value, option.textContent])).toEqual([
      ["all", "All"], ["not-yet-decided", "Not yet decided"],
      ["under-review", "Under review"], ["agent-stance", "Agent stance"],
      ["conflict", "Conflict"], ["changed-after-approval", "Changed after approval"],
    ]);
    expect(rowTitles(host)).toEqual(["Agent recommendation", "Answer under review", "Approved", "Latest conflicting title", "Undecided"]);
    expect(within(topicRow(host, THREE)).getByText("Agent stance").textContent).toBe("Agent stance");
    expect(topicRow(host, THREE).textContent).not.toContain("In force");
    expect(topicRow(host, THREE).textContent).toContain("Agent answer.");
    expect(topicRow(host, FOUR).textContent).toContain("Under review");
    expect(topicRow(host, FOUR).textContent).toContain("Current stance.");
    expect(topicRow(host, FOUR).textContent).not.toContain("Proposed stance.");
    expect(topicRow(host, FOUR).textContent).not.toContain("Changed after approval");
    expect(topicRow(host, GONE).textContent).toContain("Nothing is in force");
    expect(topicRow(host, GONE).textContent).not.toContain("conflicting answer");
    expect(topicRow(host, TWO).textContent).toContain("In force");
    expect(topicRow(host, TWO).textContent).toContain("Changed after approval");
    expect(topicRow(host, GONE).textContent).toContain("Changed after approval");

    for (const [state, topics] of [
      ["not-yet-decided", [ONE]], ["under-review", [FOUR]],
      ["agent-stance", [THREE]], ["conflict", [GONE]],
      ["changed-after-approval", [TWO, GONE]],
    ] as const) {
      await chooseState(host, state);
      expect(rowUuids(host)).toEqual(topics);
    }
    await act(async () => typeInto(filter(host), "latest conflicting"));
    expect(rowUuids(host)).toEqual([GONE]);
    await act(async () => typeInto(filter(host), "no such title"));
    expect(rowUuids(host)).toEqual([]);
    expect(within(documentTable(host)).getByText(/Changed after approval/).textContent).toContain("Changed after approval");
    expect(documentTable(host).textContent).not.toContain("No decision records in this workspace");
    await act(async () => typeInto(filter(host), ""));
    await chooseState(host, "conflict");
    await act(async () => typeInto(filter(host), "approved"));
    expect(rowUuids(host)).toEqual([]);
    expect(within(documentTable(host)).getByText(/Conflict/).textContent).toContain("Conflict");
  });

  it("warns only about changed current or conflicting answers, not superseded records", async () => {
    const host = await open([
      decision(ONE, "Changed old answer", { createdAt: 1, approvalChanged: true }),
      decision(TWO, "Unchanged current answer", { topic: ONE, supersedes: ONE, createdAt: 2 }),
      decision(THREE, "Unanswered", { status: "open", approvalChanged: true }),
    ]);
    expect(documentTable(host).textContent).not.toContain("Changed after approval");
    await chooseState(host, "changed-after-approval");
    expect(rowUuids(host)).toEqual([]);
    expect(documentTable(host).textContent).toContain("Changed after approval");
    expect(documentTable(host).textContent).not.toContain("No decision records in this workspace");
  });

  it("excludes archived topics through the first tombstone and ignores a later record's tombstone", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, decision(ONE, "Archived first", { createdAt: 1 }));
    tombstoneDirectoryEntry(peer, ONE);
    // An older peer can publish a later record without a tombstone after the
    // first record has already archived the topic.
    upsertDirectoryEntry(peer, decision(TWO, "Archived successor", { topic: ONE, supersedes: ONE, createdAt: 2 }));
    upsertDirectoryEntry(peer, decision(THREE, "Live first", { createdAt: 1 }));
    // Deliberately bypass the whole-topic archive writer to reproduce a stray
    // tombstone left on one later record by an older client.
    getDirectoryMap(peer).set(FOUR, {
      title: "Live current answer", tags: [], kind: "decision", status: "decided",
      topic: THREE, supersedes: THREE, createdAt: 2, deleted: true,
    });
    const host = await openApp(allPath(WORKSPACE));
    await chooseDecisions(host);
    expect(rowUuids(host)).toEqual([THREE]);
    expect(rowTitles(host)).toEqual(["Live current answer"]);
    expect([...rooms.keys()].sort()).toEqual(
      [directoryRoom(WORKSPACE), sidebarRoom(WORKSPACE), settingsRoom(WORKSPACE)].sort(),
    );
  });

  it("pins a topic when any record is pinned, then unpins every record and pins the topic address", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, decision(ONE, "Original answer", { createdAt: 1 }));
    upsertDirectoryEntry(peer, decision(TWO, "Current answer", { topic: ONE, supersedes: ONE, createdAt: 2 }));
    const sidebarPeer = peerOf(sidebarDoc());
    const earlier = createGroup(sidebarPeer, "Earlier");
    const current = createGroup(sidebarPeer, "Current");
    pinDoc(sidebarPeer, earlier, ONE);
    pinDoc(sidebarPeer, current, TWO);
    const host = await openApp(allPath(WORKSPACE));
    await chooseDecisions(host);
    const pin = (): HTMLButtonElement => within(topicRow(host, ONE)).getByRole<HTMLButtonElement>("button", {
      name: /^(?:Pin|Unpin) Current answer (?:to|from) the sidebar$/,
    });
    expect(pin().getAttribute("aria-pressed")).toBe("true");
    await act(async () => pin().click());
    expect(readSidebar(sidebarPeer).flatMap((group) => group.docs)).toEqual([]);
    expect(pin().getAttribute("aria-pressed")).toBe("false");
    await act(async () => pin().click());
    expect(readSidebar(sidebarPeer).flatMap((group) => group.docs)).toEqual([ONE]);
    expect(pin().getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["All documents", "Back to workspace"])("restores a list visit on Back/Forward but opens defaults through %s", async (entry) => {
    localSearch({ Current: [TWO] });
    const peer = peerOf(directoryDoc());
    for (const [uuid, title, supersedes] of [
      [ONE, "Original answer", undefined], [TWO, "Current answer", ONE],
    ] as const) {
      const doc = room(roomForDoc(WORKSPACE, uuid)).ydoc;
      initDoc(doc, { uuid, title, ...(supersedes === undefined ? {} : { topic: ONE, supersedes }) });
      setKind(doc, "decision");
      appendBlock(doc, { type: "paragraph", text: `${title} text.` });
      setStatus(doc, "decided");
      upsertDirectoryEntry(peer, decision(uuid, title, {
        ...(supersedes === undefined ? {} : { topic: ONE, supersedes }),
        createdAt: uuid === ONE ? 1 : 2, approvalChanged: true,
      }));
    }
    const host = await openApp(allPath(WORKSPACE));
    await chooseDecisions(host);
    await chooseState(host, "changed-after-approval");
    await act(async () => typeInto(filter(host), "Current"));
    await act(async () => within(documentTable(host)).getByRole("button", { name: "Title" }).click());
    await act(async () => openButtons(host)[0]?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/${ONE}`);
    expect(within(host).getByRole<HTMLInputElement>("textbox", { name: "Document title" }).value).toBe("Current answer");
    const assertRestored = (): void => {
      expect(window.location.pathname).toBe(allPath(WORKSPACE));
      expect(within(within(host).getByRole("group", { name: "Document type" }))
        .getByRole("button", { name: "Decisions" }).getAttribute("aria-pressed")).toBe("true");
      expect(stateFilter(host).value).toBe("changed-after-approval");
      expect(filter(host).value).toBe("Current");
      expect(within(documentTable(host)).getByRole("columnheader", { name: /^Title/ }).getAttribute("aria-sort")).toBe("ascending");
    };
    await traverseHistory("back");
    assertRestored();
    await traverseHistory("forward");
    if (entry === "Back to workspace") {
      await act(async () => within(host).getByRole("button", { name: "Workspace settings" }).click());
    }
    await act(async () => within(host).getByRole("button", { name: entry === "All documents" ? entry : /^Back to / }).click());
    const assertDefaults = (): void => {
      expect(window.location.pathname).toBe(entry === "All documents" ? allPath(WORKSPACE) : `/${WORKSPACE}`);
      expect(within(within(host).getByRole("group", { name: "Document type" }))
        .getByRole("button", { name: "Documents" }).getAttribute("aria-pressed")).toBe("true");
      expect(filter(host).value).toBe("");
      expect(within(host).queryByRole("combobox", { name: "Decision state" })).toBeNull();
      expect(within(documentTable(host)).getByRole("columnheader", { name: /^Changed/ }).getAttribute("aria-sort")).toBe("descending");
    };
    assertDefaults();
    await traverseHistory("back");
    if (entry === "Back to workspace") await traverseHistory("back");
    await traverseHistory("back");
    assertRestored();
    await traverseHistory("forward");
    if (entry === "Back to workspace") await traverseHistory("forward");
    await traverseHistory("forward");
    assertDefaults();
    await chooseDecisions(host);
    expect(stateFilter(host).value).toBe("all");
  });
});

describe("the filter", () => {
  it("defaults new fields in older Product history and retains the column order for an empty search", async () => {
    localSearch({ Roadmap: [ONE] });
    const directory = directoryDoc();
    upsertDirectoryEntry(directory, { uuid: ONE, title: "Roadmap" });
    upsertDirectoryEntry(directory, { uuid: TWO, title: "Other note" });
    const target = room(roomForDoc(WORKSPACE, ONE)).ydoc;
    initDoc(target, { uuid: ONE, title: "Roadmap" });
    appendBlock(target, { type: "paragraph", text: "A regular page." });
    window.history.replaceState({
      mode: "requirement",
      query: "Roadmap",
      stateFilter: "all",
      sort: { order: "title", direction: "descending" },
    }, "", allPath(WORKSPACE));
    const host = await mount(<App />);
    const assertRestored = (): void => {
      expect(within(within(host).getByRole("group", { name: "Document type" }))
        .getByRole("button", { name: "Documents" }).getAttribute("aria-pressed")).toBe("true");
      expect(filter(host).value).toBe("Roadmap");
      expect(rowTitles(host)).toEqual(["Roadmap"]);
      expect(within(documentTable(host)).getAllByRole("columnheader").some((header) => header.hasAttribute("aria-sort"))).toBe(false);
      expect(within(host).queryByRole("button", { name: "Product" })).toBeNull();
    };
    assertRestored();
    await act(async () => openButtons(host)[0]?.click());
    await traverseHistory("back");
    assertRestored();
    await act(async () => typeInto(filter(host), ""));
    expect(window.history.state.mode).toBe("working");
    expect(window.history.state.selectedTags).toEqual([]);
    expect(within(documentTable(host)).getByRole("columnheader", { name: /^Title/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("opens on Documents and keeps each type mode to its own rows", async () => {
    const peer = peerOf(directoryDoc());
    getDirectoryMap(peer).set(ONE, {
      title: "Roadmap",
      tags: [],
      kind: "requirement",
      status: "planned",
    });
    upsertDirectoryEntry(peer, {
      uuid: TWO,
      title: "Cache choice",
      kind: "decision",
      status: "open",
    });
    upsertDirectoryEntry(peer, { uuid: THREE, title: "Working note" });
    // Stored requirements with mismatched or missing states project to regular pages too.
    getDirectoryMap(peer).set(FOUR, {
      title: "Status drift",
      tags: [],
      kind: "requirement",
      status: "open",
    });
    getDirectoryMap(peer).set("ad1f5bae-e772-4cb7-8a1a-a51b37a1ca19", {
      title: "Legacy without state",
      tags: [],
      kind: "requirement",
    });
    // A foreign kind is unreadable at the schema boundary and therefore joins
    // ordinary working documents instead of disappearing from every mode.
    getDirectoryMap(peer).set(GONE, {
      title: "Foreign shape",
      tags: [],
      kind: "memo",
      status: "draft",
    });

    const host = await openApp(`/${WORKSPACE}`);
    const mode = (name: string): HTMLButtonElement =>
      within(within(host).getByRole("group", { name: "Document type" }))
        .getByRole<HTMLButtonElement>("button", { name });
    expect(mode("Documents")?.getAttribute("aria-pressed")).toBe("true");
    expect(rowTitles(host)).toEqual(["Foreign shape", "Legacy without state", "Roadmap", "Status drift", "Working note"]);
    expect(lifecycleBadges(host)).toHaveLength(0);
    expect(within(host).queryByRole("button", { name: "Product" })).toBeNull();
    expect(getDirectoryMap(peer).get(ONE)).toMatchObject({ kind: "requirement", status: "planned" });
    expect([...rooms.keys()].sort()).toEqual(
      [directoryRoom(WORKSPACE), sidebarRoom(WORKSPACE), settingsRoom(WORKSPACE)].sort(),
    );

    await act(async () => mode("Decisions")?.click());
    expect(rowTitles(host)).toEqual(["Cache choice"]);
    expect(documentTable(host).textContent).toContain("Not yet decided");
  });

  it("renders a missing-title fallback but follows the index's matching UUIDs", async () => {
    const search = vi.fn(async () => [TWO]);
    const host = await mount(
      <DocumentList
        connection={null}
        searchClient={{ search }}
        entries={[
          entry({ uuid: ONE, title: "" }),
          entry({ uuid: TWO, title: "Untitled" }),
        ]}
        groups={[]}
        onSelect={() => {}}
        onTogglePin={null}
      />,
    );
    // Both rows read "Untitled" on screen — one because that is its title, one
    // because the list draws the word in italics where a title is absent.
    expect(rowTitles(host)).toEqual(["Untitled", "Untitled"]);
    // Italic emphasis distinguishes the fallback label from a stored title.
    const fallbacks = (): HTMLElement[] =>
      within(documentTable(host)).queryAllByRole("emphasis", { hidden: true });
    expect(fallbacks()).toHaveLength(1);

    await act(async () => typeInto(filter(host), "untitled"));
    expect(search).toHaveBeenCalledWith("untitled", expect.any(AbortSignal));
    expect(rowUuids(host)).toEqual([TWO]);
    expect(fallbacks()).toHaveLength(0);
  });

  it("combines matching records with type while preserving the search text", async () => {
    const host = await mount(
      <DocumentList
        connection={null}
        searchClient={{ search: async () => [ONE, TWO] }}
        entries={[
          entry({ uuid: ONE, title: "Search plan" }),
          entry({
            uuid: TWO,
            title: "Search decision",
            kind: "decision",
            status: "open",
          }),
          entry({ uuid: THREE, title: "Roadmap" }),
        ]}
        groups={[]}
        onSelect={() => {}}
        onTogglePin={null}
      />,
    );
    const mode = (name: string): HTMLButtonElement =>
      within(within(host).getByRole("group", { name: "Document type" }))
        .getByRole<HTMLButtonElement>("button", { name });

    await act(async () => typeInto(filter(host), "search"));
    // The decision matches the text too, and still does not appear here.
    expect(rowTitles(host)).toEqual(["Search plan"]);

    await act(async () => mode("Decisions")?.click());
    expect(filter(host).value).toBe("search");
    expect(rowTitles(host)).toEqual(["Search decision"]);
  });

  it("names Search broadly and reports unavailable search outside ub open", async () => {
    const host = await mount(
      <DocumentList
        connection={null}
        entries={[entry({ uuid: ONE, title: "Overview" })]}
        groups={[]}
        onSelect={() => {}}
        onTogglePin={() => {}}
      />,
    );
    const field = filter(host);
    expect(field.disabled).toBe(false);
    expect(field.labels?.[0]?.textContent).toBe("Search");
    expect(field.placeholder).toBe("Search");
    expect(host.textContent).toContain("Search is unavailable.");

    await act(async () => typeInto(field, "overview"));
    expect(rowTitles(host)).toEqual([]);
    expect(documentTable(host).textContent).toContain("Search is unavailable.");
    expect(documentTable(host).textContent).not.toContain("No documents");
  });
});

describe("an empty list", () => {
  /** A directory room that reports whether it has synced, and nothing else. */
  function statusOnly(synced: boolean): RoomConnection {
    return {
      ...room(`status-${String(synced)}`),
      onStatusChange: (listener: (next: RoomStatus) => void) => {
        listener({ ...LIVE, connected: synced, synced });
        return () => {};
      },
    } as unknown as RoomConnection;
  }

  async function open(synced: boolean, entries: DirectoryEntry[]) {
    return await mount(
      <DocumentList
        connection={statusOnly(synced)}
        searchClient={{ search: async () => [] }}
        entries={entries}
        groups={[]}
        onSelect={() => {}}
        onTogglePin={null}
      />,
    );
  }

  it.each([
    { scenario: "no entries", entries: [] },
    { scenario: "only archived entries", entries: [entry({ uuid: GONE, title: "Archived", deleted: true })] },
  ])("says the workspace is empty only once the directory has synced with $scenario", async ({ entries }) => {
    // Nothing heard yet is not an answer: a workspace full of documents would
    // otherwise be told it has none.
    const waiting = await open(false, entries);
    expect(documentTable(waiting)).not.toBeNull();
    expect(pinUnavailable(waiting)).toBeNull();
    expect(within(waiting).getByText(/has not synced/).textContent).toContain(
      "has not synced",
    );
    unmount();

    const synced = await open(true, entries);
    expect(pinUnavailable(synced)).toBeNull();
    expect(within(synced).getByText("No documents in this workspace yet.").textContent).toBe(
      "No documents in this workspace yet.",
    );
  });

  it("qualifies an empty search with what has synced so far", async () => {
    const waiting = await open(false, [entry({ uuid: ONE, title: "Overview" })]);
    await act(async () => typeInto(filter(waiting), "nothing"));
    expect(within(waiting).getByText('No documents synced so far match "nothing".').textContent).toBe(
      'No documents synced so far match "nothing".',
    );
    unmount();

    const synced = await open(true, [entry({ uuid: ONE, title: "Overview" })]);
    await act(async () => typeInto(filter(synced), "nothing"));
    expect(within(synced).getByText('No documents match "nothing".').textContent).toBe(
      'No documents match "nothing".',
    );
    expect(synced.textContent).not.toMatch(/Search is unavailable|Searching/);
  });
});

/**
 * The sidebar's "All documents" entry opens the listing. Its placement above
 * pinned groups is asserted in `sidebar.test.tsx`.
 */
describe("the sidebar entry", () => {
  it("is there whether anything is pinned or not, and opens the listing", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });

    // Nothing pinned: the sidebar says so, and the entry is still there.
    const host = await openApp(`/${WORKSPACE}`);
    const sidebar = within(host).getByRole("complementary", { name: "Sidebar" });
    const groups = (): HTMLElement[] => within(sidebar).queryAllByRole("button", { name: /^Rename group / });
    expect(groups()).toHaveLength(0);
    const open = within(sidebar).getByRole<HTMLButtonElement>("button", { name: "All documents" });
    expect(open?.textContent).toContain("All documents");
    // Both workspace addresses render the same listing, so the entry is the
    // current page at either one — not only at the address it navigates to.
    expect(open?.getAttribute("aria-current")).toBe("page");

    await act(async () => open?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/all`);
    expect(rowTitles(host)).toEqual(["Overview"]);
    expect(
      within(sidebar).getByRole("button", { name: "All documents" }).getAttribute("aria-current"),
    ).toBe("page");

    // And with a pin in the sidebar it is exactly where it was: the entry is
    // not part of the curation below it.
    const pin = within(documentTable(host)).getByRole<HTMLButtonElement>("button", { name: "Pin Overview to the sidebar" });
    await act(async () => pin?.click());
    expect(groups()).toHaveLength(1);
    expect(within(sidebar).getByRole("button", { name: "All documents" }).textContent).toContain(
      "All documents",
    );
    expect(rowTitles(host)).toEqual(["Overview"]);
  });

  it("pins a row into the sidebar document a second client reads", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    const sidebarPeer = peerOf(sidebarDoc());

    const host = await openApp(allPath(WORKSPACE));
    expect(pinUnavailable(host)).toBeNull();
    const pin = (): HTMLButtonElement =>
      within(documentTable(host)).getByRole<HTMLButtonElement>("button", { name: /^(?:Pin|Unpin) Overview (?:to|from) the sidebar$/ });
    expect(pin()?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => pin()?.click());
    expect(readSidebar(sidebarPeer).map((group) => group.docs)).toEqual([[ONE]]);
    expect(pin()?.getAttribute("aria-pressed")).toBe("true");
    // The pin is what puts the group in the row: one write, both readings.
    const overview = within(documentTable(host)).getByRole("button", { name: "Overview" }).closest("tr")!;
    expect(within(overview).getByText("Pinned").textContent).toBe("Pinned");

    // The same control both ways, and the document is what remembers.
    await act(async () => pin()?.click());
    expect(readSidebar(sidebarPeer).map((group) => group.docs)).toEqual([[]]);
    expect(pin()?.getAttribute("aria-pressed")).toBe("false");
  });

  // One reading stands for all of them: offline and not-yet-synced disable the
  // same pin with the same sentence (sidebar.test.tsx covers the gate itself).
  it("visibly explains disabled pin controls while the sidebar is connected read-only", async () => {
    upsertDirectoryEntry(directoryDoc(), { uuid: ONE, title: "Overview" });
    const name = sidebarRoom(WORKSPACE);
    const connection = room(name);
    const status = { ...LIVE, writable: false };
    rooms.set(name, {
      ...connection,
      status,
      onStatusChange: (listener: (next: RoomStatus) => void) => {
        listener(status);
        return () => {};
      },
    });

    const host = await openApp(allPath(WORKSPACE));
    const reason = pinUnavailable(host);
    const pin = within(documentTable(host)).getByRole<HTMLButtonElement>("button", {
      name: "Pin Overview to the sidebar unavailable while sidebar is not ready to write",
    });
    expect(reason?.textContent).toContain(
      "Pin changes unavailable while the sidebar is not ready to write.",
    );
    expect(pin?.disabled).toBe(true);
    expect(pin?.getAttribute("aria-describedby")).toBe(reason?.id);
    await act(async () => pin?.click());
    expect(readSidebar(connection.ydoc)).toEqual([]);
  });
});

describe("opening a document", () => {
  it("navigates to the deep link, and a reload comes back to it", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    // The document itself, as a peer would have synced it: a reload has to find
    // it here rather than at the list it came from.
    const target = room(roomForDoc(WORKSPACE, ONE)).ydoc;
    initDoc(target, { uuid: ONE, title: "Overview" });
    appendBlock(target, { type: "paragraph", text: "hello" });

    const host = await openApp(`/${WORKSPACE}`);
    await act(async () =>
      within(documentTable(host)).getByRole("button", { name: "Overview" }).click(),
    );
    expect(window.location.pathname).toBe(`/${WORKSPACE}/${ONE}`);

    // A reload: the app goes, the address stays, and the document opens.
    unmount();
    const again = await openApp(`/${WORKSPACE}/${ONE}`);
    expect(within(again).queryByRole("table", { hidden: true })).toBeNull();
    expect(within(again).getByPlaceholderText<HTMLInputElement>("Untitled").value).toBe(
      "Overview",
    );
  });
});
