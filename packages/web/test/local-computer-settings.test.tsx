import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import * as Y from "yjs";
import { settingsRoom } from "@uberblick/schema";
import type { HistoryRetention, WorkspaceSize } from "@uberblick/mcp-server";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { LocalServing } from "../src/config.js";
import { WorkspaceSettings } from "../src/ui/settings/WorkspaceSettings.js";
import type { Workspace } from "../src/ui/route.js";
import { act, renderSettled } from "./react-render.js";

vi.mock("../src/collab/rooms.js", async (original) => ({
  ...await original<typeof import("../src/collab/rooms.js")>(),
  mintHubAuthMessage: vi.fn(async () => "local-browser-bearer"),
}));
vi.mock("../src/collab/local-session.js", () => ({
  localSessionHeaders: vi.fn(async () => ({ "X-Uberblick-Session": "local-session" })),
}));

const WORKSPACE: Workspace = {
  uuid: "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4",
  segment: "uberblick-6f4c8a51-2b7d-4e39-9a06-c81d3f572be4",
};
const SERVING: LocalServing = { workspace: WORKSPACE.uuid, remoteHubUrl: "wss://hub.example.test/ws", rebound: false };
const DEFAULT: HistoryRetention = { mode: "recent", days: 30, keepNamed: true };
const SIZE: WorkspaceSize = { bytes: 1_200_000_000, usedFraction: 0.75 };
const READ_ONLY: RoomStatus = {
  connected: true, synced: true, hasReceivedServerState: true, writable: false,
  storeRefused: false, unsyncedChanges: 0, hasAnswered: true, protocolMismatch: null,
  authFailed: false, tokenMissing: false,
};
const fetchImpl = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchImpl.mockReset().mockImplementation(async () => Response.json({ retention: DEFAULT, size: SIZE }));
  vi.stubGlobal("fetch", fetchImpl);
});
afterEach(() => vi.unstubAllGlobals());

function catalog(): RoomConnection {
  return {
    room: settingsRoom(WORKSPACE.uuid), ydoc: new Y.Doc(), status: READ_ONLY,
    onStatusChange: (listener: (status: RoomStatus) => void) => { listener(READ_ONLY); return () => {}; },
  } as unknown as RoomConnection;
}

function page({ workspace = WORKSPACE, serving = SERVING, local = false, catalogConnection = null }: {
  workspace?: Workspace; serving?: LocalServing | null; local?: boolean; catalogConnection?: RoomConnection | null;
} = {}) {
  return <WorkspaceSettings admin={false} member local={local} workspace={workspace} serving={serving}
    subject="Reader" endpoint={null} connection={null} catalogConnection={catalogConnection} agentSessions={0} />;
}

function size(host: HTMLElement): string | null {
  const group = within(within(host).getByRole("region", { name: "On this computer" }));
  expect(group.getByRole("term").textContent).toBe("Size");
  return group.getByRole("definition").textContent;
}

function select(host: HTMLElement, label: string, value: string): void {
  act(() => fireEvent.change(within(host).getByRole("combobox", { name: label }), { target: { value } }));
}

it("shows the default choices and a size placeholder until the first local reading arrives", async () => {
  let finish: ((response: Response) => void) | undefined;
  fetchImpl.mockImplementation(async () => new Promise((resolve) => { finish = resolve; }));
  const { container: host } = await renderSettled(page());
  const controls = within(host);
  expect(controls.getByRole("heading", { level: 1, name: "General" })).toBeTruthy();
  expect(controls.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["On this computer"]);
  expect(size(host)).toBe("—");
  expect(controls.getByRole<HTMLSelectElement>("combobox", { name: "History retention" }).value).toBe("recent");
  expect(controls.getByRole<HTMLSelectElement>("combobox", { name: "Recent history period" }).value).toBe("30");
  expect(controls.getByRole<HTMLInputElement>("checkbox", { name: "Keep named revisions" }).checked).toBe(true);
  expect(controls.getByRole<HTMLSelectElement>("combobox", { name: "History retention" }).disabled).toBe(true);
  await act(async () => finish?.(Response.json({ retention: DEFAULT, size: SIZE })));
  expect(size(host)).toBe("1.2 GB · 75% used");
  expect(controls.getByRole<HTMLSelectElement>("combobox", { name: "History retention" }).disabled).toBe(false);
  expect(controls.getByRole<HTMLButtonElement>("button", { name: "Save history retention" }).disabled).toBe(true);
});

it.each(["named", "everything"] as const)("saves %s retention without recent-history options", async (mode) => {
  fetchImpl.mockImplementation(async (_input, init) => Response.json({
    retention: init?.method === "POST" ? { mode } : DEFAULT, size: SIZE,
  }));
  const { container: host } = await renderSettled(page());
  select(host, "History retention", mode);
  expect(within(host).queryByRole("combobox", { name: "Recent history period" })).toBeNull();
  expect(within(host).queryByRole("checkbox", { name: "Keep named revisions" })).toBeNull();
  await act(async () => within(host).getByRole("button", { name: "Save history retention" }).click());
  const sent = fetchImpl.mock.calls.find((call) => call[1]?.method === "POST");
  expect(sent?.[0]).toBe("/api/local-settings");
  expect(JSON.parse(sent?.[1]?.body as string)).toEqual({ retention: { mode } });
  expect(within(host).getByRole("status").textContent).toBe("History retention saved on this computer.");
});

it.each([{ days: 7, keepNamed: false }, { days: 90, keepNamed: true }] as const)(
  "saves recent history for $days days with keepNamed=$keepNamed without workspace write permission", async ({ days, keepNamed }) => {
    const connection = catalog();
    const before = Y.encodeStateAsUpdate(connection.ydoc);
    fetchImpl.mockImplementation(async (_input, init) => Response.json({
      retention: init?.method === "POST" ? { mode: "recent", days, keepNamed } : DEFAULT, size: SIZE,
    }));
    const { container: host } = await renderSettled(page({ catalogConnection: connection }));
    select(host, "Recent history period", String(days));
    if (!keepNamed) act(() => within(host).getByRole("checkbox", { name: "Keep named revisions" }).click());
    const save = within(host).getByRole<HTMLButtonElement>("button", { name: "Save history retention" });
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    const sent = fetchImpl.mock.calls.find((call) => call[1]?.method === "POST");
    expect(JSON.parse(sent?.[1]?.body as string)).toEqual({ retention: { mode: "recent", days, keepNamed } });
    expect(sent?.[1]?.headers).toMatchObject({ Authorization: "Bearer local-browser-bearer", "X-Uberblick-Session": "local-session" });
    expect(Y.encodeStateAsUpdate(connection.ydoc)).toEqual(before);
    expect(save.disabled).toBe(true);
    expect(within(host).queryByRole("textbox", { name: "Name" })).toBeNull();
  },
);

it("preserves the chosen retention after a failed save and allows retrying it", async () => {
  fetchImpl.mockImplementation(async (_input, init) => init?.method === "POST"
    ? new Response("", { status: 503 }) : Response.json({ retention: DEFAULT, size: SIZE }));
  const { container: host } = await renderSettled(page());
  select(host, "Recent history period", "7");
  act(() => within(host).getByRole("checkbox", { name: "Keep named revisions" }).click());
  const save = within(host).getByRole<HTMLButtonElement>("button", { name: "Save history retention" });
  await act(async () => save.click());
  expect(within(host).getByRole("alert").textContent).toBe("Couldn't save history retention. Try again.");
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: "Recent history period" }).value).toBe("7");
  expect(within(host).getByRole<HTMLInputElement>("checkbox", { name: "Keep named revisions" }).checked).toBe(false);
  expect(save.disabled).toBe(false);
  fetchImpl.mockImplementation(async () => Response.json({ retention: { mode: "recent", days: 7, keepNamed: false }, size: SIZE }));
  await act(async () => save.click());
  expect(within(host).queryByRole("alert")).toBeNull();
  expect(within(host).getByRole("status").textContent).toBe("History retention saved on this computer.");
  expect(save.disabled).toBe(true);
});

it("keeps Size unknown after a failed reading and retries the local API", async () => {
  fetchImpl.mockImplementation(async () => new Response("", { status: 503 }));
  const { container: host } = await renderSettled(page());
  expect(size(host)).toBe("—");
  expect(within(host).getByRole("alert").textContent).toBe("Couldn't read settings on this computer. Try again.");
  expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: "History retention" }).disabled).toBe(true);
  fetchImpl.mockImplementation(async () => Response.json({ retention: DEFAULT, size: SIZE }));
  await act(async () => within(host).getByRole("button", { name: "Retry" }).click());
  expect(size(host)).toBe("1.2 GB · 75% used");
  expect(within(host).queryByRole("alert")).toBeNull();
  expect(within(host).queryByRole("button", { name: "Retry" })).toBeNull();
});

it.each([null, { ...SERVING, rebound: true }, { ...SERVING, workspace: "53f04353-622b-4b14-8d71-366193d43c74" }])(
  "does not read another computer or workspace without a matching local binding %j", async (serving) => {
    const { container: host } = await renderSettled(page({ serving }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(size(host)).toBe("—");
    expect(within(host).getByText("Open this workspace with ub open to read settings on this computer.")).toBeTruthy();
    expect(within(host).getByRole<HTMLSelectElement>("combobox", { name: "History retention" }).disabled).toBe(true);
  },
);

it("shows only Size for a local workspace, without history wording or retention requests", async () => {
  fetchImpl.mockImplementation(async () => Response.json({ size: SIZE }));
  const { container: host } = await renderSettled(page({ local: true, serving: { ...SERVING, remoteHubUrl: null } }));
  expect(size(host)).toBe("1.2 GB · 75% used");
  expect(host.textContent).not.toMatch(/history|revision/i);
  expect(within(host).queryByRole("combobox")).toBeNull();
  expect(within(host).queryByRole("button")).toBeNull();
  expect(fetchImpl.mock.calls.map((call) => call[1]?.method)).toEqual(["GET"]);
});

it("ignores a late reading after the previous workspace's local settings unmount", async () => {
  let finish: ((response: Response) => void) | undefined;
  fetchImpl.mockImplementationOnce(async () => new Promise((resolve) => { finish = resolve; }));
  const view = await renderSettled(page());
  const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
  const next: Workspace = { uuid: "53f04353-622b-4b14-8d71-366193d43c74", segment: "53f04353-622b-4b14-8d71-366193d43c74" };
  fetchImpl.mockImplementation(async () => Response.json({ retention: DEFAULT, size: { bytes: 2_000_000, usedFraction: 0.5 } }));
  await act(async () => view.rerender(page({ workspace: next, serving: { ...SERVING, workspace: next.uuid } })));
  expect(signal?.aborted).toBe(true);
  expect(size(view.container)).toBe("2 MB · 50% used");
  await act(async () => finish?.(Response.json({ retention: { mode: "everything" }, size: SIZE })));
  expect(size(view.container)).toBe("2 MB · 50% used");
  expect(within(view.container).getByRole<HTMLSelectElement>("combobox", { name: "History retention" }).value).toBe("recent");
});
