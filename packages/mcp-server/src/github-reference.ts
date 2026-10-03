/**
 * One GitHub issue or pull request, identified by owner, repository and number.
 * Both GitHub routes name the same key; no API or default repository is needed.
 */
export function githubReference(value: string): string | null {
  const input = value.trim();
  let match = /^([a-z0-9-]+)\/([a-z0-9_.-]+)#([0-9]+)$/i.exec(input);
  if (match === null) {
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
    match = /^\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/(?:issues|pull)\/([0-9]+)(?:\/|$)/i.exec(
      url.pathname,
    );
  }
  if (match === null) return null;
  const [, owner, repo, digits] = match;
  if (owner === undefined || repo === undefined || digits === undefined) return null;
  // Keep decimal identity as text, including beyond JavaScript's safe integer
  // range. Leading zeroes are another spelling, while zero names no item.
  const number = digits.replace(/^0+/, "");
  if (number === "" || repo === "." || repo === "..") return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}
