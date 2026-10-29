import { afterEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, renderSettled } from "./react-render.js";
import type { AccessAction, AccessAnswer, AccessDevice } from "../src/shell/workspace-access.js";
import { DevicesSettings } from "../src/ui/settings/DevicesSettings.js";

const HUB = "https://hub.example.test";
const SIGNED_IN = Date.UTC(2026, 9, 15, 10);
const CURRENT: AccessDevice = { deviceId: "current-device-id", deviceName: "My computer", current: true, signedInAt: SIGNED_IN };
const OTHER: AccessDevice = { deviceId: "4c20e821-a994-45be-b58f-157b54c41ec6", current: false, signedInAt: SIGNED_IN };
const INITIAL: AccessAnswer = { status: "ok", hub: HUB, handle: "own-account", devices: [CURRENT, OTHER] };
const HOSTED = { deviceId: "19e87c88-ece7-4442-a8c9-08d799436a3c", deviceName: "Research agent",
  current: false, signedInAt: SIGNED_IN, hosted: true, workspaceId: "5c974496-a04d-4b31-81da-8b70308565c7",
  workspaceName: "Research", scope: "read-only" } satisfies AccessDevice;

afterEach(() => vi.restoreAllMocks());

it("shows the login identity and device table without consulting workspace membership", async () => {
  vi.spyOn(Date, "now").mockReturnValue(SIGNED_IN + 2 * 60 * 60 * 1_000);
  const request = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>();
  await renderSettled(<DevicesSettings request={request} initial={INITIAL} />);
  expect(screen.getByRole("heading", { level: 1, name: "Devices" })).toBeDefined();
  expect(screen.getByText("Computers and hosted agents signed in to hub.example.test as @own-account. Revoking one stops its access; downloaded documents stay.")).toBeDefined();
  const table = screen.getByRole("table", { name: "Devices" });
  expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Device", "Signed in", "Revoke"]);
  const current = within(table).getByRole("rowheader", { name: "My computer This computer" });
  expect(current.querySelector("span")?.textContent).toBe("This computer");
  const unnamed = within(table).getByRole("rowheader", { name: "Unnamed device 4c20e821" });
  expect(unnamed.querySelector(`[title="${OTHER.deviceId}"]`)?.className).toContain("font-(family-name:--font-mono)");
  const signedIn = table.querySelector("time");
  expect(signedIn?.textContent).toBe("2 hours ago");
  expect(signedIn?.dateTime).toBe(new Date(SIGNED_IN).toISOString());
  expect(signedIn?.title).toBeTruthy();
  expect(within(table).getByRole("button", { name: `Revoke My computer (${CURRENT.deviceId})` }).textContent).toBe("Revoke");
  expect(request).not.toHaveBeenCalled();
});

it("uses the stored public login for an offline note and the answering login for listed devices", async () => {
  const request = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>();
  const login = { hub: HUB, handle: "stored-account" };
  const view = await renderSettled(<DevicesSettings request={request} initial={{ status: "hub-down", hub: HUB }} login={login} />);
  expect(screen.getByText(/Computers and hosted agents signed in to hub.example.test as @stored-account/)).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("hub cannot be reached");
  expect(screen.queryByRole("table")).toBeNull();
  act(() => view.rerender(<DevicesSettings request={request} initial={INITIAL} login={login} />));
  expect(screen.getByText(/Computers and hosted agents signed in to hub.example.test as @own-account/)).toBeDefined();
  expect(screen.queryByText(/@stored-account/)).toBeNull();
});

it("asks before revoking only the selected device and rereads the login's devices", async () => {
  const request = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>(async (action) =>
    action.operation === "revoke-device" ? { status: "ok", hub: HUB } : { ...INITIAL, devices: [CURRENT] });
  await renderSettled(<DevicesSettings request={request} initial={INITIAL} />);
  const trigger = screen.getByRole("button", { name: `Revoke Unnamed device (${OTHER.deviceId})` });
  await act(async () => trigger.click());
  const cancelled = screen.getByRole("alertdialog", { name: "Revoke Unnamed device (4c20e821)?" });
  expect(cancelled.textContent).toContain("This one device of yours loses access to this hub");
  expect(cancelled.textContent).toContain("Documents already downloaded stay where they are");
  expect(request).not.toHaveBeenCalled();
  await act(async () => within(cancelled).getByRole("button", { name: "Cancel" }).click());
  expect(request).not.toHaveBeenCalled();
  await act(async () => trigger.click());
  await act(async () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" }).click());
  expect(request.mock.calls.map(([action]) => action)).toEqual([
    { operation: "revoke-device", deviceId: OTHER.deviceId }, { operation: "list-devices" },
  ]);
  expect(screen.getByRole("status").textContent).toBe("Device revoked. Documents already downloaded stay where they are.");
  expect(screen.queryByText("Unnamed device")).toBeNull();
  expect(screen.getByRole("rowheader", { name: "My computer This computer" })).toBeDefined();
});

it("keeps devices with duplicate names separate and revokes by device id", async () => {
  const initial = { ...INITIAL, devices: [CURRENT, { ...OTHER, deviceName: "My computer" }] };
  const request = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>(async (action) =>
    action.operation === "revoke-device" ? { status: "ok", hub: HUB } : { ...INITIAL, devices: [CURRENT] });
  await renderSettled(<DevicesSettings request={request} initial={initial} />);
  expect(screen.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["My computer This computer", "My computer"]);
  await act(async () => screen.getByRole("button", { name: `Revoke My computer (${OTHER.deviceId})` }).click());
  await act(async () => within(screen.getByRole("alertdialog", { name: "Revoke My computer?" })).getByRole("button", { name: "Revoke" }).click());
  expect(request.mock.calls[0]?.[0]).toEqual({ operation: "revoke-device", deviceId: OTHER.deviceId });
  expect(screen.getByRole("button", { name: `Revoke My computer (${CURRENT.deviceId})` })).toBeDefined();
  expect(screen.queryByRole("button", { name: `Revoke My computer (${OTHER.deviceId})` })).toBeNull();
});

it("shows hosted client, workspace and scope in the Device cell, with the existing unnamed fallbacks", async () => {
  const request = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>();
  const unnamed: AccessDevice = { deviceId: OTHER.deviceId, hosted: true, current: false,
    workspaceId: HOSTED.workspaceId, scope: "read-write", signedInAt: 0 };
  await renderSettled(<DevicesSettings request={request} initial={{ ...INITIAL, devices: [CURRENT, HOSTED, unnamed] }} />);
  const table = screen.getByRole("table", { name: "Devices" });
  expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Device", "Signed in", "Revoke"]);
  expect(within(table).getByRole("rowheader", { name: "Research agent Hosted Research Read only" })).toBeDefined();
  const fallback = within(table).getByRole("rowheader", { name: "Unnamed device 4c20e821 Hosted Unnamed workspace 5c974496 Read and write" });
  expect(fallback.querySelector(`[title="${HOSTED.workspaceId}"]`)?.className).toContain("font-(family-name:--font-mono)");
  expect(fallback.parentElement?.querySelector("td")?.textContent).toBe("—");
  expect(within(table).getAllByText("Hosted")).toHaveLength(2);
});

it("confirms hosted access revocation and rereads the list by the selected grant's device id", async () => {
  const request = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>(async action =>
    action.operation === "revoke-device" ? { status: "ok", hub: HUB } : INITIAL);
  await renderSettled(<DevicesSettings request={request} initial={{ ...INITIAL, devices: [CURRENT, HOSTED] }} />);
  await act(async () => screen.getByRole("button", { name: `Revoke Research agent (${HOSTED.deviceId})` }).click());
  const dialog = screen.getByRole("alertdialog", { name: "Revoke Research agent?" });
  expect(dialog.textContent).toContain("This hosted agent loses access to its workspace");
  expect(dialog.textContent).toContain("need your consent to connect again");
  expect(request).not.toHaveBeenCalled();
  await act(async () => within(dialog).getByRole("button", { name: "Revoke" }).click());
  expect(request.mock.calls.map(([action]) => action)).toEqual([
    { operation: "revoke-device", deviceId: HOSTED.deviceId }, { operation: "list-devices" },
  ]);
  expect(screen.getByRole("status").textContent).toBe("Hosted access revoked. Documents already downloaded stay where they are.");
  expect(screen.queryByText("Research agent")).toBeNull();
  expect(screen.getByRole("rowheader", { name: "My computer This computer" })).toBeDefined();
});

it("keeps acknowledged self-revocation after both its refresh and parent read require sign-in", async () => {
  const refusal = { status: "sign-in-required", hub: HUB };
  const request = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>(async (action) =>
    action.operation === "revoke-device" ? { status: "closure-failed", applied: true, hub: HUB } : refusal);
  const view = await renderSettled(<DevicesSettings request={request} initial={INITIAL} />);
  await act(async () => screen.getByRole("button", { name: `Revoke My computer (${CURRENT.deviceId})` }).click());
  const dialog = screen.getByRole("alertdialog", { name: "Revoke this computer?" });
  expect(dialog.textContent).toContain("sync with the hub stops until ub auth login https://hub.example.test is run again");
  const confirm = within(dialog).getByRole("button", { name: "Revoke" });
  expect(confirm.className).not.toContain("bg-destructive");
  await act(async () => confirm.click());
  act(() => view.rerender(<DevicesSettings request={request} initial={refusal} />));
  expect(screen.getByRole("status").textContent).toContain("This computer was revoked.");
  expect(screen.getByRole("status").textContent).toContain("The change was applied");
  expect(screen.getByRole("alert").textContent).toContain("Sign-in is required");
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText(/Computers and hosted agents signed in to hub.example.test as @own-account/)).toBeDefined();
});

it("reports a refused revocation without claiming the device was revoked", async () => {
  const request = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>(async (action) =>
    action.operation === "revoke-device" ? { status: "device-not-found", hub: HUB } : INITIAL);
  const view = await renderSettled(<DevicesSettings request={request} initial={INITIAL} />);
  await act(async () => screen.getByRole("button", { name: `Revoke My computer (${CURRENT.deviceId})` }).click());
  await act(async () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" }).click());
  expect(screen.getByRole("alert").textContent).toContain("that device is no longer signed in");
  expect(screen.queryByRole("status")).toBeNull();
  const signal = request.mock.calls[0]?.[1];
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
