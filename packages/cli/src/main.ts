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
/**
 * Stop waiting for handles that will never close, without truncating output.
 *
 * A hub that accepts a connection and then says nothing leaves a websocket
 * whose close handshake no one will ever answer, so the event loop does not run
 * dry and the rule above turns "exit cleanly" into "hang". The command has
 * already said everything it is going to say by the time this is scheduled, so
 * the remaining handles get a grace period and then stop being waited for.
 *
 * The timer is unref'd, so a process that *can* exit on its own still exits
 * immediately and never waits out the grace. And stdout is drained first — the
 * whole reason this file does not call `process.exit` directly is that a pipe
 * write is asynchronous, and that is as true here as it is anywhere.
 */
function stopWaiting(): void {
  let attempts = 0;
  const check = (): void => {
    const draining =
      process.stdout.writableLength > 0 || process.stderr.writableLength > 0;
    if (draining && attempts < 20) {
      attempts += 1;
      setTimeout(check, 50).unref();
      return;
    }
    process.exit(process.exitCode ?? 0);
  };
  setTimeout(check, 500).unref();
}

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  stopWaiting();
}, fail);
