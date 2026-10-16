import { act, render } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { LocalServing } from "../src/config.js";
import type { AccountIdentity } from "../src/shell/account.js";
import type { AccessAction, AccessAnswer } from "../src/shell/workspace-access.js";
import { DevicesSettings } from "../src/ui/settings/DevicesSettings.js";
import { useAccessReading } from "../src/ui/settings/hub-administration.js";
import { useSettingsAccess } from "../src/ui/settings/settings-access.js";
import { SERVING_STATUS_POLL_MS, SERVING_STATUS_TIMEOUT_MS } from "../src/ui/status/serving-status.js";

const WORKSPACE = "53f04353-622b-4b14-8d71-366193d43c74";
const SERVING: LocalServing = { workspace: WORKSPACE, remoteHubUrl: "ws://bound.example", rebound: false };
const api = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>();
const login = vi.fn<(signal: AbortSignal) => Promise<AccountIdentity>>().mockResolvedValue({ state: "signed-in", handle: "my-login" });
vi.mock("../src/shell/workspace-access.js", () => ({ createWorkspaceAccessClient: () => api }));
vi.mock("../src/shell/account.js", () => ({ createDeviceLoginClient: () => login }));

function Reading({ serving = SERVING, fallback = false }: { serving?: LocalServing | null; fallback?: boolean }) {
  const access = useSettingsAccess(WORKSPACE, serving, "presence", "settings", true, fallback);
  return <output>{JSON.stringify({ admin: access.workspaceAdmin, pending: access.workspacePending, devices: access.devicesAvailable })}</output>;
}
function DeviceReading() {
  const access = useAccessReading(WORKSPACE, SERVING, "presence", "settings/devices", "list-devices");
  return <DevicesSettings request={access.request} initial={access.authority} />;
}
async function flush() { await act(async () => { await Promise.resolve(); }); }
function value(view: ReturnType<typeof render>) { return JSON.parse(view.container.querySelector("output")?.textContent ?? "null"); }

describe("independent settings permissions", () => {
  afterEach(() => {
    vi.clearAllMocks(); vi.useRealTimers();
    login.mockResolvedValue({ state: "signed-in", handle: "my-login" });
  });

  it("keeps a stored login's Devices available on a cold offline load, then removes it on logout", async () => {
    vi.useFakeTimers();
    api.mockResolvedValue({ status: "hub-down", hub: "https://bound.example" });
    const view = render(<Reading />);
    await flush();
    expect(value(view)).toEqual({ admin: false, pending: false, devices: true });
    login.mockResolvedValue({ state: "signed-out" });
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(value(view)).toEqual({ admin: false, pending: false, devices: false });
  });

  it("shows Devices while live role and device reads time out, without granting workspace authority", async () => {
    vi.useFakeTimers();
    api.mockImplementation(async () => new Promise(() => {}));
    const view = render(<Reading />);
    await flush();
    expect(value(view)).toEqual({ admin: false, pending: true, devices: true });
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_TIMEOUT_MS));
    expect(value(view)).toEqual({ admin: false, pending: false, devices: true });
  });

  it.each(["sign-in-required", "forbidden"])("hides Devices after a definitive %s even if its login is still stored", async (status) => {
    api.mockResolvedValue({ status, hub: "https://bound.example" });
    const view = render(<Reading />);
    await flush();
    expect(value(view)).toEqual({ admin: false, pending: false, devices: false });
  });

  it("keeps a revoked login hidden over a later outage, until a successful device list proves recovery", async () => {
    vi.useFakeTimers();
    api.mockResolvedValue({ status: "sign-in-required", hub: "https://bound.example" });
    const view = render(<Reading />);
    await flush();
    expect(value(view).devices).toBe(false);
    api.mockResolvedValue({ status: "hub-down", hub: "https://bound.example" });
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(value(view).devices).toBe(false);
    api.mockImplementation(async (action) => action.operation === "list-devices"
      ? { status: "ok", hub: "https://bound.example", handle: "my-login", devices: [] }
      : { status: "ok", hub: "https://bound.example", role: "member" });
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(value(view)).toEqual({ admin: false, pending: false, devices: true });
  });

  it("keeps a hub admin address pending until the workspace role arrives, independently of devices", async () => {
    let finish: ((answer: AccessAnswer) => void) | undefined;
    api.mockImplementation(async (action) => action.operation === "own-role"
      ? new Promise((resolve) => { finish = resolve; })
      : { status: "ok", hub: "https://bound.example", handle: "my-login", devices: [] });
    const view = render(<Reading />);
    await flush();
    expect(value(view)).toEqual({ admin: false, pending: true, devices: true });
    await act(async () => finish?.({ status: "ok", role: "admin", hub: "https://bound.example" }));
    expect(value(view)).toEqual({ admin: true, pending: false, devices: true });
  });

  it.each(["member", "forbidden", "sign-in-required", "hub-down"])("never grants workspace controls for %s", async (status) => {
    api.mockImplementation(async (action) => action.operation === "own-role"
      ? status === "member" ? { status: "ok", role: "member", hub: "https://bound.example" }
        : { status, hub: "https://bound.example" }
      : { status: "ok", hub: "https://bound.example", handle: "my-login", devices: [] });
    const view = render(<Reading />);
    await flush();
    expect(value(view)).toEqual({ admin: false, pending: false, devices: true });
  });

  it.each([null, { ...SERVING, remoteHubUrl: null }])("grants a known local workspace without a role %j", async (serving) => {
    const view = render(<Reading serving={serving} fallback />);
    await flush();
    expect(value(view)).toEqual({ admin: true, pending: false, devices: false });
    expect(api).not.toHaveBeenCalled();
  });

  it("recognizes the implicit loopback hub's local-only bridge answer", async () => {
    api.mockResolvedValue({ status: "local-only", hub: null });
    const view = render(<Reading />);
    await flush();
    expect(value(view)).toEqual({ admin: true, pending: false, devices: false });
  });

  it("does not restore a revoked device from a poll started while revocation was pending", async () => {
    vi.useFakeTimers();
    const initial: AccessAnswer = { status: "ok", hub: "https://bound.example", handle: "my-login",
      devices: [{ deviceId: "4c20e821-a994-45be-b58f-157b54c41ec6", signedInAt: 1, current: false }] };
    let finishRevoke: ((answer: AccessAnswer) => void) | undefined;
    let finishPoll: ((answer: AccessAnswer) => void) | undefined;
    let revoked = false;
    let reads = 0;
    api.mockImplementation(async (action) => {
      if (action.operation === "revoke-device") return new Promise((resolve) => { finishRevoke = resolve; });
      if (action.operation !== "list-devices") throw new Error("Unexpected access request");
      reads += 1;
      if (reads === 2) return new Promise((resolve) => { finishPoll = resolve; });
      return revoked ? { ...initial, devices: [] } : initial;
    });
    render(<DeviceReading />);
    await flush();
    const trigger = screen.getByRole("button", { name: "Revoke Unnamed device (4c20e821-a994-45be-b58f-157b54c41ec6)" });
    await act(async () => trigger.click());
    await act(async () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" }).click());
    expect(finishRevoke).toBeDefined();
    expect(reads).toBe(1);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(finishPoll).toBeDefined();
    expect(reads).toBe(2);
    await act(async () => {
      revoked = true;
      finishRevoke?.({ status: "ok", hub: "https://bound.example" });
    });
    expect(reads).toBe(3);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("No signed-in devices.")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Device revoked.");
    await act(async () => finishPoll?.(initial));
    expect(screen.queryByRole("rowheader", { name: "Unnamed device 4c20e821" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("No signed-in devices.")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Device revoked.");
  });

  it.each([null, { ...SERVING, rebound: true }, { ...SERVING, workspace: "872b46d9-5b18-4fb1-84d5-de245c337e86" }])("drops previous permissions for an unavailable binding %j", async (serving) => {
    api.mockImplementation(async (action) => action.operation === "own-role"
      ? { status: "ok", role: "admin", hub: "https://bound.example" }
      : { status: "ok", hub: "https://bound.example", handle: "my-login", devices: [] });
    const view = render(<Reading />);
    await flush();
    expect(value(view).admin).toBe(true);
    view.rerender(<Reading serving={serving} />);
    expect(value(view)).toEqual({ admin: false, pending: false, devices: false });
  });

  it("discards stale admin answers on a changed hub and loses authority on timeout", async () => {
    vi.useFakeTimers();
    let finish: ((answer: AccessAnswer) => void) | undefined;
    api.mockImplementation(async (action) => new Promise((resolve) => {
      if (action.operation === "own-role" && finish === undefined) finish = resolve;
    }));
    const view = render(<Reading />);
    view.rerender(<Reading serving={{ ...SERVING, remoteHubUrl: "ws://other.example" }} />);
    await act(async () => finish?.({ status: "ok", role: "admin", hub: "https://bound.example" }));
    expect(value(view).admin).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_TIMEOUT_MS));
    expect(value(view).pending).toBe(false);
    api.mockResolvedValue({ status: "ok", role: "admin", hub: "https://other.example" });
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(value(view).admin).toBe(true);
    api.mockImplementation(async () => new Promise(() => {}));
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS + SERVING_STATUS_TIMEOUT_MS));
    expect(value(view).admin).toBe(false);
  });
});
