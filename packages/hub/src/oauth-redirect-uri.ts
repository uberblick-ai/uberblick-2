function redirectMatchKey(uri: string): string | null {
  if (/[\\#]/.test(uri) ||
    [...uri].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) return null;
  const raw = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(uri);
  if (raw === null) return null;
  const [, scheme = "", authority = "", suffix = ""] = raw;
  if (authority.includes("@")) return null;
  let parsed: URL;
  try { parsed = new URL(uri); } catch { return null; }
  if (parsed.protocol === "https:") return uri;
  if (parsed.protocol !== "http:") return null;
  if (/^localhost(?::\d+)?$/i.test(authority)) return uri;
  const loopback = /^(127\.0\.0\.1|\[::1\])(?::\d+)?$/.exec(authority);
  if (loopback === null) return null;
  // Preserve every byte except the IP-loopback port; URL would normalize more.
  return `${scheme}://${loopback[1]}${suffix}`;
}

/** The two IP-loopback literals alone permit an ephemeral callback port. */
export function oauthRedirectUriAllowed(uri: string, registered: readonly string[]): boolean {
  const key = redirectMatchKey(uri);
  return key !== null && registered.some(entry => redirectMatchKey(entry) === key);
}
