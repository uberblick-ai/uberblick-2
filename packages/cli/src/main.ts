/**
 * The `ub` process: argv in, exit code out.
 *
 * Everything else is a function, so the whole CLI is testable without a
 * process; this file owns the two things a process owns — the exit code and
 * where an unhandled failure is reported. Failures go to stderr, always: in the
 * `ub mcp serve` path stdout belongs to the JSON-RPC transport.
 */

import { runCli } from "./cli.js";

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ub: ${message}\n`);
  process.exit(1);
}

runCli(process.argv.slice(2)).then((code) => {
  process.exit(code);
}, fail);
