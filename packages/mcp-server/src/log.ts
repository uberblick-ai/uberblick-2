/**
 * Stderr-only logging for the MCP stdio server.
 *
 * stdout is the JSON-RPC transport: every byte written there is parsed as a
 * protocol frame, so a single stray `console.log` corrupts the session and the
 * client drops the connection. Nothing in this package may write to stdout
 * except the MCP transport itself — use these helpers instead.
 */

import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { fileURLToPath } from "node:url";

export type LogLevel = "debug" | "info" | "warn" | "error";

let sourceMap: SourceMap | null | undefined;

/** Map only logged frames in the installed bundle, paying nothing until an error. */
function loggedStack(stack: string): string {
  const bundleUrl = import.meta.url;
  if (!bundleUrl.endsWith("/mcp.mjs")) return stack;

  try {
    const locations = [bundleUrl, fileURLToPath(bundleUrl)]
      .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    // V8's named, anonymous and async frames, restricted to this exact file.
    const frame = new RegExp(`^(\\s+at (?:.*[ (])?)(?:${locations}):(\\d+):(\\d+)(\\)?)$`, "gm");
    return stack.replace(frame, (original, head: string, line: string, column: string, tail: string) => {
      if (sourceMap === undefined) {
        sourceMap = new SourceMap(JSON.parse(readFileSync(new URL(`${bundleUrl}.map`), "utf8")));
      }
      const origin = sourceMap?.findOrigin(Number(line), Number(column));
      if (origin === undefined || !("fileName" in origin)) return original;
      return `${head}${origin.fileName}:${origin.lineNumber}:${origin.columnNumber}${tail}`;
    });
  } catch {
    // Missing, unreadable or invalid maps must never hide the original error.
    sourceMap = null;
    return stack;
  }
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return detail.stack === undefined ? `${detail.name}: ${detail.message}` : loggedStack(detail.stack);
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

/**
 * Write one line to stderr. Never touches stdout.
 *
 * Through `console.error` rather than `process.stderr.write`: both reach the
 * same stderr, but only the console is attributed to a test by Vitest, which
 * then prints a test's log only when that test fails. Raw writes landed in the
 * run's output for every passing test, unattributed.
 */
export function logAt(level: LogLevel, message: string, detail?: unknown): void {
  const head = `${new Date().toISOString()} ${level.toUpperCase()} uberblick/mcp-server ${message}`;
  const line = detail === undefined ? head : `${head} ${formatDetail(detail)}`;
  // biome-ignore lint/suspicious/noConsole: the one sanctioned write; stderr, never stdout.
  console.error(line);
}

export const log = {
  debug: (message: string, detail?: unknown) => logAt("debug", message, detail),
  info: (message: string, detail?: unknown) => logAt("info", message, detail),
  warn: (message: string, detail?: unknown) => logAt("warn", message, detail),
  error: (message: string, detail?: unknown) => logAt("error", message, detail),
} as const;
