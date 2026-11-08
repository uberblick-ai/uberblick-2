import { githubItemKey, isGitHubItemState } from "@uberblick/schema";
import type { GitHubItem, GitHubItemState } from "@uberblick/schema";
import { mintHubAuthMessage } from "../collab/rooms.js";
import { localSessionHeaders } from "../collab/local-session.js";

export interface GitHubItemStateReadings {
  states: Readonly<Record<string, GitHubItemState | null>>;
  refreshAfterMs?: Readonly<Record<string, number>>;
}

export type GitHubItemStateReader = (
  items: readonly GitHubItem[], signal: AbortSignal,
) => Promise<GitHubItemStateReadings>;

/** Only ub open receives this request; GitHub credentials stay on its server. */
export function createGitHubItemStateClient(
  workspace: string,
  subject: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): GitHubItemStateReader {
  return async (items, signal) => {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const states: Record<string, GitHubItemState | null> = {};
    const refreshAfterMs: Record<string, number> = {};
    try {
      const authorization = await mintHubAuthMessage(workspace, subject);
      const sessionHeaders = await localSessionHeaders();
      requestSignal.throwIfAborted();
      const response = await fetchImpl("/api/github-item-states", {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${authorization}`,
          ...sessionHeaders,
        },
        body: JSON.stringify({ items }),
        signal: requestSignal,
      });
      const body: unknown = response.ok ? await response.json() : null;
      const answer = typeof body === "object" && body !== null && "states" in body ? body.states : null;
      const refresh = typeof body === "object" && body !== null && "refreshAfterMs" in body ? body.refreshAfterMs : null;
      if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
        for (const item of items) {
          const key = githubItemKey(item);
          const state: unknown = Object.hasOwn(answer, key) ? (answer as Record<string, unknown>)[key] : null;
          states[key] = isGitHubItemState(state) &&
            state.startsWith(item.kind === "issue" ? "issue-" : "pull-") ? state : null;
          const remaining: unknown = typeof refresh === "object" && refresh !== null && Object.hasOwn(refresh, key)
            ? (refresh as Record<string, unknown>)[key] : null;
          if (typeof remaining === "number" && Number.isFinite(remaining) && remaining > 0) refreshAfterMs[key] = remaining;
        }
      }
    } catch {
      // Missing routes, sessions and network answers all leave the state unknown.
    }
    return { states, refreshAfterMs };
  };
}
