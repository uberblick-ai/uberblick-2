/**
 * The document list (#406): the corpus journey's one surface.
 *
 * One claim: **the list is the directory doc, rendered.** So the rows are
 * asserted against what a *peer* replica of the `_directory` room holds — the
 * same reading `list_docs` produces — rather than against anything this client
 * did, and a remote create, rename or description is driven by writing to that
 * peer. A listing that agreed with local history but not with the directory
 * would be a second corpus, which is the one thing discovery cannot be.
 *
 * Both filters are that same derivation: the type mode reads the cached
 * lifecycle shape, and the field narrows by the cached title. Neither crosses
 * a boundary, so there is nothing to inject and nothing to await — which is
 * itself asserted, because "consults only the directory" is the claim.
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
  directoryRoom,
  getDirectoryMap,
  initDoc,
  listDirectory,
  pinDoc,
  readSidebar,
  roomForDoc,
  sidebarRoom,
  settingsRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { allPath, canonicalPath, parseRoute } from "../src/ui/route.js";
import { DocumentList, sortDirectory } from "../src/shell/DocumentList.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { formatTimestamp } from "../src/ui/timestamps.js";

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
  // Inventories include every mounted row, as the original DOM queries did.
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
    name: "Filter this list by title",
  });
}

/**
 * Let anything the render scheduled actually run.
 *
 * The filter has nothing to await, which is the claim; this is what makes
 * "issued no request" an observation rather than a race the assertion won.
 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function entry(over: Partial<DirectoryEntry> & { uuid: string }): DirectoryEntry {
  return { title: "", tags: [], ...over };
}

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
 * Which scan the list is being read with. Last changed answers *what am I
 * working on*; title answers *what is in here*, which the filter cannot —
 * filtering needs a name you already have (owner feedback, 2026-08-30).
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
    // The semantic queries still verify the original native table structure.
    expect(table.querySelectorAll("thead th")).toHaveLength(3);
    expect(table.querySelectorAll('tbody th[scope="row"]')).toHaveLength(3);
    expect(within(table).getAllByRole("columnheader", { hidden: true })).toHaveLength(3);
    expect(within(table).getAllByRole("rowheader", { hidden: true })).toHaveLength(3);
    expect(within(host).queryByRole("group", { name: "Order", hidden: true })).toBeNull();

    const title = heading(host, "Title");
    const changed = heading(host, "Last changed");
    expect(rowTitles(host)).toEqual(["Zebra", "Alpha", "Middle"]);
    expect(activeOrder(host)).toBe("Last changed");
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

    await act(async () => chooseOrder(host, "Last changed").click());
    expect(rowTitles(host)).toEqual(["Zebra", "Alpha", "Middle"]);
    expect(activeOrder(host)).toBe("Last changed");
    expect(changed.getAttribute("aria-sort")).toBe("descending");

    await act(async () => chooseOrder(host, "Last changed").click());
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

  it("shows the title, the pinned group and the age — and neither description nor tags", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, {
      uuid: ONE,
      title: "Overview",
      tags: ["product", "reference"],
      description: "What uberblick is, and what it deliberately is not.",
      updatedAt: Date.UTC(2026, 0, 3),
    });
    // Pinned by a second writer — an agent's `pin_doc` is these same calls.
    const sidebarPeer = peerOf(sidebarDoc());
    const reading = createGroup(sidebarPeer, "Reading");
    pinDoc(sidebarPeer, reading, ONE);

    const host = await openApp(`/${WORKSPACE}`);
    const row = within(documentTable(host)).getByRole("row", { name: /^OverviewReading / });
    expect(within(row).getByText("Overview").textContent).toBe("Overview");
    expect(within(row).getByText("Reading").textContent).toBe("Reading");
    expect(within(row).getByRole("time", { hidden: true }).getAttribute("dateTime")).toBe(
      "2026-01-03T00:00:00.000Z",
    );
    // The stub still caches both — this is what one screen renders.
    expect(row?.textContent).not.toContain("deliberately is not");
    expect(row?.textContent).not.toContain("product");
    expect(row?.textContent).not.toContain("reference");
  });

  it("names the group a document is pinned into while the list is open", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    const sidebarPeer = peerOf(sidebarDoc());
    const later = createGroup(sidebarPeer, "Later");

    const host = await openApp(`/${WORKSPACE}`);
    const button = within(documentTable(host)).getByRole("button", { name: "Overview" });
    const group = (): string | null =>
      within(button).queryByText("Later")?.textContent ?? null;
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

describe("the filter", () => {
  it("opens on Working and keeps each type mode to its own rows", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, {
      uuid: ONE,
      title: "Roadmap",
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
    // The kind remains readable when a merged status belongs to the other
    // lifecycle; only the mismatched status is dropped.
    upsertDirectoryEntry(peer, {
      uuid: FOUR,
      title: "Status drift",
      kind: "requirement",
      status: "open",
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
    expect(mode("Working")?.getAttribute("aria-pressed")).toBe("true");
    expect(rowTitles(host)).toEqual(["Foreign shape", "Working note"]);
    expect(lifecycleBadges(host)).toHaveLength(0);
    expect([...rooms.keys()].sort()).toEqual(
      [directoryRoom(WORKSPACE), sidebarRoom(WORKSPACE), settingsRoom(WORKSPACE)].sort(),
    );

    await act(async () => mode("Product")?.click());
    expect(rowTitles(host)).toEqual(["Roadmap", "Status drift"]);
    expect(
      lifecycleBadges(host).map(
        (badge) => badge.textContent,
      ),
    ).toEqual(["Product · planned", "Product"]);
    await act(async () => mode("Decisions")?.click());
    expect(rowTitles(host)).toEqual(["Cache choice"]);
    expect(lifecycleBadges(host)[0]?.textContent).toBe(
      "Decision · open",
    );
  });

  it("keeps the rows whose title contains the text, and nothing a description says", async () => {
    const selected = vi.fn();
    const host = await mount(
      <DocumentList
        connection={null}
        entries={[
          entry({ uuid: ONE, title: "Overview" }),
          entry({
            uuid: TWO,
            title: "Editing and blocks",
            description: "How the overview pane composes a document.",
          }),
          entry({ uuid: THREE, title: "Roadmap" }),
        ]}
        groups={[]}
        onSelect={selected}
        onTogglePin={null}
      />,
    );
    const field = filter(host);

    // Case-insensitive, and a substring rather than a prefix.
    await act(async () => typeInto(field, "VIE"));
    expect(rowTitles(host)).toEqual(["Overview"]);

    // The word occurs in the second entry's description and in the first
    // entry's title. Only the title is consulted, so the description is not a
    // second corpus this field quietly searches.
    await act(async () => typeInto(field, "overview pane"));
    expect(rowTitles(host)).toEqual([]);

    // Two rows, and the second matches only because the comparison folds case.
    await act(async () => typeInto(field, "r"));
    expect(rowTitles(host)).toEqual(["Overview", "Roadmap"]);
    await act(async () =>
      within(documentTable(host)).getByRole("button", { name: "Overview" }).click(),
    );
    expect(selected).toHaveBeenCalledWith(ONE);

    // Clearing restores the unfiltered list.
    await act(async () => typeInto(field, ""));
    expect(rowTitles(host)).toEqual([
      "Editing and blocks",
      "Overview",
      "Roadmap",
    ]);
  });

  it("does not match the body of a document the page has already opened", async () => {
    const directory = directoryDoc();
    upsertDirectoryEntry(directory, { uuid: ONE, title: "Overview" });
    const target = room(roomForDoc(WORKSPACE, ONE)).ydoc;
    initDoc(target, { uuid: ONE, title: "Overview" });
    appendBlock(target, { type: "paragraph", text: "bodyonly quasartrail" });

    const host = await openApp(`/${WORKSPACE}/${ONE}`);
    await act(async () =>
      within(host).getByRole("button", { name: "All docs" }).click(),
    );
    await act(async () => typeInto(filter(host), "bodyonly"));
    expect(rowTitles(host)).toEqual([]);
  });

  it("never matches the Untitled a row draws in place of an absent title", async () => {
    const host = await mount(
      <DocumentList
        connection={null}
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
    // The fallback is this list's word for *no title*, not a title to match
    // against, so only the document actually called "Untitled" survives.
    expect(rowUuids(host)).toEqual([TWO]);
    expect(fallbacks()).toHaveLength(0);
  });

  it("narrows inside the chosen tab, and re-applies the text to the next tab", async () => {
    const host = await mount(
      <DocumentList
        connection={null}
        entries={[
          entry({ uuid: ONE, title: "Search plan" }),
          entry({
            uuid: TWO,
            title: "Search requirement",
            kind: "requirement",
            status: "planned",
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
    // The requirement matches the text too, and still does not appear here.
    expect(rowTitles(host)).toEqual(["Search plan"]);

    await act(async () => mode("Product")?.click());
    expect(filter(host).value).toBe("search");
    expect(rowTitles(host)).toEqual(["Search requirement"]);
  });

  it("asks nobody anything, whatever is typed", async () => {
    const host = await mount(
      <DocumentList
        connection={null}
        entries={[entry({ uuid: ONE, title: "Overview" })]}
        groups={[]}
        onSelect={() => {}}
        onTogglePin={null}
      />,
    );
    for (const text of ["overview", "nothing at all", "*", ""]) {
      await act(async () => typeInto(filter(host), text));
      await flushMicrotasks();
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("is enabled from first paint and claims nothing about a search", async () => {
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
    // The accessible name and the in-field hint are the field's whole story,
    // and neither offers document text. Nothing else on the page qualifies the
    // answer either — no unavailable state, no lag or cap caveat.
    expect(field.labels?.[0]?.textContent).toBe("Filter this list by title");
    expect(field.placeholder).toBe("Filter by title");
    expect(host.textContent).not.toMatch(
      /unavailable|document text|lag|first \d+ matches|Loading/i,
    );

    await act(async () => typeInto(field, "overview"));
    expect(rowTitles(host)).toEqual(["Overview"]);
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
        entries={entries}
        groups={[]}
        onSelect={() => {}}
        onTogglePin={null}
      />,
    );
  }

  it("says the workspace is empty only once the directory has synced", async () => {
    // Nothing heard yet is not an answer: a workspace full of documents would
    // otherwise be told it has none.
    const waiting = await open(false, []);
    expect(documentTable(waiting)).not.toBeNull();
    expect(pinUnavailable(waiting)).toBeNull();
    expect(within(waiting).getByText(/has not synced/).textContent).toContain(
      "has not synced",
    );
    unmount();

    const synced = await open(true, []);
    expect(pinUnavailable(synced)).toBeNull();
    expect(within(synced).getByText("No documents in this workspace yet.").textContent).toBe(
      "No documents in this workspace yet.",
    );
  });

  it("asserts that no title matches only once the directory has synced", async () => {
    // The filter narrows what has arrived, so before the directory has synced
    // it can only speak about what has arrived — and it says so rather than
    // asserting the corpus holds no such title.
    const waiting = await open(false, [entry({ uuid: ONE, title: "Overview" })]);
    await act(async () => typeInto(filter(waiting), "nothing"));
    expect(within(waiting).getByText("No working documents synced so far have a matching title.").textContent).toBe(
      "No working documents synced so far have a matching title.",
    );
    unmount();

    const synced = await open(true, [entry({ uuid: ONE, title: "Overview" })]);
    await act(async () => typeInto(filter(synced), "nothing"));
    expect(within(synced).getByText("No working documents have a matching title.").textContent).toBe(
      "No working documents have a matching title.",
    );
    // Neither reading is a failed or a pending search: nothing is in flight,
    // so there is no third state to report.
    expect(synced.textContent).not.toMatch(/failed|Searching|…/);
  });
});

/**
 * The sidebar's "All docs" entry, unchanged by this leaf: the sidebar is
 * curation and stays as it was, and these cases move here with the listing it
 * opens rather than dying with `AllDocsPane`. Where in the column the entry is
 * drawn is the sidebar's own business (#483 moved it into Navigation) and is
 * asserted in `sidebar.test.tsx`; what is asked here is only that it is there,
 * says "All docs", and opens the listing.
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
    const open = within(sidebar).getByRole<HTMLButtonElement>("button", { name: "All docs" });
    expect(open?.textContent).toContain("All docs");
    // Both workspace addresses render the same listing, so the entry is the
    // current page at either one — not only at the address it navigates to.
    expect(open?.getAttribute("aria-current")).toBe("page");

    await act(async () => open?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/all`);
    expect(rowTitles(host)).toEqual(["Overview"]);
    expect(
      within(sidebar).getByRole("button", { name: "All docs" }).getAttribute("aria-current"),
    ).toBe("page");

    // And with a pin in the sidebar it is exactly where it was: the entry is
    // not part of the curation below it (#483).
    const pin = within(documentTable(host)).getByRole<HTMLButtonElement>("button", { name: "Pin Overview to the sidebar" });
    await act(async () => pin?.click());
    expect(groups()).toHaveLength(1);
    expect(within(sidebar).getByRole("button", { name: "All docs" }).textContent).toContain(
      "All docs",
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
    const overview = within(documentTable(host)).getByRole("button", { name: "OverviewPinned" });
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
