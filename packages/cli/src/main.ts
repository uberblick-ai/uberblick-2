/**
 * The `ub` process: argv in, exit code out.
 *
 * Everything else is a function, so the whole CLI is testable without a
 * process; this file owns the two things a process owns — the exit code and
 * where an unhandled failure is reported. Failures go to stderr, always: in the
 * `ub mcp serve` path stdout belongs to the JSON-RPC transport.
 */

import { runCli } from "./cli.js";

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ub: ${message}\n`);
  process.exitCode = 1;
}

// `process.exitCode`, never `process.exit`: exit() tears the process down at
// once, and a write to a pipe is asynchronous, so `ub status --json | …` would
// hand its reader truncated JSON as soon as the report outgrew the pipe buffer.
// Naming the code and letting the event loop run dry drains stdout first. It
// also means a command must close what it opened — `ub status` closes its server
// instance, `ub mcp serve` drops its signal handlers — or the process would now
// hang instead of being cut short.
runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, fail);
