/** Status notices follow the same settled, room-scoped facts as their header. */
import { act, cleanup, render } from "./react-render.js";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusLine } from "../src/ui/document/EditorPane.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { NotSharedReason } from "../src/shell/document-search.js";
import { toast } from "sonner";
import { AUTH_REJECTED } from "@uberblick/schema/protocol";
import { STORE_REFUSED, TOKEN_MISSING } from "../src/ui/status/status-reading.js";

interface Notice { key: string | number; message: unknown; severity: string | undefined; }

const ROOM_A = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4/doc-a";
const ROOM_B = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4/doc-b";

function room(
  patch: Partial<RoomStatus> = {},
  key = ROOM_A,
): { connection: RoomConnection; change: (patch: Partial<RoomStatus>) => void } {
  let status: RoomStatus = {
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
    ...patch,
  };
  const observers = new Set<(next: RoomStatus) => void>();
  const connection = {
    room: key,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    get status() { return status; },
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      observers.add(listener);
      listener(status);
      return () => { observers.delete(listener); };
    },
  } as unknown as RoomConnection;
  return {
    connection,
    change: (next) => {
      act(() => {
        status = { ...status, ...next };
        for (const observer of observers) observer(status);
      });
    },
  };
}

interface LineProps {
  connection: RoomConnection;
  hubAcked?: boolean | null;
  notSharedReason?: NotSharedReason | null;
  documentLayout?: boolean;
}

function line(props: LineProps) {
  return <StatusLine presence={[]} {...props} />;
}

function settle(milliseconds = 5_000): void {
  act(() => void vi.advanceTimersByTime(milliseconds));
}

function onlyNotice(): Notice {
  expect(toast.getToasts().length).toBe(1);
  const notice = toast.getToasts()[0]!;
  if (!("title" in notice)) throw new Error("Expected a published toast");
  return { key: notice.id, message: notice.title, severity: notice.type };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(toast, "error");
  vi.spyOn(toast, "warning");
  vi.spyOn(toast, "dismiss");
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("notices agree with the header's settled reading", () => {
  it("waits for the first saved-here fact before announcing a retained hub cause", () => {
    const current = room();
    const view = render(line({
      connection: current.connection,
      hubAcked: false,
      notSharedReason: "sign-in-required",
    }));
    settle(299);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("not shared with hub");
    settle(1);
    expect(view.container.textContent).toContain("not shared with hub");
    expect(onlyNotice()).toMatchObject({
      severity: "warning",
      message: "sign-in required — run ub auth login for this hub on this machine",
    });
  });

  it("waits for the first reading before reporting an ordinary unsaved room", () => {
    const current = room({ synced: false, writable: false });
    const view = render(line({ connection: current.connection, hubAcked: true }));
    settle(399);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(view.container.querySelector(".ub-not-saved")).toBeNull();
    settle(1);
    expect(view.container.querySelector(".ub-not-saved")?.textContent).toBe("not saved");
    expect(view.container.textContent).not.toMatch(/saved here|shared with hub/);
    expect(onlyNotice()).toMatchObject({ severity: "error", message: "Changes are not saved." });
  });

  it("reports an offline unsaved room immediately and resolves when it becomes writable", () => {
    const current = room({ connected: false, writable: false });
    const view = render(line({ connection: current.connection }));
    const notice = onlyNotice();
    expect(notice).toMatchObject({ severity: "error", message: "Changes are not saved." });
    expect(view.container.querySelector(".ub-not-saved")?.textContent).toBe("not saved");
    current.change({ writable: true });
    expect(toast.getToasts().length).toBe(0);
    expect(toast.dismiss).toHaveBeenCalledWith(notice.key);
    expect(view.container.querySelector(".ub-not-saved")).toBeNull();
  });

  const refusals: { word: string; patch: Partial<RoomStatus>; message: string }[] = [
    {
      word: "update required",
      patch: { protocolMismatch: { hub: 2, client: 1 }, storeRefused: true, tokenMissing: true, authFailed: true },
      message: "this app is older than the hub — update it and reload (app 1, hub 2); this document is not saved",
    },
    {
      word: "edit refused",
      patch: { storeRefused: true, tokenMissing: true, authFailed: true },
      message: STORE_REFUSED,
    },
    { word: "no hub token", patch: { tokenMissing: true, authFailed: true }, message: TOKEN_MISSING },
    { word: "not authorized", patch: { authFailed: true }, message: `${AUTH_REJECTED}; this document is not saved` },
  ];

  it.each(refusals)("keeps $word precedence and publishes its recovery immediately", ({ word, patch, message }) => {
    const current = room(patch);
    const view = render(line({
      connection: current.connection,
      hubAcked: false,
      notSharedReason: "sign-in-required",
    }));
    expect(view.container.querySelector(".ub-status-word")?.textContent).toBe(word);
    expect(view.container.textContent).not.toContain(message);
    expect(view.container.textContent).not.toMatch(/saved here|shared with hub/);
    expect(onlyNotice()).toMatchObject({ severity: "error", message });
  });

  const causes: [NotSharedReason, string][] = [
    ["no-hub-credentials", "this machine has no credentials for its hub"],
    ["sign-in-required", "sign-in required — run ub auth login for this hub on this machine"],
    ["no-workspace-access", "no access to this workspace — ask its administrator for membership; this machine will retry with its existing login"],
    ["credential-store", "this machine cannot read its login — run ub auth status and follow its credential-store recovery"],
    ["renewal-unavailable", "this hub cannot renew the login — ask its operator to configure sign-in"],
  ];

  it.each(causes)("publishes %s only with the visible not-shared fact", (notSharedReason, message) => {
    const current = room();
    const view = render(line({ connection: current.connection, hubAcked: false, notSharedReason }));
    settle();
    expect(view.container.textContent).not.toContain("saved here");
    expect(view.container.textContent).toContain("not shared with hub");
    expect(view.container.textContent).not.toContain(message);
    expect(onlyNotice()).toMatchObject({ severity: "warning", message });
  });

  it("does not announce a retained cause with an unknown hub answer, and clears a previously known cause", () => {
    const current = room();
    const props = { connection: current.connection, notSharedReason: "no-hub-credentials" as const };
    const view = render(line({ ...props, hubAcked: null }));
    settle();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("not shared with hub");
    view.rerender(line({ ...props, hubAcked: false }));
    const notice = onlyNotice();
    view.rerender(line({ ...props, hubAcked: null }));
    expect(toast.getToasts().length).toBe(0);
    expect(toast.dismiss).toHaveBeenCalledWith(notice.key);
  });

  it("does not announce not-synced-with-hub without a known cause", () => {
    const current = room();
    const view = render(line({ connection: current.connection, hubAcked: false }));
    settle();
    expect(view.container.textContent).not.toContain("not synced with hub");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each([undefined, false])("keeps a long-lived backlog busy without a notice (hubAcked %s)", (hubAcked) => {
    const current = room({ unsyncedChanges: 4 });
    const view = render(line({ connection: current.connection, ...(hubAcked === undefined ? {} : { hubAcked }) }));
    settle();
    expect(view.container.querySelector(".ub-status-word")).toBeNull();
    expect(view.container.textContent).not.toContain("sync messages");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe("notices publish and resolve with their conditions", () => {
  it("updates an unsaved refusal in the same slot without resolving its condition", () => {
    const current = room({ connected: false, writable: false });
    render(line({ connection: current.connection }));
    const first = onlyNotice();
    vi.mocked(toast.dismiss).mockClear();
    current.change({ storeRefused: true });
    expect(onlyNotice()).toMatchObject({ key: first.key, message: STORE_REFUSED, severity: "error" });
    current.change({ storeRefused: false, tokenMissing: true });
    expect(onlyNotice()).toMatchObject({ key: first.key, message: TOKEN_MISSING, severity: "error" });
    expect(toast.dismiss).not.toHaveBeenCalledWith(first.key);
    current.change({ tokenMissing: false, writable: true });
    expect(toast.getToasts().length).toBe(0);
    expect(toast.dismiss).toHaveBeenCalledWith(first.key);
  });

  it("updates a hub cause in the same slot and resolves it when sharing recovers", () => {
    const current = room();
    const props = { connection: current.connection, hubAcked: false };
    const view = render(line({ ...props, notSharedReason: "credential-store" }));
    settle();
    const first = onlyNotice();
    vi.mocked(toast.dismiss).mockClear();
    view.rerender(line({ ...props, notSharedReason: "renewal-unavailable" }));
    expect(onlyNotice()).toMatchObject({
      key: first.key,
      message: "this hub cannot renew the login — ask its operator to configure sign-in",
      severity: "warning",
    });
    expect(toast.dismiss).not.toHaveBeenCalledWith(first.key);
    view.rerender(line({ connection: current.connection, hubAcked: true }));
    expect(toast.getToasts().length).toBe(0);
    expect(toast.dismiss).toHaveBeenCalledWith(first.key);
  });

  it("replaces a not-shared warning with the visible unsaved condition", () => {
    const current = room();
    const view = render(line({
      connection: current.connection,
      hubAcked: false,
      notSharedReason: "sign-in-required",
    }));
    settle();
    const warning = onlyNotice();
    current.change({ connected: false, writable: false });
    const error = onlyNotice();
    expect(error).toMatchObject({ severity: "error", message: "Changes are not saved." });
    expect(error.key).not.toBe(warning.key);
    expect(toast.dismiss).toHaveBeenCalledWith(warning.key);
    expect(view.container.textContent).not.toMatch(/saved here|shared with hub/);
  });

  it.each([false, true])("resolves its notices when the header unmounts (documentLayout %s)", (documentLayout) => {
    const current = room({ connected: false, writable: false });
    const view = render(line({ connection: current.connection, documentLayout }));
    const notice = onlyNotice();
    view.unmount();
    expect(toast.getToasts().length).toBe(0);
    expect(toast.dismiss).toHaveBeenCalledWith(notice.key);
  });

  it("clears the departed document's notice while the new document earns its reading", () => {
    const previous = room({ connected: false, writable: false });
    const next = room({}, ROOM_B);
    const view = render(line({ connection: previous.connection }));
    const oldNotice = onlyNotice();
    view.rerender(line({
      connection: next.connection,
      hubAcked: false,
      notSharedReason: "sign-in-required",
    }));
    expect(toast.getToasts().length).toBe(0);
    expect(toast.dismiss).toHaveBeenCalledWith(oldNotice.key);
    settle();
    const newNotice = onlyNotice();
    expect(newNotice.key).not.toBe(oldNotice.key);
    expect(newNotice.severity).toBe("warning");
  });

  it("keeps a replacement connection's current notice even for the same room", () => {
    const previous = room({ connected: false, writable: false });
    const next = room({ connected: false, writable: false });
    const view = render(line({ connection: previous.connection }));
    const oldNotice = onlyNotice();
    view.rerender(line({ connection: next.connection }));
    expect(onlyNotice()).toMatchObject({ key: oldNotice.key, severity: "error", message: "Changes are not saved." });
  });
});
