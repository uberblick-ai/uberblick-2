import { createInterface } from "node:readline/promises";

/** Ask on stderr, defaulting to no for every answer except y or yes. */
export async function confirm(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await terminal.question(`${question} [y/N] `)).trim());
  } catch {
    throw new Error("confirmation ended; nothing was removed");
  } finally {
    terminal.close();
  }
}
