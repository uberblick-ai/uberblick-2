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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DIGEST_FRAMING, payloadDigest, type WorkflowPackageEntry } from "../src/workflow-package.js";
import { removeTempDirs, runUb, runUbAsync, sandbox } from "./helpers.js";

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

function workflowPackage(root: string, marker: string, version = "1.2.3"): string {
  const directory = join(root, `workflow-${version}`);
  const files = {
    ".agents/roles/shipper.md": `# Stored contract ${marker}\n`,
    ".claude/agents/shipper.md":
      `---\nname: shipper\ndescription: Stored adapter ${marker}\n---\n\nFollow stored adapter ${marker}.\n`,
    ".codex/agents/shipper.toml":
      `name = "shipper"\ndeveloper_instructions = """Follow stored adapter ${marker}."""\n`,
    "probe.sh": `#!/bin/sh\nprintf '%s\\n' "stored probe ${marker}" > "$PROBE_EVIDENCE"\n`,
  };
  const entries: WorkflowPackageEntry[] = Object.entries(files)
    .map(([path, content]) => ({
      path,
      mode: path === "probe.sh" ? "100755" as const : "100644" as const,
      content: Buffer.from(content),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  for (const entry of entries) {
    write(join(directory, "payload", entry.path), entry.content.toString("utf8"), entry.mode === "100755" ? 0o755 : 0o644);
  }
  write(
    join(directory, "manifest.json"),
    `${JSON.stringify({
      manifestVersion: 1,
      workflow: "uberblick-workflow",
      version,
      source: { repository: "fixture/workflow", commit: "1".repeat(40) },
      digest: { algorithm: "sha256", framing: DIGEST_FRAMING, payload: payloadDigest(entries) },
      payload: entries.map(({ path, mode }) => ({ path, mode })),
    }, null, 2)}\n`,
  );
  return directory;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
const path = require("node:path");
if (process.argv[2] === "--version") { process.stdout.write("fake 0.0.0\\n"); process.exit(0); }
if (process.argv[2] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true })); process.exit(0); }
const argv = process.argv.slice(2);
const context = JSON.parse(process.env.UB_AGENT_SESSION_CONTEXT);
const custom = argv.indexOf("--agents");
const contractRef = /per \`([^\`]+)\`/.exec(argv.at(-1))[1];
fs.writeFileSync(process.env.LAUNCH_EVIDENCE, JSON.stringify({
  argv,
  prompt: argv.at(-1),
  cwd: process.cwd(),
  marker: fs.readFileSync("marker", "utf8").trim(),
  context,
  adapter: custom === -1
    ? fs.readFileSync(".claude/agents/shipper.md", "utf8")
    : JSON.parse(argv[custom + 1]).shipper.prompt,
  contract: fs.readFileSync(path.isAbsolute(contractRef) ? contractRef : path.join(process.cwd(), contractRef), "utf8"),
  visible: fs.readdirSync(".").sort(),
}));
if (process.env.SESSION_READY) {
  fs.writeFileSync(process.env.SESSION_READY, "ready\\n");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(process.env.SESSION_CONTINUE)) Atomics.wait(wait, 0, 0, 25);
}
process.stdout.write("Blocked shipper: fixture stop.\\n");
`;

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "--version") { process.stdout.write("fake 0.0.0\\n"); process.exit(0); }
if (process.argv[2] === "login") process.exit(0);
const argv = process.argv.slice(2);
const context = JSON.parse(process.env.UB_AGENT_SESSION_CONTEXT);
fs.writeFileSync(process.env.CODEX_EVIDENCE, JSON.stringify({ argv, context }));
const output = argv[argv.indexOf("-o") + 1];
fs.writeFileSync(output, "Blocked shipper: fixture stop.\\n");
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
        expect(run.stdout).toContain(
          `ub agents launch: shipper on claude in ${control}; workflow project-tree fallback\n`,
        );

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

  it("loads the stored contract and adapter while keeping the project-declared probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-agents-external-"));
    try {
      const control = project(root, "external", ".agents/roles/shipper.md");
      const pkg = workflowPackage(root, "outside-project");
      for (const path of [
        ".agents/roles/shipper.md",
        ".claude/agents/shipper.md",
        ".codex/agents/shipper.toml",
      ]) {
        rmSync(join(control, path));
      }
      git(["add", "-A"], control);
      git([...IDENTITY, "commit", "-m", "keep workflow outside project"], control);
      git(["push", "origin", "main"], control);

      const box = sandbox();
      const installed = runUb(["agents", "install", pkg, "--project", control], box);
      expect(installed.status, installed.output).toBe(0);
      for (const path of [
        ".agents/roles/shipper.md",
        ".claude/agents/shipper.md",
        ".codex/agents/shipper.toml",
      ]) {
        expect(() => readFileSync(join(control, path))).toThrow();
      }

      const bin = join(root, "bin");
      mkdirSync(bin);
      write(join(bin, "claude"), FAKE_CLAUDE, 0o755);
      write(join(bin, "codex"), FAKE_CODEX, 0o755);
      write(join(bin, "lsof"), "#!/bin/sh\nexit 0\n", 0o755);
      const evidence = join(root, "external.session.json");
      const probe = join(root, "external.probe.txt");
      const ready = join(root, "external.ready");
      const proceed = join(root, "external.continue");
      const launching = runUbAsync(
        ["agents", "launch", "shipper", "--project", control],
        box,
        {
          LAUNCH_EVIDENCE: evidence,
          PROBE_EVIDENCE: probe,
          SESSION_READY: ready,
          SESSION_CONTINUE: proceed,
          PATH: `${bin}:${box.env.PATH ?? ""}`,
        },
        60_000,
      );
      await waitForFile(ready);
      const replacement = workflowPackage(root, "replacement", "2.0.0");
      expect(runUb(["agents", "install", replacement, "--project", control], box).status).toBe(0);
      write(proceed, "continue\n");
      const launched = await launching;
      expect(launched.status, launched.output).toBe(1);
      const session = JSON.parse(readFileSync(evidence, "utf8"));
      expect(session.adapter).toContain("Follow stored adapter outside-project");
      expect(session.contract).toContain("Stored contract outside-project");
      expect(readFileSync(probe, "utf8")).toContain("probe of external");
      expect(session.prompt).toContain(join(session.context.workflowRoot, ".agents/roles/shipper.md"));
      expect(session.context.projectRoot).toBe(control);
      expect(session.context.workflowRoot).not.toBe(control);
      expect(session.context.bindings.baseRef).toEqual({ remote: "origin", branch: "main" });
      expect(session.argv.slice(0, 5)).toEqual(["-p", "--agents", session.argv[2], "--agent", "shipper"]);

      const codexEvidence = join(root, "external.codex.json");
      const codex = await runUbAsync(
        ["agents", "launch", "shipper", "--model", "codex", "--project", control],
        box,
        {
          CODEX_EVIDENCE: codexEvidence,
          PROBE_EVIDENCE: probe,
          PATH: `${bin}:${box.env.PATH ?? ""}`,
        },
        60_000,
      );
      expect(codex.status, codex.output).toBe(1);
      const codexSession = JSON.parse(readFileSync(codexEvidence, "utf8"));
      expect(codexSession.argv).toContain(
        'developer_instructions="Follow stored adapter replacement."',
      );
      expect(codexSession.context.projectRoot).toBe(session.context.projectRoot);
      expect(codexSession.context.workflowRoot).not.toBe(session.context.workflowRoot);

      rmSync(join(control, "probe.sh"));
      const missingProbeEvidence = join(root, "missing-probe.codex.json");
      const missingProbe = await runUbAsync(
        ["agents", "launch", "shipper", "--model", "codex", "--project", control],
        box,
        {
          CODEX_EVIDENCE: missingProbeEvidence,
          PROBE_EVIDENCE: probe,
          PATH: `${bin}:${box.env.PATH ?? ""}`,
        },
        60_000,
      );
      expect(missingProbe.status, missingProbe.output).toBe(1);
      expect(missingProbe.stderr).toContain(`declares a probe path that is not a readable file in ${control}`);
      expect(missingProbe.stderr).toContain("probe.sh");
      expect(existsSync(missingProbeEvidence)).toBe(false);
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
      expect(run.stdout).toContain(
        `ub agents launch: shipper on claude in ${control}; workflow project-tree fallback\n`,
      );
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
