/**
 * The lock's one dangerous operation is the unlink, because the thing it removes
 * is what another process is waiting for. Everything else about it — waiting,
 * timing out, the message — is observable through `ub init` and tested there.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { acquireInitLock } from "../src/init-lock.js";
import { removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

describe("the init lock", () => {
  it("releases the file it created, not whatever holds the name later", async () => {
    // Somebody deletes the lock while this run is still going, and a second
    // `ub init` takes it. The name is theirs now, so releasing must not touch
    // it — otherwise "nothing removes a lock it did not create" is true only of
    // the happy path, and the second run loses its lock to the first one's
    // teardown.
    const box = sandbox();
    const lock = await acquireInitLock(box.env);
    expect(existsSync(lock.path)).toBe(true);

    rmSync(lock.path);
    writeFileSync(lock.path, "999999\n");

    lock.release();
    expect(existsSync(lock.path)).toBe(true);
    expect(readFileSync(lock.path, "utf8")).toBe("999999\n");
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
