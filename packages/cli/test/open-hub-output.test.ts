import type { HubState } from "@uberblick/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorOpenHub, waitForOpenHubState } from "../src/open-hub-output.js";

const ORIGIN = "https://hub.uberblick.ai";
const UNREACHABLE = `ub open: hub ${ORIGIN} unreachable, changes stay on this machine until it is back\n`;
const RECOVERED = `ub open: hub ${ORIGIN} reachable again, syncing local changes\n`;

function source(initial: Partial<HubState> = {}) {
  let state: HubState = { status: "connected", url: "wss://hub.uberblick.ai", protocolVersion: 3, ...initial };
  const listeners = new Set<() => void>();
  return {
    state: () => state,
    onStateChange: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (next: Partial<HubState>, notify = true) => {
      state = { ...state, ...next };
      if (notify) for (const listener of listeners) listener();
    },
    listeners,
  };
}

const cleanup: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("the bounded startup hub reading", () => {
  it.each(["connected", "disabled", "auth-failed", "update-required", "hub-down"] as const)(
    "returns an already known %s state without waiting",
    async (status) => {
      const sync = source({ status });
      await expect(waitForOpenHubState(sync, 1_500)).resolves.toEqual(sync.state());
      expect(sync.listeners.size).toBe(0);
    },
  );

  it("settles on the first answer and removes its event listener and deadline", async () => {
    const sync = source({ status: "connecting" });
    const result = waitForOpenHubState(sync, 1_500);
    await vi.advanceTimersByTimeAsync(400);
    sync.set({ status: "auth-failed", authRecovery: "no-workspace-access" });
    await expect(result).resolves.toMatchObject({ status: "auth-failed", authRecovery: "no-workspace-access" });
    expect(Date.now()).toBe(400);
    expect(sync.listeners.size).toBe(0);
  });

  it.each(["connecting", "hub-down"] as const)(
    "reports unreachable within the connect budget when the transport silently remains %s",
    async (status) => {
      const sync = source({ status: "connecting" });
      const result = waitForOpenHubState(sync, 1_500);
      let settled = false;
      void result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_499);
      expect(settled).toBe(false);
      sync.set({ status }, false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ status: "hub-down" });
      expect(Date.now()).toBe(1_500);
      expect(sync.listeners.size).toBe(0);
    },
  );
});

describe("hub notices while serving locally", () => {
  function monitor(sync: ReturnType<typeof source>, options: Parameters<typeof monitorOpenHub>[3] = {}) {
    const err = vi.fn<(text: string) => void>();
    const watcher = monitorOpenHub(sync, ORIGIN, err, options);
    cleanup.push(watcher.stop);
    return { err, stop: watcher.stop };
  }

  it("keeps brief outages quiet, including a recovery and a new drop between polls", async () => {
    const sync = source();
    const { err } = monitor(sync);
    sync.set({ status: "hub-down" });
    await vi.advanceTimersByTimeAsync(9_900);
    sync.set({ status: "connected" });
    sync.set({ status: "connecting" });
    await vi.advanceTimersByTimeAsync(9_900);
    sync.set({ status: "connected" });
    expect(err).not.toHaveBeenCalled();
  });

  it("reports a ten-second outage and its recovery once despite retries", async () => {
    const sync = source();
    const { err } = monitor(sync);
    await vi.advanceTimersByTimeAsync(275);
    sync.set({ status: "hub-down" });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(err).not.toHaveBeenCalled();
    sync.set({ status: "connecting" });
    await vi.advanceTimersByTimeAsync(1);
    expect(err.mock.calls).toEqual([[UNREACHABLE]]);
    sync.set({ status: "hub-down" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(err.mock.calls).toEqual([[UNREACHABLE]]);
    sync.set({ status: "connected" });
    sync.set({ status: "connected" });
    expect(err.mock.calls).toEqual([[UNREACHABLE], [RECOVERED]]);
  });

  it("does not repeat the unreachable banner and announces its later recovery", async () => {
    const sync = source({ status: "hub-down" });
    const { err } = monitor(sync, { unreachableAtStart: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(err).not.toHaveBeenCalled();
    sync.set({ status: "connected" });
    expect(err.mock.calls).toEqual([[RECOVERED]]);
  });

  it("also observes a timeout-derived outage without an event", async () => {
    const sync = source();
    const { err } = monitor(sync);
    sync.set({ status: "hub-down" }, false);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(err.mock.calls).toEqual([[UNREACHABLE]]);
    sync.set({ status: "connected" }, false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(err.mock.calls).toEqual([[UNREACHABLE], [RECOVERED]]);
  });

  it.each([
    [{ status: "auth-failed", authRecovery: "sign-in-required" }, "refused this machine's sign-in, changes stay here; run `ub auth login`"],
    [{ status: "auth-failed", authRecovery: "no-workspace-access" }, "refused workspace access, changes stay here; ask a workspace admin for access"],
    [{ status: "auth-failed", authRecovery: "credential-store" }, "could not read this machine's sign-in, changes stay here; run `ub doctor` for details"],
    [{ status: "auth-failed", authRecovery: "renewal-unavailable" }, "could not renew this machine's sign-in, changes stay here; run `ub doctor` for details"],
    [{ status: "auth-failed" }, "refused this machine's credential, changes stay here; run `ub doctor` for details"],
    [{ status: "update-required", hubProtocolVersion: 4 }, "needs a newer Uberblick, changes stay here; run `ub update`"],
    [{ status: "update-required", hubProtocolVersion: 2 }, `runs an older Uberblick, changes stay here; ask whoever runs ${ORIGIN} to update the hub`],
  ] satisfies [Partial<HubState>, string][])("names the correct remedy for %o at startup and after reconnecting", async (state, text) => {
    const sync = source({ ...state, reason: "untrusted hub wire text" });
    const { err } = monitor(sync);
    const line = `ub open: hub ${ORIGIN} ${text}\n`;
    expect(err.mock.calls).toEqual([[line]]);
    sync.set({ status: "connecting" });
    sync.set(state);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(err.mock.calls).toEqual([[line]]);
    sync.set({ status: "connected" });
    sync.set(state);
    expect(err.mock.calls).toEqual([[line], [line]]);
  });

  it("does not duplicate the initial sign-in banner, but reports a later refusal", () => {
    const sync = source({ status: "auth-failed", authRecovery: "sign-in-required" });
    const { err } = monitor(sync, { notSignedInAtStart: true });
    expect(err).not.toHaveBeenCalled();
    sync.set({ status: "connected" });
    sync.set({ status: "auth-failed" });
    expect(err.mock.calls).toEqual([
      [`ub open: hub ${ORIGIN} refused this machine's sign-in, changes stay here; run \`ub auth login\`\n`],
    ]);
  });

  it("cancels a pending outage notice and all listeners when serving stops", async () => {
    const sync = source();
    const { err, stop } = monitor(sync);
    sync.set({ status: "hub-down" });
    await vi.advanceTimersByTimeAsync(9_999);
    stop();
    expect(sync.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    sync.set({ status: "auth-failed", authRecovery: "sign-in-required" });
    expect(err).not.toHaveBeenCalled();
  });
});
