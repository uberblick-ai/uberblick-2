/**
 * Publish configuration atomically from fresh owner-only files. Writers refuse
 * symlinks; link/rename publication replaces names without following them, even
 * if a symlink appears after classification. Reads may still follow symlinks.
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

/**
 * Diagnostics may expose paths and errno, never file contents.
 */
function errno(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? "" : ` (${code})`;
}

/** Why a path could not be opened. Only ever used for a failed open. */
export function describeFsError(error: unknown): string {
  return `it could not be opened${errno(error)}`;
}

/** What a path holds, as far as this module is willing to write to it. */
export type Target =
  | { kind: "absent" }
  | { kind: "regular" }
  | { kind: "refused"; because: string };

/**
 * Classify one opened inode with `O_NOFOLLOW`, avoiding path-check races.
 */
export function classify(path: string): Target {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    // Distinguish symlink refusal from permission failures for recovery.
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
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
 * `writeSync` may write fewer bytes than requested; complete the entire buffer.
 */
function writeAll(fd: number, contents: string): void {
  const data = Buffer.from(contents, "utf8");
  let written = 0;
  while (written < data.length) {
    written += writeSync(fd, data, written, data.length - written);
  }
}

/**
 * Stage beside the target for same-filesystem atomic publication. An unpredictable
 * exclusive name and chmod protect secret bytes even if the target had wider modes.
 * Write and deferred close failures attempt cleanup of the unreturned staging name.
 */
export function writeTempBeside(path: string, contents: string): string {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, "wx", OWNER_ONLY);
  // Mark before close: POSIX releases the fd even on error, so never retry it.
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
        // Preserve the write error and still remove the secret staging file.
      }
    }
    removeQuietly(temp);
    throw error;
  }
  return temp;
}

/**
 * Link an absent target without overwriting a racing winner; rename replaces
 * a regular target atomically. A lost claim returns false.
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
    // Link or a lost claim leaves secret bytes under this staging name.
    removeQuietly(staged);
  }
}

/**
 * Refuse symlinks and non-files; a competing creator or write failure throws.
 * Accepted targets receive an atomic owner-only replacement.
 */
export function publishOwnerOnly(
  path: string,
  contents: string,
  /** The command named in a refusal; omitted callers use a neutral retry hint. */
  command?: string,
): void {
  const target = classify(path);
  if (target.kind === "refused") {
    const retry = command === undefined
      ? "run the same command again"
      : `run \`${command}\` again`;
    throw new Error(
      `refusing to write ${path}: ${target.because} — this file must be a ` +
        `regular file you own. Move it aside and ${retry}`,
    );
  }
  const staged = writeTempBeside(path, contents);
  if (!publishStaged(staged, path, target.kind)) {
    const writer = command === undefined ? "this command" : `\`${command}\``;
    throw new Error(
      `${path} appeared while ${writer} was writing it. Run it again`,
    );
  }
}

/**
 * Ignore an already-consumed name; other failures may leave secret staging bytes
 * and must warn on stderr, keeping stdout available to reports and protocols.
 */
export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Name the failed unlink operation without revealing contents.
      process.stderr.write(
        `ub: warning: could not remove ${path}${errno(error)}\n`,
      );
    }
  }
}
