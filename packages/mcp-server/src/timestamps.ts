/** MCP timestamps omit unknown or unrepresentable directory stamps. */
export function isoTimestamp(stamp: number | undefined): string | undefined {
  if (stamp === undefined) return undefined;
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
