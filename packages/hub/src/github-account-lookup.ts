/** Unauthenticated public identity lookup, never an authorization source. */
import { isGithubAccountId, isGithubUsername } from "@uberblick/schema/github-identity";
import { RequestBudget } from "./request-budget.js";
import { GITHUB_HEADERS, readGithubJson } from "./http.js";

type AccountTarget = { githubUsername: string } | { githubAccountId: string };
type AccountLookup =
  | { status: "ok"; githubAccountId: string; githubUsername: string }
  | { status: "account-not-found" | "lookup-unavailable" };

export class GithubAccountLookup {
  private readonly closed = new AbortController();
  private readonly budget: RequestBudget;

  constructor(private readonly fetch: typeof globalThis.fetch = globalThis.fetch, now: () => number = Date.now) {
    this.budget = new RequestBudget(12, 3_600_000, 60, now);
  }

  stop(): void { this.closed.abort(); }

  async lookup(target: AccountTarget, principalId: string, workspaceId: string): Promise<AccountLookup> {
    try {
      const byId = "githubAccountId" in target;
      const value = byId ? target.githubAccountId : target.githubUsername;
      if (!(byId ? isGithubAccountId(value) : isGithubUsername(value))) throw new Error();
      this.closed.signal.throwIfAborted();
      if (!this.budget.take(`account:${principalId}`, `workspace:${workspaceId}`)) return { status: "lookup-unavailable" };
      const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(10_000)]);
      const response = await this.fetch(`https://api.github.com/${byId ? "user" : "users"}/${encodeURIComponent(value)}`, {
        method: "GET", redirect: "error", signal, headers: GITHUB_HEADERS,
      });
      signal.throwIfAborted();
      if (response.redirected) {
        await response.body?.cancel();
        throw new Error();
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return { status: "account-not-found" };
      }
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel();
        throw new Error();
      }
      const { id, login, type } = await readGithubJson(response, signal);
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || !isGithubUsername(login) ||
        (byId ? String(id) !== value : login.toLowerCase() !== value.toLowerCase())) throw new Error();
      if (type === "Organization" || type === "Bot") return { status: "account-not-found" };
      if (type !== "User") throw new Error();
      return { status: "ok", githubAccountId: String(id), githubUsername: login };
    } catch {
      // Neither provider response bodies nor exceptions cross the boundary.
      return { status: "lookup-unavailable" };
    }
  }
}
