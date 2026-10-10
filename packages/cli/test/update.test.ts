/**
 * `ub update` reports Homebrew results and refuses other copies unchanged.
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
import { type CaptureResult, type UpdateHost, processHost, updateCommand } from "../src/update.js";

const HELP = `usage: ub update

Update a Homebrew installation: \`brew update\`, then
\`brew upgrade uberblick-ai/tap/uberblick\`. Which copy that is comes from where
\`ub\`'s own files live, never from the current directory.

A source checkout is not updated. Run \`git pull\`, then \`mise run setup\`
to update it instead. \`ub update\` leaves the checkout unchanged.

options:
  -h, --help        show this help
`;

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
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map((name) => {
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

function formulaInfo(version: string): CaptureResult {
  return {
    status: 0,
    stdout: JSON.stringify({
      formulae: [{
        linked_keg: version,
        versions: { stable: "9.9.9" },
        installed: [{ version: "0.40.0" }, { version }],
      }],
      casks: [],
    }),
    stderr: "",
  };
}

function homebrewHost(before: CaptureResult, after: CaptureResult, prefix = "/opt/homebrew") {
  return {
    cliDir: join(prefix, "Cellar", "uberblick", "0.1.0", "libexec"),
    installPayload: true,
    capture: vi.fn<UpdateHost["capture"]>()
      .mockReturnValueOnce({ status: 0, stdout: `${prefix}\n`, stderr: "" })
      .mockReturnValueOnce(before)
      .mockReturnValueOnce(after),
    run: vi.fn<UpdateHost["run"]>().mockResolvedValue(null),
  } satisfies UpdateHost;
}

describe("ub update on Homebrew", () => {
  it.each([
    ["0.41.0", "0.42.0", "/opt/homebrew", "updated    0.41.0 → 0.42.0\nrestart ub open and running agents to use it\n"],
    ["0.42.0", "0.42.0", "/custom/homebrew", "current    0.42.0, nothing to update\n"],
    ["0.42.0", "0.42.0_1", "/custom/homebrew", "updated    0.42.0 → 0.42.0_1\nrestart ub open and running agents to use it\n"],
  ])("reports the linked installed version %s → %s", async (before, after, prefix, result) => {
    const host = homebrewHost(formulaInfo(before), formulaInfo(after), prefix);
    const io = recorder();

    expect(await updateCommand([], io, host)).toBe(0);

    expect(io.stdout).toBe(`copy       Homebrew (${prefix})\n${result}`);
    expect(io.stderr).toBe("");
  });

  it("keeps version-read diagnostics on stderr", async () => {
    const before = { ...formulaInfo("0.41.0"), stderr: "before read warning\n" };
    const after = { ...formulaInfo("0.42.0"), stderr: "after read warning\n" };
    const io = recorder();

    expect(await updateCommand([], io, homebrewHost(before, after))).toBe(0);

    expect(io.stdout).toBe("copy       Homebrew (/opt/homebrew)\nupdated    0.41.0 → 0.42.0\nrestart ub open and running agents to use it\n");
    expect(io.stderr).toBe("before read warning\nafter read warning\n");
  });

  describe.each(["before", "after"] as const)("a failed %s version read", (phase) => {
    it.each([
      ["command exit", { status: 7, stdout: "", stderr: "Homebrew failed\n" }, "exited 7"],
      ["spawn failure", { status: null, stdout: "", stderr: "brew not found\n" }, "could not be run"],
      ["invalid JSON", { status: 0, stdout: "not JSON", stderr: "" }, "did not report a linked installed version"],
      ["missing formula", { status: 0, stdout: '{"formulae":[]}', stderr: "" }, "did not report a linked installed version"],
      ["missing link", { status: 0, stdout: '{"formulae":[{"installed":[{"version":"0.42.0"}]}]}', stderr: "" }, "did not report a linked installed version"],
      ["null link", { status: 0, stdout: '{"formulae":[{"linked_keg":null}]}', stderr: "" }, "did not report a linked installed version"],
      ["empty link", { status: 0, stdout: '{"formulae":[{"linked_keg":""}]}', stderr: "" }, "did not report a linked installed version"],
      ["non-string link", { status: 0, stdout: '{"formulae":[{"linked_keg":42}]}', stderr: "" }, "did not report a linked installed version"],
    ] satisfies [string, CaptureResult, string][])("fails on %s with empty stdout", async (_scenario, failure, reason) => {
      const host = homebrewHost(
        phase === "before" ? failure : formulaInfo("0.41.0"),
        phase === "after" ? failure : formulaInfo("0.42.0"),
      );
      const io = recorder();

      expect(await updateCommand([], io, host)).toBe(1);

      expect(io.stdout).toBe("");
      expect(io.stderr).toBe(`${failure.stderr}ub update: \`brew info --json=v2 uberblick-ai/tap/uberblick\` ${reason}.\n`);
      expect(host.run).toHaveBeenCalledTimes(phase === "before" ? 0 : 2);
    });
  });

  it.each([
    ["update", 1],
    ["upgrade uberblick-ai/tap/uberblick", 2],
  ])("keeps stdout empty when brew %s fails", async (command, step) => {
    const host = homebrewHost(formulaInfo("0.41.0"), formulaInfo("0.42.0"));
    if (step === 2) host.run.mockResolvedValueOnce(null);
    host.run.mockResolvedValueOnce(`\`brew ${command}\` exited 1`);
    const io = recorder();

    expect(await updateCommand([], io, host)).toBe(1);

    expect(io.stdout).toBe("");
    expect(io.stderr).toBe(`ub update: \`brew ${command}\` exited 1.\n`);
    expect(host.run).toHaveBeenCalledTimes(step);
    expect(host.capture).toHaveBeenCalledTimes(2);
  });
});

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
    expect(io.stderr).toBe("ub update: this `ub` runs from a source checkout. Run `git pull`, then `mise run setup` to update it. Nothing has changed.\n");
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
    expect(io.stderr).toBe(`ub update: expected no arguments, got "--now"\n\n${HELP}`);
    expect(host.capture).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
  });

  it.each(["--help", "-h"])("shows Homebrew-only help for %s without running commands or changing files", async (flag) => {
    const { root, cliDir } = checkout("ref: refs/heads/main\n");
    const host = refusingHost(cliDir);
    const before = snapshot(root);
    const io = recorder();

    expect(await updateCommand([flag], io, host)).toBe(0);

    expect(io.stderr).toBe("");
    expect(io.stdout).toBe(HELP);
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
    expect(io.stderr).toBe("ub update: this `ub` is neither a Homebrew installation nor a checkout of the uberblick repository. `ub update` only updates Homebrew installations, installed with `brew install uberblick-ai/tap/uberblick`. Nothing has changed.\n");
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
