/**
 * How `ub` writes the files it owns.
 *
 * Three of them carry configuration this command is the only writer of, and one
 * of those carries the hub signing secret. That makes three properties
 * non-negotiable, and none of them is what `writeFileSync` gives you:
 *
 * **Owner-only from birth.** A file that already exists at 0644 keeps that mode
 * through a `writeFileSync`, because `mode:` applies only on creation. Nothing
 * here ever writes into a file whose mode it has not already set: the contents
 * are written to a fresh 0600 file and that file is moved into place.
 *
 * **Never through a symlink.** The path is classified through a descriptor
 * opened with `O_NOFOLLOW`, so a symlink is a refusal rather than a secret
 * written into whatever somebody pointed the name at. Publication is `link` or
 * `rename`, which replace a name rather than following it — so even a symlink
 * swapped in after the check cannot receive anything.
 *
 * **Whole, or not at all.** `ub status`, an MCP client and mise all read these
 * files, possibly while this command writes them, and half a file is a parse
 * error rather than an old value. Every publication is one atomic step.
 *
 * Reads deliberately stay path-based. Following a symlink to read a file you own
 * is not the hazard; writing one is.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Owner-only, and the mode every file in this module is created with. */
const OWNER_ONLY = 0o600;

/** An fs error's message: the path and the errno, never file contents. */
export function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined
    ? "it could not be opened"
    : `it could not be opened (${code})`;
}

/**
 * ELOOP is what `O_NOFOLLOW` reports for a symlink. It is worth its own message
 * everywhere it can happen: "permission denied" and "you have a symlink here"
 * lead to completely different fixes.
 */
export function isSymlinkRefusal(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ELOOP";
}

/** What a path holds, as far as this module is willing to write to it. */
export type Target =
  | { kind: "absent" }
  | { kind: "regular" }
  | { kind: "refused"; because: string };

/**
 * Classify a path through one descriptor, opened without following symlinks.
 *
 * The fd is closed again immediately: it exists so that "is this a regular
 * file?" is answered about an inode rather than about a name that could be
 * something else by the time anyone looks twice.
 */
export function classify(path: string): Target {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    if (isSymlinkRefusal(error)) {
      return { kind: "refused", because: "it is a symbolic link" };
    }
    return { kind: "refused", because: describeFsError(error) };
  }
  try {
    return fstatSync(fd).isFile()
      ? { kind: "regular" }
      : { kind: "refused", because: "it is not a regular file" };
  } finally {
    closeSync(fd);
  }
}

/**
 * Write every byte, however many `write(2)` calls that takes.
 *
 * A single `writeSync` may be short — that is the contract of the syscall, not
 * an exotic failure — and a short write to a file holding the signing secret is
 * a file that parses as something else or not at all.
 */
function writeAll(fd: number, contents: string): void {
  const data = Buffer.from(contents, "utf8");
  let written = 0;
  while (written < data.length) {
    written += writeSync(fd, data, written, data.length - written);
  }
}

/**
 * Write `contents` to a fresh owner-only file beside `path`, and return it.
 *
 * The staging half of an atomic publication: the caller then `link`s it into
 * place (a claim that must not overwrite) or `rename`s it (a replacement that
 * must). Same directory, because both of those are only atomic within one
 * filesystem.
 *
 * The name is unpredictable because the file briefly holds the signing secret,
 * and it is created with `wx` so it can never land on somebody else's file.
 *
 * **Nothing survives this call except a file whose name it returned.** The close
 * is inside the guarded region, not in a `finally` after it: `close(2)` is where
 * a deferred write error such as EIO finally surfaces, and a close that throws
 * after the write "succeeded" would otherwise leave a complete, readable copy of
 * a signing secret on disk under a name the caller never receives and nobody
 * would think to look for. A failed close is treated as a failed write.
 */
export function writeTempBeside(path: string, contents: string): string {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, "wx", OWNER_ONLY);
  // Set immediately BEFORE the close, not after: POSIX releases the descriptor
  // even when `close` reports an error, so closing again could land on an
  // unrelated file that has since been given the same number.
  let closeAttempted = false;
  try {
    fchmodSync(fd, OWNER_ONLY);
    writeAll(fd, contents);
    closeAttempted = true;
    closeSync(fd);
  } catch (error) {
    if (!closeAttempted) {
      try {
        closeSync(fd);
      } catch {
        // Already unwinding; the unlink below is what actually matters.
      }
    }
    removeQuietly(temp);
    throw error;
  }
  return temp;
}

/**
 * Move a staged file onto `path`.
 *
 * `link` when the path was absent, because a claim must not overwrite whatever
 * appeared since; `rename` when a file is already there, because a replacement
 * must. Returns false when `link` lost the race, which is the caller's cue to
 * leave the winner alone.
 */
export function publishStaged(
  staged: string,
  path: string,
  onto: "absent" | "regular",
): boolean {
  try {
    if (onto === "absent") {
      linkSync(staged, path);
    } else {
      renameSync(staged, path);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    // After `rename` this name is already gone; after `link` and after a loss it
    // is not, and it is holding a secret.
    removeQuietly(staged);
  }
}

/**
 * Create or replace `path` as an owner-only regular file, atomically.
 *
 * @throws when the path is a symlink or is not a regular file — both are
 * refusals rather than repairs; when something else claimed the name first; and
 * when the write itself fails.
 */
export function publishOwnerOnly(path: string, contents: string): void {
  const target = classify(path);
  if (target.kind === "refused") {
    throw new Error(
      `refusing to write ${path}: ${target.because} — this file must be a ` +
        "regular file you own. Move it aside and run `ub init` again",
    );
  }
  const staged = writeTempBeside(path, contents);
  if (!publishStaged(staged, path, target.kind)) {
    throw new Error(
      `${path} appeared while \`ub init\` was writing it. Run \`ub init\` again`,
    );
  }
}

/**
 * Remove a file that may already be gone.
 *
 * ENOENT is the ordinary case — a publication consumed the name. Anything else
 * means a staging file survived, possibly holding a signing secret, and that is
 * worth one line on stderr even though there is nothing to be done about it
 * here. stderr because stdout belongs to reports and, elsewhere in this CLI, to
 * a protocol.
 */
export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `ub: warning: could not remove ${path}: ${describeFsError(error)}\n`,
      );
    }
  }
}
