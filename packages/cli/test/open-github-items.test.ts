import type { GitHubItem, GitHubItemState } from "@uberblick/schema";
import { githubItemKey } from "@uberblick/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubItemStateLookup, readGitHubToken } from "../src/open-github-items.js";

const childProcess = vi.hoisted(() => ({ runFile: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: childProcess.runFile }),
}));

const MINUTE = 60_000;
const lookups: ReturnType<typeof createGitHubItemStateLookup>[] = [];

function item(number: number, kind: GitHubItem["kind"] = "issue"): GitHubItem {
  return { owner: "reader", repo: "private-repo", number: String(number), numberText: String(number), kind };
}

function issue(state = "OPEN", stateReason: string | null = null) {
  return { __typename: "Issue", state, stateReason };
}

function pull(state = "OPEN", isDraft = false, merged = false) {
  return { __typename: "PullRequest", state, isDraft, merged };
}

function answer(items: readonly (ReturnType<typeof issue> | ReturnType<typeof pull> | null)[], errors?: unknown[]) {
  return Response.json({
    data: Object.fromEntries(items.map((value, index) => [`r${index}`, value === null ? null : { item: value }])),
    ...(errors === undefined ? {} : { errors }),
  });
}

function lookup(options: Parameters<typeof createGitHubItemStateLookup>[1] = {}) {
  const value = createGitHubItemStateLookup({ GH_TOKEN: "github-private-fixture-token" }, options);
  lookups.push(value);
  return value;
}

beforeEach(() => {
  childProcess.runFile.mockReset();
});

afterEach(async () => {
  await Promise.all(lookups.splice(0).map((value) => value.stop()));
  vi.restoreAllMocks();
});

describe("ub open GitHub item states", () => {
  it("reads every supported issue and pull state in one private authenticated batch", async () => {
    const items = [item(1), item(2), item(3), item(4), item(5), item(6, "pull-request"),
      item(7, "pull-request"), item(8, "pull-request"), item(9, "pull-request")];
    const states: GitHubItemState[] = ["issue-open", "issue-completed", "issue-not-planned", "issue-duplicate",
      "issue-completed", "pull-open", "pull-draft", "pull-merged", "pull-closed"];
    const fetchImpl = vi.fn<typeof fetch>(async () => answer([
      issue(), issue("CLOSED", "COMPLETED"), issue("CLOSED", "NOT_PLANNED"), issue("CLOSED", "DUPLICATE"),
      issue("CLOSED"), pull(), pull("OPEN", true), pull("MERGED", false, true), pull("CLOSED"),
    ]));
    const value = lookup({ fetchImpl });

    const result = await value.read([...items, items[0] as GitHubItem]);

    expect(result.states).toEqual(Object.fromEntries(items.map((entry, index) => [githubItemKey(entry), states[index]])));
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/graphql");
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer github-private-fixture-token");
    expect(String(options?.body).match(/issueOrPullRequest/g)).toHaveLength(items.length);
    expect(JSON.stringify(result)).not.toContain("github-private-fixture-token");
  });

  it("keeps inaccessible, missing and mismatched kinds unknown without losing other aliases", async () => {
    const items = [item(1), item(2), item(3), item(4, "pull-request"), item(5)];
    const fetchImpl = vi.fn<typeof fetch>(async () => answer([
      issue("CLOSED", "COMPLETED"), null, pull(), issue(), issue("CLOSED", "DUPLICATE"),
    ], [{ message: "Could not resolve to a Repository", path: ["r1"] }]));

    expect((await lookup({ fetchImpl }).read(items)).states).toEqual({
      [githubItemKey(items[0] as GitHubItem)]: "issue-completed",
      [githubItemKey(items[1] as GitHubItem)]: null,
      [githubItemKey(items[2] as GitHubItem)]: null,
      [githubItemKey(items[3] as GitHubItem)]: null,
      [githubItemKey(items[4] as GitHubItem)]: "issue-duplicate",
    });
  });

  it("keeps a page with many references to one request and isolates out-of-range item numbers", async () => {
    const items = Array.from({ length: 1_000 }, (_, index) => item(index + 1));
    const enormous = { ...item(1), number: "999999999999999999999999999999", numberText: "999999999999999999999999999999" };
    const fetchImpl = vi.fn<typeof fetch>(async () => answer(items.map(() => issue())));

    const result = await lookup({ fetchImpl }).read([...items, enormous]);

    expect(Object.values(result.states).filter(state => state === "issue-open")).toHaveLength(1_000);
    expect(result.states[githubItemKey(enormous)]).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body).match(/issueOrPullRequest/g)).toHaveLength(1_000);
  });

  it("deduplicates an overlapping refresh while its GitHub request is in flight", async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve; }));
    const value = lookup({ fetchImpl });
    const entry = item(1);
    const first = value.read([entry]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const second = value.read([entry]);
    finish?.(answer([issue()]));

    expect((await first).states).toEqual({ [githubItemKey(entry)]: "issue-open" });
    expect((await second).states).toEqual({ [githubItemKey(entry)]: "issue-open" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refreshes open and draft items after five minutes and keeps closed items for an hour", async () => {
    let now = 10_000;
    const open = item(1);
    const closed = item(2);
    const draft = item(3, "pull-request");
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(answer([issue(), issue("CLOSED", "COMPLETED"), pull("OPEN", true)]))
      .mockResolvedValueOnce(answer([issue("CLOSED", "NOT_PLANNED"), pull()]))
      .mockResolvedValueOnce(answer([issue("CLOSED", "DUPLICATE")]));
    const value = lookup({ fetchImpl, now: () => now });
    await value.read([open, closed, draft]);
    now += 5 * MINUTE - 1;
    const cached = await value.read([open, closed, draft]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cached.refreshAfterMs[githubItemKey(open)]).toBeLessThan(5 * MINUTE);
    expect(cached.refreshAfterMs[githubItemKey(closed)]).toBe(55 * MINUTE + 1);
    now += 1;
    await value.read([closed]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await value.read([open, draft])).states).toEqual({
      [githubItemKey(open)]: "issue-not-planned", [githubItemKey(draft)]: "pull-open",
    });
    now = 10_000 + 60 * MINUTE;
    expect((await value.read([closed])).states).toEqual({ [githubItemKey(closed)]: "issue-duplicate" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not call GitHub without a login and quietly contains malformed and failed responses", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const entry = item(1);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("github-private-fixture-token: network failure"))
      .mockResolvedValueOnce(new Response("<html>offline</html>"))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.test" } }));
    const noLogin = lookup({ fetchImpl, credential: async () => null });
    expect((await noLogin.read([entry])).states).toEqual({ [githubItemKey(entry)]: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await lookup({ fetchImpl }).read([entry])).states).toEqual({ [githubItemKey(entry)]: null });
    }
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it("retries an unknown answer after five minutes and discards cached state when the login changes", async () => {
    let now = 10_000;
    let token = "first-reader-token";
    const entry = item(1);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(answer([issue()]))
      .mockResolvedValueOnce(answer([null]));
    const value = lookup({ fetchImpl, now: () => now, credential: async () => token });
    expect((await value.read([entry])).states[githubItemKey(entry)]).toBeNull();
    now += 5 * MINUTE - 1;
    expect((await value.read([entry])).states[githubItemKey(entry)]).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    now += 1;
    expect((await value.read([entry])).states[githubItemKey(entry)]).toBe("issue-open");
    token = "second-reader-token";
    expect((await value.read([entry])).states[githubItemKey(entry)]).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get("authorization")).toBe("Bearer second-reader-token");
  });

  it("backs off the shared login on rate limiting, including for a newly seen item", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 60 * MINUTE) / 1_000) } }))
      .mockResolvedValueOnce(answer([issue()]));
    const value = lookup({ fetchImpl, now: () => now });
    await value.read([item(1)]);
    expect((await value.read([item(2)])).states).toEqual({ [githubItemKey(item(2))]: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
    now += 5 * MINUTE;
    const limited = await value.read([item(1)]);
    expect(limited.refreshAfterMs[githubItemKey(item(1))]).toBeGreaterThanOrEqual(55 * MINUTE);
    expect(fetchImpl).toHaveBeenCalledOnce();
    now += 55 * MINUTE;
    expect((await value.read([item(2)])).states).toEqual({ [githubItemKey(item(2))]: "issue-open" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts and awaits the outbound work on shutdown and never restarts it", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, options) => new Promise((_resolve, reject) => {
      signal = options?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
    }));
    const value = lookup({ fetchImpl });
    const entry = item(1);
    const pending = value.read([entry]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    await value.stop();

    expect(signal?.aborted).toBe(true);
    expect((await pending).states).toEqual({ [githubItemKey(entry)]: null });
    await value.read([item(2)]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("bounds a stalled GitHub request without requiring shutdown", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, options) => new Promise((_resolve, reject) => {
      signal = options?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
    }));
    const entry = item(1);

    expect((await lookup({ fetchImpl }).read([entry])).states[githubItemKey(entry)]).toBeNull();

    expect(signal?.aborted).toBe(true);
  });
});

describe("GitHub credential lookup", () => {
  it("prefers GH_TOKEN, then GITHUB_TOKEN, before consulting the stored login", async () => {
    const signal = new AbortController().signal;
    await expect(readGitHubToken({ GH_TOKEN: "first-token", GITHUB_TOKEN: "second-token" }, signal)).resolves.toBe("first-token");
    await expect(readGitHubToken({ GITHUB_TOKEN: "second-token" }, signal)).resolves.toBe("second-token");
    expect(childProcess.runFile).not.toHaveBeenCalled();
  });

  it("pins the bounded stored-token lookup to github.com and keeps all subprocess output private", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const signal = new AbortController().signal;
    const env = { GH_HOST: "enterprise.example", PATH: "/fixture/path" };
    childProcess.runFile.mockResolvedValueOnce({ stdout: "stored-fixture-token\n", stderr: "private diagnostics" })
      .mockRejectedValueOnce(Object.assign(new Error("stored-fixture-token"), {
        stdout: "stored-fixture-token", stderr: "private diagnostics",
      }));

    await expect(readGitHubToken(env, signal)).resolves.toBe("stored-fixture-token");
    expect(childProcess.runFile).toHaveBeenCalledWith("gh", ["auth", "token", "--hostname", "github.com"],
      expect.objectContaining({ env, signal, encoding: "utf8", timeout: expect.any(Number),
        maxBuffer: expect.any(Number), killSignal: "SIGKILL" }));
    const options = childProcess.runFile.mock.calls[0]?.[2];
    expect(options.timeout).toBeLessThanOrEqual(1_000);
    expect(options.maxBuffer).toBeLessThanOrEqual(16_384);
    await expect(readGitHubToken(env, signal)).resolves.toBeNull();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
