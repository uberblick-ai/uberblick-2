import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import { setWorkspaceName, settingsRoom } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { WorkspaceSwitcher } from "../src/ui/WorkspaceSwitcher.js";
import { useWorkspaceNames, workspaceLabel } from "../src/ui/workspace-names.js";
import type { Workspace } from "../src/ui/route.js";

const held = vi.hoisted(() => ({ rooms: new Map<string, unknown>(), acquire: vi.fn(), release: vi.fn() }));
vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (...args: unknown[]) => {
    held.acquire(...args);
    return { connection: held.rooms.get(args[0] as string), release: held.release };
  },
}));

const ONE: Workspace = { uuid: "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4", segment: "old-6f4c8a51-2b7d-4e39-9a06-c81d3f572be4" };
const TWO: Workspace = { uuid: "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e", segment: "research-b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e" };
const IDENTITY = { name: "unhurried otter", color: "#0675c9" };
const SYNCED: RoomStatus = {
  connected: true, synced: true, hasReceivedServerState: true, hasAnswered: true,
  writable: true, storeRefused: false, unsyncedChanges: 0, protocolMismatch: null,
  authFailed: false, tokenMissing: false,
};

function room(workspace: Workspace, name: string | null, received = true): RoomConnection {
  const ydoc = new Y.Doc();
  if (name !== null) setWorkspaceName(ydoc, name);
  const status = { ...SYNCED, hasReceivedServerState: received };
  return {
    room: settingsRoom(workspace.uuid), ydoc, status,
    onStatusChange: (listener: (status: RoomStatus) => void) => { listener(status); return () => {}; },
  } as RoomConnection;
}

let mounted: { root: Root; host: HTMLElement } | null = null;
beforeEach(() => {
  held.rooms.clear(); held.acquire.mockClear(); held.release.mockClear();
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  Element.prototype.scrollIntoView = () => {};
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => mounted?.root.unmount()); mounted?.host.remove(); mounted = null;
  for (const connection of held.rooms.values()) (connection as RoomConnection).ydoc.destroy();
  vi.unstubAllGlobals();
});

function Probe({ current, connection, menuOpen = false, onSwitch = () => {} }: {
  current: Workspace; connection: RoomConnection | null; menuOpen?: boolean;
  onSwitch?: (segment: string) => void;
}) {
  const names = useWorkspaceNames([ONE, TWO], current.uuid, connection, IDENTITY, menuOpen);
  return <WorkspaceSwitcher workspaces={[ONE, TWO]} current={current} names={names} docs={0} onSwitch={onSwitch} onOpenSettings={() => {}} />;
}
function render(element: React.ReactElement): HTMLElement {
  if (mounted === null) {
    const host = document.createElement("div"); document.body.appendChild(host);
    mounted = { host, root: createRoot(host) };
  }
  act(() => mounted?.root.render(element));
  return mounted.host;
}
function open(host: HTMLElement): void {
  const trigger = host.querySelector<HTMLButtonElement>(".ub-workspace");
  act(() => trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
function entries(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]")].filter((item) => item.querySelector(".ub-menu-text"));
}

it("reads other workspace names silently while offered, and keeps duplicate names as separate routes", () => {
  const one = room(ONE, "Product Research");
  const two = room(TWO, "Product Research");
  held.rooms.set(two.room, two);
  const onSwitch = vi.fn();
  const host = render(<Probe current={ONE} connection={one} menuOpen onSwitch={onSwitch} />);
  expect(held.acquire).toHaveBeenCalledWith(settingsRoom(TWO.uuid), IDENTITY, { presence: false });
  open(host);
  expect(entries().map((entry) => entry.querySelector(".ub-menu-text")?.textContent)).toEqual(["Product Research", "Product Research"]);
  act(() => setWorkspaceName(two.ydoc, "Field Notes"));
  expect(entries().map((entry) => entry.querySelector(".ub-menu-text")?.textContent)).toEqual(["Product Research", "Field Notes"]);
  act(() => setWorkspaceName(two.ydoc, "Changed elsewhere"));
  expect(entries().map((entry) => entry.querySelector(".ub-menu-text")?.textContent)).toEqual(["Product Research", "Changed elsewhere"]);
  expect(held.acquire).toHaveBeenCalledOnce();
  act(() => entries()[1]?.click());
  expect(onSwitch).toHaveBeenCalledWith(TWO.segment);
  render(<Probe current={ONE} connection={one} />);
  expect(held.release).toHaveBeenCalledOnce();
  one.ydoc.destroy();
});

it("uses distinct neutral labels while names are absent or unreadable, including colliding UUID prefixes", () => {
  const colliding: Workspace = { uuid: `${ONE.uuid.slice(0, -1)}5`, segment: `${ONE.uuid.slice(0, -1)}5` };
  const names = new Map<string, string | null>();
  const labels = [ONE, colliding].map((workspace) => workspaceLabel(workspace, names, [ONE, colliding]));
  expect(labels).toEqual(["Unnamed workspace · 6f4c8a51 (1)", "Unnamed workspace · 6f4c8a51 (2)"]);
  for (const [index, label] of labels.entries()) expect(label).not.toContain([ONE, colliding][index]?.uuid);
  const one = room(ONE, "This name has not arrived", false);
  const two = room(TWO, null, false);
  held.rooms.set(two.room, two);
  const host = render(<Probe current={ONE} connection={one} menuOpen />);
  expect(host.querySelector(".ub-workspace-name")?.textContent).toBe("Unnamed workspace · 6f4c8a51");
  open(host);
  expect(entries().map((entry) => entry.querySelector(".ub-menu-text")?.textContent)).toEqual(["Unnamed workspace · 6f4c8a51", "Unnamed workspace · b2d9e4c7"]);
  one.ydoc.destroy();
});

it("never reuses the previous workspace's name when a route switches before its settings arrive", () => {
  const one = room(ONE, "Original workspace");
  const host = render(<Probe current={ONE} connection={one} />);
  expect(host.querySelector(".ub-workspace-name")?.textContent).toBe("Original workspace");
  render(<Probe current={TWO} connection={one} />);
  expect(host.querySelector(".ub-workspace-name")?.textContent).toBe("Unnamed workspace · b2d9e4c7");
  expect(host.textContent).not.toContain("Original workspace");
  one.ydoc.destroy();
});
