/**
 * "All docs" (#118): the fixed sidebar entry, and the listing it opens.
 *
 * One claim: **the listing is the directory doc, ordered.** So the rows are
 * asserted against what a *peer* replica of the `_directory` room holds — the
 * same reading `list_docs` produces — rather than against anything this client
 * did, and a remote create or rename is driven by writing to that peer. A
 * listing that agreed with local history but not with the directory would be a
 * second corpus, which is the one thing discovery cannot be.
 *
 * The app is mounted whole over shared Y.Docs (the `sidebar.test.tsx`
 * harness): `acquireRoom` is mocked so a room is a plain Y.Doc, because the
 * transport is not what is under test.
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
  directoryRoom,
  readSidebar,
  sidebarRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { allPath, canonicalPath, parseRoute } from "../src/ui/route.js";
import { sortDirectory } from "../src/ui/AllDocsPane.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
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
let storage = new Map<string, string>();

function installStorage(failing = false): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => {
        if (failing) throw new Error("storage is unavailable");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (failing) throw new Error("storage is unavailable");
        storage.set(key, value);
      },
      removeItem: (key: string) => void storage.delete(key),
      clear: () => storage.clear(),
    },
  });
}

let mounted: { root: Root; host: HTMLElement } | null = null;

beforeEach(() => {
  storage = new Map();
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

function directoryDoc(): Y.Doc {
  return room(directoryRoom(WORKSPACE)).ydoc;
}

/** The titles the listing shows, top to bottom. */
function rowTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".ub-all-title")].map(
    (node) => node.textContent ?? "",
  );
}

function sortButton(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>(".ub-all-sort")].find(
    (button) => button.textContent === label,
  );
  if (found === undefined) throw new Error(`no sort control called ${label}`);
  return found;
}

/** Which sort control reads as chosen. */
function chosenSort(host: HTMLElement): string | null {
  return (
    [...host.querySelectorAll<HTMLButtonElement>(".ub-all-sort")].find(
      (button) => button.getAttribute("aria-pressed") === "true",
    )?.textContent ?? null
  );
}

function entry(over: Partial<DirectoryEntry> & { uuid: string }): DirectoryEntry {
  return { title: "", tags: [], ...over };
}

describe("the sort", () => {
  const stamped = [
    entry({ uuid: ONE, title: "Beta", createdAt: 300, updatedAt: 100 }),
    entry({ uuid: TWO, title: "Alpha", createdAt: 100, updatedAt: 300 }),
    entry({ uuid: THREE, title: "Gamma", createdAt: 200, updatedAt: 200 }),
  ];

  it("orders by title A–Z, by last changed newest first, by created newest first", () => {
    const titles = (sort: "title" | "changed" | "created"): string[] =>
      sortDirectory(stamped, sort).map((row) => row.title);
    expect(titles("title")).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(titles("changed")).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(titles("created")).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("puts documents with no stamp last under both time sorts, in title order", () => {
    // The stamps are optional by construction: a stub written before they
    // existed carries none, and "no answer" is not "very old".
    const mixed = [
      ...stamped,
      entry({ uuid: GONE, title: "Zeta" }),
      entry({ uuid: "aaaa1111-2222-4333-8444-555566667777", title: "Aardvark" }),
    ];
    for (const sort of ["changed", "created"] as const) {
      const titles = sortDirectory(mixed, sort).map((row) => row.title);
      expect(titles.slice(-2)).toEqual(["Aardvark", "Zeta"]);
      expect(titles).toHaveLength(5);
    }
  });

  it("breaks ties by title, so a re-render never reshuffles the rows", () => {
    const tied = [
      entry({ uuid: ONE, title: "Second", updatedAt: 500 }),
      entry({ uuid: TWO, title: "First", updatedAt: 500 }),
    ];
    expect(sortDirectory(tied, "changed").map((row) => row.title)).toEqual([
      "First",
      "Second",
    ]);
  });
});

describe("the listing", () => {
  it("is the directory's non-deleted set, and lives at /<workspace>/all", async () => {
    const directory = directoryDoc();
    const peer = peerOf(directory);
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Editing" });
    upsertDirectoryEntry(peer, { uuid: GONE, title: "Archived" });
    tombstoneDirectoryEntry(peer, GONE);

    const host = await openApp(allPath(WORKSPACE));

    expect(rowTitles(host)).toEqual(["Editing", "Overview"]);
    // The address is the one the entry hands out, and it survives a parse.
    expect(window.location.pathname).toBe(`/${WORKSPACE}/all`);
    expect(parseRoute(`/${WORKSPACE}/all`, null)).toEqual({
      kind: "all",
      workspace: { uuid: WORKSPACE, segment: WORKSPACE },
    });
    expect(canonicalPath(parseRoute(`/${WORKSPACE}/ALL/`, null))).toBe(
      `/${WORKSPACE}/all`,
    );
  });

  it("follows a remote create and a remote rename with nobody telling it", async () => {
    const directory = directoryDoc();
    const peer = peerOf(directory);
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

  it("shows a stamp where the directory has one and a dash where it has none", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, {
      uuid: ONE,
      title: "Stamped",
      createdAt: Date.UTC(2026, 0, 2),
      updatedAt: Date.UTC(2026, 0, 3),
    });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Unstamped" });

    const host = await openApp(allPath(WORKSPACE));
    const rows = [...host.querySelectorAll(".ub-all-row")];
    expect(
      [...(rows[0]?.querySelectorAll("time") ?? [])].map((node) =>
        node.getAttribute("dateTime"),
      ),
    ).toEqual(["2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    expect(rows[1]?.querySelectorAll("time")).toHaveLength(0);
    expect(rows[1]?.textContent).toContain("—");
  });
});

describe("the sidebar entry", () => {
  it("is there whether anything is pinned or not, and opens the listing", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });

    // Nothing pinned: the sidebar says so, and the entry is still there.
    const host = await openApp(`/${WORKSPACE}`);
    expect(host.querySelector(".ub-list .ub-group")).toBeNull();
    const open = host.querySelector<HTMLButtonElement>(".ub-all-open-entry");
    expect(open?.textContent).toContain("All docs");

    await act(async () => open?.click());
    expect(window.location.pathname).toBe(`/${WORKSPACE}/all`);
    expect(rowTitles(host)).toEqual(["Overview"]);
    expect(
      host.querySelector(".ub-all-open-entry")?.getAttribute("aria-current"),
    ).toBe("page");

    // And with a pin in the sidebar it is exactly where it was: the entry is
    // not part of the curation above it.
    const pin = host.querySelector<HTMLButtonElement>(".ub-all-pin");
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
    const sidebarPeer = peerOf(room(sidebarRoom(WORKSPACE)).ydoc);

    const host = await openApp(allPath(WORKSPACE));
    const pin = (): HTMLButtonElement | null =>
      host.querySelector<HTMLButtonElement>(".ub-all-pin");
    expect(pin()?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => pin()?.click());
    expect(readSidebar(sidebarPeer).map((group) => group.docs)).toEqual([[ONE]]);
    expect(pin()?.getAttribute("aria-pressed")).toBe("true");

    // The same control both ways, and the document is what remembers.
    await act(async () => pin()?.click());
    expect(readSidebar(sidebarPeer).map((group) => group.docs)).toEqual([[]]);
    expect(pin()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens the document a row names", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Overview" });

    const host = await openApp(allPath(WORKSPACE));
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".ub-all-open")?.click(),
    );
    expect(window.location.pathname).toBe(`/${WORKSPACE}/${ONE}`);
  });
});

describe("the sort choice", () => {
  it("survives a reload", async () => {
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Beta", createdAt: 300 });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Alpha", createdAt: 100 });

    const host = await openApp(allPath(WORKSPACE));
    expect(rowTitles(host)).toEqual(["Alpha", "Beta"]);

    await act(async () => sortButton(host, "Created").click());
    expect(rowTitles(host)).toEqual(["Beta", "Alpha"]);

    // A reload: the app goes, the storage stays.
    unmount();
    const reloaded = await openApp(allPath(WORKSPACE));
    expect(chosenSort(reloaded)).toBe("Created");
    expect(rowTitles(reloaded)).toEqual(["Beta", "Alpha"]);
  });

  it("renders and sorts with no storage to remember it in", async () => {
    installStorage(true);
    const peer = peerOf(directoryDoc());
    upsertDirectoryEntry(peer, { uuid: ONE, title: "Beta", createdAt: 300 });
    upsertDirectoryEntry(peer, { uuid: TWO, title: "Alpha", createdAt: 100 });

    const host = await openApp(allPath(WORKSPACE));
    expect(chosenSort(host)).toBe("Title");
    expect(rowTitles(host)).toEqual(["Alpha", "Beta"]);

    // The choice still holds for this tab; only remembering it is lost.
    await act(async () => sortButton(host, "Created").click());
    expect(rowTitles(host)).toEqual(["Beta", "Alpha"]);
  });
});
