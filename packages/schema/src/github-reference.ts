export interface GitHubItem {
  owner: string;
  repo: string;
  number: string;
  numberText: string;
  kind: "issue" | "pull-request";
}

/** GitHub repository identity from a reference, web address or origin address. */
export function githubRepository(value: string): string | null {
  const input = value.trim();
  if (/\s/.test(input)) return null;
  let path = input;
  const scp = /^git@github\.com:(.+)$/i.exec(input);
  if (scp?.[1] !== undefined) {
    path = scp[1];
  } else if (input.includes("://")) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (
      url.host.toLowerCase() !== "github.com" || url.search !== "" || url.hash !== "" ||
      url.password !== "" ||
      !((url.protocol === "https:" || url.protocol === "http:") && url.username === "" ||
        url.protocol === "ssh:" && url.username === "git")
    ) return null;
    // Check the original path too: URL parsing can remove dot segments.
    const rawPath = /^[a-z]+:\/\/[^/]+(\/[^?#]*)$/i.exec(input)?.[1];
    if (rawPath !== url.pathname) return null;
    path = url.pathname.slice(1);
  }
  const match = /^([a-z0-9-]+)\/([a-z0-9_.-]+)\/?$/i.exec(path);
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2]?.replace(/\.git$/i, "");
  if (owner === undefined || repo === undefined || repo === "" || repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
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
