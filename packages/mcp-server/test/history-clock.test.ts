import { afterEach, expect, it, vi } from "vitest";
import { HubHistoryClock } from "../src/history-clock.js";
import { hubUrl, startHub } from "./helpers.js";

const endpoint = "wss://hub.example/ws";
const remoteTime = Date.UTC(2026, 9, 28, 12);
const date = new Date(remoteTime).toUTCString();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("samples the supported hub's uncached HTTP Date without room admission", async () => {
  const hub = await startHub();
  const clock = new HubHistoryClock(hubUrl(hub.port));
  const before = Date.now();
  try {
    await clock.ensure();
    expect(clock.now()).toBeGreaterThanOrEqual(before - 1_000);
    expect(clock.now()).toBeLessThanOrEqual(Date.now());
  } finally {
    clock.close();
    await hub.stop();
  }
});

it.each([remoteTime - 86_400_000, remoteTime + 86_400_000])(
  "uses a monotonic hub sample despite a client clock at %s",
  async localTime => {
    let monotonic = 100;
    const localClock = vi.spyOn(Date, "now").mockReturnValue(localTime);
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("ignored body", { headers: { date } }));
    vi.stubGlobal("fetch", request);
    const clock = new HubHistoryClock(endpoint);
    expect(clock.now()).toBe(localTime);
    const sampling = clock.ensure();
    expect(clock.ensure()).toBe(sampling);
    await sampling;

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("https://hub.example/auth/claim-state", {
      method: "GET", credentials: "omit", redirect: "error", signal: expect.any(AbortSignal),
    });
    expect(clock.now()).toBe(remoteTime);
    localClock.mockReturnValue(localTime + 3_600_000);
    monotonic += 250;
    expect(clock.now()).toBe(remoteTime + 250);
    expect(clock.delay(remoteTime + 10_000)).toBe(10_750);
    expect(clock.delay(remoteTime - 1)).toBe(1_000);
    await clock.ensure();
    expect(request).toHaveBeenCalledOnce();
    clock.close();
  },
);

it.each([
  { status: 503, headers: { date } },
  { status: 200, headers: {} },
  { status: 200, headers: { date: "not-a-date" } },
  { status: 200, headers: { date: "0" } },
])("keeps a failed sample stopped until reset: %j", async init => {
  const response = new Response("discarded", init);
  const cancel = vi.spyOn(response.body!, "cancel");
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response)
    .mockResolvedValueOnce(new Response("", { headers: { date } }));
  vi.stubGlobal("fetch", request);
  const clock = new HubHistoryClock(endpoint);
  await expect(clock.ensure()).rejects.toMatchObject({ code: "unreachable" });
  await expect(clock.ensure()).rejects.toMatchObject({ code: "unreachable" });
  expect(request).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(() => clock.delay(remoteTime)).toThrow();

  clock.reset();
  await clock.ensure();
  expect(request).toHaveBeenCalledTimes(2);
  clock.close();
});

it("bounds a stalled sample and cancels in-flight work on close", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const request = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) throw new Error("A bounded clock request needs an abort signal.");
    signals.push(signal);
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  vi.stubGlobal("fetch", request);
  const clock = new HubHistoryClock(endpoint);
  const timedOut = expect(clock.ensure()).rejects.toMatchObject({ code: "unreachable" });
  await vi.advanceTimersByTimeAsync(5_000);
  await timedOut;
  expect(signals[0]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await expect(clock.ensure()).rejects.toMatchObject({ code: "unreachable" });
  expect(request).toHaveBeenCalledOnce();

  clock.reset();
  const closed = expect(clock.ensure()).rejects.toMatchObject({ code: "unreachable" });
  clock.close();
  await closed;
  expect(signals[1]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  clock.reset();
  await expect(clock.ensure()).rejects.toMatchObject({ code: "unreachable" });
  expect(request).toHaveBeenCalledTimes(2);
});

it("discards a superseded sample even when its fetch ignores cancellation", async () => {
  let resolveOld!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  const newerDate = new Date(remoteTime + 60_000).toUTCString();
  const request = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => {
    oldSignal = init?.signal;
    return new Promise(resolve => { resolveOld = resolve; });
  }).mockResolvedValueOnce(new Response("", { headers: { date: newerDate } }));
  vi.stubGlobal("fetch", request);
  const clock = new HubHistoryClock(endpoint);
  const old = expect(clock.ensure()).rejects.toMatchObject({ code: "unreachable" });
  clock.reset();
  expect(oldSignal?.aborted).toBe(true);
  await clock.ensure();
  const stale = new Response("stale", { headers: { date } });
  const cancel = vi.spyOn(stale.body!, "cancel");
  resolveOld(stale);
  await old;
  expect(cancel).toHaveBeenCalledOnce();
  expect(clock.now()).toBeGreaterThanOrEqual(remoteTime + 60_000);
  clock.close();
});
