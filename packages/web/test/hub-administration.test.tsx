import { act, render } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memo } from "react";
import type { LocalServing } from "../src/config.js";
import { useAccessReading, useHubAdministration } from "../src/ui/settings/hub-administration.js";
import { WorkspaceMembersContext, useWorkspaceMembers } from "../src/ui/workspace-members.js";
import type { AccessAction, AccessAnswer } from "../src/shell/workspace-access.js";
import { SERVING_STATUS_POLL_MS, SERVING_STATUS_TIMEOUT_MS } from "../src/ui/status/serving-status.js";

const WORKSPACE = "53f04353-622b-4b14-8d71-366193d43c74";
const SERVING: LocalServing = { workspace: WORKSPACE, remoteHubUrl: "ws://bound.example", localOnly: false, rebound: false };
const api = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>();
vi.mock("../src/shell/workspace-access.js", () => ({ createWorkspaceAccessClient: () => api }));

function Reading({ serving = SERVING, path = "settings" }: { serving?: LocalServing | null; path?: string }) {
  const administration = useHubAdministration(WORKSPACE, serving, "presence", path);
  return <><output>{administration.admin ? "admin" : administration.authority?.status ?? "waiting"}</output>
    <button type="button" onClick={() => { void administration.request({ operation: "list-hub-admins" }, new AbortController().signal); }}>List</button></>;
}
async function flush() { await act(async () => { await Promise.resolve(); }); }

const NO_MEMBERS: readonly string[] = [];
const MemberNames = memo(function MemberNames({ onRender }: { onRender: (() => void) | undefined }) {
  onRender?.();
  return <output>{useWorkspaceMembers().join(",")}</output>;
});

function Members({ workspace = WORKSPACE, onRender }: { workspace?: string; onRender?: () => void }) {
  const reading = useAccessReading(workspace, { ...SERVING, workspace }, "presence", "/doc", "list-member-usernames");
  return <WorkspaceMembersContext value={reading.authority?.status === "ok" ? reading.authority.usernames ?? NO_MEMBERS : NO_MEMBERS}>
    <MemberNames onRender={onRender} />
  </WorkspaceMembersContext>;
}

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

  it("refreshes members without retaining a failed or previous workspace's list", async () => {
    let answer: AccessAnswer = { status: "ok", hub: "https://bound.example", usernames: ["alice"] };
    api.mockImplementation(async () => answer);
    const view = render(<Members />);
    await flush();
    expect(view.container.querySelector("output")?.textContent).toBe("alice");
    expect(api).toHaveBeenCalledWith({ operation: "list-member-usernames", workspaceId: WORKSPACE }, expect.any(AbortSignal));
    answer = { status: "forbidden", hub: "https://bound.example" };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(view.container.querySelector("output")?.textContent).toBe("");
    answer = { status: "ok", hub: "https://bound.example", usernames: ["bob"] };
    view.rerender(<Members workspace="872b46d9-5b18-4fb1-84d5-de245c337e86" />);
    await flush();
    expect(view.container.querySelector("output")?.textContent).toBe("bob");
  });

  it("keeps member context consumers idle on unchanged polls and updates changed or refused membership", async () => {
    vi.useFakeTimers();
    let usernames = ["alice"];
    let status: AccessAnswer["status"] = "ok";
    api.mockImplementation(async () => ({ status, hub: "https://bound.example", usernames: [...usernames] }));
    const onRender = vi.fn();
    const view = render(<Members onRender={onRender} />);
    await flush();
    expect(view.container.querySelector("output")?.textContent).toBe("alice");
    onRender.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(api).toHaveBeenCalledTimes(2);
    expect(onRender).not.toHaveBeenCalled();
    usernames = ["bob"];
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(view.container.querySelector("output")?.textContent).toBe("bob");
    expect(onRender).toHaveBeenCalledTimes(1);
    status = "forbidden";
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(view.container.querySelector("output")?.textContent).toBe("");
    expect(onRender).toHaveBeenCalledTimes(2);
  });

  it.each([null, { ...SERVING, remoteHubUrl: null, localOnly: true }, { ...SERVING, rebound: true },
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
