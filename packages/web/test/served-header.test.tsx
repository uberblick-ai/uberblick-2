/** The served workspace record classifies header chrome before access replies. */
import { useLayoutEffect, useRef } from "react";
import * as Y from "yjs";
import { getMeta, initDoc, setCodeCheck } from "@uberblick/schema";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "./react-render.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { rereadClientConfigForTesting } from "../src/config.js";
import type { AccessAction, AccessAnswer } from "../src/shell/workspace-access.js";
import { StatusLine } from "../src/ui/document/EditorPane.js";
import { useShellEnvironment } from "../src/ui/shell/environment.js";
import { Popover, PopoverContent } from "../src/ui/shadcn/popover.js";
import { SyncPanel } from "../src/ui/status/SyncPanel.js";

const access = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>();
vi.mock("../src/shell/workspace-access.js", () => ({ createWorkspaceAccessClient: () => access }));
vi.mock("../src/shell/account.js", async (original) => ({
  ...await original<object>(),
  createAccountClient: () => async () => ({ state: "unavailable" }),
  createDeviceLoginClient: () => async () => ({ state: "unavailable" }),
}));

const STARTUP = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const SECONDARY = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";
const DOCUMENT = "9f3c1a2b-0000-4000-8000-0123456789ab";
const LOOPBACK = "ws://127.0.0.1:4321/ws";
const ydocs: Y.Doc[] = [];

function fixture(workspace: string, checked: boolean): RoomConnection {
  const ydoc = new Y.Doc();
  ydocs.push(ydoc);
  initDoc(ydoc, { uuid: DOCUMENT, title: "Project notes" });
  if (checked) setCodeCheck(ydoc, {
    repository: "owner/project", commit: "a".repeat(40), result: "matches",
  });
  const status: RoomStatus = {
    connected: true, synced: true, writable: true, hasReceivedServerState: true,
    storeRefused: false, unsyncedChanges: 0, hasAnswered: true,
    protocolMismatch: null, authFailed: false, tokenMissing: false,
  };
  return {
    room: `${workspace}/${DOCUMENT}`, ydoc, provider: { awareness: null }, status,
    onStatusChange(listener: (value: RoomStatus) => void) { listener(status); return () => {}; },
  } as unknown as RoomConnection;
}

interface Snapshot {
  ready: boolean;
  endpoint: string | null | undefined;
  authority: string | null;
  dot: boolean;
  header: string;
  labels: string[];
}

function Header({ connection, snapshots }: { connection: RoomConnection; snapshots: Snapshot[] }) {
  const workspace = connection.room.split("/")[0]!;
  const environment = useShellEnvironment(`/${workspace}/${DOCUMENT}`);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    snapshots.push({
      ready: environment.hubReady,
      endpoint: environment.statusEndpoint?.url,
      authority: environment.hubAdministration.authority?.status ?? null,
      dot: host.current?.querySelector(".ub-sync-dot") != null,
      header: host.current?.textContent ?? "",
      labels: [...host.current?.querySelectorAll("[aria-label], [title]") ?? []]
        .flatMap((node) => [node.getAttribute("aria-label") ?? "", node.getAttribute("title") ?? ""]),
    });
  });
  return <div ref={host}>{environment.hubReady && <Popover>
    <StatusLine connection={connection} presence={[]} lastUpdated={Date.now() - 180_000}
      syncReading={{ endpoint: environment.statusEndpoint, hubAcked: null,
        notSharedReason: "no-hub-credentials", syncDetails: true }}
      codeChecks={getMeta(connection.ydoc).code_check} />
    <PopoverContent aria-label="Sync details">
      <SyncPanel connection={connection} endpoint={environment.statusEndpoint} hubAcked={null}
        notSharedReason="no-hub-credentials" />
    </PopoverContent>
  </Popover>}</div>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  rereadClientConfigForTesting();
  access.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  localStorage.setItem("uberblick:ub-open-session", "s".repeat(43));
});
afterEach(() => {
  cleanup();
  for (const ydoc of ydocs.splice(0)) ydoc.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])("classifies startup and secondary local-only workspaces before access answers, code check=%s", async (checked) => {
  const configuration = deferred<Response>();
  const authority = deferred<AccessAnswer>();
  access.mockReturnValue(authority.promise);
  vi.stubGlobal("fetch", vi.fn(() => configuration.promise));
  const startup = fixture(STARTUP, checked);
  const secondary = fixture(SECONDARY, checked);
  const snapshots: Snapshot[] = [];
  const view = render(<Header connection={startup} snapshots={snapshots} />);
  expect(view.container.querySelector(".ub-sync-dot")).toBeNull();
  await act(async () => configuration.resolve(Response.json({
    hubUrl: LOOPBACK, workspaces: [STARTUP, SECONDARY], servedWorkspaces: {
      [STARTUP]: { remoteHubUrl: LOOPBACK, localOnly: true },
      [SECONDARY]: { remoteHubUrl: null, localOnly: true },
    },
  })));
  expect(snapshots.some((snapshot) => snapshot.ready && snapshot.authority === null)).toBe(true);
  expect(view.container.textContent).toMatch(/^Local-only · Edited /);
  expect(within(view.container).queryByRole("button", { name: "Code check" }) !== null).toBe(checked);
  if (checked) {
    fireEvent.click(within(view.container).getByRole("button", { name: "Code check" }));
    const panel = screen.getByRole("dialog", { name: "Sync details" });
    expect(within(panel).getByText("Local-only workspace")).toBeDefined();
    expect(within(panel).getByRole("heading", { name: "Code" })).toBeDefined();
    expect(panel.textContent).not.toMatch(/Hub|Source|Room|State|Backlog|Last updated|127\.0\.0\.1/);
    fireEvent.keyDown(panel, { key: "Escape" });
  }
  await act(async () => authority.resolve({ status: "local-only", hub: null }));
  view.rerender(<Header connection={secondary} snapshots={snapshots} />);
  expect(view.container.textContent).toMatch(/^Local-only · Edited /);
  expect(within(view.container).queryByRole("button", { name: "Code check" }) !== null).toBe(checked);
  for (const snapshot of snapshots) {
    expect(snapshot.dot).toBe(false);
    expect([snapshot.header, ...snapshot.labels].join(" ")).not.toMatch(/hub|127\.0\.0\.1|offline/i);
    if (snapshot.ready) expect(snapshot.endpoint).toBe("local");
  }
});

it.each([false, true])("keeps a hub on loopback visible before access settles, rebound=%s", async (rebound) => {
  const configuration = deferred<Response>();
  const authority = deferred<AccessAnswer>();
  access.mockReturnValue(authority.promise);
  vi.stubGlobal("fetch", vi.fn(() => configuration.promise));
  const snapshots: Snapshot[] = [];
  const connection = fixture(STARTUP, false);
  const view = render(<Header connection={connection} snapshots={snapshots} />);
  await act(async () => configuration.resolve(Response.json({
    hubUrl: LOOPBACK, workspaces: [STARTUP], rebound,
    servedWorkspaces: { [STARTUP]: { remoteHubUrl: LOOPBACK, localOnly: false } },
  })));
  const firstReady = snapshots.find((snapshot) => snapshot.ready)!;
  expect(firstReady.endpoint).toBe(LOOPBACK);
  expect(firstReady.dot).toBe(true);
  expect(firstReady.authority).toBe(rebound ? "local-only" : null);
  expect(view.container.querySelector(".ub-sync-dot")).not.toBeNull();
  expect(view.container.textContent).not.toContain("Local-only");
  await act(async () => authority.resolve({ status: "ok", hub: "http://127.0.0.1:4321", role: "member" }));
  fireEvent.click(within(view.container).getByRole("button", { name: "Sync details" }));
  const panel = screen.getByRole("dialog", { name: "Sync details" });
  expect(within(panel).getByRole("heading", { name: "Sync" })).toBeDefined();
  expect(within(panel).getByText(LOOPBACK)).toBeDefined();
  expect(within(panel).getByText("Backlog")).toBeDefined();
  expect(within(panel).queryByRole("heading", { name: "Code" })).toBeNull();
  act(() => setCodeCheck(connection.ydoc, { repository: "owner/project", commit: "a".repeat(40), result: "matches" }));
  view.rerender(<Header connection={connection} snapshots={snapshots} />);
  expect(within(panel).getByRole("heading", { name: "Code" })).toBeDefined();
  for (const snapshot of snapshots.filter((value) => value.ready)) {
    expect(snapshot.endpoint).toBe(LOOPBACK);
    expect(snapshot.dot).toBe(true);
    expect(snapshot.header).not.toContain("Local-only");
  }
});
