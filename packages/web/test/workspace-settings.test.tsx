import { afterEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, renderSettled, type RenderResult } from "./react-render.js";
import * as Y from "yjs";
import {
  EXAMPLE_TAGS,
  createTagCatalogEntry,
  listTagCatalog,
  getWorkspaceName,
  setWorkspaceName,
  retireTagCatalogEntry,
  settingsRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { HubEndpoint } from "../src/config.js";
import { notifyTransient } from "../src/notifications.js";
import { WorkspaceSettings } from "../src/ui/WorkspaceSettings.js";
import type { Workspace } from "../src/ui/route.js";
import type { AccessAction, AccessAnswer, AccessMember, AccessRole } from "../src/shell/workspace-access.js";

vi.mock("../src/collab/rooms.js", async (original) => ({
  ...await original<typeof import("../src/collab/rooms.js")>(),
  mintHubAuthMessage: vi.fn(async () => `local-browser-bearer-${crypto.randomUUID()}`),
}));
vi.mock("../src/notifications.js", () => ({ notifyTransient: vi.fn() }));

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
  vi.mocked(notifyTransient).mockClear();
});

async function mount(
  connection: RoomConnection | null,
  endpoint: HubEndpoint | null = ENDPOINT,
  catalogConnection: RoomConnection | null = null,
): Promise<HTMLElement> {
  mounted = await renderSettled(
    <WorkspaceSettings
      workspace={WORKSPACE}
      endpoint={endpoint}
      connection={connection}
      catalogConnection={catalogConnection}
      agentSessions={2}
    />,
  );
  return mounted.container;
}

async function mountTags(connection: RoomConnection | null): Promise<HTMLElement> {
  mounted = await renderSettled(
    <WorkspaceSettings
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
    within(host).getAllByRole("term", { hidden: true }).map((term) => [
      term.textContent ?? "",
      // A definition-list row has no role; its term identifies the paired fact.
      within(term.parentElement as HTMLElement).getByRole("definition", { hidden: true }).textContent ?? "",
    ]),
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

  mounted?.unmount();
  mounted = null;
  const unknown = facts(await mount(null, null));
  expect(unknown.get("Hub")).toBe("—");
  expect(unknown.get("Source")).toBe("—");
  expect(unknown.get("Connection")).toBe("offline");
  expect(unknown.get("Documents")).toBe("—");
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
  expect(within(host).queryByLabelText("Create a tag")).toBeNull();
  expect(within(host).queryAllByRole("list", { hidden: true })).toHaveLength(0);

  room.update({
    connected: true,
    synced: true,
    hasReceivedServerState: true,
    writable: true,
    storeRefused: false,
  });
  await act(async () => {});
  expect(
    within(within(host).getByRole("region", { name: "Active" })).getAllByRole("listitem", { hidden: true }).map(
      // The tag is repeated in the button's screen-reader text; the row's
      // visible label precedes that second occurrence.
      (row) => within(row).getAllByText(/^[a-z0-9-]+$/)[0]?.textContent,
    ),
  ).toEqual(EXAMPLE_TAGS.map((entry) => entry.name));

  act(() => {
    for (const entry of listTagCatalog(room.connection.ydoc)) {
      retireTagCatalogEntry(room.connection.ydoc, entry.id);
    }
  });
  expect(host.textContent).toContain("No active tags.");
  expect(
    within(within(host).getByRole("region", { name: "Retired" })).getAllByRole("listitem", { hidden: true }),
  ).toHaveLength(EXAMPLE_TAGS.length);

  room.update({ connected: false, synced: false, writable: false });
  expect(host.textContent).not.toContain("Waiting for the tag catalog");
  expect(host.textContent).toContain("Tag changes are unavailable");
  const controls = within(host).getAllByRole<HTMLButtonElement>("button", { hidden: true });
  expect(controls).toHaveLength(EXAMPLE_TAGS.length + 1);
  expect(controls.every((button) => button.disabled)).toBe(true);
  expect(within(host).getByRole<HTMLInputElement>("textbox", { name: "Create a tag" }).disabled).toBe(true);

  room.update({ connected: true, synced: true, writable: true });
  expect(
    within(within(host).getByRole("region", { name: "Retired" })).getAllByRole<HTMLButtonElement>("button", { hidden: true }).every(
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
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Create a tag" });
  const submit = within(host).getByRole<HTMLButtonElement>("button", { name: "Create" });

  act(() => {
    typeInto(input, "Needs spaces");
    submit.click();
  });
  expect(within(host).getByRole("alert").textContent).toBe(
    "Use 1–30 lowercase letters or numbers, separated by single hyphens.",
  );

  act(() => {
    typeInto(input, "auth");
    submit.click();
  });
  expect(within(host).getByRole("alert").textContent).toBe(
    "“auth” is already an active tag.",
  );
  expect(notifyTransient).not.toHaveBeenCalled();

  act(() => typeInto(input, "product"));
  expect(within(host).queryByRole("alert")).toBeNull();
  act(() => submit.click());
  const created = listTagCatalog(peer).find((entry) => entry.name === "product");
  expect(created).toMatchObject({ name: "product", state: "active" });
  expect(notifyTransient).toHaveBeenLastCalledWith({ key: "workspace-settings", message: "Created “product”.", severity: "success" });
  expect(host.textContent).not.toContain("Created “product”.");

  act(() => within(within(host).getByRole("region", { name: "Active" })).getByRole<HTMLButtonElement>("button", { name: /^Retire\s*product$/ }).click());
  expect(listTagCatalog(peer).find((entry) => entry.id === created?.id)?.state).toBe(
    "retired",
  );
  expect(notifyTransient).toHaveBeenLastCalledWith({ key: "workspace-settings", message: "Retired “product”.", severity: "success" });
  expect(host.textContent).not.toContain("Retired “product”.");

  act(() => {
    typeInto(input, "product");
    submit.click();
  });
  expect(within(host).getByRole("alert").textContent).toBe(
    "“product” is retired. Restore it from the retired list.",
  );
  expect(notifyTransient).toHaveBeenCalledTimes(2);

  act(() => within(within(host).getByRole("region", { name: "Retired" })).getByRole<HTMLButtonElement>("button", { name: /^Restore\s*product$/ }).click());
  expect(listTagCatalog(peer).find((entry) => entry.id === created?.id)?.state).toBe(
    "active",
  );
  expect(within(host).queryByRole("alert")).toBeNull();
  expect(notifyTransient).toHaveBeenLastCalledWith({ key: "workspace-settings", message: "Restored “product”.", severity: "success" });
  expect(host.textContent).not.toContain("Restored “product”.");

  act(() => {
    createTagCatalogEntry(peer, "zeta");
  });
  expect(host.textContent).toContain("zeta");
});

/** The Retire or Restore control of one entry, by its accessible name. */
function lifecycle(host: HTMLElement, name: string): HTMLButtonElement {
  // Without the Tailwind stylesheet, jsdom joins the sr-only tag to the verb.
  return within(host).getByRole<HTMLButtonElement>("button", { name: new RegExp(`^${name.replace(" ", "\\s*")}$`) });
}

/** Activate a control the way a keyboard does: on the focused element. */
function activate(control: HTMLButtonElement): void {
  act(() => {
    control.focus();
    control.click();
  });
}

it("leaves focus on the nearest lifecycle control after a retire or restore", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const host = await mountTags(room.connection);

  // The entry that took the retired one's place in the list it left.
  activate(lifecycle(host, "Retire billing"));
  expect(document.activeElement).toBe(lifecycle(host, "Retire mcp"));

  // Restoring the only retired entry empties that list: its own new control.
  activate(lifecycle(host, "Restore billing"));
  expect(document.activeElement).toBe(lifecycle(host, "Retire billing"));

  // The last entry has no successor, so the new last one takes the focus.
  activate(lifecycle(host, "Retire sync"));
  expect(document.activeElement).toBe(lifecycle(host, "Retire permissions"));
});

it("leaves focus untouched when a peer changes the catalog", async () => {
  const room = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const peer = peerOf(room.connection.ydoc);
  const host = await mountTags(room.connection);
  const focused = lifecycle(host, "Retire mcp");
  act(() => focused.focus());

  act(() => createTagCatalogEntry(peer, "product"));
  expect(document.activeElement).toBe(focused);

  const auth = listTagCatalog(peer).find((entry) => entry.name === "auth");
  act(() => retireTagCatalogEntry(peer, auth?.id ?? ""));
  expect(host.textContent).toContain("Restore auth");
  expect(document.activeElement).toBe(focused);
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


it("renames only shared workspace state and refuses invalid drafts without changing the name", async () => {
  const directory = statusRoom(SYNCED);
  const settings = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  setWorkspaceName(settings.connection.ydoc, "Current name");
  createTagCatalogEntry(settings.connection.ydoc, "product");
  const catalog = listTagCatalog(settings.connection.ydoc);
  const host = await mount(directory.connection, ENDPOINT, settings.connection);
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Workspace name" });
  const submit = within(host).getByRole<HTMLButtonElement>("button", { name: "Save" });
  expect(input.value).toBe("Current name");

  for (const invalid of ["   ", "x".repeat(65), "Control\u0007name", "Format\u200bname"]) {
    act(() => typeInto(input, invalid));
    expect(within(host).queryByRole("alert")).toBeNull();
    act(() => submit.click());
    expect(within(host).getByRole("alert").textContent).toContain("1–64 characters after trimming");
    expect(getWorkspaceName(settings.connection.ydoc)).toBe("Current name");
  }
  expect(notifyTransient).not.toHaveBeenCalled();
  act(() => typeInto(input, "  Product Research  "));
  act(() => submit.click());
  expect(getWorkspaceName(settings.connection.ydoc)).toBe("Product Research");
  expect(input.value).toBe("Product Research");
  expect(notifyTransient).toHaveBeenLastCalledWith({ key: "workspace-settings", message: "Saved “Product Research”.", severity: "success" });
  expect(host.textContent).not.toContain("Saved “Product Research”.");
  expect(within(host).queryByRole("alert")).toBeNull();
  expect(listTagCatalog(settings.connection.ydoc)).toEqual(catalog);
  expect(facts(host).get("Workspace UUID")).toBe(WORKSPACE.uuid);
  expect(facts(host).get("Address segment")).toBe(WORKSPACE.segment);
  directory.connection.ydoc.destroy(); settings.connection.ydoc.destroy();
});

it("follows shared names while pristine and preserves an edited rename draft", async () => {
  const settings = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  const peer = peerOf(settings.connection.ydoc);
  const host = await mount(null, ENDPOINT, settings.connection);
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Workspace name" });
  const submit = within(host).getByRole<HTMLButtonElement>("button", { name: "Save" });
  expect(input.value).toBe("");

  act(() => setWorkspaceName(peer, "Arriving name"));
  expect(input.value).toBe("Arriving name");
  act(() => typeInto(input, "Local draft"));
  act(() => setWorkspaceName(peer, "Peer name"));
  expect(input.value).toBe("Local draft");
  act(() => setWorkspaceName(peer, "Another peer name"));
  expect(input.value).toBe("Local draft");

  act(() => typeInto(input, "Another peer name"));
  act(() => setWorkspaceName(peer, "Followed name"));
  expect(input.value).toBe("Followed name");
  act(() => typeInto(input, "Saved local name"));
  act(() => submit.click());
  expect(getWorkspaceName(peer)).toBe("Saved local name");
  act(() => setWorkspaceName(peer, "Later peer name"));
  expect(input.value).toBe("Later peer name");
  settings.connection.ydoc.destroy();
  peer.destroy();
});

it("waits for settings state and refuses renaming when its room cannot write", async () => {
  const settings = statusRoom({ ...SYNCED, hasReceivedServerState: false }, settingsRoom(WORKSPACE.uuid));
  setWorkspaceName(settings.connection.ydoc, "Existing name");
  const host = await mount(null, ENDPOINT, settings.connection);
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Workspace name" });
  // Use the input's native form relationship to force submit while disabled.
  const form = input.form as HTMLFormElement;
  const button = within(host).getByRole<HTMLButtonElement>("button", { name: "Save" });
  expect(input.disabled).toBe(true);
  expect(button.disabled).toBe(true);
  expect(input.value).toBe("");
  expect(host.textContent).toContain("Waiting for workspace settings");
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(getWorkspaceName(settings.connection.ydoc)).toBe("Existing name");
  settings.update({ hasReceivedServerState: true });
  expect(input.value).toBe("Existing name");
  expect(input.disabled).toBe(false);
  act(() => typeInto(input, "Disconnected overwrite"));
  settings.update({ writable: false, connected: false, synced: false });
  expect(input.disabled).toBe(true);
  expect(button.disabled).toBe(true);
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(getWorkspaceName(settings.connection.ydoc)).toBe("Existing name");
  expect(host.textContent).toContain("Reconnect before renaming");
  expect(within(host).getByRole("alert").textContent).toBe("Reconnect before renaming the workspace.");
  expect(notifyTransient).not.toHaveBeenCalled();
  settings.update({ writable: true, connected: true, synced: true });
  expect(button.disabled).toBe(false);
  act(() => button.click());
  expect(within(host).queryByRole("alert")).toBeNull();
  expect(notifyTransient).toHaveBeenLastCalledWith({ key: "workspace-settings", message: "Saved “Disconnected overwrite”.", severity: "success" });
  settings.connection.ydoc.destroy();
});

it.each(["input", "submit"])("preserves the focused %s when name or tag submission publishes success", async (focus) => {
  const settings = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  let host = await mount(null, ENDPOINT, settings.connection);
  let input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Workspace name" });
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
  input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Create a tag" });
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
  const input = within(host).getByRole<HTMLInputElement>("textbox", { name: "Create a tag" });
  act(() => typeInto(input, "product"));
  settings.update({ writable: false, connected: false, synced: false });
  act(() => input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(within(host).getByRole("alert").textContent).toBe("Reconnect before changing the tag catalog.");
  expect(notifyTransient).not.toHaveBeenCalled();
  settings.update({ writable: true, connected: true, synced: true });
  act(() => within(host).getByRole<HTMLButtonElement>("button", { name: "Create" }).click());
  expect(within(host).queryByRole("alert")).toBeNull();
  expect(notifyTransient).toHaveBeenLastCalledWith({ key: "workspace-settings", message: "Created “product”.", severity: "success" });
  settings.connection.ydoc.destroy();
});

const ACCESS_HUB = "https://hub.example.test";
const ADMIN: AccessMember = { principalId: "admin-principal", githubAccountId: "1001", githubUsername: "signed-in-admin", role: "admin" };
const SECOND_ADMIN: AccessMember = { principalId: "second-principal", githubAccountId: "1002", githubUsername: "second-admin", role: "admin" };
const NEW_MEMBER: AccessMember = { principalId: "new-principal", githubAccountId: "9001", githubUsername: "current-agent-login", role: "member" };

function accessHub(options: { role?: AccessRole; ownRoleStatus?: string; status?: string } = {}) {
  let role: AccessRole = options.role ?? "admin";
  let members = [{ ...ADMIN }, { ...SECOND_ADMIN }];
  let devices = [
    { deviceId: "current-device", signedInAt: Date.UTC(2026, 9, 5, 10), current: true },
    { deviceId: "other-own-device", signedInAt: Date.UTC(2026, 9, 4, 12), current: false },
  ];
  let signedIn = true;
  let ownRoleStatus = options.ownRoleStatus;
  let override: ((action: AccessAction) => AccessAnswer | Response | null) | null = null;
  const calls: { action: AccessAction; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    expect(path).toBe("/api/access");
    const action = JSON.parse(init?.body as string) as AccessAction;
    calls.push({ action, init: init ?? {} });
    let body: AccessAnswer;
    const overridden = override?.(action);
    if (overridden instanceof Response) return overridden;
    if (overridden !== undefined && overridden !== null) body = overridden;
    else if (options.status !== undefined) body = { status: options.status, hub: options.status === "local-only" ? null : ACCESS_HUB };
    else if (!signedIn) body = { status: "sign-in-required", hub: ACCESS_HUB };
    else switch (action.operation) {
      case "own-role": body = { status: ownRoleStatus ?? "ok", hub: ACCESS_HUB, ...(ownRoleStatus === undefined ? { role } : {}) }; break;
      case "list-devices": body = { status: "ok", hub: ACCESS_HUB, devices: [...devices] }; break;
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
      case "revoke-device":
        devices = devices.filter((device) => device.deviceId !== action.deviceId);
        if (action.deviceId === "current-device") signedIn = false;
        body = { status: "ok", hub: ACCESS_HUB }; break;
    }
    return new Response(JSON.stringify(body), { status: body.status === "closure-failed" ? 500 : 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { calls, setOverride: (next: typeof override) => { override = next; },
    add: (member: AccessMember) => { members.push(member); }, revokeCurrent: () => { signedIn = false; } };
}

async function mountAccess(local = true, catalogConnection: RoomConnection | null = null, servingWorkspace = WORKSPACE.uuid): Promise<HTMLElement> {
  mounted = await renderSettled(<WorkspaceSettings page="access" workspace={WORKSPACE}
    serving={local ? { workspace: servingWorkspace, remoteHubUrl: "ws://127.0.0.1:1234", rebound: false } : null}
    subject="browser-person" endpoint={ENDPOINT} connection={null} catalogConnection={catalogConnection} agentSessions={2} />);
  return mounted.container;
}

function accessButton(host: HTMLElement, label: string): HTMLButtonElement {
  return within(host).getByRole<HTMLButtonElement>("button", { name: label });
}
async function clickAccess(host: HTMLElement, label: string): Promise<void> {
  await act(async () => accessButton(host, label).click());
}
async function lookUp(host: HTMLElement, handle = "old-agent-login"): Promise<void> {
  act(() => typeInto(within(host).getByRole<HTMLInputElement>("textbox", { name: "GitHub account" }), handle));
  await clickAccess(host, "Look up account");
}
function selectAccess(host: HTMLElement, label: string, value: AccessRole): void {
  const select = within(host).getByRole<HTMLSelectElement>("combobox", { name: label });
  act(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}

it("confirms the hub-resolved login and account ID before the default member grant, then reads a fresh members table", async () => {
  const hub = accessHub();
  const catalog = statusRoom(SYNCED, settingsRoom(WORKSPACE.uuid));
  setWorkspaceName(catalog.connection.ydoc, "Collaborative settings");
  const before = Y.encodeStateAsUpdate(catalog.connection.ydoc);
  const host = await mountAccess(true, catalog.connection);
  await lookUp(host);
  expect(host.textContent).toContain("current-agent-login (GitHub account 9001)");
  expect(hub.calls.some(({ action }) => action.operation === "grant-member")).toBe(false);
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: "Role for new account" }).value).toBe("member");
  await clickAccess(host, "Confirm and add account");
  expect(hub.calls.find(({ action }) => action.operation === "grant-member")?.action).toEqual({
    operation: "grant-member", workspaceId: WORKSPACE.uuid, githubAccountId: "9001", role: "member",
  });
  expect(within(host).getByRole("table", { name: "Members" }).textContent).toContain("current-agent-login");
  expect(host.textContent).toContain("current-agent-login added as member.");
  expect(hub.calls.filter(({ action }) => action.operation === "list-members")).toHaveLength(2);
  expect(Y.encodeStateAsUpdate(catalog.connection.ydoc)).toEqual(before);
  const bearers = hub.calls.map(({ init }) => (init.headers as Record<string, string>).Authorization);
  expect(new Set(bearers).size).toBe(bearers.length);
  expect(hub.calls.every(({ init }) => init.cache === "no-store" && init.method === "POST")).toBe(true);
  expect(hub.calls.every(({ action }) => !Object.hasOwn(action, "token") && !Object.hasOwn(action, "key"))).toBe(true);
  catalog.connection.ydoc.destroy();
});

it("requires an explicit admin choice and shows a concurrent existing grant with its preserved role", async () => {
  const hub = accessHub(); const host = await mountAccess();
  await lookUp(host); selectAccess(host, "Role for new account", "admin");
  hub.add({ ...NEW_MEMBER, role: "member" });
  await clickAccess(host, "Confirm and add account");
  expect(hub.calls.find(({ action }) => action.operation === "grant-member")?.action).toMatchObject({ role: "admin" });
  expect(host.textContent).toContain("current-agent-login is already a member as member.");
  await lookUp(host);
  expect(host.textContent).toContain("Already a member as member.");
  expect(within(host).queryByText("Confirm and add account")).toBeNull();
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

it("offers members only their role and own devices with sign-in times and this-computer marker", async () => {
  const hub = accessHub({ role: "member" }); const host = await mountAccess();
  expect(host.textContent).toContain("Your role: member.");
  expect(within(host).queryByLabelText("Members")).toBeNull();
  expect(within(host).queryByLabelText("GitHub account")).toBeNull();
  expect(hub.calls.some(({ action }) => action.operation === "list-members")).toBe(false);
  const table = within(host).getByRole("table", { name: "Your devices" });
  expect(within(table).getAllByRole("row", { hidden: true }).slice(1)).toHaveLength(2);
  expect(table?.textContent).toContain("This computer");
  expect(within(table).getAllByRole("time", { hidden: true })[0]?.getAttribute("datetime")).toBe("2026-10-05T10:00:00.000Z");
  expect(table?.textContent).not.toContain("another-person");
});

it("keeps account-scoped own-device revocation available after a forbidden role read", async () => {
  const hub = accessHub({ ownRoleStatus: "forbidden" }); const host = await mountAccess();
  expect(host.textContent).toContain("The hub refused access");
  expect(accessButton(host, "Revoke device other-own-device").disabled).toBe(false);
  await clickAccess(host, "Revoke device other-own-device");
  expect(hub.calls.some(({ action }) => action.operation === "revoke-device")).toBe(false);
  const dialog = screen.getByRole("alertdialog", { name: "Revoke device?" });
  expect(dialog?.textContent).toContain("This one device of yours loses access to this hub");
  expect(dialog?.textContent).toContain("Documents already downloaded stay where they are");
  expect(dialog?.textContent).not.toContain("every device");
  await clickAccess(dialog, "Revoke device");
  expect(hub.calls.find(({ action }) => action.operation === "revoke-device")?.action).toEqual({ operation: "revoke-device", deviceId: "other-own-device" });
  expect(within(host).getByRole("table", { name: "Your devices" }).textContent).not.toContain("other-own-device");
});

it("shows a hub role-change refusal and keeps the hub's unchanged role", async () => {
  const hub = accessHub(); const host = await mountAccess();
  hub.setOverride((action) => action.operation === "change-role" ? { status: "last-admin", hub: ACCESS_HUB } : null);
  selectAccess(host, `Role for ${ADMIN.githubUsername}`, "member");
  await clickAccess(host, `Save role for ${ADMIN.githubUsername}`);
  expect(host.textContent).toContain("The hub refused this change: the last admin cannot be removed or demoted.");
  const members = within(within(host).getByRole("table", { name: "Members" }));
  expect(within(members.getAllByRole("row", { hidden: true })[1] as HTMLElement).getAllByRole("cell", { hidden: true })[0]?.textContent).toBe("admin");
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: `Role for ${ADMIN.githubUsername}` }).value).toBe("admin");
  expect(host.textContent).not.toContain("role changed to member");
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
  expect(within(host).queryByLabelText("Members")).toBeNull();
  expect(accessButton(host, "Revoke device current-device").disabled).toBe(false);
});

it("acknowledges applied closure failure for this-computer revocation despite sign-in-required follow-up reads", async () => {
  const hub = accessHub(); const host = await mountAccess();
  hub.setOverride((action) => {
    if (action.operation !== "revoke-device") return null;
    hub.revokeCurrent(); return { status: "closure-failed", applied: true, hub: ACCESS_HUB };
  });
  await clickAccess(host, "Revoke device current-device");
  const dialog = screen.getByRole("alertdialog", { name: "Revoke this computer?" });
  expect(dialog?.textContent).toContain("sync with the hub stops until ub auth login https://hub.example.test is run again");
  await clickAccess(dialog, "Revoke device");
  expect(host.textContent).toContain("This computer was revoked.");
  expect(host.textContent).toContain("The change was applied");
  expect(host.textContent).toContain("Sign-in is required");
  expect(within(host).getAllByRole("status", { hidden: true }).some((item) => item.textContent?.includes("This computer was revoked"))).toBe(true);
  expect(within(host).queryByLabelText("Your devices")).toBeNull();
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
  expect(within(host).getAllByRole("button", { hidden: true }).map((button) => button.textContent)).toEqual(["Refresh access"]);
});

it("does not call the local management route from a direct-served page", async () => {
  const hub = accessHub(); const host = await mountAccess(false);
  expect(host.textContent).toContain("Run ub open in its project");
  expect(hub.calls).toHaveLength(0); expect(within(host).queryAllByRole("button", { hidden: true })).toHaveLength(0);
});

it("accepts the served workspace's decorated segment and makes new live reads on every visit", async () => {
  const hub = accessHub({ role: "member" });
  const host = await mountAccess(true, null, WORKSPACE.segment);
  expect(host.textContent).toContain("Your role: member.");
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(1);
  const priorSignals = hub.calls.map(({ init }) => init.signal);
  mounted?.unmount(); mounted = null;
  expect(priorSignals.every((signal) => signal?.aborted)).toBe(true);
  await mountAccess(true, null, WORKSPACE.segment);
  expect(hub.calls.filter(({ action }) => action.operation === "own-role")).toHaveLength(2);
  expect(hub.calls.filter(({ action }) => action.operation === "list-devices")).toHaveLength(2);
});
