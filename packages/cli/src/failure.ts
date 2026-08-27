/**
 * What a `--json` command says when it cannot answer.
 *
 * A machine-readable mode that is machine-readable only when it works is not a
 * machine-readable mode: a script that pipes `ub status --json` into a parser
 * has to handle the failure in the same representation it handles the success,
 * or it has to scrape prose off stderr. So a command that offers `--json` emits
 * **exactly one JSON value on stdout either way** — the report when it has one,
 * the envelope below when it does not — and the exit status stays the
 * authoritative outcome signal. stderr keeps only what the result cannot
 * carry: warnings, and the MCP server's own logging.
 *
 * The envelope is a single `error` object, and that key is the discriminator: a
 * successful payload never has one. Nothing is wrapped or renamed on the way in
 * — `ub status --json` still prints its report at the top level and
 * `ub workspace list --json` still prints a bare array — because a script
 * reading them today must keep working.
 *
 * **`category` is the closed axis, `code` the additive one.** A caller branches
 * on `category`: `usage` means this invocation was refused and repeating it
 * cannot help (exit 2), `operational` means the command could not produce its
 * result here and now (exit 1). Those two, and their exit classes, are the
 * compatibility promise. `code` is the finer name for the same failure, and new
 * codes may appear inside an existing category as `ub` learns to tell failures
 * apart — a caller that switches on `code` must have a default branch.
 *
 * **Nothing here invents text.** `message` is the thrown error's own message,
 * verbatim — the same sentence the human mode prints, so the two cannot drift
 * into saying different things. It is therefore *not* sanitised, and a failure
 * out of `node:fs` carries the path it failed on: the data directory, which the
 * successful `ub status --json` payload already publishes as `databasePath` and
 * the human mode already prints. Vetting each message into a path-free form
 * would be a per-catch-site taxonomy nobody scheduled, and it would make the
 * two modes say different things.
 *
 * **What the envelope excludes is the guarantee.** The four fields below and no
 * more: never an exception's `stack`, never its `cause`, never arbitrary
 * properties carried on it. That is where a query, a stack frame's source path
 * or a value nobody vetted would ride out to a caller. And the signing secret
 * is never printed by any command, on any stream, failure included.
 *
 * **Help wins over all of it.** `--help` anywhere on the command path prints
 * that path's help on stdout and exits 0, before this is reached — so
 * `ub status --json --help` is prose, deliberately: somebody reaching for help
 * is not running the command, and its output is not the command's result. See
 * ./help.ts.
 *
 * `ub mcp install --print` stays outside all of this on purpose: it emits a
 * client-configuration snippet to paste, not a result, so it is not a `--json`
 * mode and has no envelope.
 */

import type { Io } from "./io.js";

/** How a caller must treat the failure. Closed, and pinned to the exit class. */
type FailureCategory = "usage" | "operational";

/**
 * The name of the failure. Additive: a new code may appear inside an existing
 * category, so switch on {@link FailureCategory} and default on this.
 */
type FailureCode = "invalid_arguments" | "command_failed";

/** The one shape a `--json` command prints when it cannot answer. */
interface CliFailure {
  error: {
    code: FailureCode;
    category: FailureCategory;
    /** One sentence, the same one the human mode prints. Never a secret. */
    message: string;
    /** Which command path failed, as a person would type it. */
    command: string;
  };
}

const CATEGORIES: Record<FailureCode, FailureCategory> = {
  invalid_arguments: "usage",
  command_failed: "operational",
};

/** The exit class each category is reported with. 2 for usage, 1 otherwise. */
const EXIT_CODES: Record<FailureCategory, number> = {
  usage: 2,
  operational: 1,
};

/** An exception's message, whatever was thrown. */
export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether these arguments ask for JSON, scanned before anything is parsed.
 *
 * Pre-parse for the reason `takeHelp` is pre-parse: `ub status --json --bogus`
 * has to be *refused in JSON*, and a refusal the parser produced cannot be read
 * out of the parser's own result. A bare `--` ends the search, the same rule
 * help follows.
 *
 * `--json=…` counts too, though the parser rejects it a moment later: a boolean
 * option takes no value. Somebody who wrote it plainly asked for JSON, and
 * answering the mistake in prose is the one place a `--json` reader would still
 * be handed something it cannot parse.
 */
export function wantsJson(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--json" || arg.startsWith("--json=")) return true;
  }
  return false;
}

/**
 * Report a failure in whichever representation the caller asked for, and return
 * the exit code for it.
 *
 * Written as `return reportFailure(io, { json, command, code, error })` at the
 * failure site, which is the whole of it: one call decides the stream, the
 * shape and the exit class together, so no command can get the three of them to
 * disagree.
 */
export function reportFailure(
  io: Io,
  options: {
    json: boolean;
    /** The command path, e.g. `ub workspace list`. */
    command: string;
    code: FailureCode;
    /** What was thrown, or the sentence to report. */
    error: unknown;
  },
): number {
  const category = CATEGORIES[options.code];
  const message = failureMessage(options.error);

  if (options.json) {
    const failure: CliFailure = {
      error: { code: options.code, category, message, command: options.command },
    };
    io.out(`${JSON.stringify(failure, null, 2)}\n`);
  } else {
    io.err(`${options.command}: ${message}\n`);
  }
  return EXIT_CODES[category];
}
