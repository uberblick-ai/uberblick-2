/**
 * `ub update` on a checkout.
 *
 * These cases inject the host rather than spawning `ub`, and that is forced
 * rather than preferred: the command decides which copy to update from
 * `import.meta.url`, so a spawned `ub` — even one run in a fixture directory —
 * would resolve to *this* checkout and the test would be a test of the
 * repository it runs in. The Homebrew half is the other way round, and
 * `install-payload.test.ts` proves it against a real payload, a real
 * classifier and real processes.
 *
 * What is defended here is the order of the steps, that git alone decides
 * whether the fast-forward happens, that the refresh is unconditional, and that
 * a failed step is named and left to be retried.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildLockPath } from "../src/build-lock.js";
import type { Io } from "../src/io.js";
import { type CaptureResult, type UpdateHost, updateCommand } from "../src/update.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A tree `findCheckoutRoot` accepts, with the CLI's own files inside it. */
function checkout(): { root: string; cliDir: string } {
  const root = mkdtempSync(join(tmpdir(), "uberblick-update-"));
  roots.push(root);
  writeFileSync(join(root, "mise.toml"), "[env]\n", "utf8");
  writeFileSync(join(root, "package.json"), '{ "name": "uberblick" }\n', "utf8");
  const cliDir = join(root, "packages", "cli", "src");
  mkdirSync(cliDir, { recursive: true });
  return { root, cliDir };
}

interface Call {
  label: string;
  cwd: string | undefined;
}

interface Fake {
  host: UpdateHost;
  calls: Call[];
  labels: () => string[];
}

/**
 * A host that records every command and runs none of them.
 *
 * `branch` answers `git branch --show-current`; `fails` turns one command into
 * a failure, by the same label the assertions use.
 */
function fake(
  cliDir: string,
  options: {
    branch?: CaptureResult;
    fails?: (label: string) => string | null;
    onRun?: (label: string) => void;
  } = {},
): Fake {
  const calls: Call[] = [];
  const host: UpdateHost = {
    cliDir,
    installPayload: false,
    capture(command, args) {
      calls.push({ label: [command, ...args].join(" "), cwd: undefined });
      return options.branch ?? { status: 0, stdout: "main\n", stderr: "" };
    },
    run(command, args, cwd) {
      const label = [command, ...args].join(" ");
      calls.push({ label, cwd });
      options.onRun?.(label);
      return Promise.resolve(options.fails?.(label) ?? null);
    },
  };
  return { host, calls, labels: () => calls.map((call) => call.label) };
}

function recorder(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out(text: string) {
      io.stdout += text;
    },
    err(text: string) {
      io.stderr += text;
    },
  };
  return io;
}

describe("ub update on a checkout", () => {
  it("fast-forwards, then refreshes both generated outputs under the build lock", async () => {
    const { root, cliDir } = checkout();
    const lock = buildLockPath(join(root, "packages", "web", "dist"));
    let heldDuringBuild: boolean | null = null;
    // The refresh runs whatever the merge did — this fake reports success for a
    // merge that moved nothing, which is the already-current case, and both
    // steps still run. That absent conditional is what makes the next run after
    // a failed build a repair rather than a false "up to date".
    const { host, calls, labels } = fake(cliDir, {
      onRun: (label) => {
        if (label === "mise run build-web") heldDuringBuild = existsSync(lock);
      },
    });
    const io = recorder();

    expect(await updateCommand([], io, host)).toBe(0);

    expect(labels()).toEqual([
      `git -C ${root} branch --show-current`,
      `git -C ${root} fetch origin main`,
      `git -C ${root} merge --ff-only origin/main`,
      "mise run install",
      "mise run build-web",
    ]);
    expect(calls.at(-1)?.cwd).toBe(root);
    // `ub open` rebuilds the same directory, and Vite empties it first (#512).
    expect(heldDuringBuild).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(io.stdout).toContain(root);
    expect(io.stderr).toBe("");
  });

  it("updates only `main`, and names what it found instead", async () => {
    for (const [stdout, named] of [
      ["feat/something\n", "`feat/something`"],
      ["\n", "a detached HEAD"],
    ]) {
      const { root, cliDir } = checkout();
      const { host, labels } = fake(cliDir, {
        branch: { status: 0, stdout: stdout ?? "", stderr: "" },
      });
      const io = recorder();

      expect(await updateCommand([], io, host)).toBe(1);
      expect(io.stderr).toContain(named ?? "");
      expect(io.stderr).toContain("Nothing has changed");
      expect(labels()).toEqual([`git -C ${root} branch --show-current`]);
    }
  });

  it("lets git refuse the fast-forward, and stops there", async () => {
    for (const step of ["fetch origin main", "merge --ff-only origin/main"]) {
      const { root, cliDir } = checkout();
      const refused = `git -C ${root} ${step}`;
      const { host, labels } = fake(cliDir, {
        fails: (label) => (label === refused ? `\`${label}\` exited 1` : null),
      });
      const io = recorder();

      expect(await updateCommand([], io, host)).toBe(1);
      expect(io.stderr).toContain("the checkout is unchanged");
      // Nothing after the refusal: no install, no build.
      expect(labels().at(-1)).toBe(refused);
    }
  });

  it("names a failed refresh step and leaves it to be retried", async () => {
    for (const step of ["mise run install", "mise run build-web"]) {
      const { cliDir } = checkout();
      const { host, labels } = fake(cliDir, {
        fails: (label) => (label === step ? `\`${label}\` exited 1` : null),
      });
      const io = recorder();

      expect(await updateCommand([], io, host)).toBe(1);
      expect(io.stderr).toContain(step);
      expect(io.stderr).toContain("run `ub update` again");
      expect(labels().at(-1)).toBe(step);
    }
  });

  it("refuses an argument before it looks at anything", async () => {
    const { cliDir } = checkout();
    const { host, labels } = fake(cliDir);
    const io = recorder();

    expect(await updateCommand(["--now"], io, host)).toBe(2);
    expect(io.stdout).toBe("");
    expect(io.stderr).toMatch(/^ub update: expected no arguments/);
    expect(labels()).toEqual([]);
  });
});
