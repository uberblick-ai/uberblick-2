/**
 * The lock `ub init` holds while it writes.
 *
 * Three files have to agree when this command finishes: the signing secret in
 * `credentials.json`, the workspace in `config.json`, and the `mise.local.toml`
 * derived from both. Atomic publication makes each of them individually safe to
 * write while somebody reads it, but it cannot make the *set* consistent — two
 * inits can still interleave so that the derived file mirrors one run's workspace
 * and another run's secret. A lock around the whole write phase is the one
 * mechanism that covers every branch, including the read-modify-write of a
 * `credentials.json` that already carries other keys.
 *
 * It is a lock file, not a lock service: `open(O_CREAT|O_EXCL)` on
 * `$XDG_CONFIG_HOME/uberblick/.init.lock`. Two things keep that honest.
 *
 * **It is bounded.** Waiting stops after {@link WAIT_TIMEOUT_MS} and `ub init`
 * says another one is running rather than hanging on a terminal nobody is
 * watching. The write phase itself is a handful of file operations, so anything
 * approaching that bound is a wedged process, not contention.
 *
 * **It expires.** A process killed between creating the lock and removing it
 * would otherwise leave a machine that can never be initialised again, and "rm
 * this file" is a terrible thing to make somebody find out. A lock whose mtime is
 * older than {@link STALE_AFTER_MS} is taken over.
 *
 * The atomic publications underneath stay exactly as they were. This lock makes
 * the common case orderly; they are what keeps a lock that was taken over — or a
 * writer that is not `ub init` at all — from tearing a file in half.
 */

import { mkdirSync, openSync, closeSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialsPath } from "./config.js";
import { removeQuietly } from "./safe-write.js";

/** Beside the files it protects, so one directory holds one machine's state. */
const LOCK_FILE = ".init.lock";

/** How long to wait for another `ub init` before giving up. */
const WAIT_TIMEOUT_MS = 2_000;

/** After this, the holder is assumed dead rather than slow. */
const STALE_AFTER_MS = 30_000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the lock was taken over, so the caller should try again at once. */
function takeOverIfStale(path: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    // Gone between the failed create and now: the holder released it.
    return true;
  }
  if (age < STALE_AFTER_MS) {
    return false;
  }
  removeQuietly(path);
  return true;
}

/**
 * Take the lock, or throw with something a person can act on.
 *
 * Async because the caller is: a synchronous sleep would be `Atomics.wait` on a
 * `SharedArrayBuffer`, which is a strange thing to find in a CLI when the one
 * function that needs it is already `async`.
 */
export async function acquireInitLock(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InitLock> {
  const path = initLockPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        // Whoever finds this file wants to know which process to look for.
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        path,
        release() {
          if (!released) {
            released = true;
            removeQuietly(path);
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    if (takeOverIfStale(path)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `another \`ub init\` is holding ${path}. Wait for it to finish and run ` +
          "`ub init` again; if nothing is running, delete that file",
      );
    }
    await sleep(RETRY_MS);
  }
}
