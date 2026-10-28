/**
 * The sidecar transaction releases on process exit, including SIGKILL. Keep
 * holder identity in the store since contenders cannot read the locked sidecar.
 * Removing or replacing a live sidecar invalidates this file-based lock.
 */

import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const COORDINATION_TIMEOUT_MS = 5_000;
const HOLDER_KEY = "serving-replica-holder";

/** The boot identity a refused contender reports to its caller. */
export interface ServingReplicaHolder {
  pid: number;
  sessionId: string;
}

/** A live serving replica already owns this store. */
export class ServingReplicaHeldError extends Error {
  readonly databasePath: string;
  readonly holder: ServingReplicaHolder;

  constructor(databasePath: string, holder: ServingReplicaHolder) {
    super(
      `The serving replica for ${databasePath} is already held by session ` +
        `${holder.sessionId} in process ${holder.pid}. One serving replica may use a store at a time.`,
    );
    this.name = "ServingReplicaHeldError";
    this.databasePath = databasePath;
    this.holder = holder;
  }
}

export interface ServingReplicaRole {
  readonly holder: ServingReplicaHolder;
  /** Release the process-held role. Idempotent. */
  close(): void;
}

/** SQLite's primary busy result, including extended busy codes. */
function isBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === 5;
}

function openServingLock(lockPath: string): {
  lock: DatabaseSync;
  assertCurrent(): void;
} {
  try {
    // Close before SQLite locks the inode: closing a raw descriptor afterward
    // would release this process's advisory locks held by another connection.
    closeSync(openSync(lockPath, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const identity = lstatSync(lockPath, { bigint: true });
  const lock = new DatabaseSync(lockPath);
  return {
    lock,
    assertCurrent() {
      const current = lstatSync(lockPath, { bigint: true, throwIfNoEntry: false });
      if (current === undefined || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error("The workspace's serving lock changed; retry the command.");
      }
    },
  };
}

/** Hold the same exclusion as ub open until synchronous removal finishes. */
export function acquireWorkspaceRemovalRole(databasePath: string, action: "removing" | "detaching" = "removing"): { close(): void } {
  const lockPath = `${databasePath}.serving-lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const { lock, assertCurrent } = openServingLock(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("BEGIN EXCLUSIVE");
    assertCurrent();
  } catch (error) {
    lock.close();
    if (isBusy(error)) {
      throw new Error(`a running \`ub open\` is serving this workspace; stop that run before ${action} it`);
    }
    throw error;
  }
  return {
    close() {
      if (!lock.isOpen) return;
      if (lock.isTransaction) lock.exec("ROLLBACK");
      lock.close();
    },
  };
}

function parseHolder(value: unknown): ServingReplicaHolder | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<ServingReplicaHolder>;
    return Number.isInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.sessionId === "string" &&
      parsed.sessionId.length > 0
      ? { pid: parsed.pid as number, sessionId: parsed.sessionId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Take the store writer slot before the sidecar lock and commit holder identity
 * before releasing it. A loser reads that winner without writing; a crash before
 * commit releases both transactions without publishing a holder.
 */
export function acquireServingReplicaRole(
  databasePath: string,
  holder: ServingReplicaHolder,
): ServingReplicaRole {
  if (databasePath === ":memory:") {
    throw new Error(
      "A serving replica requires a file-backed store so its process-held role can be shared.",
    );
  }

  const coordination = new DatabaseSync(databasePath);
  const lockPath = `${databasePath}.serving-lock`;
  let lock: DatabaseSync | null = null;
  let coordinating = false;
  let lockHeld = false;

  try {
    coordination.exec(`PRAGMA busy_timeout = ${COORDINATION_TIMEOUT_MS}`);
    try {
      coordination.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!isBusy(error)) throw error;
      throw new Error(
        `The store at ${databasePath} is busy; retry starting its serving replica.`,
      );
    }
    coordinating = true;

    const opened = openServingLock(lockPath);
    lock = opened.lock;
    lock.exec("PRAGMA busy_timeout = 0");

    try {
      lock.exec("BEGIN EXCLUSIVE");
      lockHeld = true;
    } catch (error) {
      if (!isBusy(error)) throw error;
      const row = coordination
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(HOLDER_KEY) as { value?: unknown } | undefined;
      const current = parseHolder(row?.value);
      try {
        lock.exec("BEGIN EXCLUSIVE");
        lockHeld = true;
      } catch (recheckError) {
        if (!isBusy(recheckError)) throw recheckError;
        // The holder can still exit between this contemporaneous check and the
        // refusal; no report of a process-held lock can eliminate that window.
        coordination.exec("ROLLBACK");
        coordinating = false;
        lock.close();
        lock = null;
        if (current === null) {
          throw new Error(
            `The serving role for ${databasePath} is locked, but its holder record is missing or invalid.`,
          );
        }
        throw new ServingReplicaHeldError(databasePath, current);
      }
    }

    // A remover can finish after this contender opened the old sidecar but
    // before its transaction acquired it. Never serve under an unlinked lock.
    opened.assertCurrent();

    coordination
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(HOLDER_KEY, JSON.stringify(holder));
    coordination.exec("COMMIT");
    coordinating = false;
    coordination.close();
  } catch (error) {
    if (coordinating && coordination.isTransaction) {
      coordination.exec("ROLLBACK");
    }
    if (coordination.isOpen) coordination.close();
    if (lockHeld && lock?.isTransaction) lock.exec("ROLLBACK");
    if (lock?.isOpen) lock.close();
    throw error;
  }

  let closed = false;
  return {
    holder,
    close() {
      if (closed) return;
      closed = true;
      if (lock?.isTransaction) lock.exec("ROLLBACK");
      if (lock?.isOpen) lock.close();
      lock = null;
    },
  };
}
