/** New-document creation crosses both the directory and new room admission gates. */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import {
  directoryRoom,
  getDirectoryEntry,
  getMeta,
  parseRoom,
  sidebarRoom,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

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

function room(name: string): Record {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const workspaceRoom =
    name === directoryRoom(WORKSPACE) || name === sidebarRoom(WORKSPACE);
  const status = workspaceRoom ? LIVE : { ...LIVE, connected: false, synced: false, writable: false };
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
  acquireRoom: (name: string) => ({
    connection: room(name).connection,
    release: () => {},
  }),
}));

const { App } = await import("../src/ui/App.js");

let mounted: { root: Root; host: HTMLElement } | null = null;

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
  window.history.replaceState(null, "", `/${WORKSPACE}`);
});

afterEach(() => {
  if (mounted !== null) {
    act(() => mounted?.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  rooms.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("writes neither room until the new room is admitted", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<App />));

  const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes("new doc"),
  );
  expect(create?.disabled).toBe(false);
  await act(async () => create?.click());

  const pending = [...rooms.values()].find(
    ({ connection }) =>
      connection.room !== directoryRoom(WORKSPACE) &&
      connection.room !== sidebarRoom(WORKSPACE),
  );
  if (pending === undefined) throw new Error("new room was not acquired");
  const uuid = parseRoom(pending.connection.room).uuid;
  const directory = room(directoryRoom(WORKSPACE)).connection;
  expect(getMeta(pending.connection.ydoc).uuid).toBe("");
  expect(getDirectoryEntry(directory.ydoc, uuid)).toBeNull();

  await act(async () => {
    update(pending, { connected: true, synced: true, writable: true });
    await Promise.resolve();
  });
  expect(getMeta(pending.connection.ydoc).uuid).toBe(uuid);
  expect(getDirectoryEntry(directory.ydoc, uuid)?.title).toBe("Untitled");
});

it("cancels a deferred create when the reader leaves its room", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<App />));

  const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes("new doc"),
  );
  await act(async () => create?.click());
  const pending = [...rooms.values()].find(
    ({ connection }) =>
      connection.room !== directoryRoom(WORKSPACE) &&
      connection.room !== sidebarRoom(WORKSPACE),
  );
  if (pending === undefined) throw new Error("new room was not acquired");
  const uuid = parseRoom(pending.connection.room).uuid;

  await act(async () =>
    host.querySelector<HTMLButtonElement>(".ub-all-open-entry")?.click(),
  );
  await act(async () => {
    update(pending, { connected: true, synced: true, writable: true });
    await Promise.resolve();
  });

  expect(window.location.pathname).toBe(`/${WORKSPACE}/all`);
  expect(getMeta(pending.connection.ydoc).uuid).toBe("");
  expect(
    getDirectoryEntry(room(directoryRoom(WORKSPACE)).connection.ydoc, uuid),
  ).toBeNull();
});

it.each(["document", "directory"] as const)(
  "leaves a generated route when the %s room terminally refuses creation",
  async (refused) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted = { root, host };
    await act(async () => root.render(<App />));

    const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("new doc"),
    );
    await act(async () => create?.click());
    const directory = room(directoryRoom(WORKSPACE));
    const pending = [...rooms.values()].find(
      ({ connection }) =>
        connection.room !== directoryRoom(WORKSPACE) &&
        connection.room !== sidebarRoom(WORKSPACE),
    );
    if (pending === undefined) throw new Error("new room was not acquired");
    await act(async () => {
      update(refused === "document" ? pending : directory, {
        storeRefused: true,
        writable: false,
      });
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/${WORKSPACE}`);
  },
);
