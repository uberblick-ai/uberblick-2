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
 * **Only its creator removes it.** There is no automatic takeover of an old
 * lock, and that is a deliberate reversal: an expiry rule needs a second
 * mechanism to decide when a holder is dead, and every version of that is a
 * race — two processes agreeing a lock is stale unlink it twice, so one of them
 * deletes a lock the other had just legitimately taken, and a lock that cannot
 * be removed at all turns the wait into a spin. A crashed holder on a
 * single-user machine is instead a visible situation with a one-line fix, and
 * the timeout message says exactly which file to delete and how old it is.
 * Nothing here ever unlinks a lock this process did not create — releasing
 * checks the file's identity, not just its name, so a lock somebody deleted
 * mid-run and somebody else then took is left alone.
 *
 * The atomic publications underneath stay exactly as they were. This lock makes
 * the common case orderly; they are what keeps a writer that is not `ub init` at
 * all from tearing a file in half.
 */

import {
  closeSync,
  fstatSync,
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
 * Whether `path` still names the file this process created.
 *
 * Device and inode together identify a file independently of its name, so a lock
 * that was deleted and recreated by somebody else fails this even though the
 * path is unchanged.
 */
function isSameFile(
  path: string,
  identity: { dev: number; ino: number },
): boolean {
  try {
    const stats = statSync(path);
    return stats.dev === identity.dev && stats.ino === identity.ino;
  } catch {
    // Already gone: somebody removed it, and there is nothing to release.
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
      // From here the lock exists, so every failure has to take it away again:
      // a lock left behind by a process that never went on to hold it is one
      // nobody will ever release, and there is no takeover to rescue it. The
      // close is inside the guarded region for the reason it is in
      // `writeTempBeside` — that is where a deferred error surfaces — and marked
      // as attempted first, because POSIX releases the descriptor even when
      // `close` reports an error.
      let closeAttempted = false;
      let identity: { dev: number; ino: number };
      try {
        // Whoever finds this file wants to know which process to look for.
        writeSync(fd, `${process.pid}\n`);
        // Which inode this name refers to *now*, so that releasing can tell
        // this lock from a different file that later took the same name.
        const stats = fstatSync(fd);
        identity = { dev: stats.dev, ino: stats.ino };
        closeAttempted = true;
        closeSync(fd);
      } catch (error) {
        if (!closeAttempted) {
          try {
            closeSync(fd);
          } catch {
            // Already unwinding; the unlink below is what matters.
          }
        }
        removeQuietly(path);
        throw error;
      }
      let released = false;
      return {
        path,
        // The only `unlink` of a lock anywhere in this CLI, and it releases the
        // file this process created rather than whatever holds the name by then:
        // if somebody deletes the lock mid-run and another `ub init` takes it,
        // the name is theirs and this must not touch it. What remains is the
        // instant between the check and the unlink, which no userland writer can
        // close — and which needs that same deletion to happen inside it.
        release() {
          if (released) {
            return;
          }
          released = true;
          if (isSameFile(path, identity)) {
            removeQuietly(path);
          }
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
    await sleep(RETRY_MS);
  }
}
