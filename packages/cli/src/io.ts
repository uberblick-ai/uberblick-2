export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const processIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export function warn(io: Io, warnings: readonly string[]): void {
  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
}

/** Keep a printed command's operand literal when pasted into a POSIX shell. */
export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:%+-]+$/.test(value) ? value : `'${value.split("'").join(`'\\''`)}'`;
}
