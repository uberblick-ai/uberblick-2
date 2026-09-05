import { afterEach, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import {
  EXAMPLE_TAGS,
  createTagCatalogEntry,
  listTagCatalog,
  retireTagCatalogEntry,
  settingsRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
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
  hasReceivedServerState: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  hasAnswered: true,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

function statusRoom(
  initial: RoomStatus,
  room = `${WORKSPACE.uuid}/_directory`,
): {
  connection: RoomConnection;
  update: (patch: Partial<RoomStatus>) => void;
} {
  let status = initial;
  const listeners = new Set<(next: RoomStatus) => void>();
  const connection = {
    room,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
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

async function mountTags(connection: RoomConnection | null): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(
      <WorkspaceSettings
        page="tags"
        workspace={WORKSPACE}
        endpoint={ENDPOINT}
        connection={null}
        catalogConnection={connection}
        agentSessions={2}
      />,
    );
  });
  return host;
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

/** A second client whose Y.Doc converges in both directions. */
function peerOf(local: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  peer.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  return peer;
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
  expect(shown.get("MCP connections")).toBe("2");

  act(() => mounted?.root.unmount());
  mounted?.host.remove();
  mounted = null;
  const unknown = facts(await mount(null, null));
  expect(unknown.get("Hub")).toBe("—");
  expect(unknown.get("Source")).toBe("—");
  expect(unknown.get("Connection")).toBe("offline");
  expect(unknown.get("Documents")).toBe("—");
});

it("counts only the routed directory after its server has answered", async () => {
  const unread = statusRoom({ ...SYNCED, hasAnswered: false });
  seedDocuments(unread.connection, 2);
  const host = await mount(unread.connection);
  expect(facts(host).get("Documents")).toBe("—");

  unread.update({ hasAnswered: true });
  expect(facts(host).get("Documents")).toBe("2");

  const foreign = statusRoom(
    SYNCED,
    "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/_directory",
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

it("waits for server state, seeds once, and keeps a retired-only reading offline", async () => {
  const room = statusRoom(
    {
      ...SYNCED,
      connected: false,
      synced: false,
      hasReceivedServerState: false,
      hasAnswered: true,
      writable: false,
      storeRefused: true,
    },
    settingsRoom(WORKSPACE.uuid),
  );
  const host = await mountTags(room.connection);

  expect(host.textContent).toContain("Waiting for the tag catalog");
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector(".ub-settings-tag-list")).toBeNull();

  room.update({
    connected: true,
    synced: true,
    hasReceivedServerState: true,
    writable: true,
    storeRefused: false,
  });
  await act(async () => {});
  expect(
    [...host.querySelectorAll("#ub-active-tags + .ub-settings-tag-list > li")].map(
      (row) => row.firstElementChild?.textContent,
    ),
  ).toEqual(EXAMPLE_TAGS.map((entry) => entry.name));

  act(() => {
    for (const entry of listTagCatalog(room.connection.ydoc)) {
      retireTagCatalogEntry(room.connection.ydoc, entry.id);
    }
  });
  expect(host.textContent).toContain("No active tags.");
  expect(
    host.querySelectorAll("#ub-retired-tags + .ub-settings-tag-list > li"),
  ).toHaveLength(EXAMPLE_TAGS.length);

  room.update({ connected: false, synced: false, writable: false });
  expect(host.textContent).not.toContain("Waiting for the tag catalog");
  expect(host.textContent).toContain("Tag changes are unavailable");
  expect(
    [...host.querySelectorAll<HTMLButtonElement>(".ub-settings-tags-card button")].every(
      (button) => button.disabled,
    ),
  ).toBe(true);

  room.update({ connected: true, synced: true, writable: true });
  expect(
    [...host.querySelectorAll<HTMLButtonElement>(".ub-settings-tag-list button")].every(
      (button) => !button.disabled,
    ),
  ).toBe(true);
  expect(listTagCatalog(room.connection.ydoc)).toHaveLength(EXAMPLE_TAGS.length);
  expect(listTagCatalog(room.connection.ydoc).every((entry) => entry.state === "retired"))
    .toBe(true);
});

it("validates unique names and converges create, retire, and restore with a peer", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const peer = peerOf(room.connection.ydoc);
  const host = await mountTags(room.connection);
  const input = host.querySelector<HTMLInputElement>("#ub-new-tag");
  const submit = host.querySelector<HTMLButtonElement>(
    ".ub-settings-tag-create button[type=submit]",
  );
  if (input === null || submit === null) throw new Error("the create form is missing");

  act(() => {
    typeInto(input, "Needs spaces");
    submit.click();
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "lowercase letters or numbers",
  );

  act(() => {
    typeInto(input, "auth");
    submit.click();
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "already an active tag",
  );

  act(() => {
    typeInto(input, "product");
    submit.click();
  });
  const created = listTagCatalog(peer).find((entry) => entry.name === "product");
  expect(created).toMatchObject({ name: "product", state: "active" });

  const productRow = [...host.querySelectorAll(".ub-settings-tag-list li")].find(
    (row) => row.firstElementChild?.textContent === "product",
  );
  act(() => productRow?.querySelector<HTMLButtonElement>("button")?.click());
  expect(listTagCatalog(peer).find((entry) => entry.id === created?.id)?.state).toBe(
    "retired",
  );

  const retiredProduct = [...host.querySelectorAll(".ub-settings-tag-list li")].find(
    (row) => row.firstElementChild?.textContent === "product",
  );
  act(() => retiredProduct?.querySelector<HTMLButtonElement>("button")?.click());
  expect(listTagCatalog(peer).find((entry) => entry.id === created?.id)?.state).toBe(
    "active",
  );

  act(() => {
    createTagCatalogEntry(peer, "zeta");
  });
  expect(host.textContent).toContain("zeta");
});

it("takes offline and refusal readings live from the shared status derivation", async () => {
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
