import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function historyHoldPath(databasePath: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid history hold session id.");
  return `${databasePath}.history-holds/${sessionId}.sqlite`;
}

/** A session's sidecar lock survives until close or process exit, including a crash. */
export class HistoryHoldSession {
  readonly id = randomUUID();
  private readonly path: string;
  private readonly lock: DatabaseSync;

  constructor(private readonly databasePath: string) {
    if (databasePath === ":memory:") {
      throw new Error("History snapshot holds require a file-backed store.");
    }
    mkdirSync(`${databasePath}.history-holds`, { recursive: true, mode: 0o700 });
    this.path = historyHoldPath(databasePath, this.id);
    // Close the raw descriptor before SQLite acquires its process-held lock.
    closeSync(openSync(this.path, "wx", 0o600));
    this.lock = new DatabaseSync(this.path);
    try {
      this.lock.exec("PRAGMA busy_timeout = 0");
      this.lock.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }

  /** Uncertain liveness keeps the snapshot: only a missing or unlocked file is dead. */
  isAlive(sessionId: string): boolean {
    if (sessionId === this.id) return this.lock.isOpen;
    let probe: DatabaseSync | undefined;
    let alive = true;
    try {
      const path = historyHoldPath(this.databasePath, sessionId);
      const identity = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (identity === undefined) return false;
      if (!identity.isFile()) return true;
      probe = new DatabaseSync(path);
      probe.exec("PRAGMA busy_timeout = 0");
      probe.exec("BEGIN EXCLUSIVE");
      const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (current === undefined) {
        alive = false;
      } else if (current.dev === identity.dev && current.ino === identity.ino) {
        // Session ids are never reused, so no new holder can acquire this dead id.
        unlinkSync(path);
        alive = false;
      }
    } catch {
      alive = true;
    } finally {
      try {
        if (probe?.isTransaction) probe.exec("ROLLBACK");
      } catch {
        alive = true;
      }
      try {
        if (probe?.isOpen) probe.close();
      } catch {
        alive = true;
      }
    }
    return alive;
  }

  /** Idempotently release this session and its sidecar. */
  close(): void {
    if (!this.lock.isOpen) return;
    try {
      if (this.lock.isTransaction) this.lock.exec("ROLLBACK");
    } finally {
      this.lock.close();
    }
    try {
      unlinkSync(this.path);
    } catch {
      // A leftover unlocked sidecar is harmless and a later liveness probe removes it.
    }
  }
}
