import type { GitHubItem } from "@uberblick/schema";

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

export function githubPillPresentation(item: GitHubItem, mainRepository: string | null) {
  return {
    label: `${item.kind === "issue" ? "Issue" : "Pull request"} ${item.owner}/${item.repo}#${item.numberText}`,
    visibleRepo: `${item.owner}/${item.repo}`.toLowerCase() === mainRepository?.toLowerCase() ? null : item.repo,
    number: `#${item.numberText}`,
    path: item.kind === "issue"
      ? "M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13"
      : "M4 5v6M4 2a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M4 11a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M12 11a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3M12 11V6a3 3 0 0 0-3-3H8M10 1L8 3l2 2",
    issueDot: item.kind === "issue",
  };
}
