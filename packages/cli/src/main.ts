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
  // Through the same stop as the success path: an exception thrown while a
  // websocket is open leaves exactly the handle {@link stopWaiting} exists for,
  // and a command that failed is no more entitled to hang than one that worked.
  stopWaiting();
}

// `process.exitCode`, never `process.exit`: exit() tears the process down at
// once, and a write to a pipe is asynchronous, so `ub status --json | …` would
// hand its reader truncated JSON as soon as the report outgrew the pipe buffer.
// Naming the code and letting the event loop run dry drains stdout first. It
// also means a command must close what it opened — `ub status` closes its server
// instance, `ub mcp serve` drops its signal handlers — or the process would now
// hang instead of being cut short.
/**
 * How long a reader may keep this process alive by not reading. Reached only
 * when a pipe is full and nobody is draining it — at which point the reader has
 * gone away, and there is nobody left for the output to be truncated *for*.
 */
const DRAIN_LIMIT_MS = 60_000;

/**
 * Stop waiting for handles that will never close, without truncating output.
 *
 * A hub that accepts a connection and then says nothing leaves a websocket
 * whose close handshake no one will ever answer, so the event loop does not run
 * dry and the rule above turns "exit cleanly" into "hang". The command has
 * already said everything it is going to say by the time this is scheduled, so
 * the remaining handles are given up on.
 *
 * **Buffered output is never given up on with them.** The whole reason this
 * file does not call `process.exit` directly is that a pipe write is
 * asynchronous, and exiting on a fixed timer would break that promise for
 * exactly the case it was made for: a large `ub status --json` into a reader
 * that is slow. So this exits only once both streams report nothing buffered,
 * however long that takes, up to {@link DRAIN_LIMIT_MS}.
 *
 * Every timer is unref'd, so a process that *can* exit on its own still exits
 * immediately and none of this is ever reached.
 */
function stopWaiting(): void {
  const deadline = Date.now() + DRAIN_LIMIT_MS;
  const check = (): void => {
    const buffered =
      process.stdout.writableLength + process.stderr.writableLength;
    if (buffered > 0 && Date.now() < deadline) {
      setTimeout(check, 25).unref();
      return;
    }
    process.exit(process.exitCode ?? 0);
  };
  // A short delay before the first look, so an ordinary command still exits
  // through the event loop running dry rather than through this.
  setTimeout(check, 250).unref();
}

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  stopWaiting();
}, fail);
