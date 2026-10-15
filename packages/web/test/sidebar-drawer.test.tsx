/**
 * App owns the sidebar's two independent states and navigation dismissal.
 * jsdom observes that wiring; the browser suite owns layout and real input.
 * Radix owns the modal's focus trap, Escape and outside dismissal.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, renderSettled, type RenderResult } from "./react-render.js";
import * as Y from "yjs";
import {
  appendBlock,
  createGroup,
  directoryRoom,
  initDoc,
  pinDoc,
  readSidebar,
  roomForDoc,
  setWorkspaceName,
  settingsRoom,
  sidebarRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const OTHER_WORKSPACE = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";
const ONE = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const TWO = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";
const COLLAPSED_KEY = "uberblick.sidebar.collapsed";
const NARROW_QUERY = "(width < 80rem)";

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
  mintHubAuthMessage: async (workspace: string) => workspace,
}));

const { App } = await import("../src/ui/App.js");

let mounted: RenderResult | null = null;
let stored: Map<string, string>;
let writes: string[];

function sidebarWidth(narrow: boolean): { change: (next: boolean) => Promise<void> } {
  let matches = narrow;
  const listeners = new Set<() => void>();
  const query = {
    get matches() { return matches; },
    media: NARROW_QUERY,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (media: string) =>
    media === NARROW_QUERY
      ? query
      : { matches: false, addEventListener: () => {}, removeEventListener: () => {} },
  );
  return {
    change: async (next) => {
      await act(async () => {
        matches = next;
        for (const listener of listeners) listener();
      });
      await settleFocus();
    },
  };
}

beforeEach(() => {
  stored = new Map();
  writes = [];
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      stored.set(key, value);
    },
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({
      hubUrl: "ws://127.0.0.1:4321",
      workspaces: [WORKSPACE, OTHER_WORKSPACE],
    })),
  );
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const empty = new DOMRect();
  Range.prototype.getClientRects = () => [empty] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => empty;
  sidebarWidth(true);

  const directory = room(directoryRoom(WORKSPACE)).ydoc;
  const sidebar = room(sidebarRoom(WORKSPACE)).ydoc;
  const group = createGroup(sidebar, "Pinned");
  for (const [uuid, title] of [[ONE, "Overview"], [TWO, "Editing"]] as const) {
    const doc = room(roomForDoc(WORKSPACE, uuid)).ydoc;
    initDoc(doc, { uuid, title });
    appendBlock(doc, { type: "paragraph", text: title });
    upsertDirectoryEntry(directory, { uuid, title });
    pinDoc(sidebar, group, uuid);
  }
});

function unmount(): void {
  mounted?.unmount();
  mounted = null;
}

afterEach(() => {
  mounted = null;
  rooms.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openApp(path = `/${WORKSPACE}/${ONE}`): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  mounted = await renderSettled(<App />);
  return mounted.container;
}

function drawer(): HTMLElement | null {
  // A portaled workspace menu temporarily hides the drawer's dialog role.
  // Its title still identifies the mounted boundary, including during menus.
  return screen.queryByText("Sidebar")?.closest<HTMLElement>('[role="dialog"]') ?? null;
}

function labelledButton(label: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: label });
}

function sidebarButton(name: string | RegExp): HTMLButtonElement {
  const sidebar = drawer();
  if (sidebar === null) throw new Error("Missing sidebar drawer");
  return within(sidebar).getByRole<HTMLButtonElement>("button", { name });
}

async function settleFocus(): Promise<void> {
  // Radix releases a closing focus scope on its next task; App restores focus
  // after that release so navigation cannot leave it in unmounted content.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => button.click());
  await settleFocus();
}

async function openDrawer(settings = false): Promise<void> {
  await click(labelledButton(settings ? "Show sidebar" : "Show document list"));
  expect(drawer()).not.toBeNull();
}

async function openWorkspaceMenu(): Promise<void> {
  const button = sidebarButton(/^Unnamed workspace(?: · 6f4c8a51)? 127\.0\.0\.1:4321$/);
  await act(async () => {
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(drawer()).not.toBeNull();
}

function menuItem(text: string): HTMLElement {
  return screen.getByRole("menuitem", { name: text });
}

it("keeps the drawer unsaved and closed on load and narrowing with desktop collapse saved", async () => {
  const preference = "true";
  stored.set(COLLAPSED_KEY, preference);
  const width = sidebarWidth(true);
  let host = await openApp();
  expect(drawer()).toBeNull();
  expect(labelledButton("Show document list")).not.toBeNull();

  await openDrawer();
  expect(within(drawer() as HTMLElement).getByRole("navigation", { name: "Documents" }).hasAttribute("inert"))
    .toBe(false);
  await click(labelledButton("Close document list"));
  expect(drawer()).toBeNull();
  expect(document.activeElement).toBe(labelledButton("Show document list"));
  expect(stored.get(COLLAPSED_KEY)).toBe(preference);

  await openDrawer();
  await width.change(false);
  expect(drawer()).toBeNull();
  // This unnamed layout wrapper exposes desktop state independently of the
  // mobile dialog; data-state is the contract being asserted.
  expect(host.querySelector('[data-slot="sidebar-wrapper"]')?.getAttribute("data-state"))
    .toBe(preference === "true" ? "collapsed" : "expanded");
  await width.change(true);
  expect(drawer()).toBeNull();
  await openDrawer();
  unmount();
  host = await openApp();
  expect(drawer()).toBeNull();
  expect(within(host).getByRole("button", { name: "Show document list" })).not.toBeNull();
  expect(stored.get(COLLAPSED_KEY)).toBe(preference);
  expect(writes).not.toContain(COLLAPSED_KEY);
});

const destinations = [
  { choice: "another document", name: "Editing", path: `/${WORKSPACE}/${TWO}` },
  { choice: "Workspace settings", name: "Workspace settings", path: `/${WORKSPACE}/settings` },
  { choice: "another workspace", menu: `Unnamed workspace · ${OTHER_WORKSPACE.slice(0, 8)}`, path: `/${OTHER_WORKSPACE}` },
];

it("retires each outgoing drawer pane from interaction and assistive navigation", async () => {
  await openApp();

  function expectMode(settings: boolean): void {
    // A label query also finds the retired navigation whose role/name is
    // suppressed by aria-hidden; this asserts mounted boundary state.
    const documentsPane = within(drawer() as HTMLElement).getByLabelText("Documents");
    const settingsPane = within(drawer() as HTMLElement).getByLabelText("Workspace settings");
    for (const [pane, retired] of [[documentsPane, settings], [settingsPane, !settings]] as const) {
      expect(pane).not.toBeNull();
      expect(pane?.hasAttribute("inert")).toBe(retired);
      expect(pane?.getAttribute("aria-hidden")).toBe(String(retired));
    }
  }

  await openDrawer();
  expectMode(false);
  await click(sidebarButton("Workspace settings"));
  await openDrawer(true);
  expectMode(true);
  await click(sidebarButton("Back to Unnamed workspace"));
  await openDrawer();
  expectMode(false);
});

it.each(destinations)("closes and restores focus after choosing $choice", async (destination) => {
  // A saved hidden desktop sidebar must not retire the open drawer's controls.
  stored.set(COLLAPSED_KEY, "true");
  await openApp();
  await openDrawer();
  if ("menu" in destination) {
    await openWorkspaceMenu();
    await click(menuItem(destination.menu));
  } else {
    await click(sidebarButton(destination.name));
  }

  expect(drawer()).toBeNull();
  const settings = window.location.pathname.includes("/settings");
  expect(document.activeElement).toBe(labelledButton(settings ? "Show sidebar" : "Show document list"));
  expect(stored.get(COLLAPSED_KEY)).toBe("true");
  expect(writes).not.toContain(COLLAPSED_KEY);
  expect(window.location.pathname).toBe(destination.path);
});

it.each([
  { remoteHubUrl: "wss://notes.example:8443/rooms/ws", location: "notes.example:8443" },
  { remoteHubUrl: null, location: "This device" },
])("names the routed workspace's own location: $location", async ({ remoteHubUrl, location }) => {
  vi.mocked(fetch).mockImplementation(async (input, init) => new Response(JSON.stringify(input === "/api/access"
    ? { status: "forbidden", hub: init?.headers && new Headers(init.headers).get("Authorization") === `Bearer ${OTHER_WORKSPACE}`
      ? "https://notes.example:8443" : "https://hub.example" }
    : {
    hubUrl: "ws://127.0.0.1:4321",
    workspaces: [WORKSPACE, OTHER_WORKSPACE],
    servedWorkspaces: {
      [WORKSPACE]: { name: "Product", remoteHubUrl: "wss://hub.example/rooms/ws" },
      [OTHER_WORKSPACE]: { name: "Notes", remoteHubUrl },
    },
  })));
  setWorkspaceName(room(settingsRoom(WORKSPACE)).ydoc, "Product");
  setWorkspaceName(room(settingsRoom(OTHER_WORKSPACE)).ydoc, "Notes");
  await openApp();
  await openDrawer();

  const firstHeader = sidebarButton("Product hub.example");
  expect(firstHeader.textContent).not.toContain("127.0.0.1");
  await act(async () => {
    firstHeader.focus();
    firstHeader.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await click(menuItem("Notes"));
  expect(window.location.pathname).toBe(`/${OTHER_WORKSPACE}`);
  await openDrawer();

  const nextHeader = sidebarButton(`Notes ${location}`);
  expect(nextHeader.textContent).not.toContain("127.0.0.1");
  expect(nextHeader.textContent).not.toContain("hub.example");
});

it.each([
  { answer: { status: "local-only", hub: null }, location: "This device", rebound: false },
  { answer: { status: "not-configured", hub: "http://localhost:1234" }, location: "localhost:1234", rebound: false },
  { answer: { status: "hub-down", hub: null }, location: null, rebound: false },
  { answer: { status: "local-only", hub: null }, location: null, rebound: true },
])("names the startup binding from its access reading: $answer.status, rebound=$rebound", async ({ answer, location, rebound }) => {
  vi.mocked(fetch).mockImplementation(async (input) => Response.json(input === "/api/access" ? answer : {
    hubUrl: "ws://127.0.0.1:4321",
    workspaces: [WORKSPACE],
    rebound,
    servedWorkspaces: { [WORKSPACE]: { name: "Notes", remoteHubUrl: "ws://localhost:1234" } },
  }));
  setWorkspaceName(room(settingsRoom(WORKSPACE)).ydoc, "Notes");
  await openApp();
  await openDrawer();
  const header = sidebarButton(location === null ? "Notes" : `Notes ${location}`);
  expect(header.querySelector(".ub-workspace-location")?.textContent ?? null).toBe(location);
});

it("omits an unconfirmed startup location and retires its answer on an unserved route", async () => {
  let finishAccess: ((response: Response) => void) | undefined;
  vi.mocked(fetch).mockImplementation(async (input) => input === "/api/access"
    ? new Promise<Response>((resolve) => { finishAccess = resolve; })
    : Response.json({
      hubUrl: "ws://127.0.0.1:4321",
      workspaces: [WORKSPACE],
      servedWorkspaces: { [WORKSPACE]: { name: "Notes", remoteHubUrl: "ws://localhost:1234" } },
    }));
  setWorkspaceName(room(settingsRoom(WORKSPACE)).ydoc, "Notes");
  await openApp();
  await openDrawer();
  expect(sidebarButton("Notes").querySelector(".ub-workspace-location")).toBeNull();

  await act(async () => {
    window.history.pushState(null, "", `/${OTHER_WORKSPACE}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await act(async () => finishAccess?.(Response.json({ status: "local-only", hub: null })));
  expect(sidebarButton("Unnamed workspace").querySelector(".ub-workspace-location")).toBeNull();
});

// Safari's order: compositionend lands before the Escape keydown, which then
// reads isComposing false and only the IME keyCode still says it is composing.
it("leaves composing Escape after compositionend (Safari) to the group-name field", async () => {
  await openApp();
  await openDrawer();
  await click(sidebarButton("+ group"));
  const field = within(drawer() as HTMLElement).getByRole<HTMLInputElement>("textbox", { name: "Group name" });
  const sidebar = room(sidebarRoom(WORKSPACE)).ydoc;
  const groups = readSidebar(sidebar);
  field.value = "日本語";
  await act(async () => {
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true, isComposing: false, keyCode: 229,
    }));
  });
  expect(within(drawer() as HTMLElement).getByRole("textbox", { name: "Group name" })).toBe(field);
  expect(field.value).toBe("日本語");
  expect(document.activeElement).toBe(field);
  expect(readSidebar(sidebar)).toEqual(groups);

  // The next ordinary Escape cancels the fresh name and removes its group,
  // while the sidebar's capture-phase listener still leaves the drawer open.
  await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true,
  })));
  expect(drawer()).not.toBeNull();
  expect(within(drawer() as HTMLElement).queryByRole("textbox", { name: "Group name" })).toBeNull();
  expect(readSidebar(sidebar)).toEqual(groups.slice(0, -1));
});
