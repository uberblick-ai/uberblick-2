/**
 * `ub update` refuses source checkouts without running commands or writing files.
 *
 * The host is injected because `import.meta.url` identifies the CLI's own copy,
 * regardless of its working directory. `install-payload.test.ts` covers the
 * Homebrew path against a real payload, classifier and processes.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Io } from "../src/io.js";
import { type UpdateHost, processHost, updateCommand } from "../src/update.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A tree `findCheckoutRoot` accepts, including generated and local files. */
function checkout(head: string): { root: string; cliDir: string } {
  const root = mkdtempSync(join(tmpdir(), "uberblick-update-"));
  roots.push(root);
  writeFileSync(join(root, "mise.toml"), "[env]\n", "utf8");
  writeFileSync(join(root, "package.json"), '{ "name": "uberblick" }\n', "utf8");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), head, "utf8");
  const cliDir = join(root, "packages", "cli", "src");
  mkdirSync(cliDir, { recursive: true });
  const dist = join(root, "packages", "web", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "existing web app\n", "utf8");
  writeFileSync(join(root, "local-work.txt"), "uncommitted work\n", "utf8");
  return { root, cliDir };
}

function snapshot(root: string): unknown[] {
  return readdirSync(root, { recursive: true }).sort().map((name) => {
    const path = join(root, name);
    const stat = statSync(path);
    return [name, stat.mtimeMs, stat.isDirectory() ? null : readFileSync(path)];
  });
}

/** Any subprocess call fails the test, even a read of the current branch. */
function refusingHost(cliDir: string) {
  return {
    cliDir,
    installPayload: false,
    capture: vi.fn(() => { throw new Error("unexpected command capture"); }),
    run: vi.fn(async () => { throw new Error("unexpected command run"); }),
  } satisfies UpdateHost;
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
  it.each([
    ["main", "ref: refs/heads/main\n"],
    ["a feature branch", "ref: refs/heads/feat/something\n"],
    ["a detached HEAD", "0123456789abcdef0123456789abcdef01234567\n"],
  ])("refuses %s without running commands or changing files", async (_branch, head) => {
    const { root, cliDir } = checkout(head);
    const host = refusingHost(cliDir);
    const before = snapshot(root);
    const io = recorder();

    expect(await updateCommand([], io, host)).toBe(1);

    expect(io.stdout).toBe("");
    expect(io.stderr).toContain("source checkout");
    expect(io.stderr).toContain("`git pull`, then `mise run setup`");
    expect(io.stderr).toContain("Nothing has changed");
    expect(host.capture).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses an argument before it looks at anything", async () => {
    const { cliDir } = checkout("ref: refs/heads/main\n");
    const host = refusingHost(cliDir);
    const io = recorder();

    expect(await updateCommand(["--now"], io, host)).toBe(2);
    expect(io.stdout).toBe("");
    expect(io.stderr).toMatch(/^ub update: expected no arguments/);
    expect(host.capture).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
  });

  it("shows Homebrew-only help without running commands or changing files", async () => {
    const { root, cliDir } = checkout("ref: refs/heads/main\n");
    const host = refusingHost(cliDir);
    const before = snapshot(root);
    const io = recorder();

    expect(await updateCommand(["--help"], io, host)).toBe(0);

    expect(io.stderr).toBe("");
    expect(io.stdout).toContain("Update a Homebrew installation");
    expect(io.stdout).toContain("A source checkout is not updated");
    expect(io.stdout).toContain("`git pull`, then `mise run setup`");
    expect(host.capture).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses an unsupported copy and names Homebrew as the only update path", async () => {
    const cliDir = mkdtempSync(join(tmpdir(), "uberblick-update-unsupported-"));
    roots.push(cliDir);
    const host = refusingHost(cliDir);
    const io = recorder();

    expect(await updateCommand([], io, host)).toBe(1);

    expect(io.stdout).toBe("");
    expect(io.stderr).toContain("neither a Homebrew installation nor a checkout");
    expect(io.stderr).toContain("`ub update` only updates Homebrew installations");
    expect(host.capture).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
  });
});

describe("the commands ub update spawns", () => {
  it("passes a signal on to the child it is waiting for", async () => {
    const host = processHost();
    // Outlives the signal window, so a run that forwards nothing gives a
    // different answer instead of hanging until the suite's timeout.
    const running = host.run(process.execPath, ["-e", "setTimeout(() => {}, 3000)"]);
    await new Promise((done) => setTimeout(done, 300));
    process.emit("SIGINT", "SIGINT");

    // Emitting the event exercises forwarding without terminating Vitest.
    expect(await running).toMatch(/was killed by SIGINT/);
  });
});
