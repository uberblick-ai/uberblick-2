const REFUSED_APP_SCHEMES = new Set([
  "javascript:", "data:", "file:", "blob:", "about:", "vbscript:", "ftp:", "ws:", "wss:",
]);

function redirectMatchKey(uri: string): string | null {
  if (/[\\#]/.test(uri) ||
    [...uri].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) return null;
  const raw = /^([a-z][a-z\d+.-]*):(?:\/\/([^/?#]*))?(.*)$/i.exec(uri);
  if (raw === null) return null;
  const [, scheme = "", authority = "", suffix = ""] = raw;
  if (authority.includes("@")) return null;
  let parsed: URL;
  try { parsed = new URL(uri); } catch { return null; }
  if (parsed.protocol === "https:") return authority === "" ? null : uri;
  if (parsed.protocol !== "http:") return REFUSED_APP_SCHEMES.has(parsed.protocol) ? null : uri;
  if (/^localhost(?::\d+)?$/i.test(authority)) return uri;
  const loopback = /^(127\.0\.0\.1|\[::1\])(?::\d+)?$/.exec(authority);
  if (loopback === null) return null;
  // Preserve every byte except the IP-loopback port; URL would normalize more.
  return `${scheme}://${loopback[1]}${suffix}`;
}

export function oauthRedirectUriValid(uri: string): boolean {
  return redirectMatchKey(uri) !== null;
}

/** The two IP-loopback literals alone permit an ephemeral callback port. */
export function oauthRedirectUriAllowed(uri: string, registered: readonly string[]): boolean {
  const key = redirectMatchKey(uri);
  return key !== null && registered.some(entry => redirectMatchKey(entry) === key);
}
