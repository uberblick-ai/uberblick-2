/**
 * `remote-update.sh`, run for real.
 *
 * The script is what makes the host follow `main` unattended, so the properties
 * worth defending are the ones nobody is watching when they fail: a build that
 * failed must be retried rather than remembered as deployed, two runs must not
 * build at once, and a commit that rewrites the updater must not tear the run
 * that is applying it in half. None of that survives being mocked, so these
 * tests give the real script a real git repository — a local bare "origin", a
 * clone standing in for the host's checkout — and a stub `remote-compose.sh`
 * committed where the real one lives, which is the only thing a checkout ever
 * invokes docker through.
 *
 * They need a util-linux `flock`, which the deployment host has and macOS does
 * not: on a host without one every case here except the two refusal cases fails,
 * with the script's own `cannot lock ...` on its stderr. That is the honest
 * answer rather than a defect — see #525, and the refusal cases themselves.
 */

import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

/**
 * An identity and no user configuration: these repositories must behave the
 * same on a machine whose global git config has hooks, templates or a default
 * branch of its own.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "uberblick tests",
  GIT_AUTHOR_EMAIL: "tests@uberblick.invalid",
  GIT_COMMITTER_NAME: "uberblick tests",
  GIT_COMMITTER_EMAIL: "tests@uberblick.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** The host's `.env`, which the updater must never touch. */
const HOST_ENV = "TAILSCALE_HOST=box.tailnet.ts.net\nHUB_AUTH_TOKEN=a-secret\n";

/**
 * Stands in for the compose wrapper: records the invocation, optionally blocks
 * until released, optionally fails.
 */
const COMPOSE_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$UB_TEST_COMPOSE_LOG"
if [ -n "\${UB_TEST_COMPOSE_HOLD:-}" ]; then
  : > "\${UB_TEST_COMPOSE_HOLD}.started"
  while [ -f "$UB_TEST_COMPOSE_HOLD" ]; do sleep 0.05; done
fi
if [ -f "$UB_TEST_COMPOSE_FAIL" ]; then exit 1; fi
exit 0
`;

function git(cwd: string, ...args: string[]): string {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (ran.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${ran.stderr}`);
  }
  return ran.stdout.trim();
}

interface Fixture {
  root: string;
  /** Where commits are authored, then pushed to the bare origin. */
  work: string;
  /** The host's checkout. */
  checkout: string;
  composeLog: string;
  failFile: string;
}

function fixture(): Fixture {
  const root = sandbox().cwd;
  const bare = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);

  const work = join(root, "work");
  git(root, "clone", "--quiet", bare, work);
  writeFileSync(join(work, "remote-compose.sh"), COMPOSE_STUB, "utf8");
  // The real updater, verbatim — the file under test.
  copyFileSync(join(REPO_ROOT, "remote-update.sh"), join(work, "remote-update.sh"));
  writeFileSync(join(work, "marker.txt"), "one\n", "utf8");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "one");
  git(work, "push", "--quiet", "origin", "main");

  const checkout = join(root, "checkout");
  git(root, "clone", "--quiet", bare, checkout);
  // What `ub remote init` leaves behind after its own build succeeded.
  git(checkout, "update-ref", "refs/uberblick/deployed", "HEAD");
  writeFileSync(join(checkout, ".env"), HOST_ENV, "utf8");

  return {
    root,
    work,
    checkout,
    composeLog: join(root, "compose.log"),
    failFile: join(root, "build-fails"),
  };
}

/** Author a new commit upstream and return its sha. */
function push(fix: Fixture, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(fix.work, name), content, "utf8");
  }
  git(fix.work, "add", "-A");
  git(fix.work, "commit", "--quiet", "-m", "next");
  git(fix.work, "push", "--quiet", "origin", "main");
  return git(fix.work, "rev-parse", "HEAD");
}

function updateEnv(fix: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...GIT_ENV,
    // The lock lives here, so each fixture locks against itself alone.
    XDG_RUNTIME_DIR: fix.root,
    UB_TEST_COMPOSE_LOG: fix.composeLog,
    UB_TEST_COMPOSE_FAIL: fix.failFile,
    ...extra,
  };
}

function update(fix: Fixture, extra: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync("sh", [join(fix.checkout, "remote-update.sh")], {
    cwd: fix.checkout,
    encoding: "utf8",
    env: updateEnv(fix, extra),
    timeout: 20_000,
  });
}

/** Every compose invocation so far, one per line. */
function builds(fix: Fixture): string[] {
  if (!existsSync(fix.composeLog)) return [];
  return readFileSync(fix.composeLog, "utf8").trimEnd().split("\n").filter(Boolean);
}

function deployedRef(fix: Fixture): string {
  return git(fix.checkout, "rev-parse", "refs/uberblick/deployed");
}

/**
 * A `PATH` standing in for a host whose `flock` cannot be trusted: absent, or
 * present and answering `status` without granting anything.
 *
 * Directories cannot simply be dropped from the real `PATH`: on Linux `flock`
 * lives beside `git`, and a run that cannot find `git` would refuse for the
 * wrong reason and prove nothing. So the shim directory names what the script
 * reaches instead — `sh` and `dirname` before the lock, `git` after it, so a
 * guard that failed to refuse would really fetch and build.
 */
function pathWithBrokenFlock(fix: Fixture, status: number | null): string {
  const bin = join(fix.root, `bin-flock-${status ?? "absent"}`);
  mkdirSync(bin, { recursive: true });
  for (const tool of ["sh", "dirname", "git"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    const resolved = found.stdout.trim();
    if (resolved === "") throw new Error(`${tool} is not on PATH`);
    symlinkSync(resolved, join(bin, tool));
  }
  if (status !== null) {
    const shim = join(bin, "flock");
    writeFileSync(shim, `#!/bin/sh\nexit ${status}\n`, "utf8");
    chmodSync(shim, 0o755);
  }
  return bin;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("remote-update.sh", () => {
  it("does nothing at all when origin/main is the deployed commit", () => {
    const fix = fixture();
    const ran = update(fix);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toMatch(/up to date at [0-9a-f]{40}/);
    expect(builds(fix)).toEqual([]);
  });

  it("builds a new commit and moves the deployed ref only after the build", () => {
    const fix = fixture();
    const next = push(fix, { "marker.txt": "two\n" });

    const ran = update(fix);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain(`deployed ${next}`);
    expect(builds(fix)).toEqual(["up --build --detach"]);
    expect(deployedRef(fix)).toBe(next);
    expect(readFileSync(join(fix.checkout, "marker.txt"), "utf8")).toBe("two\n");
  });

  /**
   * The wedged host this design exists to prevent: reset to the new commit,
   * build fails, and a run comparing against HEAD would call itself current
   * forever with the containers still on the old code.
   */
  it("retries a commit whose build failed, instead of reporting itself current", () => {
    const fix = fixture();
    const before = deployedRef(fix);
    const next = push(fix, { "marker.txt": "two\n" });
    writeFileSync(fix.failFile, "", "utf8");

    const failed = update(fix);
    expect(failed.status).not.toBe(0);
    expect(deployedRef(fix)).toBe(before);

    spawnSync("rm", [fix.failFile]);
    const retried = update(fix);
    expect(retried.status).toBe(0);
    expect(retried.stdout).not.toContain("up to date");
    expect(retried.stdout).toContain(`deployed ${next}`);
    expect(builds(fix)).toEqual(["up --build --detach", "up --build --detach"]);
    expect(deployedRef(fix)).toBe(next);
  });

  it("starts no second build while one is running", async () => {
    const fix = fixture();
    push(fix, { "marker.txt": "two\n" });
    const hold = join(fix.root, "hold");
    writeFileSync(hold, "", "utf8");

    const first = spawn("sh", [join(fix.checkout, "remote-update.sh")], {
      cwd: fix.checkout,
      env: updateEnv(fix, { UB_TEST_COMPOSE_HOLD: hold }),
    });
    const firstExit = new Promise<number | null>((resolve) => {
      first.on("close", resolve);
    });
    for (let waited = 0; !existsSync(`${hold}.started`) && waited < 200; waited += 1) {
      await sleep(50);
    }
    expect(existsSync(`${hold}.started`)).toBe(true);

    const second = update(fix);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already running");

    spawnSync("rm", [hold]);
    expect(await firstExit).toBe(0);
    expect(builds(fix)).toEqual(["up --build --detach"]);
  });

  /**
   * A guard that disables itself where its tool is missing or different is not a
   * guard, and this one failed in the direction that looks fine: an update that
   * never fetched, reset or built printed "already running" and exited 0.
   *
   * Two hosts, because the guard has to survive both shapes of the same lie: no
   * `flock` at all answers 127, and a `flock` that reports every failure as 1 —
   * busybox does, and so does any build that does not understand `-E` — answers
   * the status a naive guard reads as contention.
   */
  for (const host of [
    { what: "ships no flock", flock: null },
    { what: "has a flock that answers every failure with 1", flock: 1 },
  ]) {
    it(`refuses, and deploys nothing, on a host that ${host.what}`, () => {
      const fix = fixture();
      const before = deployedRef(fix);
      push(fix, { "marker.txt": "two\n" });

      const ran = update(fix, { PATH: pathWithBrokenFlock(fix, host.flock) });

      expect(ran.status).not.toBe(0);
      expect(`${ran.stdout}${ran.stderr}`).toContain("cannot lock");
      expect(ran.stdout).not.toContain("already running");
      expect(builds(fix)).toEqual([]);
      expect(deployedRef(fix)).toBe(before);
      expect(readFileSync(join(fix.checkout, "marker.txt"), "utf8")).toBe("one\n");
    });
  }

  /**
   * The commit being deployed replaces the running script. `git reset --hard`
   * unlinks and recreates it, so the shell keeps reading its original inode:
   * this run must finish on the code it started with, and the replacement must
   * be on disk for the next tick.
   */
  it("completes a run whose commit rewrites the updater itself", () => {
    const fix = fixture();
    const rewritten = "#!/bin/sh\nexit 42\n";
    const next = push(fix, { "remote-update.sh": rewritten });

    const ran = update(fix);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain(`deployed ${next}`);
    expect(builds(fix)).toEqual(["up --build --detach"]);
    expect(readFileSync(join(fix.checkout, "remote-update.sh"), "utf8")).toBe(rewritten);
  });

  it("keeps the host's .env byte for byte, and names what the reset discarded", () => {
    const fix = fixture();
    writeFileSync(join(fix.checkout, "marker.txt"), "edited on the host\n", "utf8");
    push(fix, { "marker.txt": "two\n" });

    const ran = update(fix);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("discarding host-local changes to tracked files");
    expect(ran.stdout).toContain("marker.txt");
    expect(readFileSync(join(fix.checkout, ".env"), "utf8")).toBe(HOST_ENV);
    expect(readFileSync(join(fix.checkout, "marker.txt"), "utf8")).toBe("two\n");
  });
});
