/**
 * The `ub` process: argv in, exit code out.
 *
 * Everything else is a function, so the whole CLI is testable without a
 * process; this file owns the two things a process owns — the exit code and
 * where an unhandled failure is reported. Failures go to stderr, always: in the
 * `ub mcp serve` path stdout belongs to the JSON-RPC transport.
 */

import { runCli } from "./cli.js";
import { stopWhenDrained } from "./exit.js";
import { quietUnactionableWarnings } from "./warnings.js";

// Before anything is written: whichever entry point reached this module — the
// `bin/ub.mjs` shim, or a bundle built from it — gets the same stderr policy.
// See ./warnings.ts for why running after yjs has loaded is still in time.
quietUnactionableWarnings();

// `process.exitCode`, never `process.exit`: exit() tears the process down at
// once, and a write to a pipe is asynchronous, so `ub status --json | …` would
// hand its reader truncated JSON as soon as the report outgrew the pipe buffer.
// Naming the code and letting the event loop run dry drains stdout first. It
// also means a command must close what it opened — `ub status` closes its server
// instance, `ub mcp serve` drops its signal handlers — or the process would now
// hang instead of being cut short.
//
// One class of command cannot hold up its end: a hub that accepts a websocket
// and then never answers leaves a connection nobody can close. `stopWhenDrained`
// gives up on those handles without ever giving up on buffered output — see
// ./exit.ts, which owns that ordering and the reasoning for it.
function stopWaiting(): void {
  stopWhenDrained([process.stdout, process.stderr], () => {
    process.exit(process.exitCode ?? 0);
  });
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ub: ${message}\n`);
  process.exitCode = 1;
  // Through the same stop as the success path: an exception thrown while a
  // websocket is open leaves exactly the handle this exists for, and a command
  // that failed is no more entitled to hang than one that worked.
  stopWaiting();
}

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  stopWaiting();
}, fail);
