/** Header truth: edit freshness, quiet ordinary states, and distinct save failures. */
import * as Y from "yjs";
import { act, cleanup, render } from "./react-render.js";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusLine } from "../src/ui/document/EditorPane.js";
import { Popover } from "../src/ui/shadcn/popover.js";
import { SyncDot } from "../src/ui/status/SyncDot.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { NotSharedReason } from "../src/shell/document-search.js";
import { notifyTransient } from "../src/notifications.js";

const copy = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../src/editor/source-chrome.js", async (original) => ({
  ...await original<object>(), writeToClipboard: copy,
}));
vi.mock("../src/notifications.js", async (original) => ({
  ...await original<object>(), notifyTransient: vi.fn(),
}));

const ROOM = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4/doc";
function fixture(patch: Partial<RoomStatus> = {}) {
  let status: RoomStatus = {
    connected: true, synced: true, writable: true, hasReceivedServerState: true,
    storeRefused: false, unsyncedChanges: 0, hasAnswered: true,
    protocolMismatch: null, authFailed: false, tokenMissing: false, ...patch,
  };
  const listeners = new Set<(value: RoomStatus) => void>();
  const ydoc = new Y.Doc();
  const connection = {
    room: ROOM, ydoc, provider: { awareness: null },
    get status() { return status; },
    onStatusChange(listener: (value: RoomStatus) => void) {
      listeners.add(listener); listener(status); return () => listeners.delete(listener);
    },
  } as unknown as RoomConnection;
  return { connection, change(next: Partial<RoomStatus>) {
    act(() => { status = { ...status, ...next }; for (const listener of listeners) listener(status); });
  } };
}

beforeEach(() => { vi.useFakeTimers(); copy.mockClear(); vi.mocked(notifyTransient).mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function settle() { act(() => void vi.advanceTimersByTime(5_000)); }

it.each(["offline", "error"] as const)("retires activity interrupted by %s without replaying it on recovery", (state) => {
  const tree = (red: boolean, pulse: number) => <SyncDot offline={state === "offline" && red}
    error={state === "error" && red} confirmed={!red} lastConfirmedAt={Date.now()} pulse={pulse} syncDetails={false} />;
  const view = render(tree(false, 1));
  const dot = () => view.container.querySelector(".ub-sync-dot");
  expect(dot()?.classList.contains("ub-sync-dot--pulse")).toBe(true);
  view.rerender(tree(true, 1));
  expect(dot()?.classList.contains("ub-sync-dot--pulse")).toBe(false);
  view.rerender(tree(false, 1));
  expect(dot()?.getAttribute("data-pulse")).toBe("1");
  expect(dot()?.classList.contains("ub-sync-dot--pulse")).toBe(false);
  view.rerender(tree(false, 2));
  expect(dot()?.classList.contains("ub-sync-dot--pulse")).toBe(true);
  act(() => { vi.advanceTimersByTime(650); });
  expect(dot()?.classList.contains("ub-sync-dot--pulse")).toBe(false);
});

describe("the edited row", () => {
  it("keeps edit freshness visible before sync is known, with the existing exact-time hover", () => {
    const stamp = Date.now() - 120_000;
    const current = fixture();
    const view = render(<StatusLine connection={current.connection} presence={[]} lastUpdated={stamp} />);
    expect(view.container.textContent).toBe("Edited 2 minutes ago");
    const time = within(view.container).getByRole("time");
    expect(time.getAttribute("dateTime")).toBe(new Date(stamp).toISOString());
    expect(time.getAttribute("title")).toBeTruthy();
    expect(view.container.querySelector("[aria-live]")).toBeNull();
    for (const lastUpdated of [undefined, Number.NaN, Infinity, Number.MAX_VALUE]) {
      view.rerender(<StatusLine connection={current.connection} presence={[]} lastUpdated={lastUpdated} />);
      expect(within(view.container).queryByRole("time")).toBeNull();
    }
  });

  it("copies the full revision and shows only its prefix in mono", async () => {
    const view = render(<StatusLine connection={fixture().connection} presence={[]} revision="e9faf4df1234abcd" />);
    const revision = within(view.container).getByRole("button", { name: "Copy revision e9faf4df1234abcd" });
    expect(revision.textContent).toBe("rev e9faf4df");
    expect(revision.querySelector(".ub-doc-id")?.textContent).toBe("e9faf4df");
    await act(async () => revision.click());
    expect(copy).toHaveBeenCalledWith("e9faf4df1234abcd");
    expect(notifyTransient).toHaveBeenLastCalledWith({ key: "clipboard", message: "Revision copied", severity: "success" });
    copy.mockResolvedValueOnce(false);
    await act(async () => revision.click());
    expect(notifyTransient).toHaveBeenLastCalledWith({
      key: "clipboard", message: "Couldn't copy the revision. Try again in a browser with clipboard access.", severity: "error",
    });
  });
});

describe("hub status", () => {
  function mount(hubAcked: boolean | null | undefined, patch: Partial<RoomStatus> = {}, reason: NotSharedReason | null = null, endpoint = "wss://hub.example/ws") {
    const current = fixture(patch);
    const tree = (ack: boolean | null | undefined) => <Popover><StatusLine connection={current.connection}
      presence={[]} endpoint={{ url: endpoint, source: "document" }} hubAcked={ack}
      notSharedReason={reason} lastUpdated={Date.now()} syncDetails /></Popover>;
    const view = render(tree(hubAcked));
    settle();
    return { ...view, current, ack(value: boolean | null) { view.rerender(tree(value)); } };
  }

  it("shows a silent resting dot and no sync prose in ordinary states", () => {
    const view = mount(true);
    expect(view.container.textContent).toBe("Edited just now");
    expect(within(view.container).getByRole("button", { name: "Synced with hub just now" })).toBeTruthy();
    expect(view.container.querySelector(".ub-sync-dot")?.getAttribute("data-pulse")).toBe("0");
    expect(document.querySelector(".ub-sync-announcement")?.textContent).toBe("");
    view.current.change({ unsyncedChanges: 4 });
    settle();
    expect(view.container.textContent).toBe("Edited just now");
    expect(within(view.container).getByRole("button", { name: "Sync details" })).toBeTruthy();
  });

  it("has no dot or details trigger in a workspace on this device alone", () => {
    const view = mount(true, {}, null, "local");
    expect(view.container.querySelector(".ub-sync-dot")).toBeNull();
    expect(within(view.container).queryByRole("button")).toBeNull();
    expect(view.container.textContent).toBe("Edited just now");
  });

  it("uses neutral details for unknown acknowledgement and never calls it offline", () => {
    const view = mount(null);
    expect(within(view.container).getByRole("button", { name: "Sync details" })).toBeTruthy();
    expect(view.container.textContent).toBe("Edited just now");
  });

  it("claims device saving only for a saved replica with known unacknowledged hub state", () => {
    const view = mount(false);
    const button = within(view.container).getByRole("button", { name: /^Offline since \d\d:\d\d$/ });
    expect(button.querySelector(".ub-sync-dot")?.getAttribute("data-state")).toBe("offline");
    expect(view.container.querySelector(".ub-status-offline")?.textContent).toBe("Offline. Changes are saved on this device.");
    expect(document.querySelector(".ub-sync-announcement")?.textContent).toBe("Offline. Changes are saved on this device.");
    view.ack(null);
    expect(view.container.querySelector(".ub-status-offline")).toBeNull();
    expect(within(view.container).getByRole("button", { name: "Sync details" })).toBeTruthy();
    view.ack(true);
    expect(document.querySelector(".ub-sync-announcement")?.textContent).toBe("Synced with hub.");
  });

  it.each([
    ["update required", { protocolMismatch: { hub: 2, client: 1 } }],
    ["edit refused", { storeRefused: true }],
    ["no hub token", { tokenMissing: true }],
    ["not authorized", { authFailed: true }],
  ] as const)("keeps the %s refusal with neutral details", (word, patch) => {
    const view = mount(false, patch);
    expect(view.container.querySelector(".ub-status-word")?.textContent).toBe(word);
    expect(within(view.container).getByRole("button", { name: "Sync details" })).toBeTruthy();
    expect(view.container.querySelector(".ub-sync-dot")?.getAttribute("data-state")).toBe("error");
    expect(view.container.textContent).not.toContain("Changes are saved on this device.");
  });

  it("retains not shared with hub without the saved-device offline claim", () => {
    const view = mount(false, {}, "no-hub-credentials");
    expect(view.container.querySelector(".ub-status-word")?.textContent).toBe("not shared with hub");
    expect(view.container.textContent).not.toContain("Changes are saved on this device.");
  });

  it("keeps not saved when the page loses its own server", () => {
    const view = mount(false, { connected: false, synced: false, writable: false });
    expect(view.container.querySelector(".ub-not-saved")?.textContent).toBe("not saved");
    expect(view.container.querySelector(".ub-status-offline")).toBeNull();
    expect(view.container.textContent).not.toContain("Changes are saved on this device.");
  });
});
