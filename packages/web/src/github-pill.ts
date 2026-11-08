import type { GitHubItem, GitHubItemState } from "@uberblick/schema";
import { formatTimestamp } from "./ui/timestamps.js";

const ISSUE_RING = "M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13";
const PULL_BRANCH = "M4 5v6M4 2a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M4 11a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M12 11a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3";
const PULL_OPEN = `${PULL_BRANCH}M12 11V6a3 3 0 0 0-3-3H8M10 1L8 3l2 2`;
const STATE_NAMES: Record<GitHubItemState, string> = {
  "issue-open": "Open",
  "issue-completed": "Closed as completed",
  "issue-not-planned": "Closed as not planned",
  "issue-duplicate": "Closed as duplicate",
  "pull-open": "Open",
  "pull-draft": "Draft",
  "pull-merged": "Merged",
  "pull-closed": "Closed without merging",
};

function iconPath(item: GitHubItem, state: GitHubItemState | null): string {
  switch (state) {
    case "issue-completed": return `${ISSUE_RING}M4.75 8l2 2 4.5-4.5`;
    case "issue-not-planned":
    case "issue-duplicate": return `${ISSUE_RING}M3.5 12.5l9-9`;
    case "pull-draft": return `${PULL_BRANCH}M12 2a.5.5 0 1 0 0 1a.5.5 0 0 0 0-1M12 6a.5.5 0 1 0 0 1a.5.5 0 0 0 0-1`;
    case "pull-merged": return "M4 5v6M4 2a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M4 11a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M12 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M5.5 4.5A5 5 0 0 0 10.5 8";
    case "pull-closed": return `${PULL_BRANCH}M12 11V7M10 1l4 4M14 1l-4 4`;
    default: return item.kind === "issue" ? ISSUE_RING : PULL_OPEN;
  }
}

export function githubLinkNamesItem(text: string, href: string, item: GitHubItem): boolean {
  if (text === href) return true;
  const match = /^(?:(?:([^/\s#]+)\/)?([^/\s#]+))?#([0-9]+)$/.exec(text);
  if (match === null) return false;
  const [, owner, repo, number] = match;
  return (
    number?.replace(/^0+(?=\d)/, "") === item.number &&
    (owner === undefined || owner.toLowerCase() === item.owner.toLowerCase()) &&
    (repo === undefined || repo.toLowerCase() === item.repo.toLowerCase())
  );
}

export function githubPillPresentation(item: GitHubItem, mainRepository: string | null, state: GitHubItemState | null = null, seenAt: number | null = null) {
  const age = seenAt === null ? null : formatTimestamp(seenAt, Date.now(), true)?.label ?? null;
  return {
    label: `${item.kind === "issue" ? "Issue" : "Pull request"} ${item.owner}/${item.repo}#${item.numberText} · ${state === null ? "State unknown" : STATE_NAMES[state]}${age === null ? "" : ` · seen ${age}`}`,
    state: state ?? "unknown",
    visibleRepo: `${item.owner}/${item.repo}`.toLowerCase() === mainRepository?.toLowerCase() ? null : item.repo,
    number: `#${item.numberText}`,
    path: iconPath(item, state),
    issueDot: item.kind === "issue" && (state === null || state === "issue-open"),
  };
}
