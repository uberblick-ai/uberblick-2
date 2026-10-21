import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { removeTempDirs, sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

vi.mock("node:timers/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:timers/promises")>(),
  setTimeout: vi.fn(),
}));

afterEach(() => { vi.restoreAllMocks(); });
afterAll(removeTempDirs);

it("waits the announced interval before the first and every later collect without a test ceiling", async () => {
  const waits: number[] = [];
  const releases: Array<() => void> = [];
  vi.mocked(delay).mockImplementation(async <T = void>(ms?: number, value?: T) => {
    waits.push(ms ?? 0);
    await new Promise<void>(resolve => { releases.push(resolve); });
    return value as T;
  });
  let collects = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/credential/renew") return new Response(null, { status: 401 });
    if (path === "/auth/claim-state") return Response.json({ unclaimed: false, canClaim: false });
    if (path === "/auth/github/start") return Response.json({
      status: "pending", requestId: "11111111-1111-4111-8111-111111111111", collectionSecret: "s".repeat(43),
      verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 60, interval: 2,
    });
    if (path === "/auth/github/collect") {
      collects++;
      return Response.json(collects === 1 ? { status: "pending", interval: 3 } : { status: "denied" });
    }
    if (path === "/auth/github/cancel") return Response.json({ status: "abandoned" });
    throw new Error(`unexpected auth route: ${path}`);
  });
  const running = runInProcess(["auth", "login", "https://hub.example.test"], sandbox(), { UB_TEST_MAX_WAIT_MS: undefined });
  try {
    await vi.waitFor(() => { expect(waits).toEqual([2_000]); });
    expect(collects).toBe(0);
    releases[0]!();
    await vi.waitFor(() => { expect(waits).toEqual([2_000, 3_000]); });
    expect(collects).toBe(1);
    releases[1]!();
    const run = await running;
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("denied");
    expect(collects).toBe(2);
  } finally {
    vi.mocked(delay).mockResolvedValue(undefined);
    for (const release of releases) release();
    await running;
  }
});
