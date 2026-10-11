/**
 * Serialize machine-configuration read-modify-write operations. Atomic file
 * publication still protects readers from writers that do not hold this lock.
 * Waiting is bounded; age never triggers takeover or removal.
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

/** Beside the files it protects, so one directory holds one machine's state. */
const LOCK_FILE = ".init.lock";

/** Separate seed lock covers read-before-write eligibility checks and longer writes. */
const SEED_LOCK_FILE = ".seed.lock";

/**
 * Do not apply the terminal-probe test ceiling: a live sibling may legitimately
 * hold this lock while doing work, so shortening its wait creates false failures.
 */
const WAIT_TIMEOUT_MS = 2_000;

/** Long enough not to spin, short enough to be invisible. */
const RETRY_MS = 20;

export interface InitLock {
  path: string;
  /** Idempotent: safe to call from a `finally` that may run twice. */
  release(): void;
}

export function initLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(credentialsPath(env)), LOCK_FILE);
}

/** Workspace creation holds this through offline seeding before publishing its binding. */
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

/**
 * Quote recovery paths literally for POSIX shells, including embedded quotes.
 * The recovery command uses `rm --` to prevent option parsing.
 */
function shellQuote(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

/**
 * Never retry close: POSIX releases the descriptor even on error, and its number
 * may already belong to another file.
 */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Cleanup must not replace the caller's error.
  }
}

/**
 * The held descriptor prevents inode reuse while comparing device and inode.
 * `lstat` refuses a substituted symlink rather than following it.
 */
function namesHeldFile(fd: number, path: string): boolean {
  try {
    const held = fstatSync(fd);
    const named = lstatSync(path);
    return held.dev === named.dev && held.ino === named.ino;
  } catch {
    // Missing or unreadable identity gives no permission to remove the name.
    return false;
  }
}

/**
 * Lock age is diagnostic only; it never authorizes takeover.
 */
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
  /**
   * Announce contention once before waiting; zero-wait callers never call it.
   */
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

/**
 * Try once synchronously so readers can fall back to a coherent cached value.
 * Only contention returns `null`; other create/write failures throw.
 */
function tryAcquirePath(path: string): InitLock | null {
  let fd: number;
  try {
    // Hold the exclusive-create descriptor until release to pin its identity.
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw error;
  }

  try {
    // Identify the holder for timeout recovery.
    writeSync(fd, `${process.pid}\n`);
  } catch (error) {
    // Failed initialization must release our created lock; there is no takeover.
    // Unlink before close so the descriptor still pins the compared identity.
    if (namesHeldFile(fd, path)) {
      removeQuietly(path);
    }
    closeQuietly(fd);
    throw error;
  }

  let released = false;
  return {
    path,
    // Remove only our created file, never a replacement lock. Unlink before
    // close: the held descriptor prevents the compared inode from being reused.
    release() {
      if (released) {
        return;
      }
      released = true;
      if (namesHeldFile(fd, path)) {
        removeQuietly(path);
      }
      // A deferred close error must not mask the error that triggered cleanup.
      closeQuietly(fd);
    },
  };
}

/**
 * Caller-supplied paths, including build locks, use the same exclusive create,
 * held descriptor and creator-only removal as config-root locks.
 */
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

/**
 * Wait without blocking the event loop; timeout reports the holder and a quoted
 * recovery command, and cancellation prevents subsequent acquisition.
 */
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
