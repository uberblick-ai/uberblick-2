import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderSettled, type RenderResult } from "./react-render.js";
import * as Y from "yjs";
import { directoryRoom, initDoc, roomForDoc, upsertDirectoryEntry } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { DocumentSearchStatus, NotSharedReason } from "../src/shell/document-search.js";
import { SERVING_STATUS_POLL_MS, SERVING_STATUS_SETTLE_MS } from "../src/ui/status/serving-status.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DOCUMENT = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const LIVE: RoomStatus = {
  connected: true, synced: true, writable: true, unsyncedChanges: 0,
  hasReceivedServerState: true, hasAnswered: true, storeRefused: false,
  protocolMismatch: null, authFailed: false, tokenMissing: false,
};
const rooms = new Map<string, RoomConnection>();
const listeners = new Map<string, Set<(status: RoomStatus) => void>>();

function room(name: string): RoomConnection {
  const previous = rooms.get(name);
  if (previous !== undefined) return previous;
  const subscribers = new Set<(status: RoomStatus) => void>();
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: { ...LIVE },
    onStatusChange(listener: (status: RoomStatus) => void) {
      subscribers.add(listener);
      listener(connection.status);
      return () => { subscribers.delete(listener); };
    },
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  listeners.set(name, subscribers);
  return connection;
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
  mintHubAuthMessage: async () => "local-browser-bearer",
}));

const { App } = await import("../src/ui/App.js");
const { rereadClientConfigForTesting } = await import("../src/config.js");

let mounted: RenderResult | null = null;
let answer: DocumentSearchStatus | Error | null;
let remoteHubUrl: string | null;
let locationKnown: boolean;

function status(hubAcked: boolean, notSharedReason?: NotSharedReason): DocumentSearchStatus {
  return {
    caughtUp: hubAcked,
    rooms: {
      [directoryRoom(WORKSPACE)]: { hubAcked },
      [roomForDoc(WORKSPACE, DOCUMENT)]: { hubAcked },
    },
    ...(notSharedReason === undefined ? {} : { notSharedReason }),
  };
}

beforeEach(() => {
  rereadClientConfigForTesting();
  answer = status(false);
  remoteHubUrl = "wss://hub.example.test/ws";
  locationKnown = true;
  const storage = new Map([["uberblick:ub-open-session", "s".repeat(43)]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (input === "/uberblick-config.json") return Response.json({
      hubUrl: "ws://127.0.0.1:4321", workspaces: [WORKSPACE],
      servedWorkspaces: { [WORKSPACE]: { remoteHubUrl } },
    });
    if (input === "/api/status") {
      if (answer === null) return await new Promise<Response>(() => {});
      if (answer instanceof Error) throw answer;
      return Response.json(answer);
    }
    if (input === "/api/access") return Response.json({
      status: locationKnown ? "forbidden" : "hub-down",
      hub: locationKnown ? "https://hub.example.test" : null,
    });
    if (input === "/api/account") return Response.json({ state: "unavailable" });
    if (input === "/api/device-login") return Response.json({ state: "signed-out" });
    return new Response("", { status: 404 });
  });
  vi.useFakeTimers();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  for (const connection of rooms.values()) connection.ydoc.destroy();
  rooms.clear();
  listeners.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openApp(document = false): Promise<HTMLElement> {
  if (document) {
    upsertDirectoryEntry(room(directoryRoom(WORKSPACE)).ydoc, { uuid: DOCUMENT, title: "Overview" });
    initDoc(room(roomForDoc(WORKSPACE, DOCUMENT)).ydoc, { uuid: DOCUMENT, title: "Overview" });
  }
  window.history.replaceState(null, "", `/${WORKSPACE}${document ? `/${DOCUMENT}` : ""}`);
  mounted = await renderSettled(<App />);
  return mounted.container;
}

async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function dot(host: HTMLElement): Element | null {
  return host.querySelector(".ub-workspace-location .ub-hub-problem");
}

describe("the sidebar on a page served by ub open", () => {
  it("uses settled upstream acknowledgement while its directory connection stays healthy", async () => {
    const host = await openApp();
    expect(host.querySelector(".ub-workspace-location")?.textContent).toBe("hub.example.test");
    expect(dot(host)).toBeNull();
    await advance(SERVING_STATUS_SETTLE_MS - 1);
    expect(dot(host)).toBeNull();
    await advance(1);
    expect(dot(host)).not.toBeNull();
    expect(room(directoryRoom(WORKSPACE)).status.connected).toBe(true);

    answer = status(true);
    await advance(SERVING_STATUS_POLL_MS);
    await advance(SERVING_STATUS_SETTLE_MS);
    expect(dot(host)).toBeNull();
    act(() => {
      const connection = room(directoryRoom(WORKSPACE));
      Object.assign(connection.status, { connected: false, synced: false });
      for (const listener of listeners.get(connection.room) ?? []) listener(connection.status);
    });
    await advance(SERVING_STATUS_POLL_MS);
    expect(dot(host)).toBeNull();
  });

  it("makes no hub claim before a first answer even when the local connection is lost", async () => {
    answer = null;
    Object.assign(room(directoryRoom(WORKSPACE)).status, { connected: false, synced: false });
    const host = await openApp();
    expect(dot(host)).toBeNull();
    await advance(SERVING_STATUS_SETTLE_MS);
    expect(dot(host)).toBeNull();
  });

  it("uses the open document's upstream reading instead of the healthy directory room", async () => {
    answer = {
      caughtUp: false,
      rooms: {
        [directoryRoom(WORKSPACE)]: { hubAcked: true },
        [roomForDoc(WORKSPACE, DOCUMENT)]: { hubAcked: false },
      },
    };
    const host = await openApp(true);
    await advance(SERVING_STATUS_SETTLE_MS);
    expect(dot(host)).not.toBeNull();
    expect(host.textContent).toContain("Offline. Changes are saved on this device.");
  });

  it.each<NotSharedReason>(["no-workspace-access", "sign-in-required"])(
    "shows the workspace refusal %s, then makes no hub claim when the local server is lost",
    async (reason) => {
      answer = status(true, reason);
      const host = await openApp();
      expect(dot(host)).toBeNull();
      await advance(SERVING_STATUS_SETTLE_MS);
      expect(dot(host)).not.toBeNull();

      answer = new Error("local server is unreachable");
      act(() => {
        const connection = room(directoryRoom(WORKSPACE));
        Object.assign(connection.status, { connected: false, synced: false });
        for (const listener of listeners.get(connection.room) ?? []) listener(connection.status);
      });
      await advance(SERVING_STATUS_POLL_MS);
      expect(dot(host)).toBeNull();
      await advance(SERVING_STATUS_SETTLE_MS);
      expect(dot(host)).toBeNull();
    },
  );

  it.each(["local", "unknown"])("does not attach a problem to a %s location", async (location) => {
    if (location === "local") remoteHubUrl = null;
    else locationKnown = false;
    answer = status(false, "no-hub-credentials");
    const host = await openApp();
    await advance(SERVING_STATUS_SETTLE_MS);
    expect(host.querySelector(".ub-workspace-location")?.textContent ?? null).toBe(
      location === "local" ? "This device" : null,
    );
    expect(dot(host)).toBeNull();
  });
});
