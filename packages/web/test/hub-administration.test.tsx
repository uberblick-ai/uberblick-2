import { act, render } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalServing } from "../src/config.js";
import { useHubAdministration } from "../src/ui/settings/hub-administration.js";
import type { AccessAction, AccessAnswer } from "../src/shell/workspace-access.js";
import { SERVING_STATUS_POLL_MS, SERVING_STATUS_TIMEOUT_MS } from "../src/ui/status/serving-status.js";

const WORKSPACE = "53f04353-622b-4b14-8d71-366193d43c74";
const SERVING: LocalServing = { workspace: WORKSPACE, remoteHubUrl: "ws://bound.example", rebound: false };
const api = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>();
vi.mock("../src/shell/workspace-access.js", () => ({ createWorkspaceAccessClient: () => api }));

function Reading({ serving = SERVING, path = "settings" }: { serving?: LocalServing | null; path?: string }) {
  const administration = useHubAdministration(WORKSPACE, serving, "presence", path);
  return <><output>{administration.admin ? "admin" : administration.authority?.status ?? "waiting"}</output>
    <button type="button" onClick={() => { void administration.request({ operation: "list-hub-admins" }, new AbortController().signal); }}>List</button></>;
}
async function flush() { await act(async () => { await Promise.resolve(); }); }

describe("bound hub authority", () => {
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

  it("uses hub authority without reading the workspace role and refreshes on focus or navigation", async () => {
    let authority: AccessAnswer = { status: "ok", hub: "https://bound.example", role: "admin" };
    api.mockImplementation(async () => authority);
    const view = render(<Reading />);
    await flush();
    expect(view.container.querySelector("output")?.textContent).toBe("admin");
    expect(api.mock.calls.map(([action]) => action.operation)).toEqual(["own-hub-role"]);
    authority = { status: "forbidden", hub: "https://bound.example" };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(view.container.querySelector("output")?.textContent).toBe("forbidden");
    authority = { status: "ok", role: "admin", hub: "https://bound.example" };
    view.rerender(<Reading path="settings/hub-admins" />);
    await flush();
    expect(view.container.querySelector("output")?.textContent).toBe("admin");
  });

  it.each([null, { ...SERVING, remoteHubUrl: null }, { ...SERVING, rebound: true },
    { ...SERVING, workspace: "872b46d9-5b18-4fb1-84d5-de245c337e86" }, { ...SERVING, workspace: "not-a-workspace" }])("never picks another login for an unavailable binding %j", async (serving) => {
    const view = render(<Reading serving={serving} />);
    await flush();
    expect(view.container.querySelector("output")?.textContent).toBe("local-only");
    expect(api).not.toHaveBeenCalled();
  });

  it("a refused list clears authority and prevents an older role answer restoring it", async () => {
    let finishRole: ((answer: AccessAnswer) => void) | undefined;
    api.mockResolvedValue({ status: "ok", role: "admin", hub: "https://bound.example" });
    const view = render(<Reading />);
    await flush();
    api.mockImplementation(async (action) => action.operation === "own-hub-role"
      ? new Promise((resolve) => { finishRole = resolve; }) : { status: "forbidden", hub: "https://bound.example" });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => view.container.querySelector("button")?.click());
    expect(view.container.querySelector("output")?.textContent).toBe("forbidden");
    await act(async () => finishRole?.({ status: "ok", role: "admin", hub: "https://bound.example" }));
    expect(view.container.querySelector("output")?.textContent).toBe("forbidden");
  });

  it("polls live authority and retires an administrator reading when the hub stops answering", async () => {
    vi.useFakeTimers();
    api.mockResolvedValueOnce({ status: "ok", role: "admin", hub: "https://bound.example" });
    api.mockImplementation(async () => new Promise(() => {}));
    const view = render(<Reading />);
    await flush();
    expect(view.container.querySelector("output")?.textContent).toBe("admin");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS + SERVING_STATUS_TIMEOUT_MS));
    expect(view.container.querySelector("output")?.textContent).toBe("hub-down");
    api.mockResolvedValue({ status: "forbidden", hub: "https://bound.example" });
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(view.container.querySelector("output")?.textContent).toBe("forbidden");
  });
});
