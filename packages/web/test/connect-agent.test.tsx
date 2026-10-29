import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectAgent } from "../src/ui/shell/ConnectAgent.js";
import { BROWSER_SESSION_STORAGE_KEY } from "../src/ui/shell/BrowserHubSignIn.js";
import { act, render } from "./react-render.js";

const fetchMock = vi.fn<typeof fetch>();
const token = "a".repeat(43);
const requestId = "agent-request";
const unavailable = "This request is no longer available. Start again from the agent.";

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function session(sessionToken = token, username = "octocat") {
  return { token: sessionToken, username, expiresAt: Date.now() + 86_400_000 };
}

function pending(overrides: object = {}) {
  return { status: "pending", clientName: "Helpful agent", redirectHost: "agent.example:8443",
    workspaceId: "workspace-id", workspaceName: "Shared notes", accessLevels: ["read-only", "read-write"], ...overrides };
}

function restore(): void {
  localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(session()));
  fetchMock.mockResolvedValueOnce(answer({ status: "signed-in", ...session() }));
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function expectUnavailable(view: ReturnType<typeof render>): void {
  expect(view.getByText(unavailable)).toBeTruthy();
  expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(view.queryByRole("button", { name: "Deny" })).toBeNull();
  expect(view.queryByRole("region", { name: "Agent request" })).toBeNull();
  expect(view.container.textContent).not.toContain("Helpful agent");
  expect(view.container.textContent).not.toContain("Shared notes");
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  window.history.replaceState(null, "", `/connect?request=${requestId}`);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("connect an agent", () => {
  it.each(["/connect", "/connect?request="])("shows only the start-again message without a request: %s", async path => {
    window.history.replaceState(null, "", path);
    localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(session()));
    const view = render(<ConnectAgent />);
    await flush();
    expectUnavailable(view);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no session or consent request from a framed page", async () => {
    vi.spyOn(window, "self", "get").mockReturnValue({} as Window & typeof globalThis);
    localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(session()));
    const view = render(<ConnectAgent />);
    await flush();
    expect(view.getByRole("link", { name: "Open this hub in its own browser tab" }).getAttribute("href"))
      .toBe(window.location.href);
    expect(view.queryByRole("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores the session, reads pending details at this origin, and defaults to read only", async () => {
    restore();
    fetchMock.mockResolvedValueOnce(answer(pending()));
    const view = render(<ConnectAgent />);
    await flush();
    expect(view.getByText("octocat")).toBeTruthy();
    expect(view.getByText("Helpful agent")).toBeTruthy();
    expect(view.getByText("agent.example:8443")).toBeTruthy();
    expect(view.getByText("Shared notes")).toBeTruthy();
    expect((view.getByRole("combobox", { name: "Access" }) as HTMLSelectElement).value).toBe("read-only");
    expect(view.getByRole("option", { name: "Read and write" })).toBeTruthy();
    expect(view.queryByText(/Approve only if you started/)).toBeNull();
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`${window.location.origin}/oauth/consent/read`);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error" });
    expect(new Headers(init?.headers).get("X-Uberblick-Session")).toBe(token);
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({ requestId });
  });

  it("uses the workspace id when unnamed and offers only the access returned by consent", async () => {
    restore();
    fetchMock.mockResolvedValueOnce(answer(pending({ workspaceName: null, accessLevels: ["read-only"] })));
    const view = render(<ConnectAgent />);
    await flush();
    expect(view.getByText("workspace-id")).toBeTruthy();
    expect(view.getAllByRole("option").map(option => option.textContent)).toEqual(["Read only"]);
    expect(view.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it.each(["localhost:4321", "127.0.0.1", "127.231.45.67:8910", "[::1]:4321"])("warns before returning to loopback host %s", async redirectHost => {
    restore();
    fetchMock.mockResolvedValueOnce(answer(pending({ redirectHost })));
    const view = render(<ConnectAgent />);
    await flush();
    expect(view.getByText(redirectHost)).toBeTruthy();
    expect(view.getByText("The browser returns to an app on this computer. Approve only if you started this from an agent on this computer."))
      .toBeTruthy();
  });

  it("does not mistake a public hostname containing localhost for loopback", async () => {
    restore();
    fetchMock.mockResolvedValueOnce(answer(pending({ redirectHost: "localhost.agent.example:443" })));
    const view = render(<ConnectAgent />);
    await flush();
    expect(view.getByText("localhost.agent.example:443")).toBeTruthy();
    expect(view.queryByText(/Approve only if you started/)).toBeNull();
  });

  it("shows the signed-in non-member and lets them sign out to change accounts", async () => {
    restore();
    fetchMock.mockResolvedValueOnce(answer({ status: "not-a-member" }, 403))
      .mockResolvedValueOnce(answer({ status: "signed-out" }));
    const view = render(<ConnectAgent />);
    await flush();
    expect(view.getByText("octocat")).toBeTruthy();
    expect(view.getByText(/You are not a member of this workspace/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(view.queryByRole("button", { name: "Deny" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(view.queryByText("octocat")).toBeNull();
    expect(view.queryByText(/You are not a member/)).toBeNull();
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("uses the same detail-free message for an unknown, expired or consumed first read", async () => {
    restore();
    fetchMock.mockResolvedValueOnce(answer({ status: "unknown-request" }, 404));
    const view = render(<ConnectAgent />);
    await flush();
    expectUnavailable(view);
  });

  it("keeps an unavailable request detail-free even when sign-in just claimed a workspace", async () => {
    fetchMock.mockResolvedValueOnce(answer({ status: "signed-out" }, 401))
      .mockResolvedValueOnce(answer({ status: "pending", requestId: "github-request", collectionSecret: "collection-secret",
        verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 900, interval: 1 }))
      .mockResolvedValueOnce(answer({ status: "complete", session: session(), claimedWorkspaceId: "private-claimed-workspace" }))
      .mockResolvedValueOnce(answer({ status: "unknown-request" }, 404));
    const view = render(<ConnectAgent />);
    await flush();
    fireEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expectUnavailable(view);
    expect(view.getByText("octocat")).toBeTruthy();
    expect(view.container.textContent).not.toContain("private-claimed-workspace");
    expect(view.container.textContent).not.toContain("Claimed this hub");
  });

  it.each(["Approve", "Deny"])("removes stale request details and actions when %s finds the request expired", async action => {
    restore();
    fetchMock.mockResolvedValueOnce(answer(pending()))
      .mockResolvedValueOnce(answer({ status: "unknown-request" }, 404));
    const view = render(<ConnectAgent />);
    await flush();
    fireEvent.change(view.getByRole("combobox", { name: "Access" }), { target: { value: "read-write" } });
    fireEvent.click(view.getByRole("button", { name: action }));
    await flush();
    expectUnavailable(view);
    const [url, init] = fetchMock.mock.calls[2]!;
    expect(url).toBe(`${window.location.origin}/oauth/consent/submit`);
    expect(new Headers(init?.headers).get("X-Uberblick-Session")).toBe(token);
    expect(JSON.parse(String(init?.body))).toEqual(action === "Approve"
      ? { requestId, decision: "approve", accessLevel: "read-write" } : { requestId, decision: "deny" });
  });

  it("submits once while a decision is in flight, even for rapid conflicting clicks", async () => {
    let complete!: (response: Response) => void;
    restore();
    fetchMock.mockResolvedValueOnce(answer(pending()))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    const view = render(<ConnectAgent />);
    await flush();
    const approve = view.getByRole("button", { name: "Approve" });
    const deny = view.getByRole("button", { name: "Deny" });
    act(() => { fireEvent.click(approve); fireEvent.click(approve); fireEvent.click(deny); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect((deny as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: "Sign out" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => complete(answer({ status: "unknown-request" }, 404)));
    expectUnavailable(view);
  });

  it("returns to sign-in after a consent 401 and reads the same request after the new sign-in", async () => {
    const nextSession = session("b".repeat(43), "another-account");
    restore();
    fetchMock.mockResolvedValueOnce(answer(pending()))
      .mockResolvedValueOnce(answer({ status: "signed-out" }, 401))
      .mockResolvedValueOnce(answer({ status: "pending", requestId: "github-request", collectionSecret: "collection-secret",
        verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH", expiresIn: 900, interval: 1 }))
      .mockResolvedValueOnce(answer({ status: "complete", session: nextSession }))
      .mockResolvedValueOnce(answer(pending()));
    const view = render(<ConnectAgent />);
    await flush();
    fireEvent.click(view.getByRole("button", { name: "Approve" }));
    await flush();
    expect(view.queryByRole("region", { name: "Agent request" })).toBeNull();
    expect(view.getByRole("alert").textContent).toContain("Your browser session has ended");
    expect(localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Sign in with GitHub" }));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(view.getByText("another-account")).toBeTruthy();
    expect(view.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(JSON.parse(String(fetchMock.mock.calls[5]![1]?.body))).toEqual({ requestId });
    expect(new Headers(fetchMock.mock.calls[5]![1]?.headers).get("X-Uberblick-Session")).toBe(nextSession.token);
  });

  it("retries a failed read without inventing request details", async () => {
    restore();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(answer(pending()));
    const view = render(<ConnectAgent />);
    await flush();
    expect(view.getByRole("alert").textContent).toBe("The hub could not read this request.");
    expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await flush();
    expect(view.getByText("Helpful agent")).toBeTruthy();
  });

  it("aborts a pending consent read when signing out and ignores its late answer", async () => {
    let complete!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    restore();
    fetchMock.mockImplementationOnce((_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(resolve => { complete = resolve; });
    }).mockResolvedValueOnce(answer({ status: "signed-out" }));
    const view = render(<ConnectAgent />);
    await flush();
    fireEvent.click(view.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(signal?.aborted).toBe(true);
    await act(async () => complete(answer(pending())));
    expect(view.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(view.queryByText("Helpful agent")).toBeNull();
    expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
