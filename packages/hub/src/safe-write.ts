/**
 * Publish configuration atomically from fresh 0600 files, including replacements
 * of files with broader modes. Refuse symlink targets; link/rename publication
 * cannot write through a symlink swapped in after classification. Path-based
 * reads may follow symlinks; this module protects writes.
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

const OWNER_ONLY = 0o600;

/** Diagnostics may include paths and errno, never file contents. */
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

/** Use one no-follow descriptor so type checks refer to one inode despite name replacement. */
export function classify(path: string): Target {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    // Distinguish a refused symlink from permission failures for recovery.
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

/** writeSync may write only part of the buffer; publication requires every byte. */
function writeAll(fd: number, contents: string): void {
  const data = Buffer.from(contents, "utf8");
  let written = 0;
  while (written < data.length) {
    written += writeSync(fd, data, written, data.length - written);
  }
}

/**
 * Stage a fresh 0600 file on the target filesystem for atomic link/rename.
 * An unpredictable exclusive-create name protects staged secrets. Failed writes
 * or closes remove staging; only a returned name may survive the call.
 */
export function writeTempBeside(path: string, contents: string): string {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, "wx", OWNER_ONLY);
  // Mark before close: even a failed close releases the descriptor number,
  // so a retry could close another file.
  let closeAttempted = false;
  try {
    fchmodSync(fd, OWNER_ONLY);
    writeAll(fd, contents);
    // Close may report a deferred write error; keep it inside staging cleanup.
    closeAttempted = true;
    closeSync(fd);
  } catch (error) {
    if (!closeAttempted) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write failure; staging is removed below.
      }
    }
    removeQuietly(temp);
    throw error;
  }
  return temp;
}

/** Link claims without overwriting; rename replaces. A lost claim returns false and preserves the winner. */
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
    // Link and failed claims leave a secret-bearing staging name; rename consumes it.
    removeQuietly(staged);
  }
}

/** Atomic owner-only publication refuses symlinks, non-files, lost claims and write failures. */
export function publishOwnerOnly(
  path: string,
  contents: string,
  /** The command named in a refusal — whichever one the user actually ran. */
  command = "ub open",
): void {
  const target = classify(path);
  if (target.kind === "refused") {
    throw new Error(
      `refusing to write ${path}: ${target.because} — this file must be a ` +
        `regular file you own. Move it aside and run \`${command}\` again`,
    );
  }
  const staged = writeTempBeside(path, contents);
  if (!publishStaged(staged, path, target.kind)) {
    throw new Error(
      `${path} appeared while \`${command}\` was writing it. Run it again`,
    );
  }
}

/** Ignore consumed names; report other cleanup failures on stderr because staging may contain secrets. */
export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Keep stdout available for reports and protocols; describe the failed unlink.
      process.stderr.write(
        `ub: warning: could not remove ${path}${errno(error)}\n`,
      );
    }
  }
}
