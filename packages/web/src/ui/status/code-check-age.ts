const DAY = 24 * 60 * 60 * 1_000;

/** Only checks older than the fixed re-check threshold need a freshness hint. */
export function staleCodeCheckAgeDays(checkedAt: string, now: number): number | null {
  const age = now - Date.parse(checkedAt);
  return age > 14 * DAY ? Math.floor(age / DAY) : null;
}
