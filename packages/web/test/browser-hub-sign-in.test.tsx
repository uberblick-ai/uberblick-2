import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "./react-render.js";
import { BROWSER_SESSION_POLL_MS, BROWSER_SESSION_STORAGE_KEY, BrowserHubSignIn } from "../src/ui/shell/BrowserHubSignIn.js";

const fetchMock = vi.fn<typeof fetch>();
const token = "a".repeat(43);
const onClaim = vi.fn();

function answer(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function savedSession(expiresAt = Date.now() + 86_400_000) {
  return { token, username: "octocat", expiresAt };
}

function mount(claimable = false) {
  return render(<BrowserHubSignIn claimable={claimable} claimStateKnown onClaim={onClaim} />);
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  fetchMock.mockReset();
  onClaim.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("hub browser sign-in", () => {
  it("starts only on request, follows GitHub's polling interval, and stores only the browser session", async () => {
    const issued = savedSession();
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-out" }, 401))
      .mockResolvedValueOnce(answer({ status: "pending", requestId: "request-id", collectionSecret: "collection-secret",
        verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 900, interval: 1 }))
      .mockResolvedValueOnce(answer({ status: "pending", interval: 3 }))
      .mockResolvedValueOnce(answer({ status: "complete", session: issued, claimedWorkspaceId: "workspace-uuid" }));
    const view = mount(true);
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${window.location.origin}/auth/browser/session`);
    fireEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    await flush();
    expect(view.getByRole("link", { name: "https://github.com/login/device" }).getAttribute("href"))
      .toBe("https://github.com/login/device");
    expect(view.container.textContent).toContain("ABCD-EFGH");
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(view.container.textContent).toContain("Signed in as octocat");
    expect(view.container.textContent).toContain("hub administrator and administrator of the default workspace (workspace-uuid)");
    expect(onClaim).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)!)).toEqual(issued);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(new RegExp(`^${window.location.origin}/auth/browser/`));
      expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error" });
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    }
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({});
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({ requestId: "request-id", collectionSecret: "collection-secret" });
  });

  it("restores the account from the hub and keeps the token until sign-out is confirmed", async () => {
    localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(savedSession()));
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-in", username: "renamed-octocat", expiresAt: savedSession().expiresAt }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(answer({ status: "signed-out" }));
    const view = mount();
    expect(view.container.textContent).not.toContain("Signed in as");
    await flush();
    expect(view.container.textContent).toContain("Signed in as renamed-octocat");
    fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(view.getByRole("alert").textContent).toContain("hub could not confirm sign-out");
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).not.toBeNull();
    expect(view.container.textContent).toContain("Signed in as renamed-octocat");
    fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(view.container.textContent).not.toContain("Signed in as");
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
    for (const [, init] of fetchMock.mock.calls) expect(new Headers(init?.headers).get("X-Uberblick-Session")).toBe(token);
  });

  it("accepts server confirmation that sign-out already ended an expired or revoked session", async () => {
    localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(savedSession()));
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-in", ...savedSession() }))
      .mockResolvedValueOnce(answer({ status: "signed-out" }, 401));
    const view = mount();
    await flush();
    fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("does not let an obsolete failed session poll restore uncertainty after confirmed sign-out", async () => {
    let failPoll!: (reason: Error) => void;
    localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(savedSession()));
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-in", ...savedSession() }))
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { failPoll = reject; }))
      .mockResolvedValueOnce(answer({ status: "signed-out" }));
    const view = mount();
    await flush();
    await advance(BROWSER_SESSION_POLL_MS);
    fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    await flush();
    await act(async () => failPoll(new TypeError("Failed to fetch")));
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("checks expiry with the hub despite a fast browser clock, then clears a refused session", async () => {
    const expiresAt = Date.now() - 1;
    localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(savedSession(expiresAt)));
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-in", ...savedSession(expiresAt) }))
      .mockResolvedValueOnce(answer({ status: "signed-in", ...savedSession(expiresAt) }))
      .mockResolvedValueOnce(answer({ status: "signed-out" }, 401));
    const view = mount();
    await flush();
    await advance(0);
    expect(view.container.textContent).toContain("Signed in as octocat");
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).not.toBeNull();
    await advance(BROWSER_SESSION_POLL_MS);
    expect(view.container.textContent).not.toContain("Signed in as");
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("retains an active session during a failed status check and clears uncertainty when the hub recovers", async () => {
    localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(savedSession()));
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-in", ...savedSession() }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(answer({ status: "signed-in", ...savedSession() }));
    const view = mount();
    await flush();
    await advance(BROWSER_SESSION_POLL_MS);
    expect(view.container.textContent).toContain("Signed in as octocat");
    expect(view.getByRole("alert").textContent).toContain("could not confirm this browser’s session status");
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).not.toBeNull();
    await advance(BROWSER_SESSION_POLL_MS);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.textContent).toContain("Signed in as octocat");
  });

  it("offers no browser sign-in when the hub reports it unconfigured", async () => {
    fetchMock.mockResolvedValue(answer({ status: "not-configured" }, 503));
    const view = mount();
    await flush();
    expect(view.container.textContent).toContain("Browser sign-in is not configured on this hub");
    expect(view.queryByRole("button", { name: "Sign in with GitHub" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels the pending approval at the hub and stops collecting", async () => {
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-out" }, 401))
      .mockResolvedValueOnce(answer({ status: "pending", requestId: "request-id", collectionSecret: "collection-secret",
        verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 900, interval: 1 }))
      .mockResolvedValueOnce(answer({ status: "abandoned" }));
    const view = mount();
    await flush();
    fireEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    await flush();
    fireEvent.click(view.getByRole("button", { name: "Cancel sign-in" }));
    await flush();
    expect(String(fetchMock.mock.calls[2]![0])).toBe(`${window.location.origin}/auth/browser/cancel`);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({ requestId: "request-id", collectionSecret: "collection-secret" });
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(view.container.textContent).not.toContain("ABCD-EFGH");
    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a completed session usable and reports when browser storage prevents reload persistence", async () => {
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-out" }, 401))
      .mockResolvedValueOnce(answer({ status: "pending", requestId: "request-id", collectionSecret: "collection-secret",
        verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 900, interval: 1 }))
      .mockResolvedValueOnce(answer({ status: "complete", session: savedSession() }))
      .mockResolvedValueOnce(answer({ status: "signed-out" }));
    const view = mount();
    await flush();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage unavailable", "SecurityError"); });
    fireEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    await flush();
    await advance(1_000);
    expect(view.container.textContent).toContain("Signed in as octocat");
    expect(view.getByRole("alert").textContent).toContain("could not keep the session for reload");
    fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(new Headers(fetchMock.mock.calls[3]![1]?.headers).get("X-Uberblick-Session")).toBe(token);
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it.each(["denied", "expired"])("explains %s GitHub approval and allows a fresh explicit start", async (status) => {
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-out" }, 401))
      .mockResolvedValueOnce(answer({ status: "pending", requestId: "request-id", collectionSecret: "collection-secret",
        verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 900, interval: 1 }))
      .mockResolvedValueOnce(answer({ status }));
    const view = mount();
    await flush();
    fireEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    await flush();
    await advance(1_000);
    expect(view.getByRole("alert").textContent).toContain(status === "denied" ? "denied" : "expired");
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
  });
});
