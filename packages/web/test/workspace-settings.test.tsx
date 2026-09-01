/**
 * Workspace settings mode (#485).
 *
 * Three claims, and everything here is a way of asking one of them.
 *
 * 1. **The address is the mode.** Entering, leaving and arriving by link are one
 *    gesture, because all three are `parseRoute` over the address bar — which is
 *    also why browser Back is the way out and nothing else remembers the mode.
 *    What each pathname *means* is `route.test.tsx`; this file is the app's
 *    wiring of it.
 * 2. **Exactly one pane is live.** The column holds one sidebar at rest and two
 *    for the length of the slide, and the one being left takes no pointer, holds
 *    no focus and is out of the accessibility tree the whole time. A transform
 *    alone would leave its draggable rows and its drop slots reachable, which is
 *    the bug this rules out.
 * 3. **Every fact on the General page is a reading**, of state this client
 *    already holds — with each fact keeping the unknown answer its own source
 *    has. Nothing here asks the hub anything, which is the point: the page has
 *    to be right in the outage a reader opens it during.
 *
 * The app is mounted whole over shared Y.Docs, the `sidebar.test.tsx` harness:
 * `acquireRoom` is mocked so a room is a plain Y.Doc, because the transport is
 * not what is under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import * as Y from "yjs";
import { directoryRoom, upsertDirectoryEntry } from "@uberblick/schema";
import { hubEndpoint } from "../src/config.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
/** The same workspace as an address may spell it — the slug is display. */
const SEGMENT = `uberblick-${WORKSPACE}`;
const ONE = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const TWO = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";

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

/** What every stubbed room reports; set before the rooms are made. */
let roomStatus: RoomStatus = OFFLINE;

const rooms = new Map<string, RoomConnection>();

function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: roomStatus,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(roomStatus);
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

/** A fresh in-memory Storage — Node's own global shadows jsdom's here. */
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
  roomStatus = OFFLINE;
  vi.useRealTimers();
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

/** Two documents in the directory, so the workspace has a count to report. */
function seedDirectory(): void {
  const directory = room(directoryRoom(WORKSPACE)).ydoc;
  upsertDirectoryEntry(directory, { uuid: ONE, title: "Overview" });
  upsertDirectoryEntry(directory, { uuid: TWO, title: "Editing" });
}

function click(element: Element | null | undefined): void {
  act(() => (element as HTMLElement | null | undefined)?.click());
}

/**
 * The pane the reader is actually in — the one that is not inert.
 *
 * Everything about the column is asked of this rather than of the host, because
 * for the length of a slide there are two columns and only one of them is on
 * screen. A test that read the host would be reading whichever the DOM happened
 * to hold first.
 */
function liveColumn(host: HTMLElement): HTMLElement {
  const live = host.querySelector<HTMLElement>(".ub-sidebar-pane:not([inert])");
  if (live === null) throw new Error("no live sidebar pane");
  return live;
}

/** The row with these words, wherever in the live column it is. */
function row(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...liveColumn(host).querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );
}

/** The General page's facts, as `{label: value}`. */
function facts(host: HTMLElement): Record<string, string> {
  const read: Record<string, string> = {};
  for (const fact of host.querySelectorAll(".ub-settings-facts .ub-panel-fact")) {
    read[fact.querySelector("dt")?.textContent ?? ""] =
      fact.querySelector("dd")?.textContent ?? "";
  }
  return read;
}

/** The two panes of the sidebar's track, document mode first. */
function panes(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".ub-sidebar-pane")];
}

/**
 * Everything in `scope` a person could reach: a control, a drag handle, or a
 * place a drag can land. The three the acceptance criterion names, and the three
 * a pane that had merely been slid off screen would keep offering.
 */
function reachable(scope: ParentNode): HTMLElement[] {
  return [
    ...scope.querySelectorAll<HTMLElement>(
      'button, a[href], input, [tabindex], [draggable="true"], .ub-drop-slot',
    ),
  ];
}

describe("settings mode is an address, and the way out is the address bar", () => {
  it("opens from the footer row, and Back returns to the workspace", async () => {
    seedDirectory();
    const host = await openApp(`/${SEGMENT}`);
    expect(row(host, "Workspace settings")).toBeDefined();

    click(row(host, "Workspace settings"));
    expect(window.location.pathname).toBe(`/${SEGMENT}/settings`);
    // The column is the settings navigation now: a way back, the section, and
    // General as the page on screen.
    const column = liveColumn(host);
    expect(column.querySelector(".ub-nav-label")?.textContent).toBe(
      "Workspace settings",
    );
    expect(column.querySelector(".ub-back-entry")?.textContent).toContain(SEGMENT);
    expect(row(host, "General")?.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector(".ub-settings-heading")?.textContent).toBe("General");
    // The user card is not what the mode swaps: this client is who it is in
    // either one.
    expect(column.querySelectorAll(".ub-user-card")).toHaveLength(1);

    // And the chrome that names the column stays true: it is not the document
    // list that is on screen to hide.
    expect(
      host.querySelector(".ub-sidebar-toggle")?.getAttribute("aria-label"),
    ).toBe("Hide settings navigation");

    click(column.querySelector(".ub-back-entry"));
    expect(window.location.pathname).toBe(`/${SEGMENT}`);
    expect(liveColumn(host).querySelector(".ub-list-head")).not.toBeNull();
    expect(
      host.querySelector(".ub-sidebar-toggle")?.getAttribute("aria-label"),
    ).toBe("Hide document list");
  });

  it("opens settings mode directly from a pasted link, with no swap to run", async () => {
    // The mode is the address and nothing else, so a fresh tab at it is already
    // in it — and there is no outgoing pane to keep alive, because nothing was
    // left.
    seedDirectory();
    const host = await openApp(`/${SEGMENT}/settings`);

    expect(host.querySelector(".ub-back-entry")).not.toBeNull();
    expect(host.querySelector(".ub-list-head")).toBeNull();
    expect(reachable(panes(host)[0] as HTMLElement)).toHaveLength(0);
  });
});

describe("exactly one sidebar pane is live", () => {
  it("keeps the pane it is leaving inert for the whole slide, then lets it go", async () => {
    seedDirectory();
    const host = await openApp(`/${SEGMENT}`);
    const [docs, settings] = panes(host) as [HTMLElement, HTMLElement];

    // Document mode at rest: the settings pane holds nothing at all, and the
    // document sidebar is live.
    expect(docs.hasAttribute("inert")).toBe(false);
    expect(reachable(settings)).toHaveLength(0);
    expect(reachable(docs).length).toBeGreaterThan(0);

    // The slide. Both panes hold a column now — that is what there is to
    // animate — and the one being left is dead for the whole of it.
    vi.useFakeTimers();
    click(row(host, "Workspace settings"));
    expect(reachable(docs).length).toBeGreaterThan(0);
    expect(docs.hasAttribute("inert")).toBe(true);
    expect(settings.hasAttribute("inert")).toBe(false);
    // Nothing the outgoing column offers is offered: no control, no drag handle,
    // and no drop slot outside that inert subtree.
    for (const element of reachable(docs)) {
      expect(element.closest("[inert]")).toBe(docs);
    }
    expect(docs.querySelectorAll(".ub-drop-slot").length).toBeGreaterThan(0);

    // And once the slide is over the column it left is gone, so the pane is
    // empty rather than merely unreachable.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(reachable(docs)).toHaveLength(0);
    expect(reachable(settings).length).toBeGreaterThan(0);
  });
});

describe("the General page reads state this client already holds", () => {
  it("names the workspace, its documents, its hub and its connection", async () => {
    seedDirectory();
    const host = await openApp(`/${SEGMENT}/settings`);
    const endpoint = hubEndpoint();
    const shown = facts(host);

    // The identity, and how this address spells it: only the uuid reaches a
    // room key, and the two are different facts.
    expect(shown.Workspace).toBe(WORKSPACE);
    expect(shown.Address).toBe(SEGMENT);
    // Live from the directory, like the switcher's own count.
    expect(shown.Documents).toBe("2");
    // The endpoint this session actually resolved, and who decided it — not a
    // second derivation of either.
    expect(shown.Hub).toBe(endpoint.url);
    expect(shown.Source).toContain("uberblick-config.json");
    // The room is offline in this harness, and the page says so without a
    // request having been made.
    expect(shown.Connection).toBe("offline");
    expect(shown["MCP connections"]).toBe("0");
    // jsdom has no Storage API, and a browser that will not estimate gets an
    // omitted row rather than a zero nobody can vouch for.
    expect(shown["Local cache"]).toBeUndefined();
  });

  it("reads a refusal in the words the status line reads it in", async () => {
    // The one reading that is not "how is the socket": a page served without a
    // token will never sync, and calling that `offline` would name the wrong
    // fix. It is the shared reading (#448), so it arrives here with the sentence
    // saying what to do about it.
    roomStatus = { ...OFFLINE, tokenMissing: true };
    seedDirectory();
    const host = await openApp(`/${SEGMENT}/settings`);
    const shown = facts(host);

    expect(shown.Connection).toBe("no hub token");
    expect(shown.Reason).toContain("served without a hub token");
  });
});
