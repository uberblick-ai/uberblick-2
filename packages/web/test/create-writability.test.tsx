/** New-document creation crosses both the directory and new room admission gates. */

import { act, renderSettled } from "./react-render.js";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  directoryRoom,
  getDirectoryEntry,
  getMeta,
  parseRoom,
  sidebarRoom,
  settingsRoom,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { acquireRoom } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

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

interface Record {
  connection: RoomConnection;
  listeners: Set<(status: RoomStatus) => void>;
}

const rooms = new Map<string, Record>();
let admitNewRooms = false;

function room(name: string): Record {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const workspaceRoom =
    name === directoryRoom(WORKSPACE) || name === sidebarRoom(WORKSPACE);
  const status = workspaceRoom || admitNewRooms ? LIVE : { ...LIVE, connected: false, synced: false, writable: false };
  const listeners = new Set<(next: RoomStatus) => void>();
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listeners.add(listener);
      listener(connection.status);
      return () => listeners.delete(listener);
    },
  } as unknown as RoomConnection;
  const created = { connection, listeners };
  rooms.set(name, created);
  return created;
}

function update(record: Record, patch: Partial<RoomStatus>): void {
  record.connection.status = { ...record.connection.status, ...patch };
  for (const listener of record.listeners) listener(record.connection.status);
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: vi.fn((name: string) => ({
    connection: room(name).connection,
    release: vi.fn(),
  })),
}));

const { App } = await import("../src/ui/App.js");

function creationRelease(name: string): () => void {
  const index = vi.mocked(acquireRoom).mock.calls.findIndex((call) => call[0] === name);
  const result = vi.mocked(acquireRoom).mock.results[index];
  if (result?.type !== "return") throw new Error("new room was not acquired");
  return result.value.release;
}

beforeEach(() => {
  vi.mocked(acquireRoom).mockClear();
  admitNewRooms = false;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  window.history.replaceState(null, "", `/${WORKSPACE}`);
});

afterEach(() => {
  rooms.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["sidebar", "palette"] as const)("writes neither room until a new room created from the %s is admitted", async (source) => {
  const { container: host, unmount } = await renderSettled(<App />);

  if (source === "palette") await act(async () => fireEvent.keyDown(document, { key: "k", ctrlKey: true }));
  const create = source === "sidebar"
    ? within(host).getByRole<HTMLButtonElement>("button", { name: "+ New page" })
    : within(document.body).getByRole<HTMLButtonElement>("option", { name: "Create document" });
  expect(create.disabled).toBe(false);
  await act(async () => create.click());

  const pending = [...rooms.values()].find(
    ({ connection }) =>
      connection.room !== directoryRoom(WORKSPACE) &&
      connection.room !== sidebarRoom(WORKSPACE) &&
      connection.room !== settingsRoom(WORKSPACE),
  );
  if (pending === undefined) throw new Error("new room was not acquired");
  const uuid = parseRoom(pending.connection.room).uuid;
  const directory = room(directoryRoom(WORKSPACE)).connection;
  const release = creationRelease(pending.connection.room);
  const pageAcquisition = vi.mocked(acquireRoom).mock.calls.findIndex(
    (call, index) => call[0] === pending.connection.room &&
      vi.mocked(acquireRoom).mock.calls.slice(0, index).some((previous) => previous[0] === call[0]),
  );
  expect(pageAcquisition).toBeGreaterThan(-1);
  expect(release).not.toHaveBeenCalled();
  expect(getMeta(pending.connection.ydoc).uuid).toBe("");
  expect(getDirectoryEntry(directory.ydoc, uuid)).toBeNull();

  await act(async () => {
    update(pending, { connected: true, synced: true, writable: true });
    await Promise.resolve();
  });
  expect(getMeta(pending.connection.ydoc).uuid).toBe(uuid);
  expect(getDirectoryEntry(directory.ydoc, uuid)?.title).toBe("Untitled");
  expect(release).toHaveBeenCalledTimes(1);
  expect(vi.mocked(release).mock.invocationCallOrder[0]).toBeGreaterThan(
    vi.mocked(acquireRoom).mock.invocationCallOrder[pageAcquisition]!,
  );
  unmount();
  expect(release).toHaveBeenCalledTimes(1);
});

it("holds an already admitted create until the page acquires its room", async () => {
  const { container: host, unmount } = await renderSettled(<App />);
  admitNewRooms = true;
  await act(async () => within(host).getByRole("button", { name: "+ New page" }).click());
  const pending = [...rooms.values()].find(
    ({ connection }) => connection.room !== directoryRoom(WORKSPACE) &&
      connection.room !== sidebarRoom(WORKSPACE) &&
      connection.room !== settingsRoom(WORKSPACE),
  );
  if (pending === undefined) throw new Error("new room was not acquired");
  const release = creationRelease(pending.connection.room);
  const acquisitions = vi.mocked(acquireRoom).mock.calls.flatMap((call, index) =>
    call[0] === pending.connection.room ? [index] : [],
  );
  expect(acquisitions.length).toBeGreaterThan(1);
  expect(getMeta(pending.connection.ydoc).uuid).toBe(parseRoom(pending.connection.room).uuid);
  expect(release).toHaveBeenCalledTimes(1);
  expect(vi.mocked(release).mock.invocationCallOrder[0]).toBeGreaterThan(
    vi.mocked(acquireRoom).mock.invocationCallOrder[acquisitions[1]!]!,
  );
  unmount();
  expect(release).toHaveBeenCalledTimes(1);
});

it("disables both create entry points when the directory becomes read-only", async () => {
  const { container: host } = await renderSettled(<App />);
  await act(async () => update(room(directoryRoom(WORKSPACE)), { writable: false }));
  expect(within(host).getByRole<HTMLButtonElement>("button", { name: "+ New page" }).disabled).toBe(true);
  const roomCount = rooms.size;

  await act(async () => fireEvent.keyDown(document, { key: "k", ctrlKey: true }));
  const palette = within(document.body).getByRole("dialog", { name: "Command palette" });
  const create = within(palette).getByRole<HTMLButtonElement>("option", { name: "Create document" });
  expect(create.disabled).toBe(true);
  await act(async () => fireEvent.keyDown(within(palette).getByRole("combobox"), { key: "Enter" }));

  expect(rooms.size).toBe(roomCount);
  expect(window.location.pathname).toBe(`/${WORKSPACE}`);
});

it("leaves the shortcut alone when no workspace is current", async () => {
  window.history.replaceState(null, "", "/");
  await renderSettled(<App />);
  const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => document.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(within(document.body).queryByRole("dialog")).toBeNull();
  expect(window.location.pathname).toBe("/");
});

it("cancels a deferred create when the reader leaves its room", async () => {
  const { container: host } = await renderSettled(<App />);

  const create = within(host).getByRole<HTMLButtonElement>("button", { name: "+ New page" });
  await act(async () => create?.click());
  const pending = [...rooms.values()].find(
    ({ connection }) =>
      connection.room !== directoryRoom(WORKSPACE) &&
      connection.room !== sidebarRoom(WORKSPACE) &&
      connection.room !== settingsRoom(WORKSPACE),
  );
  if (pending === undefined) throw new Error("new room was not acquired");
  const uuid = parseRoom(pending.connection.room).uuid;
  const release = creationRelease(pending.connection.room);
  expect(release).not.toHaveBeenCalled();

  await act(async () =>
    within(host).getByRole("button", { name: "All documents" }).click(),
  );
  expect(release).toHaveBeenCalledTimes(1);
  await act(async () => {
    update(pending, { connected: true, synced: true, writable: true });
    await Promise.resolve();
  });

  expect(window.location.pathname).toBe(`/${WORKSPACE}/all`);
  expect(getMeta(pending.connection.ydoc).uuid).toBe("");
  expect(
    getDirectoryEntry(room(directoryRoom(WORKSPACE)).connection.ydoc, uuid),
  ).toBeNull();
  expect(release).toHaveBeenCalledTimes(1);
});

it.each([
  ["document", "store refusal"],
  ["directory", "store refusal"],
  ["document", "protocol mismatch"],
  ["directory", "protocol mismatch"],
] as const)(
  "leaves a generated route when the %s room reports %s",
  async (refused, reason) => {
    const { container: host } = await renderSettled(<App />);

    const create = within(host).getByRole<HTMLButtonElement>("button", { name: "+ New page" });
    await act(async () => create?.click());
    const directory = room(directoryRoom(WORKSPACE));
    const pending = [...rooms.values()].find(
      ({ connection }) =>
        connection.room !== directoryRoom(WORKSPACE) &&
        connection.room !== sidebarRoom(WORKSPACE) &&
        connection.room !== settingsRoom(WORKSPACE),
    );
    if (pending === undefined) throw new Error("new room was not acquired");
    const uuid = parseRoom(pending.connection.room).uuid;
    const release = creationRelease(pending.connection.room);
    await act(async () => {
      update(refused === "document" ? pending : directory, {
        ...(reason === "store refusal"
          ? { storeRefused: true }
          : { protocolMismatch: { hub: 2, client: 1 } }),
        writable: false,
      });
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/${WORKSPACE}`);
    expect(getMeta(pending.connection.ydoc).uuid).toBe("");
    expect(getDirectoryEntry(directory.connection.ydoc, uuid)).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  },
);
