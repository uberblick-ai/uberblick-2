export function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A `ub status` or `ub mcp install` report line. */
export function field(name: string, value: string): string {
  return `${name.padEnd(12)}${value}\n`;
}

/** Whole largest units, or just now under five seconds. */
export function timeAgo(time: string): string {
  const seconds = Math.floor((Date.now() - Date.parse(time)) / 1_000);
  if (seconds < 5) return "just now";
  for (const [unit, duration] of [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const) {
    if (seconds >= duration) return `${plural(Math.floor(seconds / duration), unit)} ago`;
  }
  return `${plural(seconds, "second")} ago`;
}
