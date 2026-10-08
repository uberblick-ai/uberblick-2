/** The remote guide makes only the claims established by the public answer. */
import { act, render } from "./react-render.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAIM_STATE_POLL_MS,
  CLAIM_STATE_TIMEOUT_MS,
  RemoteHubGuide,
} from "../src/ui/RemoteHubGuide.js";

const fetchMock = vi.fn<typeof fetch>();

function answer(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function mount(): HTMLElement {
  return render(<RemoteHubGuide />).container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function commands(host: HTMLElement): string[] {
  return [...host.querySelectorAll("code")].map((code) => code.textContent ?? "");
}

function expectUnconfirmed(host: HTMLElement): void {
  expect(host.textContent).toContain("setup state could not be confirmed");
  expect(host.textContent).not.toContain("This hub is unclaimed");
  expect(host.textContent).not.toContain("ub auth login");
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the remote hub setup reading", () => {
  it("waits for evidence, then explains the one-time claim and computer binding", async () => {
    let complete!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const host = mount();
    expect(host.textContent).not.toContain("This hub is unclaimed");
    expect(host.textContent).not.toContain("ub auth login");

    await act(async () => complete(answer({ unclaimed: true, canClaim: true })));
    const text = host.textContent ?? "";
    expect(text).toContain("This hub is unclaimed");
    expect(text).toMatch(/first.*GitHub.*approval/i);
    expect(text).toContain("first member and administrator");
    expect(text).toContain("default workspace");
    expect(text).toMatch(/one[- ]time|once/i);
    expect(text).toMatch(/workspace UUID.*report|reported.*workspace UUID/i);
    expect(commands(host)).toContain(`ub auth login '${window.location.origin}'`);
    expect(commands(host)).toContain(`ub workspace use '${window.location.origin}/<workspace-id>'`);
    expect(commands(host)).toContain("ub open");
    expect(text).toMatch(/browser is not signed in/i);
  });

  it("describes closed claiming without promising setup, configured sign-in or membership", async () => {
    fetchMock.mockResolvedValue(answer({ unclaimed: false, canClaim: false }));
    const host = mount();
    await flush();
    const text = host.textContent ?? "";
    expect(text).toContain("This hub can no longer be claimed");
    expect(text).toMatch(/browser is not signed in/i);
    expect(text).toMatch(/browser sign-in is not available yet/i);
    expect(text).toMatch(/signing in.*(does not|never|grants no).*membership|login.*(does not|never).*membership/i);
    expect(text).toMatch(/workspace administrator/i);
    expect(text).toMatch(/already bound/i);
    expect(commands(host)).toContain(`ub auth login '${window.location.origin}'`);
    expect(commands(host)).toContain(`ub workspace use '${window.location.origin}/<workspace-id>'`);
    expect(commands(host)).toContain("ub open");
    expect(text).not.toMatch(/hub is set up|sign-in is configured|sign-in is not configured/i);

    await advance(CLAIM_STATE_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("withholds the claim command when an unclaimed hub has no configured GitHub sign-in", async () => {
    fetchMock.mockResolvedValue(answer({ unclaimed: true, canClaim: false }));
    const host = mount();
    await flush();
    expect(host.textContent).toContain("GitHub sign-in is not configured on this hub");
    expect(host.textContent).not.toContain("ub auth login");

    await advance(CLAIM_STATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an extra field", { unclaimed: true, canClaim: true, workspace: "private-workspace" }],
    ["a missing field", { unclaimed: true }],
    ["a non-boolean unclaimed", { unclaimed: "true", canClaim: true }],
    ["a non-boolean canClaim", { unclaimed: true, canClaim: 1 }],
    ["a claimable closed hub", { unclaimed: false, canClaim: true }],
    ["an older hub error", { status: "unknown-request" }],
    ["an array", [true, true]],
    ["null", null],
  ])("does not infer state from %s", async (_name, value) => {
    fetchMock.mockResolvedValue(answer(value));
    const host = mount();
    await flush();
    expectUnconfirmed(host);
    expect(host.textContent).not.toContain("private-workspace");
  });

  it.each([
    ["the SPA HTML fallback", "<!doctype html><html><body>Uberblick</body></html>", 200, "text/html"],
    ["a refused read", '{"unclaimed":true,"canClaim":true}', 403, "application/json"],
    ["a missing older route", '{"status":"unknown-request"}', 404, "application/json"],
    ["invalid JSON", '{"unclaimed":true', 200, "application/json"],
  ])("does not infer state from %s", async (_name, body, status, contentType) => {
    fetchMock.mockResolvedValue(new Response(body, { status, headers: { "Content-Type": contentType } }));
    const host = mount();
    await flush();
    expectUnconfirmed(host);
  });

  it("reads only the serving origin without credentials or cached/redirected answers", async () => {
    fetchMock.mockResolvedValue(answer({ unclaimed: false, canClaim: false }));
    mount();
    await flush();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${window.location.origin}/auth/claim-state`);
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  });

  it("rechecks at a bounded cadence and replaces an unclaimed reading when claiming closes", async () => {
    let complete!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }))
      .mockResolvedValue(answer({ unclaimed: false, canClaim: false }));
    const host = mount();
    // The cadence starts after a read completes, rather than overlapping a
    // slower response or consuming the delay while it is still in flight.
    await advance(CLAIM_STATE_TIMEOUT_MS - 1);
    await act(async () => complete(answer({ unclaimed: true, canClaim: true })));
    expect(host.textContent).toContain("This hub is unclaimed");

    await advance(CLAIM_STATE_POLL_MS - 1);
    expect(fetchMock).toHaveBeenCalledOnce();
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("This hub can no longer be claimed");
    expect(host.textContent).not.toContain("This hub is unclaimed");
    await advance(CLAIM_STATE_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes an earlier unclaimed reading when the recheck fails and retries later", async () => {
    fetchMock.mockResolvedValueOnce(answer({ unclaimed: true, canClaim: true }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(answer({ unclaimed: false, canClaim: false }));
    const host = mount();
    await flush();
    await advance(CLAIM_STATE_POLL_MS);
    expectUnconfirmed(host);
    await advance(CLAIM_STATE_POLL_MS);
    expect(host.textContent).toContain("This hub can no longer be claimed");
  });

  it.each(["headers", "body"] as const)("bounds a stalled %s read and retries after the deadline", async (stage) => {
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (_url, init) => {
      signal = init?.signal;
      if (stage === "headers") {
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
        },
      }), { headers: { "Content-Type": "application/json" } });
    });
    const host = mount();
    await flush();
    await advance(CLAIM_STATE_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    await advance(1);
    expect(signal?.aborted).toBe(true);
    expectUnconfirmed(host);
    await advance(CLAIM_STATE_POLL_MS - 1);
    expect(fetchMock).toHaveBeenCalledOnce();
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts on unmount and prevents a late answer from starting another recheck", async () => {
    let complete!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => { complete = resolve; });
    });
    const view = render(<RemoteHubGuide />);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => complete(answer({ unclaimed: true, canClaim: true })));
    await advance(CLAIM_STATE_POLL_MS * 2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
