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

/** Keep a printed command's operand literal when pasted into a POSIX shell. */
export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:%+-]+$/.test(value) ? value : `'${value.split("'").join(`'\\''`)}'`;
}
