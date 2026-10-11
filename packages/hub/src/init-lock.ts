/**
 * Serialize machine-configuration read-modify-write operations beside credentials.json.
 * Secret, device-login and workspace-record writers preserve unrelated keys and
 * the winning secret under this lock; atomic publication separately protects readers.
 * Waits are bounded. Only the creator removes a lock; crashed holders need manual
 * removal because stale-lock takeover can unlink a successor's live lock.
 */

import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { credentialsPath } from "./storage.js";
import { removeQuietly } from "./safe-write.js";

const LOCK_FILE = ".init.lock";

/** Separate from short configuration writes: seeding takes seconds and must not duplicate documents. */
const SEED_LOCK_FILE = ".seed.lock";

/**
 * Keep outside budget.ts's test ceiling: a live sibling needs the full wait to
 * finish real writes, while shortened terminal probes may legitimately expire.
 */
const WAIT_TIMEOUT_MS = 2_000;

const RETRY_MS = 20;

export interface InitLock {
  path: string;
  /** Idempotent: safe to call from a `finally` that may run twice. */
  release(): void;
}

export function initLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(credentialsPath(env)), LOCK_FILE);
}

/** Workspace creation waits for seeding and writes the offline replica before publishing its binding. */
export function seedLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(credentialsPath(env)), SEED_LOCK_FILE);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Quote arbitrary config paths literally for the pasted POSIX removal command; `rm --` guards options. */
function shellQuote(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

/** Never retry a failed close: POSIX releases the number, which another file can reuse. */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Cleanup must not mask the caller's failure.
  }
}

/**
 * Keep fd open for the entire lock lifetime to prevent inode reuse fooling this
 * comparison. lstat refuses a replacement symlink instead of following its target.
 */
function namesHeldFile(fd: number, path: string): boolean {
  try {
    const held = fstatSync(fd);
    const named = lstatSync(path);
    return held.dev === named.dev && held.ino === named.ino;
  } catch {
    // An absent, unreadable or closed file is no longer ours to remove.
    return false;
  }
}

/** Diagnostic only; age never authorizes lock removal. */
function describeAge(path: string): string {
  try {
    const seconds = Math.round((Date.now() - statSync(path).mtimeMs) / 1000);
    return `${seconds}s old`;
  } catch {
    return "age unknown";
  }
}

export interface LockOptions {
  /** Which lock file. Defaults to {@link initLockPath}. */
  path?: string;
  /** How long to wait for a holder before giving up. Zero tries exactly once. */
  waitMs?: number;
  /** The command to retry; omitted callers name ub open. */
  command?: string;
  /** Called once before waiting on contention; never called when waitMs is zero. */
  onWait?: (path: string) => void;
  /** Cancel a waiting operation before it can acquire or publish. */
  signal?: AbortSignal;
}

export interface TryLockOptions {
  /** Which lock file. Defaults to {@link initLockPath}. */
  path?: string;
}

/** Contention lasted for the caller's whole wait, rather than the lock operation failing. */
export class LockWaitTimeoutError extends Error {}

/** One synchronous attempt lets readers fall back immediately; only contention returns null. */
function tryAcquirePath(path: string): InitLock | null {
  let fd: number;
  try {
    // Hold this exclusive-create descriptor until release; see namesHeldFile.
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw error;
  }

  try {
    // Identify the holder for manual recovery.
    writeSync(fd, `${process.pid}\n`);
  } catch (error) {
    // Failed initialization must not leave an orphan. Unlink our held file before
    // closing its descriptor so its inode cannot be recycled during removal.
    if (namesHeldFile(fd, path)) {
      removeQuietly(path);
    }
    closeQuietly(fd);
    throw error;
  }

  let released = false;
  return {
    path,
    // Remove only our held file, preserving a successor after manual deletion.
    // Unlink before close to keep its inode pinned through removal.
    release() {
      if (released) {
        return;
      }
      released = true;
      if (namesHeldFile(fd, path)) {
        removeQuietly(path);
      }
      // A deferred close error must not mask the failure entering finally.
      closeQuietly(fd);
    },
  };
}

/** Exclusive-create lock at any path, including directory-keyed build locks; null means contention. */
export function tryAcquireLock(path: string): InitLock | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return tryAcquirePath(path);
}

/** Take the init lock immediately, or return `null` when another process has it. */
export function tryAcquireInitLock(
  env: NodeJS.ProcessEnv = process.env,
  options: TryLockOptions = {},
): InitLock | null {
  return tryAcquireLock(options.path ?? initLockPath(env));
}

/** Wait without blocking the event loop; timeout identifies the holder's path and manual recovery. */
export async function acquireInitLock(
  env: NodeJS.ProcessEnv = process.env,
  options: LockOptions = {},
): Promise<InitLock> {
  options.signal?.throwIfAborted();
  const path = options.path ?? initLockPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.waitMs ?? WAIT_TIMEOUT_MS);
  let announced = false;

  for (;;) {
    options.signal?.throwIfAborted();
    const lock = tryAcquirePath(path);
    if (lock !== null) {
      return lock;
    }

    if (Date.now() >= deadline) {
      throw new LockWaitTimeoutError(
        `another configuration writer is holding ${path} (${describeAge(path)}). Wait ` +
          `for it to finish and run \`${options.command ?? "ub open"}\` again — or, if nothing is ` +
          `running, remove it: rm -- ${shellQuote(path)}`,
      );
    }
    if (!announced) {
      announced = true;
      options.onWait?.(path);
    }
    await sleep(RETRY_MS, options.signal);
  }
}
