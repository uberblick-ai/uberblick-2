/** One conservative local boundary for both bind addresses and endpoints. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost") return true;
  if (normalized.includes(":")) {
    try { return new URL(`http://[${normalized}]`).hostname === "[::1]"; }
    catch { return false; }
  }
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" &&
    octets.every(octet => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}
