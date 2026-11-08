import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { githubItemKey, githubItemStateTtl, githubItemUrl, type GitHubItem, type GitHubItemState } from "@uberblick/schema";
import { readJsonObject } from "./open-access.js";

const runFile = promisify(execFile);
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CACHE_ITEMS = 20_000;

export interface GitHubItemStateLookup {
  read(items: readonly GitHubItem[]): Promise<GitHubItemStateReading>;
  stop(): Promise<void>;
}

export interface GitHubItemStateReading {
  states: Record<string, GitHubItemState | null>;
  refreshAfterMs: Record<string, number>;
}

function unknownReading(items: readonly GitHubItem[]): GitHubItemStateReading {
  return {
    states: Object.fromEntries(items.map(item => [githubItemKey(item), null])),
    refreshAfterMs: Object.fromEntries(items.map(item => [githubItemKey(item), githubItemStateTtl(null)])),
  };
}

export async function readGitHubToken(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | null> {
  const supplied = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (supplied) return supplied;
  try {
    const { stdout } = await runFile("gh", ["auth", "token", "--hostname", "github.com"], {
      env, signal, encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 16_384,
    });
    const token = stdout.trim();
    return token !== "" && !/\s/.test(token) ? token : null;
  } catch {
    // Subprocess output and errors may contain the credential; neither escapes.
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function readItem(value: unknown): GitHubItem | null {
  const fields = object(value);
  if (fields === null || typeof fields.owner !== "string" || typeof fields.repo !== "string" ||
    typeof fields.number !== "string" || (fields.kind !== "issue" && fields.kind !== "pull-request")) return null;
  const route = fields.kind === "issue" ? "issues" : "pull";
  const item = githubItemUrl(`https://github.com/${fields.owner}/${fields.repo}/${route}/${fields.number}`);
  return item !== null && item.owner === fields.owner && item.repo === fields.repo && item.number === fields.number
    ? item : null;
}

export async function readGitHubItems(request: IncomingMessage): Promise<GitHubItem[] | null> {
  const body = await readJsonObject(request, MAX_INPUT_BYTES);
  if (!Array.isArray(body?.items)) return null;
  const items = body.items.map(readItem);
  return items.some(item => item === null) ? null : items as GitHubItem[];
}

function stateOf(item: GitHubItem, value: unknown): GitHubItemState | null {
  const fields = object(value);
  if (fields === null) return null;
  if (item.kind === "issue" && fields.__typename === "Issue") {
    if (fields.state === "OPEN") return "issue-open";
    if (fields.state !== "CLOSED") return null;
    switch (fields.stateReason) {
      case null: case "COMPLETED": return "issue-completed";
      case "NOT_PLANNED": return "issue-not-planned";
      case "DUPLICATE": return "issue-duplicate";
      default: return null;
    }
  }
  if (item.kind !== "pull-request" || fields.__typename !== "PullRequest") return null;
  if (fields.merged === true || fields.state === "MERGED") return "pull-merged";
  if (fields.state === "CLOSED") return "pull-closed";
  return fields.state === "OPEN" && typeof fields.isDraft === "boolean"
    ? fields.isDraft ? "pull-draft" : "pull-open" : null;
}

function queryFor(items: readonly GitHubItem[]): string {
  return `query { ${items.map((item, index) =>
    `r${index}:repository(owner:${JSON.stringify(item.owner)},name:${JSON.stringify(item.repo)}) { item:issueOrPullRequest(number:${item.number}) { __typename ... on Issue { state stateReason } ... on PullRequest { state isDraft merged } } }`,
  ).join(" ")} }`;
}

function retryAt(response: Response, now: number): number {
  const after = response.headers.get("retry-after");
  const seconds = after === null ? NaN : Number(after);
  const date = after === null ? NaN : Date.parse(after);
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
  return Math.max(now + githubItemStateTtl(null),
    Number.isFinite(seconds) ? now + seconds * 1_000 : Number.isFinite(date) ? date : 0,
    Number.isFinite(reset) ? reset : 0);
}

interface LookupOptions {
  fetchImpl?: typeof globalThis.fetch;
  credential?: (signal: AbortSignal) => Promise<string | null>;
  now?: () => number;
}

/** One serving run, with no credential or state written to the workspace. */
export function createGitHubItemStateLookup(env: NodeJS.ProcessEnv, options: LookupOptions = {}): GitHubItemStateLookup {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const credential = options.credential ?? (signal => readGitHubToken(env, signal));
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  const cache = new Map<string, { state: GitHubItemState | null; until: number }>();
  let login: string | null = null;
  let blockedUntil = 0;
  let pending: Promise<unknown> = Promise.resolve();

  const refresh = async (items: readonly GitHubItem[], token: string): Promise<void> => {
    let data: Record<string, unknown> | null = null;
    try {
      const response = await fetchImpl(GITHUB_GRAPHQL, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: queryFor(items) }),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]),
      });
      if (response.status === 403 || response.status === 429) blockedUntil = retryAt(response, now());
      if (response.ok) {
        const body = object(await response.json());
        data = object(body?.data);
        if (Array.isArray(body?.errors) && body.errors.some(error => object(error)?.type === "RATE_LIMITED")) {
          blockedUntil = retryAt(response, now());
        }
      }
    } catch { /* Offline, slow or malformed answers are silent unknown readings. */ }
    for (const [index, item] of items.entries()) {
      const state = stateOf(item, object(data?.[`r${index}`])?.item);
      cache.set(githubItemKey(item), { state, until: now() + githubItemStateTtl(state) });
    }
    while (cache.size > MAX_CACHE_ITEMS) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      cache.delete(first);
    }
  };

  const read = async (items: readonly GitHubItem[]): Promise<GitHubItemStateReading> => {
    const unique = new Map(items.map(item => [githubItemKey(item), item]));
    const unknown = unknownReading(items);
    if (lifetime.signal.aborted || unique.size === 0) return unknown;
    const token = await credential(lifetime.signal);
    const identity = token === null ? null : createHash("sha256").update(token).digest("hex");
    if (identity !== login) { cache.clear(); login = identity; blockedUntil = 0; }
    if (token === null || lifetime.signal.aborted) return unknown;
    const due = [...unique.values()].filter(item => (cache.get(githubItemKey(item))?.until ?? 0) <= now());
    // GraphQL Int is signed 32-bit. One enormous number must not refuse the batch.
    const eligible = due.filter(item => BigInt(item.number) <= 2_147_483_647n);
    if (eligible.length > 0 && now() >= blockedUntil) await refresh(eligible, token);
    const keys = [...unique.keys()];
    return {
      states: Object.fromEntries(keys.map(key => {
        const entry = cache.get(key);
        return [key, entry !== undefined && entry.until > now() ? entry.state : null];
      })),
      refreshAfterMs: Object.fromEntries(keys.map(key => {
        const until = cache.get(key)?.until ?? 0;
        return [key, Math.max(1_000,
          (until > now() ? until : Math.max(blockedUntil, now() + githubItemStateTtl(null))) - now())];
      })),
    };
  };

  return {
    read(items) {
      // Concurrent tabs share cache fills and never multiply the same lookup.
      const result = pending.then(() => read(items)).catch(() => unknownReading(items));
      pending = result;
      return result;
    },
    async stop() { lifetime.abort(); await pending; cache.clear(); },
  };
}
