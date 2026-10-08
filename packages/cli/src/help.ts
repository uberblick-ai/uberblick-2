/**
 * Contextual help, intercepted before anything else a command does.
 *
 * One helper, used by every dispatcher, because help is a contract of the whole
 * `ub` surface rather than a feature of the commands that happened to get it
 * first: `--help` and `-h` print that path's help on stdout and exit 0, from
 * anywhere among the command's own arguments, before validation, before a
 * missing operand is noticed, and before anything is written, connected to, or
 * prompted for. Somebody reaching for help is by definition not ready to run the
 * command, so running any part of it would be the wrong answer.
 *
 * A bare `--` ends our options: everything after it belongs to whatever the
 * command hands it to — `ub mcp install -- ub mcp serve --help` registers a
 * command with `--help` in it, and must not print help instead.
 *
 * The scan runs before `parseArgs`, so it cannot tell an option's *value* from
 * an option: `ub mcp install --hub -h` prints help before validating `-h` as a
 * hub address. That is the accepted price of help winning over validation,
 * and it costs nothing real — no option here takes a value that plausibly
 * spells `-h` or `--help`; a literal option value can use `--hub=-h`.
 */

import type { Io } from "./io.js";

/** Whether these arguments ask for help, with a bare `--` ending the search. */
function helpWanted(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

/**
 * Print `text` when the arguments ask for help, and say whether that happened.
 *
 * Written as `if (takeHelp(argv, io, X_HELP)) return 0;` at the top of a
 * command, which is the whole of the interception.
 */
export function takeHelp(argv: readonly string[], io: Io, text: string): boolean {
  if (!helpWanted(argv)) return false;
  io.out(text);
  return true;
}
