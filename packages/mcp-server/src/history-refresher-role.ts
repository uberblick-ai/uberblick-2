import { closeSync, lstatSync, openSync, type BigIntStats } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface HistoryRefresherRole {
  /** A removed or replaced workspace copy or sidecar no longer owns the role. */
  isCurrent(): boolean;
  close(): void;
}

const heldInodes = new Set<string>();

function sameFile(path: string, identity: BigIntStats): boolean {
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return current !== undefined && current.dev === identity.dev && current.ino === identity.ino;
}

/** A separate SQLite transaction excludes only background history refreshers. */
export function tryAcquireHistoryRefresherRole(databasePath: string): HistoryRefresherRole | null {
  if (databasePath === ":memory:") {
    throw new Error("A history refresher requires a file-backed workspace cache.");
  }
  const databaseIdentity = lstatSync(databasePath, { bigint: true, throwIfNoEntry: false });
  if (databaseIdentity === undefined) return null;
  const lockPath = `${databasePath}.history-refresher-lock`;
  try {
    // Close the raw descriptor before SQLite acquires its process-held lock.
    closeSync(openSync(lockPath, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const identity = lstatSync(lockPath, { bigint: true });
  const inode = `${identity.dev}:${identity.ino}`;
  // Never open and close another descriptor for an inode this process holds.
  if (heldInodes.has(inode)) return null;
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("BEGIN EXCLUSIVE");
    if (!sameFile(lockPath, identity) || !sameFile(databasePath, databaseIdentity)) {
      lock.exec("ROLLBACK");
      lock.close();
      return null;
    }
  } catch (error) {
    if (lock.isTransaction) lock.exec("ROLLBACK");
    lock.close();
    const errcode = (error as { errcode?: unknown } | null)?.errcode;
    if (typeof errcode === "number" && (errcode & 0xff) === 5) return null;
    throw error;
  }
  heldInodes.add(inode);
  return {
    isCurrent() {
      return lock.isOpen && sameFile(lockPath, identity) && sameFile(databasePath, databaseIdentity);
    },
    close() {
      if (!lock.isOpen) return;
      try {
        if (lock.isTransaction) lock.exec("ROLLBACK");
      } finally {
        lock.close();
        heldInodes.delete(inode);
      }
    },
  };
}
