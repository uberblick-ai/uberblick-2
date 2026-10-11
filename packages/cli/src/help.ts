import type { Io } from "./io.js";

/** Bare `--` ends the scan; literal option values can use `--option=-h`. */
function helpWanted(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

/**
 * Call before validation or side effects and return 0 when it prints to stdout.
 * The scan does not parse option values.
 */
export function takeHelp(argv: readonly string[], io: Io, text: string): boolean {
  if (!helpWanted(argv)) return false;
  io.out(text);
  return true;
}
