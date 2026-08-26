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
 * `$XDG_CONFIG_HOME/uberblick/.init.lock`, and two rules keep that honest.
 *
 * **It is bounded.** Waiting stops after {@link WAIT_TIMEOUT_MS} and `ub init`
 * says what is in the way rather than hanging on a terminal nobody is watching.
 * The write phase is a handful of file operations, so anything approaching that
 * bound is a wedged or dead process, not contention.
 *
 * The starter-document seed needs the same mutual exclusion for a different
 * reason — it reads the workspace to decide what to write, and two runs reading
 * before either writes would write the same documents twice — but it takes
 * seconds rather than milliseconds, so it takes a lock of its own
 * ({@link seedLockPath}) and never blocks anybody's file writing behind a hub
 * connection. Its caller does not wait for it either: a run that finds it held
 * has nothing to add, because whoever holds it is writing exactly those
 * documents.
 *
 * **Only its creator removes it.** There is no automatic takeover of an old
 * lock, and that is a deliberate reversal: an expiry rule needs a second
 * mechanism to decide when a holder is dead, and every version of that is a
 * race — two processes agreeing a lock is stale unlink it twice, so one of them
 * deletes a lock the other had just legitimately taken, and a lock that cannot
 * be removed at all turns the wait into a spin. A crashed holder on a
 * single-user machine is instead a visible situation with a one-line fix, and
 * the timeout message says exactly which file to delete and how old it is.
 * Nothing here ever unlinks a lock this process did not create: the descriptor
 * from the exclusive create is **held open for the lock's whole lifetime**, and
 * releasing compares that descriptor against the name before removing it. A
 * remembered inode number would not do — inode numbers are recycled once the
 * file they belonged to is gone — but a held descriptor keeps the file alive, so
 * the comparison cannot be fooled by a lock somebody deleted mid-run and
 * somebody else then took.
 *
 * The atomic publications underneath stay exactly as they were. This lock makes
 * the common case orderly; they are what keeps a writer that is not `ub init` at
 * all from tearing a file in half.
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
import { credentialsPath } from "./config.js";
import { removeQuietly } from "./safe-write.js";

/** Beside the files it protects, so one directory holds one machine's state. */
const LOCK_FILE = ".init.lock";

/** Beside it, held only while the starter documents are being written. */
const SEED_LOCK_FILE = ".seed.lock";

/** How long to wait for another `ub init` before giving up. */
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

/** The starter-document seed's lock. See the module comment for why it is separate. */
export function seedLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(credentialsPath(env)), SEED_LOCK_FILE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A path as a shell would have to be given it.
 *
 * The timeout message ends in a command somebody will paste, and the path in it
 * comes from `XDG_CONFIG_HOME` — which may hold spaces, quotes, `$(…)` or a
 * newline. Single quotes make a POSIX shell treat every one of those literally;
 * the only character they cannot contain is a single quote itself, which is why
 * one is spliced in as `'\''`. `rm --` then keeps a path beginning with `-` from
 * being read as options.
 */
function shellQuote(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

/**
 * Close a descriptor whose close outcome nothing can act on.
 *
 * Never called twice on the same descriptor: POSIX releases it even when `close`
 * reports an error, so a retry could land on an unrelated file that has since
 * been given the same number.
 */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Nothing left to do about it, and nothing left that depends on it.
  }
}

/**
 * Whether `path` still names the file `fd` refers to.
 *
 * Device and inode identify a file independently of its name — but only while
 * something pins the file, which is exactly what `fd` does. A *remembered*
 * (dev, ino) pair is not enough: once the last descriptor closes and the file is
 * unlinked, the filesystem is free to hand that inode number to the next file
 * created, so a lock somebody deleted and recreated could match a recorded pair
 * and be unlinked as if it were ours. Holding the descriptor open for the lock's
 * whole lifetime makes that impossible: the inode cannot be reused while it is
 * held, so `fstat` on it is always the file this process created.
 *
 * `lstat`, not `stat`: if the name has since become a symlink, the answer is
 * "not ours" rather than whatever it points at.
 */
function namesHeldFile(fd: number, path: string): boolean {
  try {
    const held = fstatSync(fd);
    const named = lstatSync(path);
    return held.dev === named.dev && held.ino === named.ino;
  } catch {
    // Gone, replaced by something unreadable, or a descriptor already closed:
    // in every case this process has no lock left to release.
    return false;
  }
}

/**
 * How long that lock has been there, for the message. Never a decision — see the
 * module comment on why nothing here acts on a lock's age.
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
  /**
   * Called once, when this process has found the lock held and is about to
   * wait for it. A run that stops for seconds says why rather than looking
   * wedged; a caller that does not wait ({@link waitMs} zero) never calls it.
   */
  onWait?: (path: string) => void;
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
  options: LockOptions = {},
): Promise<InitLock> {
  const path = options.path ?? initLockPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.waitMs ?? WAIT_TIMEOUT_MS);
  let announced = false;

  for (;;) {
    try {
      // Held open for the lock's whole lifetime, which is what makes releasing
      // it safe — see {@link namesHeldFile}. Nothing else needs the descriptor.
      const fd = openSync(path, "wx", 0o600);
      try {
        // Whoever finds this file wants to know which process to look for.
        writeSync(fd, `${process.pid}\n`);
      } catch (error) {
        // The lock exists from the create onward, so a failure here has to take
        // it away again: one left behind by a process that never went on to hold
        // it is one nobody will ever release, and there is no takeover to rescue
        // it. Unlink first, close second — the same order as `release`, and for
        // the same reason.
        if (namesHeldFile(fd, path)) {
          removeQuietly(path);
        }
        closeQuietly(fd);
        throw error;
      }
      let released = false;
      return {
        path,
        // The only `unlink` of a lock anywhere in this CLI, and it releases the
        // file this process created rather than whatever holds the name by then:
        // if somebody deletes the lock mid-run and another `ub init` takes it,
        // the name is theirs and this must not touch it.
        //
        // Unlink first, close second. While the descriptor is open the file it
        // refers to cannot be recycled, so the comparison and the removal are
        // about the same file with certainty; closing first would reopen the
        // window this exists to shut.
        release() {
          if (released) {
            return;
          }
          released = true;
          if (namesHeldFile(fd, path)) {
            removeQuietly(path);
          }
          // A deferred write error can surface here. The lock is already gone,
          // which is all a caller in a `finally` cares about, and throwing out
          // of a release would mask whatever sent us into that `finally`.
          closeQuietly(fd);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `another \`ub init\` is holding ${path} (${describeAge(path)}). Wait ` +
          "for it to finish and run `ub init` again — or, if nothing is " +
          `running, remove it: rm -- ${shellQuote(path)}`,
      );
    }
    if (!announced) {
      announced = true;
      options.onWait?.(path);
    }
    await sleep(RETRY_MS);
  }
}
