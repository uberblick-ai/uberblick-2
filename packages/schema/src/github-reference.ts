export interface GitHubItem {
  owner: string;
  repo: string;
  number: string;
  numberText: string;
  kind: "issue" | "pull-request";
}

/** GitHub item URLs, with their spelling preserved for display. */
export function githubItemUrl(value: string): GitHubItem | null {
  const input = value.trim();
  if (!/^https?:\/\/\S+$/i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.host !== "github.com" || url.username !== "" || url.password !== "") {
    return null;
  }
  const match = /^\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/(issues|pull)\/([0-9]+)(?:\/|$)/i.exec(
    url.pathname,
  );
  if (match === null) return null;
  const [, owner, repo, route, digits] = match;
  if (owner === undefined || repo === undefined || route === undefined || digits === undefined) {
    return null;
  }
  const number = itemNumber(digits);
  if (number === null || repo === "." || repo === "..") return null;
  return { owner, repo, number, numberText: digits, kind: route.toLowerCase() === "issues" ? "issue" : "pull-request" };
}

/** Both GitHub routes identify the same reference, without an API or default repository. */
export function githubReference(value: string): string | null {
  const input = value.trim();
  const match = /^([a-z0-9-]+)\/([a-z0-9_.-]+)#([0-9]+)$/i.exec(input);
  if (match !== null) {
    const [, owner, repo, digits] = match;
    if (owner === undefined || repo === undefined || digits === undefined) return null;
    const number = itemNumber(digits);
    if (number === null || repo === "." || repo === "..") return null;
    return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  }
  const item = githubItemUrl(input);
  return item === null ? null : `${item.owner.toLowerCase()}/${item.repo.toLowerCase()}#${item.number}`;
}

function itemNumber(digits: string): string | null {
  // Decimal identity stays exact beyond JavaScript's safe integer range.
  const number = digits.replace(/^0+/, "");
  return number === "" ? null : number;
}
