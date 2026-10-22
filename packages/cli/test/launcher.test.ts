/**
 * `bin/ub.mjs` — the launcher a checkout actually ships.
 *
 * Every other spawning suite here runs the bundle `test/global-setup.ts` builds,
 * because paying for a tsx registration and a fresh transpile of three packages
 * in each of several hundred children adds substantial startup time. The
 * shipped launcher needs a test of its own because it owns two observable
 * contracts a built entry does not inherit — a bundle can be green while the
 * file a user runs is broken.
 *
 * The two:
 *
 * 1. **It resolves `tsx` relative to itself**, so `ub` works from anywhere. A
 *    `#!/usr/bin/env -S node --import tsx` shebang would resolve `tsx` against
 *    the *caller's* working directory instead; this suite runs from a temp
 *    directory that has no `node_modules` at all, so a regression there is an
 *    immediate failure rather than a surprise for whoever first runs `ub`
 *    outside the checkout.
 * 2. **It reaches the stderr warning policy** in `src/warnings.ts`: the one
 *    unactionable warning is dropped and every other still printed. Both halves
 *    are driven here rather than inferred, and by a warning this test raises
 *    itself, so the assertion does not depend on which warnings a given Node
 *    build happens to emit.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PACKAGE_ROOT, REPO_ROOT, SHIPPED_UB, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

describe("bin/ub.mjs", () => {
  it("runs from outside the checkout, and drops one warning while printing the rest", () => {
    const box = sandbox();
    // An archive-shaped copy runs this checkout's shim and source instead of
    // selecting a linked worktree's primary checkout during the test.
    const archive = join(box.cwd, "archive");
    const cli = join(archive, "packages", "cli");
    const launcher = join(cli, "bin", "ub.mjs");
    mkdirSync(join(cli, "bin"), { recursive: true });
    copyFileSync(SHIPPED_UB, launcher);
    symlinkSync(join(PACKAGE_ROOT, "src"), join(cli, "src"), "dir");
    symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(cli, "node_modules"), "dir");
    symlinkSync(join(PACKAGE_ROOT, "tsconfig.json"), join(cli, "tsconfig.json"), "file");
    symlinkSync(join(REPO_ROOT, "tsconfig.base.json"), join(archive, "tsconfig.base.json"), "file");

    // `--import`, not `NODE_OPTIONS`: tsx runs its module hooks on a worker
    // thread, and NODE_OPTIONS reaches that thread too — the probe would run
    // twice and one copy would print through Node's own listener, which is a
    // property of tsx rather than of anything `ub` decides.
    const probe = join(box.cwd, "warning-probe.mjs");
    writeFileSync(
      probe,
      // The first is the genuine article's name and text — lib0 reads
      // `localStorage` at import time and Node warns that
      // `--localstorage-file` was not passed. Raising it here as well as
      // letting the real one fire means this case still says something if the
      // dependency ever stops emitting it.
      'process.emitWarning("localStorage is not available because --localstorage-file was not provided.", "ExperimentalWarning");\n' +
        'process.emitWarning("a warning ub did not raise", "ProbeWarning");\n',
      "utf8",
    );

    const run = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(probe).href, launcher, "--version"],
      { cwd: box.cwd, env: box.env, encoding: "utf8", timeout: 25_000 },
    );

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);

    // Dropped: neither the one this test raised nor the one lib0 raises for
    // real on the way to `cliVersion` — `ub --version` loads the whole eager
    // graph, yjs included.
    expect(run.stderr).not.toMatch(/localStorage/);

    // Kept, and kept by *our* listener: Node's own prints `(node:<pid>) ` in
    // front, and `src/warnings.ts` removes that listener before adding this
    // one. So the absence of the prefix is what says the policy is in force
    // rather than merely harmless.
    expect(run.stderr).toContain("ProbeWarning: a warning ub did not raise");
    expect(run.stderr).not.toMatch(/\(node:\d+\)/);
  });
});
