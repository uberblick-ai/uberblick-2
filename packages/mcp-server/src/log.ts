/**
 * Stderr-only logging for the MCP stdio server.
 *
 * stdout is the JSON-RPC transport: every byte written there is parsed as a
 * protocol frame, so a single stray `console.log` corrupts the session and the
 * client drops the connection. Nothing in this package may write to stdout
 * except the MCP transport itself — use these helpers instead.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return detail.stack ?? `${detail.name}: ${detail.message}`;
  }
  if (typeof detail === "string") {
    return detail;
  }
  try {
    return JSON.stringify(detail) ?? String(detail);
  } catch {
    return String(detail);
  }
}

/** Write one line to stderr. Never touches stdout. */
export function logAt(level: LogLevel, message: string, detail?: unknown): void {
  const head = `${new Date().toISOString()} ${level.toUpperCase()} uberblick/mcp-server ${message}`;
  const line = detail === undefined ? head : `${head} ${formatDetail(detail)}`;
  process.stderr.write(`${line}\n`);
}

export const log = {
  debug: (message: string, detail?: unknown) => logAt("debug", message, detail),
  info: (message: string, detail?: unknown) => logAt("info", message, detail),
  warn: (message: string, detail?: unknown) => logAt("warn", message, detail),
  error: (message: string, detail?: unknown) => logAt("error", message, detail),
} as const;
