/**
 * Where output goes.
 *
 * One indirection, for one reason: stdout is a transport in the `ub mcp serve`
 * path and a parseable document in `ub status --json`, so which stream a line
 * lands on is a contract rather than a detail. Commands take an {@link Io} and
 * tests hand them a recorder.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const processIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};
