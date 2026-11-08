import { afterEach, describe, expect, it, vi } from "vitest";
import { githubItemKey, githubItemUrl, writeGitHubItemObservation } from "@uberblick/schema";
import type { GitHubItem } from "@uberblick/schema";
import * as Y from "yjs";
import { createGitHubItemStates } from "../src/github-item-states.js";
import { createGitHubItemStateClient } from "../src/shell/github-item-states.js";
import type { GitHubItemStateReadings } from "../src/shell/github-item-states.js";
import { mintHubAuthMessage } from "../src/collab/rooms.js";

vi.mock("../src/collab/rooms.js", () => ({
  mintHubAuthMessage: vi.fn(async () => "browser-bearer"),
}));
vi.mock("../src/collab/local-session.js", () => ({
  localSessionHeaders: vi.fn(async () => ({ "X-Uberblick-Session": "browser-session" })),
}));

function item(path: string): GitHubItem {
  const parsed = githubItemUrl(`https://github.com/${path}`);
  if (parsed === null) throw new Error("invalid test item");
  return parsed;
}
const issue = item("Owner/Repo/issues/12");
const pull = item("Owner/Repo/pull/13");
const fiveMinutes = 5 * 60_000;
const hour = 60 * 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("page GitHub state readings", () => {
  it("reads workspace state without a personal route and updates its subscribers and age live", async () => {
    vi.useFakeTimers();
    const shared = new Y.Doc();
    const seenAt = Date.now() - 3 * hour;
    writeGitHubItemObservation(shared, githubItemKey(issue), { state: "issue-completed", seenAt, isPublic: false });
    const states = createGitHubItemStates(null, shared);
    const changed = vi.fn();
    const stop = states.subscribe([issue], changed);
    expect(states.get(issue)).toBe("issue-completed");
    expect(states.seenAt?.(issue)).toBe(seenAt);
    writeGitHubItemObservation(shared, githubItemKey(issue), { state: "issue-not-planned", seenAt: Date.now(), isPublic: false });
    expect(states.get(issue)).toBe("issue-not-planned");
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    shared.destroy();
  });

  it("gives a fresh personal reading precedence and falls back while refreshing and after an inaccessible or offline answer", async () => {
    vi.useFakeTimers();
    const shared = new Y.Doc();
    writeGitHubItemObservation(shared, githubItemKey(issue), { state: "issue-completed", seenAt: Date.now() - hour, isPublic: true });
    let answer!: (reading: GitHubItemStateReadings) => void;
    const read = vi.fn().mockResolvedValueOnce({ states: { [githubItemKey(issue)]: "issue-open" } })
      .mockImplementationOnce(() => new Promise<GitHubItemStateReadings>((resolve) => { answer = resolve; }))
      .mockRejectedValueOnce(new Error("offline"));
    const states = createGitHubItemStates(read, shared);
    const changed = vi.fn();
    const stop = states.subscribe([issue], changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.get(issue)).toBe("issue-open");
    expect(states.seenAt?.(issue)).toBeNull();
    writeGitHubItemObservation(shared, githubItemKey(issue), { state: "issue-not-planned", seenAt: Date.now(), isPublic: true });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(states.get(issue)).toBe("issue-open");
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    expect(states.get(issue)).toBe("issue-not-planned");
    expect(states.seenAt?.(issue)).not.toBeNull();
    answer({ states: {} });
    await Promise.resolve();
    expect(states.get(issue)).toBe("issue-not-planned");
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    expect(read).toHaveBeenCalledTimes(3);
    expect(states.get(issue)).toBe("issue-not-planned");
    stop();
    expect(vi.getTimerCount()).toBe(0);
    shared.destroy();
  });

  it("batches duplicate editor, comment and comparison references and repaints their readers", async () => {
    vi.useFakeTimers();
    let answer!: (states: GitHubItemStateReadings) => void;
    const read = vi.fn((_items: readonly GitHubItem[], _signal: AbortSignal) => new Promise<GitHubItemStateReadings>((resolve) => { answer = resolve; }));
    const states = createGitHubItemStates(read);
    const editor = vi.fn();
    const comment = vi.fn();
    const stopEditor = states.subscribe([issue, pull], editor);
    const stopComment = states.subscribe([item("OWNER/REPO/issues/0012")], comment);
    expect(states.get(issue)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0].map(githubItemKey)).toEqual([githubItemKey(issue), githubItemKey(pull)]);
    answer({ states: { [githubItemKey(issue)]: "issue-completed", [githubItemKey(pull)]: "pull-draft" } });
    await Promise.resolve();
    expect(states.get(issue)).toBe("issue-completed");
    expect(states.get(pull)).toBe("pull-draft");
    expect(editor).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledTimes(1);
    stopEditor();
    stopComment();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps its cached reading while a refresh is pending without a workspace record", async () => {
    vi.useFakeTimers();
    let answer!: (states: GitHubItemStateReadings) => void;
    const read = vi.fn().mockResolvedValueOnce({ states: { [githubItemKey(issue)]: "issue-open" } })
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const states = createGitHubItemStates(read);
    const changed = vi.fn();
    const stop = states.subscribe([issue], changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.get(issue)).toBe("issue-open");
    await vi.advanceTimersByTimeAsync(fiveMinutes - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(states.get(issue)).toBe("issue-open");
    expect(changed).toHaveBeenCalledTimes(1);
    answer({ states: { [githubItemKey(issue)]: "issue-completed" } });
    await Promise.resolve();
    expect(states.get(issue)).toBe("issue-completed");
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    const resume = states.subscribe([issue], vi.fn());
    expect(states.get(issue)).toBe("issue-completed");
    await vi.advanceTimersByTimeAsync(hour - 1);
    expect(read).toHaveBeenCalledTimes(2);
    resume();
  });

  it("keeps a newer personal reading while refreshing until a newer workspace reading arrives", async () => {
    vi.useFakeTimers();
    const shared = new Y.Doc();
    writeGitHubItemObservation(shared, githubItemKey(issue), { state: "issue-completed", seenAt: Date.now() - hour, isPublic: true });
    let answer!: (reading: GitHubItemStateReadings) => void;
    const read = vi.fn().mockResolvedValueOnce({ states: { [githubItemKey(issue)]: "issue-open" } })
      .mockImplementationOnce(() => new Promise<GitHubItemStateReadings>((resolve) => { answer = resolve; }));
    const states = createGitHubItemStates(read, shared);
    const changed = vi.fn(() => states.get(issue));
    const stop = states.subscribe([issue], changed);
    await vi.advanceTimersByTimeAsync(fiveMinutes - 60_000);
    const stopComment = states.subscribe([issue], vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(states.get(issue)).toBe("issue-open");
    expect(states.seenAt?.(issue)).toBeNull();
    expect(changed.mock.results.map(result => result.value)).toEqual(["issue-open"]);
    const seenAt = Date.now();
    writeGitHubItemObservation(shared, githubItemKey(issue), { state: "issue-not-planned", seenAt, isPublic: true });
    expect(states.get(issue)).toBe("issue-not-planned");
    expect(states.seenAt?.(issue)).toBe(seenAt);
    answer({ states: {} });
    await Promise.resolve();
    expect(states.get(issue)).toBe("issue-not-planned");
    stop();
    stopComment();
    shared.destroy();
  });

  it("refreshes terminal states after an hour and does not extend them on an open-item batch", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({ states: { [githubItemKey(issue)]: "issue-completed" as const, [githubItemKey(pull)]: "pull-open" as const } }));
    const states = createGitHubItemStates(read);
    const stopIssue = states.subscribe([issue], vi.fn());
    const stopPull = states.subscribe([pull], vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    expect(read).toHaveBeenCalledTimes(2);
    stopPull();
    await vi.advanceTimersByTimeAsync(hour - fiveMinutes - 1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    stopIssue();
  });

  it("silently changes a failed refresh to unknown and retries at the open interval", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ states: { [githubItemKey(issue)]: "issue-open" } })
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ states: {} });
    const states = createGitHubItemStates(read);
    const stop = states.subscribe([issue], vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    expect(states.get(issue)).toBeNull();
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    expect(read).toHaveBeenCalledTimes(3);
    stop();
  });

  it("uses the server cache's remaining lifetime rather than restarting its full TTL", async () => {
    vi.useFakeTimers();
    const shared = new Y.Doc();
    const seenAt = Date.now() - fiveMinutes;
    writeGitHubItemObservation(shared, githubItemKey(issue), { state: "issue-not-planned", seenAt, isPublic: true });
    const read = vi.fn().mockResolvedValueOnce({
      states: { [githubItemKey(issue)]: "issue-completed" as const },
      refreshAfterMs: { [githubItemKey(issue)]: 1000 },
    }).mockImplementationOnce(() => new Promise<GitHubItemStateReadings>(() => {}));
    const states = createGitHubItemStates(read, shared);
    const stop = states.subscribe([issue], vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(states.get(issue)).toBe("issue-completed");
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(states.get(issue)).toBe("issue-not-planned");
    expect(states.seenAt?.(issue)).toBe(seenAt);
    stop();
    shared.destroy();
  });

  it("honors a server cooldown even when the reading is unknown", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({
      states: { [githubItemKey(issue)]: null },
      refreshAfterMs: { [githubItemKey(issue)]: hour },
    }));
    const states = createGitHubItemStates(read);
    const stop = states.subscribe([issue], vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(hour - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("aborts the last reader's request and ignores a late answer after navigation", async () => {
    vi.useFakeTimers();
    let answer!: (states: GitHubItemStateReadings) => void;
    const read = vi.fn((_items: readonly GitHubItem[], _signal: AbortSignal) =>
      new Promise<GitHubItemStateReadings>((resolve) => { answer = resolve; }));
    const states = createGitHubItemStates(read);
    const changed = vi.fn();
    const stop = states.subscribe([issue], changed);
    const stopEmpty = states.subscribe([], vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const signal = read.mock.calls[0]?.[1];
    stop();
    expect(signal?.aborted).toBe(true);
    answer({ states: { [githubItemKey(issue)]: "issue-open" } });
    await Promise.resolve();
    expect(states.get(issue)).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stopEmpty();
  });
});

describe("ub open GitHub state client", () => {
  it("asks its own authenticated server once for the whole batch", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ states: {
      [githubItemKey(issue)]: "issue-duplicate", [githubItemKey(pull)]: "pull-merged",
    }, refreshAfterMs: { [githubItemKey(issue)]: hour, [githubItemKey(pull)]: 12345 } }));
    const read = createGitHubItemStateClient("workspace", "reader", fetchImpl as typeof fetch);
    const signal = new AbortController().signal;
    await expect(read([issue, pull], signal)).resolves.toEqual({ states: {
      [githubItemKey(issue)]: "issue-duplicate", [githubItemKey(pull)]: "pull-merged",
    }, refreshAfterMs: { [githubItemKey(issue)]: hour, [githubItemKey(pull)]: 12345 } });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("/api/github-item-states", {
      method: "POST", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        Authorization: "Bearer browser-bearer", "X-Uberblick-Session": "browser-session",
      },
      body: JSON.stringify({ items: [issue, pull] }),
    });
    expect(mintHubAuthMessage).toHaveBeenCalledWith("workspace", "reader");
  });

  it("bounds a stalled local response and releases the page for another refresh", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }));
    const read = createGitHubItemStateClient("workspace", "reader", fetchImpl as typeof fetch);
    const states = createGitHubItemStates(read);
    const stop = states.subscribe([issue], vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(states.get(issue)).toBeNull();
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    stop();
  });

  it("treats absent, malformed, inaccessible and non-JSON routes as unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("<!doctype html>"))
      .mockResolvedValueOnce(Response.json({ states: [] }))
      .mockResolvedValueOnce(Response.json({ states: { [githubItemKey(issue)]: "pull-open" } }))
      .mockRejectedValueOnce(new Error("offline"));
    const read = createGitHubItemStateClient("workspace", "reader", fetchImpl as typeof fetch);
    for (let index = 0; index < 5; index += 1) {
      const result = await read([issue], new AbortController().signal);
      expect(result.states[githubItemKey(issue)] ?? null).toBeNull();
    }
  });
});
