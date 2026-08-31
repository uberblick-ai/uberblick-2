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
 * The second claim the filter makes is structural rather than cosmetic: it is a
 * derivation over stubs that are already in memory, so typing opens no room.
 * That is asserted at the seam the shell actually has — `acquireRoom` is mocked
 * here, so every room this app joins is a key in `rooms`, and the whole corpus
 * plus a query must add none.
 *
 * The app is mounted whole over shared Y.Docs (the `sidebar.test.tsx`
 * harness): a room is a plain Y.Doc, because the transport is not what is
 * under test.
 *
 * Timestamps are asserted through each row's `<time dateTime>` rather than its
 * rendered label: the label is `Intl`'s, in whatever locale the machine
 * running the tests has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import * as Y from "yjs";
import {
  appendBlock,
  createGroup,
  directoryRoom,
  initDoc,
  pinDoc,
  readSidebar,
  roomForDoc,
  sidebarRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { allPath, canonicalPath, parseRoute } from "../src/ui/route.js";
import {
  DocumentList,
  relativeAge,
  sortDirectory,
} from "../src/shell/DocumentList.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
/** A second corpus on the same hub — where the switcher goes. */
const OTHER_WORKSPACE = "2d9b6e70-5c14-4a82-b7f3-0e6a91d84c25";
const ONE = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const TWO = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";
const THREE = "7c2e5a11-3f80-4d66-b1a9-8e4d2c6f0a55";
const GONE = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

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

let mounted: { root: Root; host: HTMLElement } | null = null;

beforeEach(() => {
  installStorage();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
});

afterEach(() => {
  unmount();
  rooms.clear();
  vi.restoreAllMocks();
});

function unmount(): void {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
}

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
 * Go somewhere else in the mounted app, the way the shell does: the address
 * moves and `useRoutePath` reads it back. Whether a switcher click or the Back
 * button put it there is the same event to everything downstream.
 */
async function goTo(path: string): Promise<void> {
  await act(async () => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

function directoryDoc(): Y.Doc {
  return room(directoryRoom(WORKSPACE)).ydoc;
}

function sidebarDoc(): Y.Doc {
  return room(sidebarRoom(WORKSPACE)).ydoc;
}

/** The titles the list shows, top to bottom. */
function rowTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".ub-docs-title")].map(
    (node) => node.textContent ?? "",
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

function search(host: HTMLElement): HTMLInputElement {
  const field = host.querySelector<HTMLInputElement>(".ub-docs-search");
  if (field === null) throw new Error("the search field is missing");
  return field;
}

function entry(over: Partial<DirectoryEntry> & { uuid: string }): DirectoryEntry {
  return { title: "", tags: [], ...over };
}

describe("relative changed time", () => {
  const NOW = Date.UTC(2026, 7, 27, 12);
  const ago = (milliseconds: number): string =>
    new Date(NOW - milliseconds).toISOString();

  it.each([
    ["just now", new Date(NOW + 60_000).toISOString()],
    ["20 minutes ago", ago(20 * 60_000)],
    ["1 hour ago", ago(60 * 60_000)],
    ["1 day ago", ago(24 * 60 * 60_000)],
    ["2 days ago", ago(2 * 24 * 60 * 60_000)],
    ["1 week ago", ago(7 * 24 * 60 * 60_000)],
    ["2 months ago", ago(60 * 24 * 60 * 60_000)],
    ["1 year ago", ago(365 * 24 * 60 * 60_000)],
  ])("formats %s", (expected, iso) => {
    expect(relativeAge(iso, NOW)).toBe(expected);
  });

  it("refuses an unusable value", () => {
    expect(relativeAge("not-a-date", NOW)).toBe("");
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
      const changed = (): string | undefined =>
        host.querySelector(".ub-docs-row time")?.textContent ?? undefined;
      expect(changed()).toBe("just now");

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
    const titles = sortDirectory([
      entry({ uuid: ONE, title: "Beta", updatedAt: 100 }),
      entry({ uuid: TWO, title: "Alpha", updatedAt: 300 }),
      entry({ uuid: THREE, title: "Gamma", updatedAt: 200 }),
    ]).map((row) => row.title);
    expect(titles).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("puts documents with no usable stamp last, in title order", () => {
    // The stamps are optional by construction: a stub written before they
    // existed carries none, and "no answer" is not "very old". A stamp no
    // `Date` can hold is the same kind of no-answer — the stubs are written by
    // whichever replica had the clock, so a finite absurdity is a real state.
    const titles = sortDirectory([
      entry({ uuid: ONE, title: "Beta", updatedAt: 100 }),
      entry({ uuid: GONE, title: "Zeta" }),
      entry({ uuid: "aaaa1111-2222-4333-8444-555566667777", title: "Aardvark" }),
      entry({
        uuid: "bbbb2222-3333-4444-8555-666677778888",
        title: "Skewed",
        updatedAt: Number.MAX_VALUE,
      }),
    ]).map((row) => row.title);
    expect(titles).toEqual(["Beta", "Aardvark", "Skewed", "Zeta"]);
  });

  it("breaks ties by title, so a re-render never reshuffles the rows", () => {
    const tied = [
      entry({ uuid: ONE, title: "Second", updatedAt: 500 }),
      entry({ uuid: TWO, title: "First", updatedAt: 500 }),
    ];
    expect(sortDirectory(tied).map((row) => row.title)).toEqual([
      "First",
      "Second",
    ]);
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
    // group a row is pinned in.)
    expect([...rooms.keys()].sort()).toEqual(
      [directoryRoom(WORKSPACE), sidebarRoom(WORKSPACE)].sort(),
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
    const row = host.querySelector(".ub-docs-row");
    expect(row?.querySelector(".ub-docs-title")?.textContent).toBe("Overview");
    expect(row?.querySelector(".ub-docs-group")?.textContent).toBe("Reading");
    expect(row?.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-01-03T00:00:00.000Z",
    );
    // The stub still caches both — this is what one screen renders.
    expect(row?.textContent).not.toContain("deliberately is not");
    expect(row?.querySelectorAll(".ub-tag")).toHaveLength(0);
  });

  it("names the group a document is pinned into while the list is open", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    const sidebarPeer = peerOf(sidebarDoc());
    const later = createGroup(sidebarPeer, "Later");

    const host = await openApp(`/${WORKSPACE}`);
    const group = (): string | null =>
      host.querySelector(".ub-docs-group")?.textContent ?? null;
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
    const rows = [...host.querySelectorAll(".ub-docs-row")];
    expect(rows[0]?.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-01-03T00:00:00.000Z",
    );
    expect(rows[1]?.querySelectorAll("time")).toHaveLength(0);
    expect(rows[1]?.textContent).toContain("—");
    expect(rows[2]?.querySelectorAll("time")).toHaveLength(0);
    expect(rows[2]?.textContent).toContain("—");
  });
});

describe("the filter", () => {
  it("matches the title alone over the stubs, and opens no room", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, {
      uuid: ONE,
      title: "Overview",
      description: "A lighthouse phrase",
    });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Editing", tags: ["howto"] });

    const host = await openApp(`/${WORKSPACE}`);
    const field = search(host);

    // On the title, folded — the needle and the haystack fold the same way.
    await act(async () => typeInto(field, "OVER"));
    expect(rowTitles(host)).toEqual(["Overview"]);

    // Not on a description, and not on a tag: a row the list does not print
    // them on would look like a row that matched on nothing.
    await act(async () => typeInto(field, "lighthouse"));
    expect(rowTitles(host)).toEqual([]);

    await act(async () => typeInto(field, "howto"));
    expect(rowTitles(host)).toEqual([]);

    // The whole of it is a derivation over stubs already in memory: no query
    // has joined a room, and none ever can — the corpus is filterable offline.
    expect([...rooms.keys()].sort()).toEqual(
      [directoryRoom(WORKSPACE), sidebarRoom(WORKSPACE)].sort(),
    );

    await act(async () => typeInto(field, ""));
    expect(rowTitles(host)).toEqual(["Editing", "Overview"]);
  });

  it("follows a title an agent changes under an open query", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Lighthouse" });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Editing" });

    const host = await openApp(`/${WORKSPACE}`);
    await act(async () => typeInto(search(host), "lighthouse"));
    expect(rowTitles(host)).toEqual(["Lighthouse"]);

    await act(async () => {
      upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
      upsertDirectoryEntry(peer, { uuid: TWO, title: "Lighthouse keeping" });
    });
    expect(rowTitles(host)).toEqual(["Lighthouse keeping"]);
  });

  it("says what it looks at, on screen", async () => {
    const host = await openApp(`/${WORKSPACE}`);
    const scope = host.querySelector(".ub-docs-scope")?.textContent ?? "";
    // No row matches on something its row does not show, and the sentence says
    // exactly that.
    expect(scope).toContain("titles");
    expect(scope).not.toContain("tags");
    expect(scope).not.toContain("descriptions");
    // And it says what it does *not* look at, which is the assumption a reader
    // would otherwise make: full text lives in the agents' `search`.
    expect(scope).toContain("not the text inside documents");
  });

  /**
   * The query is about one corpus, so it does not travel to another. Carried
   * across a switch it would hide every document in the workspace just opened
   * — a first screen that looks empty for a reason nothing on it explains.
   * Moving between the two addresses of the *same* workspace is not that, and
   * keeps what was typed.
   */
  it("clears when the workspace changes, and not when the address does", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });

    const host = await openApp(`/${WORKSPACE}`);
    await act(async () => typeInto(search(host), "over"));
    expect(rowTitles(host)).toEqual(["Overview"]);

    await goTo(allPath(WORKSPACE));
    expect(search(host).value).toBe("over");

    await goTo(`/${OTHER_WORKSPACE}`);
    expect(search(host).value).toBe("");
  });
});

describe("an empty list", () => {
  /** A directory room that reports whether it has synced, and nothing else. */
  function statusOnly(synced: boolean): RoomConnection {
    return {
      ...room(`status-${String(synced)}`),
      onStatusChange: (listener: (next: RoomStatus) => void) => {
        listener({ ...OFFLINE, connected: synced, synced });
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
    expect(waiting.querySelector(".ub-docs-empty")?.textContent).toContain(
      "has not synced",
    );
    unmount();

    const synced = await open(true, []);
    expect(synced.querySelector(".ub-docs-empty")?.textContent).toBe(
      "No documents in this workspace yet.",
    );
  });

  it("reports no matches only among what has arrived, until the directory syncs", async () => {
    const waiting = await open(false, [entry({ uuid: ONE, title: "Overview" })]);
    await act(async () => typeInto(search(waiting), "nothing"));
    expect(waiting.querySelector(".ub-docs-empty")?.textContent).toBe(
      "No matches among the documents synced so far.",
    );
    unmount();

    const synced = await open(true, [entry({ uuid: ONE, title: "Overview" })]);
    await act(async () => typeInto(search(synced), "nothing"));
    expect(synced.querySelector(".ub-docs-empty")?.textContent).toBe(
      "No documents match your search.",
    );
  });
});

/**
 * The sidebar's "All docs" entry, unchanged by this leaf: the sidebar is
 * curation and stays as it was, and these cases move here with the listing it
 * opens rather than dying with `AllDocsPane`.
 */
describe("the sidebar entry", () => {
  it("is there whether anything is pinned or not, and opens the listing", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });

    // Nothing pinned: the sidebar says so, and the entry is still there.
    const host = await openApp(`/${WORKSPACE}`);
    expect(host.querySelector(".ub-list .ub-group")).toBeNull();
    const open = host.querySelector<HTMLButtonElement>(".ub-all-open-entry");
    expect(open?.textContent).toContain("All docs");
    // Both workspace addresses render the same listing, so the entry is the
    // current page at either one — not only at the address it navigates to.
    expect(open?.getAttribute("aria-current")).toBe("page");

    await act(async () => open?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/all`);
    expect(rowTitles(host)).toEqual(["Overview"]);
    expect(
      host.querySelector(".ub-all-open-entry")?.getAttribute("aria-current"),
    ).toBe("page");

    // And with a pin in the sidebar it is exactly where it was: the entry is
    // not part of the curation above it.
    const pin = host.querySelector<HTMLButtonElement>(".ub-docs-pin");
    await act(async () => pin?.click());
    expect(host.querySelectorAll(".ub-list .ub-group")).toHaveLength(1);
    expect(host.querySelector(".ub-all-open-entry")?.textContent).toContain(
      "All docs",
    );
    expect(rowTitles(host)).toEqual(["Overview"]);
  });

  it("pins a row into the sidebar document a second client reads", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    const sidebarPeer = peerOf(sidebarDoc());

    const host = await openApp(allPath(WORKSPACE));
    const pin = (): HTMLButtonElement | null =>
      host.querySelector<HTMLButtonElement>(".ub-docs-pin");
    expect(pin()?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => pin()?.click());
    expect(readSidebar(sidebarPeer).map((group) => group.docs)).toEqual([[ONE]]);
    expect(pin()?.getAttribute("aria-pressed")).toBe("true");
    // The pin is what puts the group in the row: one write, both readings.
    expect(host.querySelector(".ub-docs-group")?.textContent).toBe("Pinned");

    // The same control both ways, and the document is what remembers.
    await act(async () => pin()?.click());
    expect(readSidebar(sidebarPeer).map((group) => group.docs)).toEqual([[]]);
    expect(pin()?.getAttribute("aria-pressed")).toBe("false");
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
      host.querySelector<HTMLButtonElement>(".ub-docs-open")?.click(),
    );
    expect(window.location.pathname).toBe(`/${WORKSPACE}/${ONE}`);

    // A reload: the app goes, the address stays, and the document opens.
    unmount();
    const again = await openApp(`/${WORKSPACE}/${ONE}`);
    expect(again.querySelector(".ub-docs-rows")).toBeNull();
    expect(again.querySelector<HTMLInputElement>(".ub-title")?.value).toBe(
      "Overview",
    );
  });
});
