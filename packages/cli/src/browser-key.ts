/**
 * The browser's loopback key is independent of every upstream credential.
 * Keep it per workspace so a page's cached signing key survives `ub open`
 * restarts, including a restart that gains or loses hub authentication.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveStorage } from "@uberblick/hub/storage";
import { parseWorkspaceId } from "@uberblick/schema";
import { describeFsError, publishStaged, writeTempBeside } from "./safe-write.js";

function owned(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

function refusal(path: string, because: string): Error {
  return new Error(`refusing local browser key ${path}: ${because}`);
}

/** Read through one descriptor, so a swapped path cannot bypass admission. */
function readKey(path: string): string | null {
  let fd: number;
  try {
    // NONBLOCK makes a FIFO a prompt refusal rather than a hung startup.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw refusal(path, "it is a symbolic link; use a regular file you own");
    }
    throw refusal(path, describeFsError(error));
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat.uid)) {
      throw refusal(path, "it must be a regular file you own");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw refusal(path, `other users can access it; fix it with: chmod 600 ${path}`);
    }
    // Exactly one canonical 32-byte base64url key, followed by a newline.
    // Check size before reading, keeping malformed input bounded.
    if (stat.size !== 44) {
      throw refusal(path, "it is malformed; repair the stored key before running `ub open` again");
    }
    const contents = readFileSync(fd, "utf8");
    const key = contents.slice(0, -1);
    const bytes = Buffer.from(key, "base64url");
    if (!contents.endsWith("\n") || bytes.length !== 32 || bytes.toString("base64url") !== key) {
      throw refusal(path, "it is malformed; repair the stored key before running `ub open` again");
    }
    return key;
  } finally {
    closeSync(fd);
  }
}

/**
 * Load or exclusively publish the served workspace's owner-only browser key.
 * An existing key is never rewritten or regenerated: changing it would strand
 * pages kept open across a restart. Complete publication lets simultaneous
 * first launches adopt the same winner without exposing an empty file.
 */
export function localBrowserKey(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const workspace = parseWorkspaceId(workspaceId, "local browser workspace").uuid;
  const directory = join(resolveStorage({ env }).configDir, "browser-keys");
  const path = join(directory, `${workspace}.key`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || !owned(stat.uid) || (stat.mode & 0o077) !== 0) {
      throw refusal(directory, "it must be an owner-only directory you own; fix its permissions or move it aside");
    }
    const existing = readKey(path);
    if (existing !== null) return existing;
    const candidate = randomBytes(32).toString("base64url");
    const staged = writeTempBeside(path, `${candidate}\n`);
    if (publishStaged(staged, path, "absent")) return candidate;
    const winner = readKey(path);
    if (winner !== null) return winner;
    throw refusal(path, "it disappeared during creation; run `ub open` again");
  } catch (error) {
    // Filesystem errors only name the path and errno, never stored contents.
    if (error instanceof Error && error.message.startsWith("refusing local browser key ")) throw error;
    throw refusal(path, describeFsError(error));
  }
}
