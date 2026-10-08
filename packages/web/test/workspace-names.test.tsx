import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, render, type RenderResult } from "./react-render.js";
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

let mounted: RenderResult | null = null;
beforeEach(() => {
  held.rooms.clear(); held.acquire.mockClear(); held.release.mockClear();
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  mounted = null;
  for (const connection of held.rooms.values()) (connection as RoomConnection).ydoc.destroy();
  vi.unstubAllGlobals();
});

function Probe({ current, connection, menuOpen = false, onSwitch = () => {}, recordedNames = null }: {
  current: Workspace; connection: RoomConnection | null; menuOpen?: boolean;
  onSwitch?: (segment: string) => void;
  recordedNames?: ReadonlyMap<string, string | null> | null;
}) {
  const names = useWorkspaceNames([ONE, TWO], current.uuid, connection, IDENTITY, menuOpen, recordedNames);
  return <WorkspaceSwitcher workspaces={[ONE, TWO]} current={current} names={names} onSwitch={onSwitch} />;
}
function mount(element: React.ReactElement): HTMLElement {
  if (mounted === null) {
    mounted = render(element);
  } else {
    mounted.rerender(element);
  }
  return mounted.container;
}
function open(host: HTMLElement, name: string): void {
  const trigger = within(host).getByRole("button", { name });
  act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
function entries(): HTMLElement[] {
  return within(screen.getByRole("menu")).getAllByRole("menuitem", { hidden: true });
}
function entryNames(): string[] {
  // The current row also holds an aria-hidden check, outside its visible label.
  return entries().map((entry) => within(entry).getByText(/^(?!✓$).+/).textContent ?? "");
}

it("reads other workspace names silently while offered, and keeps duplicate names as separate routes", () => {
  const one = room(ONE, "Product Research");
  const two = room(TWO, "Product Research");
  held.rooms.set(two.room, two);
  const onSwitch = vi.fn();
  const host = mount(<Probe current={ONE} connection={one} menuOpen onSwitch={onSwitch} />);
  expect(held.acquire).toHaveBeenCalledWith(settingsRoom(TWO.uuid), IDENTITY, { presence: false });
  open(host, "Product Research");
  expect(entryNames()).toEqual(["Product Research", "Product Research"]);
  act(() => setWorkspaceName(two.ydoc, "Field Notes"));
  expect(entryNames()).toEqual(["Product Research", "Field Notes"]);
  act(() => setWorkspaceName(two.ydoc, "Changed elsewhere"));
  expect(entryNames()).toEqual(["Product Research", "Changed elsewhere"]);
  expect(held.acquire).toHaveBeenCalledOnce();
  act(() => entries()[1]?.click());
  expect(onSwitch).toHaveBeenCalledWith(TWO.segment);
  mount(<Probe current={ONE} connection={one} />);
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
  const host = mount(<Probe current={ONE} connection={one} menuOpen />);
  expect(within(host).getByText("Unnamed workspace · 6f4c8a51").textContent).toBe("Unnamed workspace · 6f4c8a51");
  expect(host.textContent).not.toContain(ONE.uuid);
  expect(host.textContent).not.toContain(ONE.segment);
  open(host, "Unnamed workspace · 6f4c8a51");
  expect(entryNames()).toEqual(["Unnamed workspace · 6f4c8a51", "Unnamed workspace · b2d9e4c7"]);
  for (const workspace of [ONE, TWO]) {
    expect(entries().map((entry) => entry.textContent).join(" ")).not.toContain(workspace.uuid);
    expect(entries().map((entry) => entry.textContent).join(" ")).not.toContain(workspace.segment);
  }
  one.ydoc.destroy();
});

it("labels a local menu without starting other replicas and retains names learned while viewing them", () => {
  const one = room(ONE, "Live name");
  const recordedNames = new Map([[ONE.uuid, "Startup snapshot"], [TWO.uuid, "Secondary snapshot"]]);
  const host = mount(<Probe current={ONE} connection={one} menuOpen recordedNames={recordedNames} />);
  open(host, "Live name");
  expect(entryNames())
    .toEqual(["Live name", "Secondary snapshot"]);
  expect(held.acquire).not.toHaveBeenCalled();
  act(() => setWorkspaceName(one.ydoc, "Renamed while viewing"));
  mount(<Probe current={TWO} connection={null} menuOpen recordedNames={recordedNames} />);
  expect(entryNames())
    .toEqual(["Renamed while viewing", "Secondary snapshot"]);
  expect(held.acquire).not.toHaveBeenCalled();
  one.ydoc.destroy();
});

it("never reuses the previous workspace's name when a route switches before its settings arrive", () => {
  const one = room(ONE, "Original workspace");
  const host = mount(<Probe current={ONE} connection={one} />);
  expect(within(host).getByText("Original workspace").textContent).toBe("Original workspace");
  mount(<Probe current={TWO} connection={one} />);
  expect(within(host).getByText("Unnamed workspace · b2d9e4c7").textContent).toBe("Unnamed workspace · b2d9e4c7");
  expect(host.textContent).not.toContain("Original workspace");
  one.ydoc.destroy();
});
