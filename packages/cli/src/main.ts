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

// A reader that hung up is not a failure worth reporting — there is nobody left
// to report it to. Without this, `ub status --json | head -1` on a report that
// outgrows the pipe buffer dies of an unhandled EPIPE, printing a Node stack
// trace over the caller's stderr and exiting 1: a crash where the caller did
// something ordinary and deliberate. So a vanished reader is swallowed and the
// process exits with the status the command had already reached — the exit
// status reports what `ub` did, never what its reader did.
//
// `EPIPE` and nothing else: that errno *is* the reader-gone signal, and a
// stream error that is not it — ENOSPC on a redirect, a device that went away —
// is a real failure whose report is worth the noise. It still throws.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      throw error;
    }
  });
}

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
