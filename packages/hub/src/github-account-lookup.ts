/** Unauthenticated public identity lookup, never an authorization source. */
import { isGithubAccountId, isGithubUsername } from "./github-identity.js";

type AccountTarget = { githubUsername: string } | { githubAccountId: string };
type AccountLookup =
  | { status: "ok"; githubAccountId: string; githubUsername: string }
  | { status: "account-not-found" | "lookup-unavailable" };

export class GithubAccountLookup {
  private readonly closed = new AbortController();

  constructor(private readonly fetch: typeof globalThis.fetch = globalThis.fetch) {}

  stop(): void { this.closed.abort(); }

  async lookup(target: AccountTarget): Promise<AccountLookup> {
    try {
      const byId = "githubAccountId" in target;
      const value = byId ? target.githubAccountId : target.githubUsername;
      if (!(byId ? isGithubAccountId(value) : isGithubUsername(value))) throw new Error();
      const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(10_000)]);
      signal.throwIfAborted();
      const response = await this.fetch(`https://api.github.com/${byId ? "user" : "users"}/${encodeURIComponent(value)}`, {
        method: "GET", redirect: "error", signal,
        headers: { Accept: "application/json", "User-Agent": "Uberblick-Hub", "X-GitHub-Api-Version": "2026-03-10" },
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
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 65_536) throw new Error();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      signal.throwIfAborted();
      const identity: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (identity === null || typeof identity !== "object" || Array.isArray(identity)) throw new Error();
      const { id, login, type } = identity as Record<string, unknown>;
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
