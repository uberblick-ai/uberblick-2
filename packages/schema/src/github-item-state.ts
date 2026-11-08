import type { GitHubItem } from "./github-reference.js";

/** GitHub readings never belong to a document or its history. */
export type GitHubItemState =
  | "issue-open" | "issue-completed" | "issue-not-planned" | "issue-duplicate"
  | "pull-open" | "pull-draft" | "pull-merged" | "pull-closed";

export function githubItemKey(item: GitHubItem): string {
  return `${item.owner.toLowerCase()}/${item.repo.toLowerCase()}#${item.number}:${item.kind}`;
}

export function isGitHubItemState(value: unknown): value is GitHubItemState {
  return value === "issue-open" || value === "issue-completed" || value === "issue-not-planned" ||
    value === "issue-duplicate" || value === "pull-open" || value === "pull-draft" ||
    value === "pull-merged" || value === "pull-closed";
}

export function githubItemStateTtl(state: GitHubItemState | null): number {
  return state === null || state === "issue-open" || state === "pull-open" || state === "pull-draft"
    ? 5 * 60 * 1_000 : 60 * 60 * 1_000;
}
