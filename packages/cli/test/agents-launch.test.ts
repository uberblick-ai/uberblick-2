/**
 * `ub agents launch` against real projects, as a person would run it.
 *
 * The property this file exists for cannot be observed from argv: that the
 * *caller's* project — not the directory this executable was installed into,
 * and not the other project running at the same time — supplies the role, its
 * contract, its adapter, its probe and the worktree the session runs in. So
 * both runs spawn, from a working directory outside both projects, with a fake
 * `claude` on PATH that records what it was actually handed.
 *
 * Two projects declare the same role name with different contracts, and they
 * run concurrently in both orders. What is proved here is resolution
 * isolation: no path of one project reaches the other's session. It is
 * deliberately not an operating-system or credential boundary — a runtime a
 * project declares unsandboxed can still read the machine it runs on.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, runUbAsync, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

function git(args: string[], cwd: string): void {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(ran.status, `git ${args.join(" ")}: ${ran.stderr}`).toBe(0);
}

function write(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
  if (mode !== undefined) chmodSync(path, mode);
}

/**
 * One project that has adopted a workflow: its own role name, contract, probe
 * and adapters, and a marker no other project carries.
 */
function project(root: string, name: string, contractPath: string): string {
  const control = join(root, name);
  const origin = join(root, `${name}.git`);
  mkdirSync(control, { recursive: true });
  git(["init", "--bare", origin], root);
  git(["init", "-b", "main"], control);

  write(join(control, "marker"), `${name}\n`);
  write(join(control, contractPath), `# Shipper of ${name}\n`);
  write(join(control, ".claude/agents/shipper.md"), `---\nname: shipper\n---\n${name}\n`);
  write(join(control, ".codex/agents/shipper.toml"), `name = "shipper"\n`);
  write(join(control, "probe.sh"), `#!/bin/sh\nprintf '%s\\n' "probe of ${name}" > "$PROBE_EVIDENCE"\n`, 0o755);
  write(
    join(control, ".agents/launch.json"),
    `${JSON.stringify(
      {
        version: 2,
        project: {
          baseRef: { remote: "origin", branch: "main" },
          repository: `${name}-org/${name}`,
          sessionBriefing: `Reach the ${name} corpus through this project's own MCP entry.`,
        },
        entryRoles: {
          shipper: {
            contract: contractPath,
            defaultRuntime: "claude",
            probe: ["sh", "probe.sh"],
            runtimes: {
              claude: { adapter: ".claude/agents/shipper.md", sandbox: "runtime", permissionMode: "auto" },
              codex: { adapter: ".codex/agents/shipper.toml", sandbox: "workspace-write" },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  git(["add", "-A"], control);
  git([...IDENTITY, "commit", "-m", "adopt a workflow"], control);
  git(["remote", "add", "origin", origin], control);
  git(["push", "-u", "origin", "main"], control);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: control, encoding: "utf8" });
  expect(top.status, top.stderr).toBe(0);
  return top.stdout.trim();
}

/**
 * A `claude` that answers preflight and then records its session.
 *
 * It ends on the role's own `Blocked` sentinel, which is the loop's documented
 * one-iteration stop: exactly one session runs, and nothing waits 30 minutes
 * for a second.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "--version") { process.stdout.write("fake 0.0.0\\n"); process.exit(0); }
if (process.argv[2] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true })); process.exit(0); }
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.LAUNCH_EVIDENCE, JSON.stringify({
  argv,
  prompt: argv.at(-1),
  cwd: process.cwd(),
  marker: fs.readFileSync("marker", "utf8").trim(),
  adapter: fs.readFileSync(".claude/agents/shipper.md", "utf8"),
  visible: fs.readdirSync(".").sort(),
}));
process.stdout.write("Blocked shipper: fixture stop.\\n");
`;

describe("ub agents launch, against real projects", () => {
  it("gives each project its own role, contract, probe and worktree, concurrently", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-agents-launch-"));
    try {
      // Different declared contract paths, so a launcher that reached for a
      // convention of its own instead of the project's data would be caught.
      const first = project(root, "alpha", ".agents/roles/shipper.md");
      const second = project(root, "beta", "workflow/roles/shipper.md");

      const bin = join(root, "bin");
      mkdirSync(bin);
      write(join(bin, "claude"), FAKE_CLAUDE, 0o755);
      // This test owns project selection, not process discovery. Supplying the
      // no-survivor answer keeps it valid in the immutable review image, which
      // intentionally has no host `lsof`; focused launch tests exercise the
      // real cleanup outcomes through the SessionProcesses boundary.
      write(join(bin, "lsof"), "#!/bin/sh\nexit 0\n", 0o755);

      // Outside both projects, and outside this checkout: the caller's own
      // directory decides nothing here, because `--project` does.
      const box = sandbox();
      const evidence = (name: string, other: string) => ({
        LAUNCH_EVIDENCE: join(root, `${name}.session.json`),
        PROBE_EVIDENCE: join(root, `${name}.probe.txt`),
        PATH: `${bin}:${box.env.PATH ?? ""}`,
        // These selectors name the other project on purpose. The selected
        // project must win for resolution and every Git command beneath it.
        GIT_DIR: join(other, ".git"),
        GIT_WORK_TREE: other,
      });

      const [alpha, beta] = await Promise.all([
        runUbAsync(["agents", "launch", "shipper", "--project", first], box, evidence("alpha", second), 60_000),
        runUbAsync(["agents", "launch", "shipper", "--project", second], box, evidence("beta", first), 60_000),
      ]);

      for (const [run, control, contract, other] of [
        [alpha, first, ".agents/roles/shipper.md", second],
        [beta, second, "workflow/roles/shipper.md", first],
      ] as const) {
        const name = control.endsWith("alpha") ? "alpha" : "beta";
        // The sentinel stop, so exactly one session ran.
        expect(run.status, run.output).toBe(1);
        expect(run.stdout).toContain(`ub agents launch: shipper on claude in ${control}\n`);

        const session = JSON.parse(readFileSync(join(root, `${name}.session.json`), "utf8"));
        // The assignment names this project's declared contract, at the path
        // this project chose — not a shape the CLI knows.
        expect(session.prompt).toContain(`per \`${contract}\``);
        expect(session.prompt).toContain("launched by `ub agents launch`");
        // Everything past identity is this project's own briefing, so a second
        // project is never told to reach the first one's corpus.
        expect(session.prompt).toContain(
          `Reach the ${name} corpus through this project's own MCP entry.`,
        );
        expect(session.prompt).not.toContain(
          `Reach the ${name === "alpha" ? "beta" : "alpha"} corpus`,
        );
        expect(session.argv.slice(0, 5)).toEqual([
          "-p",
          "--agent",
          "shipper",
          "--permission-mode",
          "auto",
        ]);
        // The session ran in a worktree of this project's own repository, so
        // the adapter its runtime resolves is this project's.
        expect(session.marker).toBe(name);
        expect(session.adapter).toContain(name);
        expect(session.cwd).not.toBe(control);
        // This project's probe ran, in this project.
        expect(readFileSync(join(root, `${name}.probe.txt`), "utf8").trim()).toBe(`probe of ${name}`);

        // Nothing of the other project reached this one: not its root, not its
        // contract path, not its name — in the prompt, the argv, or the
        // directory the session could see.
        const seen = JSON.stringify(session);
        expect(seen).not.toContain(other);
        expect(seen).not.toContain(control.endsWith("alpha") ? "beta" : "alpha");

        // A completed session's worktree is gone again.
        const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], {
          cwd: control,
          encoding: "utf8",
        });
        expect(worktrees.stdout.match(/^worktree /gm)).toHaveLength(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the project from the working directory when --project is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-agents-cwd-"));
    try {
      const control = project(root, "gamma", ".agents/roles/shipper.md");
      const bin = join(root, "bin");
      mkdirSync(bin);
      write(join(bin, "claude"), FAKE_CLAUDE, 0o755);

      // Deep inside the project, with no option at all: the Git root at or
      // above here is the project, and the caller never says so twice.
      const nested = join(control, "packages", "deep");
      mkdirSync(nested, { recursive: true });
      const box = sandbox();
      const run = await runUbAsync(
        ["agents", "launch", "shipper"],
        { ...box, cwd: nested },
        {
          LAUNCH_EVIDENCE: join(root, "gamma.session.json"),
          PROBE_EVIDENCE: join(root, "gamma.probe.txt"),
          PATH: `${bin}:${box.env.PATH ?? ""}`,
        },
        60_000,
      );

      expect(run.status, run.output).toBe(1);
      expect(run.stdout).toContain(`ub agents launch: shipper on claude in ${control}\n`);
      const session = JSON.parse(readFileSync(join(root, "gamma.session.json"), "utf8"));
      expect(session.marker).toBe("gamma");
      expect(session.prompt).toContain("per `.agents/roles/shipper.md`");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a directory that has adopted no workflow, naming what it looked for", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-agents-empty-"));
    try {
      git(["init", "-b", "main"], root);
      const box = sandbox();

      const missing = await runUbAsync(["agents", "launch", "shipper", "--project", root], box);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(join(root, ".agents/launch.json"));
      expect(missing.stderr).toMatch(/missing or invalid JSON/);

      const outside = mkdtempSync(join(tmpdir(), "ub-agents-nogit-"));
      const ungoverned = await runUbAsync(["agents", "launch", "shipper", "--project", outside], box);
      expect(ungoverned.status).toBe(1);
      expect(ungoverned.stderr).toContain("no Git project at or above");
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves and validates a project the same way under the `ub launch` alias", async () => {
    // `ub launch` stays a compatibility alias of this command (owner decision,
    // 2026-09-08), so the two spellings are one route: the same argv takes the
    // same project resolution and the same validation to the same exit status.
    // This is the launch path — past argv, into the selected project — stopped
    // where it stops for everyone, before any child process starts, so the
    // equivalence costs no session. The usage errors are the same equivalence
    // in `help.test.ts`.
    const root = mkdtempSync(join(tmpdir(), "ub-agents-alias-"));
    try {
      git(["init", "-b", "main"], root);
      const box = sandbox();

      const canonical = await runUbAsync(["agents", "launch", "shipper", "--project", root], box);
      const alias = await runUbAsync(["launch", "shipper", "--project", root], box);

      expect(canonical.status).toBe(1);
      expect(canonical.stderr).toContain(join(root, ".agents/launch.json"));
      expect(alias.status).toBe(canonical.status);
      expect(alias.stdout).toBe(canonical.stdout);
      expect(alias.stderr).toBe(canonical.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
