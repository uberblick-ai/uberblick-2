/**
 * The lock's one dangerous operation is the unlink, because the thing it removes
 * is what another process is waiting for. Everything else about it — waiting,
 * timing out, the message — is observable through `ub init` and tested there.
 */

import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { acquireInitLock, tryAcquireInitLock } from "../src/init-lock.js";
import { removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

describe("the init lock", () => {
  it("offers an immediate try for readers with a coherent fallback", async () => {
    const box = sandbox();
    const writer = await acquireInitLock(box.env);

    expect(tryAcquireInitLock(box.env)).toBeNull();

    writer.release();
    const reader = tryAcquireInitLock(box.env);
    expect(reader).not.toBeNull();
    reader?.release();
  });

  it("releases the file it created, not whatever holds the name later", async () => {
    // Somebody deletes the lock while this run is still going, and a second
    // `ub init` takes it. The name is theirs now, so releasing must not touch
    // it — otherwise "nothing removes a lock it did not create" is true only of
    // the happy path, and the second run loses its lock to the first one's
    // teardown.
    //
    // This does not depend on the filesystem declining to reuse an inode
    // number, which it is free to do: the lock holds its descriptor open, so the
    // file it created cannot be recycled while the replacement is made, and the
    // two are therefore distinguishable however the numbers fall.
    const box = sandbox();
    const lock = await acquireInitLock(box.env);
    expect(existsSync(lock.path)).toBe(true);

    rmSync(lock.path);
    writeFileSync(lock.path, "999999\n");

    lock.release();
    expect(existsSync(lock.path)).toBe(true);
    expect(readFileSync(lock.path, "utf8")).toBe("999999\n");
  });

  it("leaves a name that became a symlink alone, even one that resolves to it", async () => {
    // The case that makes `lstat` rather than `stat` load-bearing: the name is
    // replaced by a symlink pointing at another link to the lock's own file, so
    // *following* it lands on the very inode the descriptor holds. Following
    // would say "mine" and delete a name this process never created.
    const box = sandbox();
    const lock = await acquireInitLock(box.env);
    const hardLink = `${lock.path}.another-name`;
    linkSync(lock.path, hardLink);

    rmSync(lock.path);
    symlinkSync(hardLink, lock.path);

    lock.release();
    expect(lstatSync(lock.path).isSymbolicLink()).toBe(true);
    expect(existsSync(hardLink)).toBe(true);
  });

  it("removes its own lock, and only once", async () => {
    const box = sandbox();
    const lock = await acquireInitLock(box.env);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);

    // A second release is a no-op rather than an unlink of whatever is there by
    // then — `finally` blocks run in pairs more often than anyone expects.
    writeFileSync(lock.path, "someone-else\n");
    lock.release();
    expect(existsSync(lock.path)).toBe(true);
  });
});
