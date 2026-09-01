import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import { upsertDirectoryEntry } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { HubEndpoint } from "../src/config.js";
import { WorkspaceSettings } from "../src/ui/WorkspaceSettings.js";
import type { Workspace } from "../src/ui/route.js";

const WORKSPACE: Workspace = {
  uuid: "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4",
  segment: "uberblick-6f4c8a51-2b7d-4e39-9a06-c81d3f572be4",
};

const ENDPOINT: HubEndpoint = {
  url: "wss://hub.example.test/ws",
  source: "document",
};

const SYNCED: RoomStatus = {
  connected: true,
  synced: true,
  unsyncedChanges: 0,
  localReplicaLoaded: true,
  hasLocalCache: true,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

function statusRoom(initial: RoomStatus, workspace = WORKSPACE.uuid): {
  connection: RoomConnection;
  update: (patch: Partial<RoomStatus>) => void;
} {
  let status = initial;
  const listeners = new Set<(next: RoomStatus) => void>();
  const connection = {
    room: `${workspace}/_directory`,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    whenLocalReplicaLoaded: Promise.resolve(),
  } as unknown as RoomConnection;
  return {
    connection,
    update: (patch) => {
      status = { ...status, ...patch };
      connection.status = status;
      act(() => {
        for (const listener of listeners) listener(status);
      });
    },
  };
}

function seedDocuments(connection: RoomConnection, count: number): void {
  const uuids = [
    "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31",
    "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73",
    "7c2e5a11-3f80-4d66-b1a9-8e4d2c6f0a55",
  ];
  for (const [index, uuid] of uuids.slice(0, count).entries()) {
    upsertDirectoryEntry(connection.ydoc, { uuid, title: `Document ${index + 1}` });
  }
}

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(() => {
  if (mounted !== null) {
    act(() => mounted?.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  vi.unstubAllGlobals();
});

async function mount(
  connection: RoomConnection | null,
  endpoint: HubEndpoint | null = ENDPOINT,
): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(
      <WorkspaceSettings
        workspace={WORKSPACE}
        endpoint={endpoint}
        connection={connection}
        agentSessions={2}
      />,
    );
  });
  return host;
}

function facts(host: HTMLElement): Map<string, string> {
  return new Map(
    [...host.querySelectorAll<HTMLElement>(".ub-settings-facts .ub-panel-fact")].map(
      (row) => [
        row.querySelector("dt")?.textContent ?? "",
        row.querySelector("dd")?.textContent ?? "",
      ],
    ),
  );
}

/** Good news uses the same 300ms calm cadence as the status line. */
async function settleSynced(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 310));
  });
}

it("renders only live client-held facts and preserves each unknown rule", async () => {
  vi.stubGlobal("navigator", {
    storage: { estimate: async () => ({ usage: 2_500_000, quota: 1e9 }) },
  });
  const room = statusRoom(SYNCED);
  seedDocuments(room.connection, 3);
  const host = await mount(room.connection);
  await settleSynced();
  const shown = facts(host);

  expect(shown.get("Workspace UUID")).toBe(WORKSPACE.uuid);
  expect(shown.get("Address segment")).toBe(WORKSPACE.segment);
  expect(shown.get("Documents")).toBe("3");
  expect(shown.get("Hub")).toBe(ENDPOINT.url);
  expect(shown.get("Source")).toBe("served /uberblick-config.json");
  expect(shown.get("Connection")).toBe("synced");
  expect(shown.get("Local cache (all workspaces)")).toBe("2.5 MB");
  expect(shown.get("MCP connections")).toBe("2");

  act(() => mounted?.root.unmount());
  mounted?.host.remove();
  mounted = null;
  vi.stubGlobal("navigator", { storage: undefined });
  const unknown = facts(await mount(null, null));
  expect(unknown.get("Hub")).toBe("—");
  expect(unknown.get("Source")).toBe("—");
  expect(unknown.get("Connection")).toBe("offline");
  expect(unknown.get("Documents")).toBe("—");
  expect(
    [...unknown.keys()].some((label) => label.startsWith("Local cache")),
  ).toBe(false);
});

it("counts only the routed directory after its local replica has answered", async () => {
  vi.stubGlobal("navigator", { storage: undefined });
  const unread = statusRoom({ ...SYNCED, localReplicaLoaded: false });
  seedDocuments(unread.connection, 2);
  const host = await mount(unread.connection);
  expect(facts(host).get("Documents")).toBe("—");

  unread.update({ localReplicaLoaded: true });
  expect(facts(host).get("Documents")).toBe("2");

  const foreign = statusRoom(
    SYNCED,
    "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  );
  seedDocuments(foreign.connection, 1);
  await act(async () => {
    mounted?.root.render(
      <WorkspaceSettings
        workspace={WORKSPACE}
        endpoint={ENDPOINT}
        connection={foreign.connection}
        agentSessions={2}
      />,
    );
  });
  expect(facts(host).get("Documents")).toBe("—");
});

it("takes offline and refusal readings live from the shared status derivation", async () => {
  vi.stubGlobal("navigator", { storage: undefined });
  const room = statusRoom(SYNCED);
  const host = await mount(room.connection);
  await settleSynced();
  expect(facts(host).get("Connection")).toBe("synced");

  room.update({ connected: false, synced: false });
  expect(facts(host).get("Connection")).toBe("offline");

  room.update({
    connected: true,
    synced: true,
    protocolMismatch: { client: 1, hub: 2 },
  });
  expect(facts(host).get("Connection")).toContain("update required");
  expect(facts(host).get("Connection")).toContain("app 1, hub 2");

  room.update({ protocolMismatch: null, tokenMissing: true });
  expect(facts(host).get("Connection")).toContain("no hub token");
  expect(facts(host).get("Connection")).toContain("cannot authenticate");

  room.update({ tokenMissing: false, authFailed: true });
  expect(facts(host).get("Connection")).toContain("not authorized");
  expect(facts(host).get("Connection")).toContain("hub rejected");
});
