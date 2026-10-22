import { afterEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, renderSettled, type RenderResult } from "./react-render.js";
import * as Y from "yjs";
import {
  EXAMPLE_TAGS,
  createTagCatalogEntry,
  listDirectory,
  listTagCatalog,
  getWorkspaceName,
  getWorkspaceMainRepository,
  setWorkspaceMainRepository,
  setWorkspaceName,
  setTagCatalogDescription,
  deleteTagCatalogEntry,
  restoreDirectoryEntry,
  settingsRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { HubEndpoint } from "../src/config.js";
import { toast } from "sonner";
import { writeToClipboard } from "../src/editor/source-chrome.js";
import { WorkspaceSettings } from "../src/ui/settings/WorkspaceSettings.js";
import type { Workspace } from "../src/ui/route.js";
import type { AccessAction, AccessAnswer, AccessMember, AccessRole } from "../src/shell/workspace-access.js";

vi.mock("../src/collab/rooms.js", async (original) => ({
  ...await original<typeof import("../src/collab/rooms.js")>(),
  mintHubAuthMessage: vi.fn(async () => `local-browser-bearer-${crypto.randomUUID()}`),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../src/editor/source-chrome.js", async (original) => ({
  ...await original<typeof import("../src/editor/source-chrome.js")>(),
  writeToClipboard: vi.fn().mockResolvedValue(true),
}));

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

let mounted: RenderResult | null = null;

afterEach(() => {
  mounted = null;
  vi.unstubAllGlobals();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(writeToClipboard).mockReset().mockResolvedValue(true);
});

async function mount(
  connection: RoomConnection | null,
  endpoint: HubEndpoint | null = ENDPOINT,
  catalogConnection: RoomConnection | null = null,
  workspaceLocation: string | null = ENDPOINT.url,
): Promise<HTMLElement> {
  mounted = await renderSettled(
    <WorkspaceSettings
      admin={true}
      workspace={WORKSPACE}
      endpoint={endpoint}
      connection={connection}
      catalogConnection={catalogConnection}
      workspaceLocation={workspaceLocation}
      agentSessions={2}
    />,
  );
  return mounted.container;
}

async function mountTags(connection: RoomConnection | null, local = true): Promise<HTMLElement> {
  mounted = await renderSettled(
    <WorkspaceSettings
      admin={true}
      local={local}
      page="tags"
      workspace={WORKSPACE}
      endpoint={ENDPOINT}
      connection={null}
      catalogConnection={connection}
      agentSessions={2}
    />,
  );
  return mounted.container;
}

it.each(["general", "tags", "members"] as const)("offers no %s controls or writes before workspace admin authority is confirmed", async (page) => {
  const directory = statusRoom(SYNCED);
  const catalog = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const before = Y.encodeStateAsUpdate(catalog.connection.ydoc);
  const fetchImpl = vi.fn();
  vi.stubGlobal("fetch", fetchImpl);
  mounted = await renderSettled(<WorkspaceSettings admin={false} page={page} workspace={WORKSPACE}
    endpoint={ENDPOINT} connection={directory.connection} catalogConnection={catalog.connection} agentSessions={2}
    serving={{ workspace: WORKSPACE.uuid, remoteHubUrl: "wss://hub.example.test/ws", rebound: false }} />);
  const pageControls = within(mounted.container);
  expect(pageControls.queryAllByRole("textbox")).toEqual([]);
  expect(pageControls.queryAllByRole("button")).toEqual([]);
  expect(pageControls.queryAllByRole("table")).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(Y.encodeStateAsUpdate(catalog.connection.ydoc)).toEqual(before);
});

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
    within(host).getAllByRole("term", { hidden: true }).map((term) => {
      // A definition-list row has no role; its term identifies the paired fact.
      const value = within(term.parentElement as HTMLElement).getByRole("definition", { hidden: true }).cloneNode(true) as HTMLElement;
      for (const button of value.querySelectorAll("button")) button.remove();
      return [term.textContent ?? "", value.textContent?.trim() ?? ""] as const;
    }),
  );
}

function openConnectionDetails(host: HTMLElement): void {
  act(() => within(host).getByRole<HTMLButtonElement>("button", { name: "Connection details" }).click());
}

it("renders only live client-held facts and preserves each unknown rule", async () => {
  const room = statusRoom(SYNCED);
  seedDocuments(room.connection, 3);
  const host = await mount(room.connection);
  expect(within(host).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Where it lives", "About this workspace", "Connection details",
  ]);
  expect(within(host).getByRole("button", { name: "Connection details" }).getAttribute("aria-expanded")).toBe("false");
  expect(within(host).queryByRole("term", { name: "Address segment" })).toBeNull();
  openConnectionDetails(host);
  const shown = facts(host);

  expect(shown.get("Workspace ID")).toBe(WORKSPACE.uuid);
  expect(shown.get("Address segment")).toBe(WORKSPACE.segment);
  expect(shown.get("Documents")).toBe("3");
  expect(shown.get("Hub")).toBe("hub.example.test");
  expect(shown.get("Source")).toBe("served /uberblick-config.json");
  expect(shown.get("Connection")).toBe("synced");
  expect(shown.get("MCP connections")).toBe("2");

  mounted?.unmount();
  mounted = null;
  const unknownHost = await mount(null, null, null, null);
  openConnectionDetails(unknownHost);
  const unknown = facts(unknownHost);
  expect(unknown.get("Hub")).toBe("—");
  expect(unknown.get("Source")).toBe("—");
  expect(unknown.get("Connection")).toBe("offline");
  expect(unknown.get("Documents")).toBe("—");
  expect(unknown.get("Tags")).toBe("—");
  expect(unknown.get("Last edited")).toBe("—");
  expect(unknown.get("MCP connections")).toBe("—");
});

it("counts only the routed directory after server state, across disconnects", async () => {
  const unread = statusRoom({
    ...SYNCED,
    connected: false,
    synced: false,
    hasReceivedServerState: false,
    hasAnswered: true,
    writable: false,
  });
  seedDocuments(unread.connection, 2);
  const host = await mount(unread.connection);
  expect(facts(host).get("Documents")).toBe("—");
  expect(facts(host).get("Last edited")).toBe("—");

  unread.update({
    connected: true,
    synced: true,
    hasReceivedServerState: true,
    writable: true,
  });
  expect(facts(host).get("Documents")).toBe("2");

  unread.update({ connected: false, synced: false, writable: false });
  expect(facts(host).get("Documents")).toBe("2");

  const foreign = statusRoom(
    SYNCED,
    "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/_directory",
  );
  seedDocuments(foreign.connection, 1);
  await act(async () => {
    mounted?.rerender(
      <WorkspaceSettings
        admin={true}
        workspace={WORKSPACE}
        endpoint={ENDPOINT}
        connection={foreign.connection}
        agentSessions={2}
      />,
    );
  });
  expect(facts(host).get("Documents")).toBe("—");
  expect(facts(host).get("Last edited")).toBe("—");
});

it.each([
  ["wss://upstream.example.test/ws", "upstream.example.test"],
  ["local", "This device"],
])("uses the shell location %s rather than the local serving endpoint", async (location, label) => {
  const endpoint: HubEndpoint = { url: "ws://127.0.0.1:43123", source: "document" };
  const host = await mount(null, endpoint, null, location);
  expect(facts(host).get("Hub")).toBe(label);
  openConnectionDetails(host);
  expect(host.textContent).not.toContain(endpoint.url);
  expect(host.textContent).not.toContain("wss://");
});

it.each([true, false])("copies the bare workspace ID and reports clipboard success=%s", async (copied) => {
  vi.mocked(writeToClipboard).mockResolvedValueOnce(copied);
  const host = await mount(null);
  const copy = within(host).getByRole<HTMLButtonElement>("button", { name: "Copy workspace ID" });
  await act(async () => copy.click());
  expect(writeToClipboard).toHaveBeenCalledTimes(1);
  expect(vi.mocked(writeToClipboard).mock.calls[0]?.[0]).toBe(WORKSPACE.uuid);
  expect(toast[copied ? "success" : "error"]).toHaveBeenLastCalledWith(
    copied ? "Workspace ID copied" : "Couldn't copy the workspace ID. Try again in a browser with clipboard access.",
    { id: "copy-workspace-id" },
  );
});

it("counts regular documents and active tags live, and takes the newest stamp from live document and decision entries", async () => {
  const directory = statusRoom(SYNCED);
  const settings = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const regular = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
  const archived = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";
  const created = "7c2e5a11-3f80-4d66-b1a9-8e4d2c6f0a55";
  const decision = "5104a4b1-7249-48d6-8050-146ca373f56e";
  const archivedTopic = "6670f9ee-a571-4b6c-83f7-40c05be3ae76";
  const archivedSuccessor = "2a7b16f2-d7f8-46dd-84c2-4a1f63c09053";
  const now = Date.now();
  const decisionStamp = now - 3_600_000;
  upsertDirectoryEntry(directory.connection.ydoc, { uuid: regular, title: "Regular", updatedAt: now - 7_200_000 });
  upsertDirectoryEntry(directory.connection.ydoc, { uuid: archived, title: "Archived regular", updatedAt: now - 60_000 });
  tombstoneDirectoryEntry(directory.connection.ydoc, archived);
  upsertDirectoryEntry(directory.connection.ydoc, { uuid: decision, title: "Live decision", kind: "decision", updatedAt: decisionStamp });
  upsertDirectoryEntry(directory.connection.ydoc, { uuid: archivedTopic, title: "Archived decision", kind: "decision", updatedAt: now - 30_000 });
  tombstoneDirectoryEntry(directory.connection.ydoc, archivedTopic);
  // A successor received after its topic's archive still belongs to that archive.
  upsertDirectoryEntry(directory.connection.ydoc, { uuid: archivedSuccessor, title: "Archived successor", kind: "decision", topic: archivedTopic, updatedAt: now - 10_000 });
  const tag = createTagCatalogEntry(settings.connection.ydoc, "product");
  const retired = createTagCatalogEntry(settings.connection.ydoc, "auth");
  deleteTagCatalogEntry(settings.connection.ydoc, retired.id);
  const host = await mount(directory.connection, ENDPOINT, settings.connection);
  expect(facts(host).get("Documents")).toBe("1 (1 archived)");
  expect(facts(host).get("Tags")).toBe("1");
  const stamp = within(host).getByRole("time");
  expect(stamp.getAttribute("dateTime")).toBe(new Date(decisionStamp).toISOString());

  act(() => upsertDirectoryEntry(directory.connection.ydoc, { uuid: created, title: "Created", updatedAt: now }));
  expect(facts(host).get("Documents")).toBe("2 (1 archived)");
  expect(stamp.getAttribute("dateTime")).toBe(new Date(now).toISOString());
  act(() => tombstoneDirectoryEntry(directory.connection.ydoc, regular));
  expect(facts(host).get("Documents")).toBe("1 (2 archived)");
  act(() => restoreDirectoryEntry(directory.connection.ydoc, regular));
  expect(facts(host).get("Documents")).toBe("2 (1 archived)");
  act(() => upsertDirectoryEntry(directory.connection.ydoc, { uuid: decision, title: "Edited decision", kind: "decision", updatedAt: now + 1_000 }));
  expect(stamp.getAttribute("dateTime")).toBe(new Date(now + 1_000).toISOString());
  act(() => createTagCatalogEntry(settings.connection.ydoc, "architecture"));
  expect(facts(host).get("Tags")).toBe("2");
  act(() => deleteTagCatalogEntry(settings.connection.ydoc, tag.id));
  expect(facts(host).get("Tags")).toBe("1");
});

it("waits for the routed settings room without seeding or requesting more data", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const settings = statusRoom({ ...SYNCED, hasReceivedServerState: false }, settingsRoom(WORKSPACE.uuid));
  createTagCatalogEntry(settings.connection.ydoc, "product");
  const before = Y.encodeStateAsUpdate(settings.connection.ydoc);
  const host = await mount(null, ENDPOINT, settings.connection);
  expect(facts(host).get("Tags")).toBe("—");
  settings.update({ hasReceivedServerState: true });
  expect(facts(host).get("Tags")).toBe("1");
  settings.update({ connected: false, synced: false, writable: false });
  expect(facts(host).get("Tags")).toBe("1");
  expect(Y.encodeStateAsUpdate(settings.connection.ydoc)).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();

  const foreign = statusRoom(SYNCED, settingsRoom("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"));
  createTagCatalogEntry(foreign.connection.ydoc, "auth");
  await act(async () => mounted?.rerender(<WorkspaceSettings admin={true} workspace={WORKSPACE} endpoint={ENDPOINT} connection={null} catalogConnection={foreign.connection} agentSessions={2} />));
  expect(facts(host).get("Tags")).toBe("—");
  mounted?.unmount();
  const empty = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const emptyBefore = Y.encodeStateAsUpdate(empty.connection.ydoc);
  const emptyHost = await mount(null, ENDPOINT, empty.connection);
  expect(facts(emptyHost).get("Tags")).toBe("0");
  expect(Y.encodeStateAsUpdate(empty.connection.ydoc)).toEqual(emptyBefore);
  expect(listTagCatalog(empty.connection.ydoc)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("updates last edited when a peer's stamp converges while its concurrent directory stub loses", async () => {
  const directory = statusRoom(SYNCED);
  directory.connection.ydoc.clientID = 2;
  const uuid = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
  const now = Date.now();
  upsertDirectoryEntry(directory.connection.ydoc, { uuid, title: "Original", updatedAt: now - 120_000 });
  const peer = new Y.Doc();
  peer.clientID = 1;
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(directory.connection.ydoc));
  upsertDirectoryEntry(directory.connection.ydoc, { uuid, title: "Local title", updatedAt: now - 60_000 });
  upsertDirectoryEntry(peer, { uuid, title: "Peer title", updatedAt: now });
  const host = await mount(directory.connection);
  const stamp = within(host).getByRole("time");
  expect(stamp.getAttribute("dateTime")).toBe(new Date(now - 60_000).toISOString());

  act(() => Y.applyUpdate(directory.connection.ydoc, Y.encodeStateAsUpdate(peer)));
  expect(listDirectory(directory.connection.ydoc)[0]?.title).toBe("Local title");
  expect(stamp.getAttribute("dateTime")).toBe(new Date(now).toISOString());
  peer.destroy();
});

it.each([
  { age: 59_000, initial: "just now", later: "1 minute ago" },
  { age: 400 * 24 * 3_600_000, initial: "1 year ago", later: "1 year ago" },
])("keeps last edited relative and advances its clock at age $age", async ({ age, initial, later }) => {
  vi.useFakeTimers();
  try {
    const now = Date.UTC(2026, 9, 16, 12);
    vi.setSystemTime(now);
    const directory = statusRoom(SYNCED);
    const editedAt = now - age;
    upsertDirectoryEntry(directory.connection.ydoc, { uuid: "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31", title: "Clock", updatedAt: editedAt });
    const host = await mount(directory.connection);
    const stamp = within(host).getByRole("time");
    expect(stamp.textContent).toBe(initial);
    expect(stamp.getAttribute("dateTime")).toBe(new Date(editedAt).toISOString());
    expect(stamp.getAttribute("title")).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(editedAt));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(stamp.textContent).toBe(later);
  } finally {
    vi.useRealTimers();
  }
});

it("waits for server state, seeds once and keeps deleted examples absent offline", async () => {
  const room = statusRoom({ ...SYNCED, connected: false, synced: false, hasReceivedServerState: false, writable: false }, settingsRoom(WORKSPACE.uuid));
  const host = await mountTags(room.connection);
  expect(host.textContent).toContain("Waiting for the tag catalog");
  expect(within(host).queryByLabelText("Name")).toBeNull();
  room.update({ connected: true, synced: true, hasReceivedServerState: true, writable: true });
  expect(listTagCatalog(room.connection.ydoc).map((entry) => entry.name)).toEqual(EXAMPLE_TAGS.map((entry) => entry.name));
  act(() => { for (const entry of listTagCatalog(room.connection.ydoc)) deleteTagCatalogEntry(room.connection.ydoc, entry.id); });
  expect(host.textContent).toContain("No tags.");
  expect(within(host).queryByText("Retired")).toBeNull();
  room.update({ connected: false, synced: false, writable: false });
  expect(host.textContent).toContain("Tag changes are unavailable");
  expect(within(host).getByRole<HTMLInputElement>("textbox", { name: "Name" }).disabled).toBe(true);
  expect(within(host).getByRole<HTMLInputElement>("textbox", { name: "Description (optional)" }).disabled).toBe(true);
  room.update({ connected: true, synced: true, writable: true });
  expect(listTagCatalog(room.connection.ydoc)).toEqual([]);
});

it("lets an admin curate an unseeded hub catalog without creating example tags", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const host = await mountTags(room.connection, false);
  expect(listTagCatalog(room.connection.ydoc)).toEqual([]);
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Name" });
  expect(input.disabled).toBe(false);
  act(() => typeInto(input, "product"));
  act(() => within(host).getByRole<HTMLButtonElement>("button", { name: "Create" }).click());
  expect(listTagCatalog(room.connection.ydoc)).toEqual([expect.objectContaining({ name: "product" })]);
  room.connection.ydoc.destroy();
});

it("preserves invalid tag drafts, creates descriptions and converges lifecycle changes with a peer", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const peer = peerOf(room.connection.ydoc);
  const host = await mountTags(room.connection);
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Name" });
  const description = within(host).getByRole<HTMLInputElement>("textbox", { name: "Description (optional)" });
  const submit = within(host).getByRole<HTMLButtonElement>("button", { name: "Create" });

  expect(within(host).getByRole("heading", { level: 2, name: "New tag" })).toBeTruthy();
  expect(within(host).getByText("A short description tells people and agents when to use it.")).toBeTruthy();
  expect(within(host).queryByText(
    "Letters and numbers, separated by hyphens; saved in lowercase; 30 characters maximum.",
  )).toBeNull();
  const table = within(host).getByRole("table", { name: "Tags" });
  expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Description", "Actions"]);
  const initial = Y.encodeStateAsUpdate(peer);
  for (const draft of ["iOS app", "ios--app"]) {
    act(() => {
      typeInto(input, draft);
      typeInto(description, "  iOS documents  ");
      submit.click();
    });
    expect(within(host).getByRole("alert").textContent).toBe(
      "Use 1–30 letters or numbers, separated by single hyphens.",
    );
    expect(input.value).toBe(draft);
    expect(description.value).toBe("  iOS documents  ");
    expect(Y.encodeStateAsUpdate(peer)).toEqual(initial);
  }

  act(() => typeInto(input, "iOS"));
  expect(input.value).toBe("iOS");
  expect(within(host).queryByRole("alert")).toBeNull();
  act(() => submit.click());
  const created = listTagCatalog(peer).find((entry) => entry.name === "ios");
  expect(created).toMatchObject({ name: "ios", description: "iOS documents" });
  expect(input.value).toBe("");
  expect(description.value).toBe("");
  expect(toast.success).toHaveBeenLastCalledWith("Created “ios”.", { id: "workspace-settings" });
  expect(host.textContent).not.toContain("Created “ios”.");

  const beforeDuplicate = Y.encodeStateAsUpdate(peer);
  act(() => {
    typeInto(input, "iOS");
    typeInto(description, "Keep this draft");
    submit.click();
  });
  expect(within(host).getByRole("alert").textContent).toBe(
    "“ios” is already a tag.",
  );
  expect(input.value).toBe("iOS");
  expect(description.value).toBe("Keep this draft");
  expect(Y.encodeStateAsUpdate(peer)).toEqual(beforeDuplicate);
  expect(listTagCatalog(peer).filter((entry) => entry.name === "ios")).toHaveLength(1);
  expect(toast.success).toHaveBeenCalledTimes(1);

  act(() => {
    typeInto(input, "  Billing-V2 ");
    typeInto(description, "d".repeat(301));
  });
  expect(input.value).toBe("  Billing-V2 ");
  expect(within(host).queryByRole("alert")).toBeNull();
  act(() => submit.click());
  expect(within(host).getByRole("alert").textContent).toContain("300");
  expect(input.value).toBe("  Billing-V2 ");
  expect(description.value).toBe("d".repeat(301));
  expect(Y.encodeStateAsUpdate(peer)).toEqual(beforeDuplicate);
  act(() => typeInto(description, "   "));
  act(() => submit.click());
  const blankDescription = listTagCatalog(peer).find((entry) => entry.name === "billing-v2");
  expect(blankDescription).toMatchObject({ name: "billing-v2" });
  expect(blankDescription).not.toHaveProperty("description");
  expect(input.value).toBe("");
  expect(description.value).toBe("");
  expect(toast.success).toHaveBeenLastCalledWith("Created “billing-v2”.", { id: "workspace-settings" });

  const trigger = within(host).getByRole<HTMLButtonElement>("button", { name: /^Delete\s*ios$/ });
  activate(trigger);
  let dialog = screen.getByRole("alertdialog", { name: "Delete “ios”?" });
  expect(listTagCatalog(peer).some((entry) => entry.id === created?.id)).toBe(true);
  activate(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Cancel" }));
  expect(listTagCatalog(peer).some((entry) => entry.id === created?.id)).toBe(true);
  activate(trigger);
  dialog = screen.getByRole("alertdialog", { name: "Delete “ios”?" });
  activate(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Delete" }));
  expect(listTagCatalog(peer).some((entry) => entry.id === created?.id)).toBe(false);
  expect(toast.success).toHaveBeenLastCalledWith("Deleted “ios”.", { id: "workspace-settings" });
  act(() => { typeInto(input, "iOS"); submit.click(); });
  const recreated = listTagCatalog(peer).find((entry) => entry.name === "ios");
  expect(recreated?.id).not.toBe(created?.id);
  expect(input.value).toBe("");
  let remoteId = "";
  act(() => { remoteId = createTagCatalogEntry(peer, "zeta", undefined, "From a peer").id; });
  const remoteRow = within(table).getByRole("row", { name: /zeta/ });
  expect(within(remoteRow).getByRole("cell", { name: "From a peer" })).toBeTruthy();
  act(() => setTagCatalogDescription(peer, remoteId, "Changed by a peer"));
  expect(within(remoteRow).getByRole("cell", { name: "Changed by a peer" })).toBeTruthy();
});

function activate(control: HTMLButtonElement): void {
  act(() => { control.focus(); control.click(); });
}

it("prefills, replaces and clears a tag description, while Cancel saves nothing", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const entry = createTagCatalogEntry(room.connection.ydoc, "product", undefined, "Current meaning");
  const peer = peerOf(room.connection.ydoc);
  const host = await mountTags(room.connection, false);
  const openEdit = (): HTMLElement => {
    activate(within(host).getByRole<HTMLButtonElement>("button", { name: "Edit product" }));
    return screen.getByRole("dialog", { name: "Edit “product”" });
  };
  let dialog = openEdit();
  let input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Description" });
  expect(input.value).toBe("Current meaning");
  act(() => typeInto(input, "  New meaning  "));
  activate(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(listTagCatalog(peer)).toEqual([{ ...entry, description: "New meaning" }]);
  expect(within(host).getByRole("cell", { name: "New meaning" })).toBeTruthy();

  dialog = openEdit();
  input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Description" });
  expect(input.value).toBe("New meaning");
  const beforeCancel = Y.encodeStateAsUpdate(peer);
  act(() => typeInto(input, "Unsaved meaning"));
  activate(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(Y.encodeStateAsUpdate(peer)).toEqual(beforeCancel);

  dialog = openEdit();
  input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Description" });
  expect(input.value).toBe("New meaning");
  act(() => typeInto(input, "   "));
  activate(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save" }));
  expect(listTagCatalog(peer)).toEqual([{ id: entry.id, name: "product" }]);
  expect(within(host).getByRole("cell", { name: "No description" })).toBeTruthy();
});

it("keeps invalid edit drafts in the dialog without changing the catalog", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  createTagCatalogEntry(room.connection.ydoc, "product", undefined, "Current meaning");
  const host = await mountTags(room.connection, false);
  activate(within(host).getByRole<HTMLButtonElement>("button", { name: "Edit product" }));
  const dialog = screen.getByRole("dialog", { name: "Edit “product”" });
  const input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Description" });
  const before = Y.encodeStateAsUpdate(room.connection.ydoc);
  act(() => typeInto(input, "d".repeat(301)));
  activate(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save" }));
  expect(within(dialog).getByRole("alert").textContent).toContain("300");
  expect(input.value).toBe("d".repeat(301));
  expect(screen.getByRole("dialog", { name: "Edit “product”" })).toBe(dialog);
  expect(Y.encodeStateAsUpdate(room.connection.ydoc)).toEqual(before);
  expect(toast.success).not.toHaveBeenCalled();
});

it("refuses an edit after a peer deletes the tag without resurrecting it or writing", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const entry = createTagCatalogEntry(room.connection.ydoc, "product", undefined, "Current meaning");
  const peer = peerOf(room.connection.ydoc);
  const host = await mountTags(room.connection, false);
  activate(within(host).getByRole<HTMLButtonElement>("button", { name: "Edit product" }));
  const dialog = screen.getByRole("dialog", { name: "Edit “product”" });
  const input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Description" });
  act(() => typeInto(input, "Unsaved meaning"));
  act(() => deleteTagCatalogEntry(peer, entry.id));
  const before = Y.encodeStateAsUpdate(peer);
  activate(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save" }));
  expect(within(dialog).getByRole("alert").textContent).toBe("This tag no longer exists.");
  expect(input.value).toBe("Unsaved meaning");
  expect(Y.encodeStateAsUpdate(peer)).toEqual(before);
  expect(listTagCatalog(peer)).toEqual([]);
  expect(toast.success).not.toHaveBeenCalled();
});

it("rechecks writability before creating a tag and keeps both drafts", async () => {
  const room = statusRoom({ ...SYNCED }, settingsRoom(WORKSPACE.uuid));
  const host = await mountTags(room.connection, false);
  const name = within(host).getByRole<HTMLInputElement>("textbox", { name: "Name" });
  const description = within(host).getByRole<HTMLInputElement>("textbox", { name: "Description (optional)" });
  act(() => { typeInto(name, "product"); typeInto(description, "A draft meaning"); });
  const before = Y.encodeStateAsUpdate(room.connection.ydoc);
  room.connection.status.writable = false;
  act(() => name.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(within(host).getByRole("alert").textContent).toBe("Reconnect before changing the tag catalog.");
  expect(name.value).toBe("product");
  expect(description.value).toBe("A draft meaning");
  expect(Y.encodeStateAsUpdate(room.connection.ydoc)).toEqual(before);
  room.update({ writable: false });
  expect(within(host).getByRole<HTMLButtonElement>("button", { name: "Create" }).disabled).toBe(true);
  expect(host.textContent).toContain("Tag changes are unavailable");
});

it("rechecks writability when saving a description and disables Save when notified", async () => {
  const room = statusRoom({ ...SYNCED }, settingsRoom(WORKSPACE.uuid));
  createTagCatalogEntry(room.connection.ydoc, "product", undefined, "Current meaning");
  const host = await mountTags(room.connection, false);
  activate(within(host).getByRole<HTMLButtonElement>("button", { name: "Edit product" }));
  const dialog = screen.getByRole("dialog", { name: "Edit “product”" });
  const input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Description" });
  act(() => typeInto(input, "Unsaved meaning"));
  const before = Y.encodeStateAsUpdate(room.connection.ydoc);
  room.connection.status.writable = false;
  act(() => input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(within(dialog).getByRole("alert").textContent).toBe("Reconnect before changing the tag catalog.");
  expect(input.value).toBe("Unsaved meaning");
  expect(Y.encodeStateAsUpdate(room.connection.ydoc)).toEqual(before);
  room.update({ writable: false });
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
  expect(host.textContent).toContain("Tag changes are unavailable");
});

it("rechecks writability when confirming deletion", async () => {
  const room = statusRoom({ ...SYNCED }, settingsRoom(WORKSPACE.uuid));
  const host = await mountTags(room.connection);
  activate(within(host).getByRole<HTMLButtonElement>("button", { name: /^Delete\s*auth$/ }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete “auth”?" });
  room.connection.status.writable = false;
  activate(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Delete" }));
  expect(listTagCatalog(room.connection.ydoc).some((entry) => entry.name === "auth")).toBe(true);
  room.update({ writable: true });
  activate(within(host).getByRole<HTMLButtonElement>("button", { name: /^Delete\s*auth$/ }));
  const unavailableDialog = screen.getByRole("alertdialog", { name: "Delete “auth”?" });
  room.update({ writable: false });
  expect(within(unavailableDialog).getByRole<HTMLButtonElement>("button", { name: "Delete" }).disabled).toBe(true);
});

it("leaves focus untouched when a peer changes the catalog", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const peer = peerOf(room.connection.ydoc);
  const host = await mountTags(room.connection);
  const focused = within(host).getByRole<HTMLButtonElement>("button", { name: /^Delete\s*mcp$/ });
  act(() => focused.focus());
  act(() => createTagCatalogEntry(peer, "product"));
  expect(document.activeElement).toBe(focused);
  const auth = listTagCatalog(peer).find((entry) => entry.name === "auth");
  act(() => deleteTagCatalogEntry(peer, auth?.id ?? ""));
  expect(within(host).queryByRole("button", { name: /^Delete\s*auth$/ })).toBeNull();
  expect(document.activeElement).toBe(focused);
});

it("takes offline and refusal readings live from the shared status derivation", async () => {
  const room = statusRoom(SYNCED);
  const host = await mount(room.connection);
  openConnectionDetails(host);
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


const SHARED_FIELDS = [
  {
    label: "Name",
    save: "Save",
    read: getWorkspaceName,
    write: setWorkspaceName,
    other: getWorkspaceMainRepository,
    sample: (word: string) => `${word} name`,
    invalid: "   ",
    alert: "1–64 characters after trimming",
    typed: "  Product Research  ",
    stored: "Product Research",
    toast: "Saved “Product Research”.",
    reconnect: "Reconnect before renaming the workspace.",
  },
  {
    label: "Main repository",
    save: "Save main repository",
    read: getWorkspaceMainRepository,
    write: setWorkspaceMainRepository,
    other: getWorkspaceName,
    sample: (word: string) => `Owner/${word}`,
    invalid: "https://github.com/Owner/Repo/issues/1",
    alert: "owner/repo or a github.com repository address",
    typed: "https://github.com/Owner/Repo.git/",
    stored: "Owner/Repo",
    toast: "Saved main repository “Owner/Repo”.",
    reconnect: "Reconnect before changing the main repository.",
  },
];

it.each(SHARED_FIELDS)("$label waits for settings state, follows remote values while pristine and stores only a valid draft in its own room", async (field) => {
  const settings = statusRoom({ ...SYNCED, hasReceivedServerState: false }, settingsRoom(WORKSPACE.uuid));
  const doc = settings.connection.ydoc;
  setWorkspaceName(doc, "Current name");
  setWorkspaceMainRepository(doc, "Current/Repo");
  createTagCatalogEntry(doc, "product");
  const catalog = listTagCatalog(doc);
  const current = field.read(doc);
  const other = field.other(doc);
  const peer = peerOf(doc);
  const host = await mount(null, ENDPOINT, settings.connection);
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: field.label });
  const submit = within(host).getByRole<HTMLButtonElement>("button", { name: field.save });
  // Use the input's native form relationship to force submit while disabled.
  const forceSubmit = (): void => {
    act(() => input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  };
  try {
    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(input.value).toBe("");
    expect(host.textContent).toContain("Waiting for workspace settings");
    forceSubmit();
    expect(field.read(doc)).toBe(current);

    settings.update({ hasReceivedServerState: true });
    expect(input.value).toBe(current);
    act(() => field.write(peer, field.sample("Peer")));
    expect(input.value).toBe(field.sample("Peer"));
    act(() => typeInto(input, field.sample("Draft")));
    act(() => field.write(peer, field.sample("Later")));
    expect(input.value).toBe(field.sample("Draft"));

    settings.update({ writable: false, connected: false, synced: false });
    expect(input.disabled).toBe(true);
    forceSubmit();
    expect(within(host).getByRole("alert").textContent).toBe(field.reconnect);
    settings.connection.room = settingsRoom("11111111-2222-4333-8444-555555555555");
    settings.update({ writable: true, connected: true, synced: true });
    expect(input.disabled).toBe(true);
    forceSubmit();
    expect(field.read(doc)).toBe(field.sample("Later"));

    settings.connection.room = settingsRoom(WORKSPACE.uuid);
    settings.update({});
    expect(input.value).toBe(field.sample("Draft"));
    act(() => typeInto(input, field.invalid));
    act(() => submit.click());
    const alert = within(host).getByRole("alert");
    expect(alert.textContent).toContain(field.alert);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(field.read(doc)).toBe(field.sample("Later"));
    expect(toast.success).not.toHaveBeenCalled();

    act(() => typeInto(input, field.typed));
    act(() => submit.click());
    expect(field.read(peer)).toBe(field.stored);
    expect(input.value).toBe(field.stored);
    expect(toast.success).toHaveBeenLastCalledWith(field.toast, { id: "workspace-settings" });
    expect(within(host).queryByRole("alert")).toBeNull();
    expect(field.other(peer)).toBe(other);
    expect(listTagCatalog(peer)).toEqual(catalog);
    act(() => field.write(peer, field.sample("Followed")));
    expect(input.value).toBe(field.sample("Followed"));
  } finally { doc.destroy(); peer.destroy(); }
});

it.each(["input", "submit"])("preserves the focused %s when name or tag submission publishes success", async (focus) => {
  const settings = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  let host = await mount(null, ENDPOINT, settings.connection);
  let input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Name" });
  let submit = within(host).getByRole<HTMLButtonElement>("button", { name: "Save" });
  act(() => {
    typeInto(input, "New name");
    (focus === "input" ? input : submit).focus();
    submit.click();
  });
  expect(document.activeElement).toBe(focus === "input" ? input : submit);
  expect(within(host).queryByRole("status")).toBeNull();

  mounted?.unmount();
  host = await mountTags(settings.connection);
  input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Name" });
  submit = within(host).getByRole<HTMLButtonElement>("button", { name: "Create" });
  act(() => {
    typeInto(input, "product");
    (focus === "input" ? input : submit).focus();
    submit.click();
  });
  expect(document.activeElement).toBe(focus === "input" ? input : submit);
  expect(within(host).queryByRole("status")).toBeNull();
  settings.connection.ydoc.destroy();
});

it("keeps tag reconnect refusal inline and clears it when submission later succeeds", async () => {
  const settings = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const host = await mountTags(settings.connection);
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Name" });
  act(() => typeInto(input, "product"));
  settings.update({ writable: false, connected: false, synced: false });
  act(() => input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(within(host).getByRole("alert").textContent).toBe("Reconnect before changing the tag catalog.");
  expect(toast.success).not.toHaveBeenCalled();
  settings.update({ writable: true, connected: true, synced: true });
  act(() => within(host).getByRole<HTMLButtonElement>("button", { name: "Create" }).click());
  expect(within(host).queryByRole("alert")).toBeNull();
  expect(toast.success).toHaveBeenLastCalledWith("Created “product”.", { id: "workspace-settings" });
  settings.connection.ydoc.destroy();
});

const ACCESS_HUB = "https://hub.example.test";
const ADMIN: AccessMember = { principalId: "admin-principal", githubAccountId: "1001", githubUsername: "signed-in-admin", role: "admin" };
const SECOND_ADMIN: AccessMember = { principalId: "second-principal", githubAccountId: "1002", githubUsername: "second-admin", role: "admin" };
const NEW_MEMBER: AccessMember = { principalId: "new-principal", githubAccountId: "9001", githubUsername: "current-agent-login", role: "member" };

function accessHub(options: { role?: AccessRole; ownRoleStatus?: string; status?: string } = {}) {
  let role: AccessRole = options.role ?? "admin";
  let members = [{ ...ADMIN }, { ...SECOND_ADMIN }];
  let ownRoleStatus = options.ownRoleStatus;
  let override: ((action: AccessAction) => AccessAnswer | Response | null | Promise<AccessAnswer | Response | null>) | null = null;
  const calls: { action: AccessAction; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    expect(path).toBe("/api/access");
    const action = JSON.parse(init?.body as string) as AccessAction;
    calls.push({ action, init: init ?? {} });
    let body: AccessAnswer;
    const overridden = await override?.(action);
    if (overridden instanceof Response) return overridden;
    if (overridden !== undefined && overridden !== null) body = overridden;
    else if (options.status !== undefined) body = { status: options.status, hub: options.status === "local-only" ? null : ACCESS_HUB };
    else switch (action.operation) {
      case "own-hub-role":
      case "list-hub-admins":
      case "list-hub-workspaces":
      case "suspend-workspace":
      case "restore-workspace":
      case "remove-hub-admin": body = { status: "forbidden", hub: ACCESS_HUB }; break;
      case "own-role": body = { status: ownRoleStatus ?? "ok", hub: ACCESS_HUB, ...(ownRoleStatus === undefined ? { role } : {}) }; break;
      case "list-devices": throw new Error("Members must not read devices");
      case "list-members": body = { status: "ok", hub: ACCESS_HUB, members: members.map((item) => ({ ...item })) }; break;
      case "resolve-account": body = { status: "ok", hub: ACCESS_HUB, githubAccountId: NEW_MEMBER.githubAccountId, githubUsername: NEW_MEMBER.githubUsername }; break;
      case "grant-member": {
        const member = members.find((item) => item.githubAccountId === action.githubAccountId);
        const granted = member ?? { ...NEW_MEMBER, role: action.role ?? "member" };
        if (member === undefined) members.push(granted);
        body = { status: member === undefined ? "ok" : "already-member", hub: ACCESS_HUB, member: granted };
        break;
      }
      case "change-role": {
        const member = members.find((item) => item.principalId === action.principalId);
        if (member !== undefined) member.role = action.role;
        if (action.principalId === ADMIN.principalId) role = action.role;
        body = { status: "ok", hub: ACCESS_HUB };
        break;
      }
      case "remove-member":
        members = members.filter((item) => item.principalId !== action.principalId);
        if (action.principalId === ADMIN.principalId) ownRoleStatus = "forbidden";
        body = { status: "ok", hub: ACCESS_HUB }; break;
      case "revoke-device": throw new Error("Members must not revoke devices");
    }
    return new Response(JSON.stringify(body), { status: body.status === "closure-failed" ? 500 : 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { calls, setOverride: (next: typeof override) => { override = next; },
    add: (member: AccessMember) => { members.push(member); } };
}

async function mountAccess(local = true, catalogConnection: RoomConnection | null = null, servingWorkspace = WORKSPACE.uuid, verifiedHandle: string | null = null): Promise<HTMLElement> {
  mounted = await renderSettled(<WorkspaceSettings admin={true} page="members" workspace={WORKSPACE}
    serving={local ? { workspace: servingWorkspace, remoteHubUrl: "ws://127.0.0.1:1234", rebound: false } : null}
    subject="browser-person" verifiedHandle={verifiedHandle} endpoint={ENDPOINT} connection={null} catalogConnection={catalogConnection} agentSessions={2} />);
  return mounted.container;
}

function accessButton(host: HTMLElement, label: string): HTMLButtonElement {
  return within(host).getByRole<HTMLButtonElement>("button", { name: label });
}
async function clickAccess(host: HTMLElement, label: string): Promise<void> {
  await act(async () => accessButton(host, label).click());
}
async function lookUp(host: HTMLElement, handle = "old-agent-login"): Promise<void> {
  act(() => typeInto(within(host).getByRole<HTMLInputElement>("textbox", { name: "GitHub handle" }), handle));
  await clickAccess(host, "Look up");
}
async function selectAccess(host: HTMLElement, label: string, value: AccessRole): Promise<void> {
  const select = within(host).getByRole<HTMLSelectElement>("combobox", { name: label });
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}

it("shows the role under the title and uses named member controls without a refresh or save step", async () => {
  accessHub(); const host = await mountAccess();
  const title = within(host).getByRole("heading", { level: 1, name: "Members" });
  expect(title.nextElementSibling?.textContent).toBe("You are an admin of this workspace.");
  expect(within(host).getByRole("heading", { level: 2, name: "Add a member" })).toBeTruthy();
  const members = within(host).getByRole("table", { name: "Members" });
  expect(within(members).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Account", "Role", "Actions"]);
  const role = within(host).getByRole("combobox", { name: `Role for ${ADMIN.githubUsername}` });
  expect(within(role).getAllByRole("option").map((option) => option.textContent)).toEqual(["Member", "Admin"]);
  expect(accessButton(host, `Remove ${ADMIN.githubUsername}`).textContent).toBe("Remove");
  expect(within(host).queryByRole("heading", { name: "Workspace access" })).toBeNull();
  expect(within(host).queryByRole("button", { name: /Refresh|Save role/ })).toBeNull();
  expect(host.textContent).not.toContain("Access is read from the hub on each visit");
});

it.each([
  ["SIGNED-IN-ADMIN", ADMIN.githubUsername],
  [null, null],
  ["browser-person", null],
])("marks only the verified account handle %s as you", async (verifiedHandle, currentHandle) => {
  accessHub(); const host = await mountAccess(true, null, WORKSPACE.uuid, verifiedHandle);
  const markers = within(within(host).getByRole("table", { name: "Members" })).queryAllByText("you", { exact: true });
  expect(markers).toHaveLength(currentHandle === null ? 0 : 1);
  if (currentHandle !== null) expect(markers[0]?.closest("th")?.textContent).toBe(`${currentHandle}you`);
});

it("confirms the hub-resolved login and account ID before the default member grant, then reads a fresh members table", async () => {
  const hub = accessHub();
  const catalog = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  setWorkspaceName(catalog.connection.ydoc, "Collaborative settings");
  const before = Y.encodeStateAsUpdate(catalog.connection.ydoc);
  const host = await mountAccess(true, catalog.connection);
  await lookUp(host);
  expect(host.textContent).toContain("current-agent-login · GitHub account 9001");
  expect(hub.calls.some(({ action }) => action.operation === "grant-member")).toBe(false);
  expect(within(host).queryByRole("combobox", { name: "Role for new account" })).toBeNull();
  await clickAccess(host, "Add as member");
  expect(hub.calls.find(({ action }) => action.operation === "grant-member")?.action).toEqual({
    operation: "grant-member", workspaceId: WORKSPACE.uuid, githubAccountId: "9001", role: "member",
  });
  expect(within(host).getByRole("table", { name: "Members" }).textContent).toContain("current-agent-login");
  expect(host.textContent).toContain("current-agent-login added as Member.");
  expect(hub.calls.filter(({ action }) => action.operation === "list-members")).toHaveLength(2);
  expect(Y.encodeStateAsUpdate(catalog.connection.ydoc)).toEqual(before);
  const bearers = hub.calls.map(({ init }) => (init.headers as Record<string, string>).Authorization);
  expect(new Set(bearers).size).toBe(bearers.length);
  expect(hub.calls.every(({ init }) => init.cache === "no-store" && init.method === "POST")).toBe(true);
  expect(hub.calls.every(({ action }) => !Object.hasOwn(action, "token") && !Object.hasOwn(action, "key"))).toBe(true);
  catalog.connection.ydoc.destroy();
});

it("keeps a concurrent existing grant's role and offers no grant for a known member", async () => {
  const hub = accessHub(); const host = await mountAccess();
  await lookUp(host);
  hub.add({ ...NEW_MEMBER, role: "admin" });
  await clickAccess(host, "Add as member");
  expect(hub.calls.find(({ action }) => action.operation === "grant-member")?.action).toMatchObject({ role: "member" });
  expect(host.textContent).toContain("current-agent-login is already a member as Admin.");
  await lookUp(host);
  expect(host.textContent).toContain("Already a member as Admin.");
  expect(within(host).queryByRole("button", { name: "Add as member" })).toBeNull();
  expect(hub.calls.filter(({ action }) => action.operation === "grant-member")).toHaveLength(1);
});

it.each([ ["account-not-found", "No such GitHub account"], ["lookup-unavailable", "lookup is unavailable"] ])(
  "distinguishes %s without granting or keeping a confirmed account", async (status, message) => {
    const hub = accessHub(); const host = await mountAccess();
    hub.setOverride((action) => action.operation === "resolve-account" ? { status, hub: ACCESS_HUB } : null);
    await lookUp(host);
    expect(host.textContent).toContain(message);
    expect(hub.calls.some(({ action }) => action.operation === "grant-member")).toBe(false);
    expect(within(host).queryByLabelText("Role for new account")).toBeNull();
  },
);

it.each(["@octocat", "https://github.com/octocat", "octo cat"])(
  "explains the bridge's invalid-request answer for handle %s without reporting a hub outage", async (handle) => {
    const hub = accessHub(); const host = await mountAccess();
    hub.setOverride((action) => action.operation === "resolve-account"
      ? new Response(JSON.stringify({ status: "invalid-request" }), { status: 400 }) : null);
    await lookUp(host, handle);
    expect(within(host).getByRole("alert").textContent).toBe("Enter a GitHub handle, without @, a link or spaces.");
    expect(host.textContent).not.toContain("The hub cannot be reached");
    expect(within(host).getByRole("table", { name: "Members" }).textContent).toContain(ADMIN.githubUsername);
    expect(hub.calls.filter(({ action }) => action.operation === "list-members")).toHaveLength(1);
    expect(hub.calls.some(({ action }) => action.operation === "grant-member")).toBe(false);
    expect(within(host).queryByLabelText("Role for new account")).toBeNull();
  },
);

it("shows a member role without member management or device reads", async () => {
  const hub = accessHub({ role: "member" }); const host = await mountAccess();
  expect(host.textContent).toContain("You are a member of this workspace.");
  expect(within(host).queryByRole("table", { name: "Members" })).toBeNull();
  expect(within(host).queryByLabelText("GitHub handle")).toBeNull();
  expect(hub.calls.some(({ action }) => action.operation === "list-members")).toBe(false);
  expect(hub.calls.some(({ action }) => action.operation === "list-devices")).toBe(false);
});

it("shows a refused role read without member management or device reads", async () => {
  const hub = accessHub({ ownRoleStatus: "forbidden" }); const host = await mountAccess();
  expect(host.textContent).toContain("The hub refused access");
  expect(within(host).queryByRole("table", { name: "Members" })).toBeNull();
  expect(within(host).queryByLabelText("GitHub handle")).toBeNull();
  expect(hub.calls.some(({ action }) => action.operation === "list-members")).toBe(false);
  expect(hub.calls.some(({ action }) => action.operation === "list-devices")).toBe(false);
});

it("shows a hub role-change refusal and keeps the hub's unchanged role", async () => {
  const hub = accessHub(); const host = await mountAccess();
  hub.setOverride((action) => action.operation === "change-role" ? { status: "last-admin", hub: ACCESS_HUB } : null);
  await selectAccess(host, `Role for ${ADMIN.githubUsername}`, "member");
  expect(host.textContent).toContain("The hub refused this change: the last admin cannot be removed or demoted.");
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: `Role for ${ADMIN.githubUsername}` }).value).toBe("admin");
  expect(toast.success).not.toHaveBeenCalled();
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(2);
  expect(hub.calls.filter(({ action }) => action.operation === "list-members")).toHaveLength(2);
});

it("saves a different role on pick, disables management until the reread and announces success once", async () => {
  const hub = accessHub(); const host = await mountAccess();
  await lookUp(host);
  await selectAccess(host, `Role for ${SECOND_ADMIN.githubUsername}`, "admin");
  expect(hub.calls.some(({ action }) => action.operation === "change-role")).toBe(false);
  let releaseChange: (answer: null) => void = () => { throw new Error("No pending role change"); };
  hub.setOverride((action) => action.operation === "change-role"
    ? new Promise<null>((resolve) => { releaseChange = resolve; }) : null);
  await selectAccess(host, `Role for ${SECOND_ADMIN.githubUsername}`, "member");
  expect(hub.calls.filter(({ action }) => action.operation === "change-role").map(({ action }) => action)).toEqual([
    { operation: "change-role", workspaceId: WORKSPACE.uuid, principalId: SECOND_ADMIN.principalId, role: "member" },
  ]);
  expect(within(host).getByRole<HTMLInputElement>("textbox", { name: "GitHub handle" }).disabled).toBe(true);
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: `Role for ${SECOND_ADMIN.githubUsername}` }).value).toBe("member");
  expect(within(host).getAllByRole<HTMLSelectElement>("combobox").every((select) => select.disabled)).toBe(true);
  expect(within(host).getAllByRole<HTMLButtonElement>("button").every((button) => button.disabled)).toBe(true);
  expect(toast.success).not.toHaveBeenCalled();
  await act(async () => releaseChange(null));
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: `Role for ${SECOND_ADMIN.githubUsername}` }).value).toBe("member");
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: `Role for ${SECOND_ADMIN.githubUsername}` }).disabled).toBe(false);
  expect(toast.success).toHaveBeenCalledTimes(1);
  expect(toast.success).toHaveBeenCalledWith("Role changed", { id: "workspace-role" });
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(2);
  expect(hub.calls.filter(({ action }) => action.operation === "list-members")).toHaveLength(2);
});

it("rereads a failed role pick and displays the hub's role without a success toast", async () => {
  const hub = accessHub(); const host = await mountAccess();
  hub.setOverride((action) => {
    if (action.operation === "change-role") throw new TypeError("Hub connection lost");
    return null;
  });
  await selectAccess(host, `Role for ${SECOND_ADMIN.githubUsername}`, "member");
  expect(within(host).getByRole("alert").textContent).toBe("The hub cannot be reached. Reconnect to the hub, then retry.");
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: `Role for ${SECOND_ADMIN.githubUsername}` }).value).toBe("admin");
  expect(toast.success).not.toHaveBeenCalled();
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(2);
  expect(hub.calls.filter(({ action }) => action.operation === "list-members")).toHaveLength(2);
});

it("keeps member management unavailable when the reread after a failed pick also fails", async () => {
  const hub = accessHub(); const host = await mountAccess();
  hub.setOverride(() => ({ status: "hub-down", hub: ACCESS_HUB }));
  await selectAccess(host, `Role for ${SECOND_ADMIN.githubUsername}`, "member");
  expect(host.textContent).toContain("The hub cannot be reached. Reconnect to the hub, then retry.");
  expect(within(host).queryByRole("table", { name: "Members" })).toBeNull();
  expect(within(host).queryByRole("textbox", { name: "GitHub handle" })).toBeNull();
  expect(within(host).queryByRole("combobox")).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(2);
});

it("applies self-demotion on pick and removes member management after the new role is read", async () => {
  const hub = accessHub(); const host = await mountAccess();
  await selectAccess(host, `Role for ${ADMIN.githubUsername}`, "member");
  expect(host.textContent).toContain("You are a member of this workspace.");
  expect(within(host).queryByRole("alertdialog")).toBeNull();
  expect(within(host).queryByRole("table", { name: "Members" })).toBeNull();
  expect(toast.success).toHaveBeenCalledWith("Role changed", { id: "workspace-role" });
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(2);
});

it("confirms member removal on every device, then preserves acknowledged self-removal after access is forbidden", async () => {
  const hub = accessHub(); const host = await mountAccess();
  await clickAccess(host, `Remove ${ADMIN.githubUsername}`);
  const dialog = screen.getByRole("alertdialog", { name: `Remove ${ADMIN.githubUsername}?` });
  expect(dialog?.textContent).toContain("This person loses this workspace on every device");
  expect(dialog?.textContent).toContain("Documents already downloaded stay where they are");
  expect(hub.calls.some(({ action }) => action.operation === "remove-member")).toBe(false);
  await clickAccess(dialog, "Remove member");
  expect(host.textContent).toContain("signed-in-admin removed from this workspace.");
  expect(host.textContent).toContain("The hub refused access");
  expect(within(host).queryByRole("table", { name: "Members" })).toBeNull();
  expect(hub.calls.some(({ action }) => action.operation === "list-devices")).toBe(false);
});

it.each([
  ["local-only", "no members", "ub workspace promote"],
  ["not-configured", "no GitHub sign-in configured", "hub owner"],
  ["sign-in-required", "Sign-in is required", "ub auth login"],
  ["hub-down", "cannot be reached", "Reconnect"],
  ["protocol-mismatch", "protocol versions differ", "Update ub"],
])("offers no changes in %s and gives a recovery step", async (status, message, step) => {
  accessHub({ status }); const host = await mountAccess();
  expect(host.textContent).toContain(message); expect(host.textContent).toContain(step);
  expect(within(host).queryAllByRole("table", { hidden: true })).toHaveLength(0);
  expect(within(host).queryAllByRole("textbox", { hidden: true })).toHaveLength(0);
  expect(within(host).queryAllByRole("button", { hidden: true })).toHaveLength(0);
});

it("does not call the local management route from a direct-served page", async () => {
  const hub = accessHub(); const host = await mountAccess(false);
  expect(host.textContent).toContain("Run ub open in its project");
  expect(hub.calls).toHaveLength(0); expect(within(host).queryAllByRole("button", { hidden: true })).toHaveLength(0);
});

it("accepts the served workspace's decorated segment and makes new live reads on every visit", async () => {
  const hub = accessHub();
  const host = await mountAccess(true, null, WORKSPACE.segment);
  expect(host.textContent).toContain("You are an admin of this workspace.");
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(1);
  const priorSignals = hub.calls.map(({ init }) => init.signal);
  mounted?.unmount(); mounted = null;
  expect(priorSignals.every((signal) => signal?.aborted)).toBe(true);
  hub.add({ ...NEW_MEMBER });
  const revisited = await mountAccess(true, null, WORKSPACE.segment);
  expect(within(revisited).getByRole("table", { name: "Members" }).textContent).toContain(NEW_MEMBER.githubUsername);
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(2);
  expect(hub.calls.filter(({ action }) => action.operation === "list-devices")).toHaveLength(0);
  expect(hub.calls.filter(({ action }) => action.operation === "list-members")).toHaveLength(2);
});
