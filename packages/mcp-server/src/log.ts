/**
 * Write diagnostics only to stderr; stdout belongs exclusively to MCP frames.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { fileURLToPath } from "node:url";

export type LogLevel = "debug" | "info" | "warn" | "error";

let sourceMap: SourceMap | null | undefined;
const disabledLogging = new AsyncLocalStorage<boolean>();

/** Keep an embedded caller's diagnostics quiet without affecting other callers. */
export function withLoggingDisabled<T>(run: () => T): T {
  return disabledLogging.run(true, run);
}

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
 * Use console.error so Vitest attributes stderr to its test and hides passing
 * tests' logs; raw stderr writes bypass that attribution.
 */
export function logAt(level: LogLevel, message: string, detail?: unknown): void {
  if (disabledLogging.getStore()) return;
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
