/**
 * How `ub` writes the files it owns.
 *
 * Three of them carry configuration this command is the only writer of, and one
 * of those carries the hub signing secret. That makes two properties
 * non-negotiable, and neither is what `writeFileSync` gives you:
 *
 * **Owner-only, with no window.** A file that already exists at 0644 keeps that
 * mode through a `writeFileSync`, because `mode:` applies only on creation. So
 * the descriptor is tightened with `fchmod` *before* anything is written into
 * it, never with a `chmod` on the path afterwards — by then the secret has
 * already been in a world-readable file.
 *
 * **Never through a symlink.** `O_NOFOLLOW` makes the open fail rather than
 * write the secret into whatever somebody pointed the name at. Everything after
 * that is done on the descriptor, so what was checked and what is written are
 * the same inode: no path is resolved twice.
 *
 * Reads deliberately stay path-based. Following a symlink to read a file you own
 * is not the hazard; writing one is.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
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
  return code === undefined ? "it could not be opened" : `it could not be opened (${code})`;
}

/**
 * ELOOP is what `O_NOFOLLOW` reports for a symlink. It is worth its own message
 * everywhere it can happen: "permission denied" and "you have a symlink here"
 * lead to completely different fixes.
 */
export function isSymlinkRefusal(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ELOOP";
}

/**
 * Create or rewrite `path` as an owner-only regular file.
 *
 * @throws when the path is a symlink or is not a regular file. Both are refusals
 * rather than repairs: this module knows what it wrote there, and anything else
 * belongs to somebody who should be told rather than overwritten.
 */
export function writeOwnerOnly(path: string, contents: string): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      OWNER_ONLY,
    );
  } catch (error) {
    if (isSymlinkRefusal(error)) {
      throw new Error(
        `refusing to write ${path}: it is a symbolic link, and this file must ` +
          "be a regular file you own — remove the link and run `ub init` again",
      );
    }
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(
        `refusing to write ${path}: it is not a regular file — move it aside ` +
          "and run `ub init` again",
      );
    }
    // Tighten first, truncate second, write last. In that order there is no
    // instant at which this file holds new contents at an old, wider mode.
    fchmodSync(fd, OWNER_ONLY);
    ftruncateSync(fd, 0);
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
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
 * The name is unpredictable because it briefly holds the signing secret, and it
 * is created with `wx` so it can never land on somebody else's file.
 */
export function writeTempBeside(path: string, contents: string): string {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, "wx", OWNER_ONLY);
  try {
    fchmodSync(fd, OWNER_ONLY);
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return temp;
}

/** Remove a file that may already be gone. Used to clean up staging files. */
export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ENOENT is the ordinary case: the link or rename consumed it.
  }
}
