import { isDocId } from "./marks.js";

const skipped = new Map<string, Set<unknown>>();

/** Synced identities must already be canonical; warn once instead of repairing shared data. */
export function readSyncedDocId(value: unknown, source: string): string | null {
  if (isDocId(value)) return value;
  let seen = skipped.get(source);
  if (seen === undefined) {
    seen = new Set();
    skipped.set(source, seen);
  }
  if (!seen.has(value)) {
    seen.add(value);
    const display = typeof value === "string"
      ? JSON.stringify(value)
      : value === null ? "null" : `<${typeof value}>`;
    console.warn(`Skipping invalid synced document id in ${source}: ${display}`);
  }
  return null;
}
