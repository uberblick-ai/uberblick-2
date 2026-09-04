/**
 * Crash-safe ownership of the one serving replica for a store.
 *
 * The sidecar transaction is the process-held lock: SQLite and the OS release
 * it when the process exits, including after SIGKILL. The holder record lives
 * in the store because the exclusive sidecar cannot be read by a contender.
 * A short store write transaction serializes the two, so a loser can only read
 * the record committed by the process whose sidecar transaction is still live.
 * Deleting or replacing the sidecar under a live holder is unsupported: no
 * file-based lock can defend against removing its file.
 */

import { chmodSync, existsSync } from "node:fs";
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
 * Acquire the serving role for one file-backed store.
 *
 * Ordering is load-bearing. Every candidate first takes the store's writer
 * slot, then tries the sidecar lock. A winner records itself before releasing
 * the writer slot. A loser therefore reads that exact winner without writing;
 * a winner killed before its record commits releases both transactions and is
 * never observable as the holder.
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
  const freshLock = !existsSync(lockPath);
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

    lock = new DatabaseSync(lockPath);
    if (freshLock) chmodSync(lockPath, 0o600);
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
