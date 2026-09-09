import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type LaunchServices,
  type LaunchSignals,
  type SessionProcesses,
  type SessionResult,
  LAUNCH_HELP,
  LAUNCH_OPTIONS,
  claudeSessionArgs,
  codexSessionArgs,
  createLaunchServices,
  launchAssignment,
  launchCommand,
  launchEnvironment,
  makeRunId,
  readLaunchData,
  runForeground,
} from "../src/launch.js";
import { resolveProjectRoot } from "../src/project.js";
import { REPO_ROOT, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const noWorktreeProcesses: SessionProcesses = {
  inWorktree: () => ({ pids: [] }),
  signal(pid, signal) {
    process.kill(pid, signal);
  },
};

function result(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    started: true,
    code: 0,
    signal: null,
    interrupted: null,
    lastLine: "Done: implementer codex test",
    ...overrides,
  };
}

function rig(options: {
  preflight?: string | null;
  refresh?: { detail: string; retry: boolean } | null;
  refreshes?: Array<{ detail: string; retry: boolean } | null>;
  probes?: number[];
  probeOutput?: string;
  linkBase?: string | null;
  sessions?: SessionResult[];
  waits?: Array<NodeJS.Signals | null>;
} = {}) {
  const data = readLaunchData(REPO_ROOT);
  const probes = [...(options.probes ?? [0])];
  const sessions = [...(options.sessions ?? [result({ interrupted: "SIGINT" })])];
  const waits = [...(options.waits ?? [])];
  const refreshes = [...(options.refreshes ?? [])];
  const seen = {
    dataLoads: [] as Array<string | undefined>,
    preflight: [] as Array<{ runtime: string; adapter: string }>,
    refreshes: 0,
    baseRefs: [] as string[],
    probes: [] as Array<readonly string[]>,
    sessions: [] as Array<{ role: string; runtime: string; base: string }>,
    waits: [] as number[],
    terminations: [] as NodeJS.Signals[],
  };
  const services: LaunchServices = {
    root: REPO_ROOT,
    linkBase: options.linkBase ?? null,
    loadData(activeRuntime) {
      seen.dataLoads.push(activeRuntime);
      return data;
    },
    preflight(runtime, adapter) {
      seen.preflight.push({ runtime, adapter });
      return options.preflight ?? null;
    },
    refreshMain(baseRef) {
      seen.baseRefs.push(`${baseRef.remote}/${baseRef.branch}`);
      seen.refreshes++;
      if (refreshes.length > 0) return refreshes.shift()!;
      return options.refresh ?? null;
    },
    async runProbe(command) {
      seen.probes.push(command);
      return { status: probes.shift() ?? 0, output: options.probeOutput ?? "" };
    },
    async runSession(role, runtime, _entry, project) {
      seen.sessions.push({ role, runtime, base: `${project.baseRef.remote}/${project.baseRef.branch}` });
      return sessions.shift() ?? result({ interrupted: "SIGINT" });
    },
    async wait(milliseconds) {
      seen.waits.push(milliseconds);
      return waits.length > 0 ? waits.shift()! : "SIGINT";
    },
    terminate(signal) {
      seen.terminations.push(signal);
      return false;
    },
  };
  let stdout = "";
  let stderr = "";
  return {
    services,
    seen,
    io: {
      out: (text: string) => {
        stdout += text;
      },
      err: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** One entry-role declaration, with every path the project's own to choose. */
function role(
  overrides: {
    role?: string;
    contract?: string;
    probe?: string[];
    claudeAdapter?: string;
  } = {},
) {
  const name = overrides.role ?? "implementer";
  return {
    contract: overrides.contract ?? `.agents/roles/${name}.md`,
    defaultRuntime: "codex",
    probe: overrides.probe ?? ["sh", "scripts/probe-work.sh", name],
    runtimes: {
      claude: {
        adapter: overrides.claudeAdapter ?? `.claude/agents/${name}.md`,
        sandbox: "runtime",
        permissionMode: "auto",
      },
      codex: {
        adapter: `.codex/agents/${name}.toml`,
        sandbox: "unsandboxed",
      },
    },
  };
}

/** The bindings every project must declare, as this suite's projects declare them. */
function projectBindings(overrides: Record<string, unknown> = {}) {
  return { baseRef: { remote: "origin", branch: "main" }, ...overrides };
}

/** The whole launch file for one declared role, without writing its files. */
function launchData(
  declared: ReturnType<typeof role>,
  project: Record<string, unknown> = projectBindings(),
) {
  return { version: 1, project, entryRoles: { implementer: declared } };
}

function git(root: string, args: string[]) {
  const ran = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(ran.status, ran.stderr).toBe(0);
  return ran;
}

/** Commit whatever `root` currently holds, and point `origin/main` at it. */
function commitAsOriginMain(root: string): void {
  git(root, ["init", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/main", head.stdout.trim()]);
}

/** A fake runtime that records having been started at all, and nothing else. */
function fakeRuntime(bin: string, name: string): void {
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, name);
  writeFileSync(
    executable,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.LAUNCH_EVIDENCE, process.cwd());
process.stdout.write("No eligible shipper work: test fixture.\\n");
`,
  );
  chmodSync(executable, 0o755);
}

/** A project on disk whose launch data is exactly what it declares. */
function writeProject(
  root: string,
  roles: Record<string, ReturnType<typeof role>>,
  project: Record<string, unknown> = projectBindings(),
): void {
  const launch = join(root, ".agents/launch.json");
  mkdirSync(dirname(launch), { recursive: true });
  writeFileSync(launch, `${JSON.stringify({ version: 1, project, entryRoles: roles }, null, 2)}\n`);
  for (const entry of Object.values(roles)) {
    for (const relative of [entry.contract, entry.runtimes.codex.adapter]) {
      if (relative.startsWith("..") || relative.startsWith("/")) continue;
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "declared by the project\n");
    }
  }
}

describe("ub agents launch", () => {
  it("builds a fresh runtime identity and a contract-scoped assignment", () => {
    const runId = makeRunId("codex", "implementer");
    expect(runId).toMatch(/^codex-implementer-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    const assignment = launchAssignment("implementer", runId, "contracts/roles/implementer.md");
    expect(assignment).toContain(`role \`implementer\`, run id \`${runId}\``);
    // The contract path is the project's, not a shape the CLI knows.
    expect(assignment).toContain("contracts/roles/implementer.md");
    expect(assignment).toContain("launched by `ub agents launch`");
  });

  it("hands a session the project's own briefing and none of its own", () => {
    const runId = makeRunId("claude", "implementer");
    const briefed = launchAssignment(
      "implementer",
      runId,
      "contracts/implementer.md",
      "MCP route: use the registered atlas server.",
    );
    expect(briefed).toContain("MCP route: use the registered atlas server.");
    // Identity, the project's words, and the one shape every role's final line
    // has — nothing here names a server, a tool or a command of the CLI's own.
    const bare = launchAssignment("implementer", runId, "contracts/implementer.md");
    expect(bare).not.toMatch(/uberblick|mise|mcp/i);
    expect(bare).toContain("End with the role contract's final line.");
    expect(launchAssignment("implementer", runId, "contracts/implementer.md", "   ")).toBe(bare);
  });

  it("builds argv-only Codex sessions from the declared sandbox", () => {
    const prompt = "one prompt";
    expect(codexSessionArgs("/worktree", "/last", prompt, "unsandboxed")).toEqual([
      "exec",
      "-C",
      "/worktree",
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      "/last",
      prompt,
    ]);
    expect(codexSessionArgs("/worktree", "/last", prompt, "workspace-write")).toEqual([
      "exec",
      "-C",
      "/worktree",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-o",
      "/last",
      prompt,
    ]);
    expect(() => codexSessionArgs("/worktree", "/last", prompt, "runtime")).toThrow(
      /invalid Codex sandbox/,
    );
  });

  it("adds no candidate-selection, trust or approval surface of its own", () => {
    // The whole command surface: one runtime choice and one project. A
    // candidate tree to inspect is an input a project's own role or adapter
    // supplies, so the launcher has nowhere to put one — and nothing it hands
    // a runtime widens what the project declared.
    expect(Object.keys(LAUNCH_OPTIONS).sort()).toEqual(["model", "project"]);

    const workspaceWrite = codexSessionArgs("/worktree", "/last", "prompt", "workspace-write");
    const claude = claudeSessionArgs("shipper", "prompt", "auto");
    for (const argv of [workspaceWrite, codexSessionArgs("/w", "/l", "p", "unsandboxed"), claude]) {
      for (const invented of [
        "--add-dir",
        "--candidate",
        "--ephemeral",
        "--setting-sources",
        "trust_level",
        "projects.",
      ]) {
        expect(argv.join(" "), invented).not.toContain(invented);
      }
    }
    // Every option either argv carries is a declared mode or a transport path.
    expect(claude.filter((part) => part.startsWith("--"))).toEqual([
      "--agent",
      "--permission-mode",
    ]);
    expect(workspaceWrite.filter((part) => part.startsWith("--"))).toEqual([]);
  });

  it("builds the data-owned headless Claude permission mode", () => {
    expect(claudeSessionArgs("integrator", "one prompt", "auto")).toEqual([
      "-p",
      "--agent",
      "integrator",
      "--permission-mode",
      "auto",
      "one prompt",
    ]);
    expect(() => claudeSessionArgs("integrator", "one prompt", undefined)).toThrow(
      /invalid Claude permission mode/,
    );
  });

  it("passes the tool approvals the project declared, and invents none", () => {
    // A project's checked-in runtime settings are ignored where the runtime has
    // not trusted the project, so a declared approval only reaches the session
    // as an argument. What the project did not declare is not supplied.
    expect(claudeSessionArgs("integrator", "one prompt", "auto", ["Bash(git log:*)", "Read"])).toEqual([
      "-p",
      "--agent",
      "integrator",
      "--permission-mode",
      "auto",
      "--allowedTools",
      "Bash(git log:*),Read",
      "one prompt",
    ]);
    for (const declared of [undefined, []]) {
      expect(claudeSessionArgs("integrator", "one prompt", "auto", declared)).not.toContain(
        "--allowedTools",
      );
    }
  });

  it("streams a direct child, forwards a terminal signal once, and reaps it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-child-"));
    try {
      const evidence = join(root, "signals");
      const source = new EventEmitter();
      let stdout = "";
      const pending = runForeground(
        process.execPath,
        [
          "-e",
          'const fs=require("node:fs"); process.on("SIGTERM",()=>{fs.appendFileSync(process.argv[1],"SIGTERM\\n"); setTimeout(()=>process.exit(0),10)}); process.stdout.write("ready\\n"); setInterval(()=>{},1000)',
          evidence,
        ],
        root,
        process.env,
        {
          out: (text) => {
            stdout += text;
          },
          err: () => {},
        },
        source as LaunchSignals,
        noWorktreeProcesses,
      );
      for (let attempt = 0; attempt < 100 && !stdout.includes("ready"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(stdout).toContain("ready");
      source.emit("SIGTERM");
      source.emit("SIGTERM");
      const outcome = await pending;

      expect(outcome).toMatchObject({ started: true, interrupted: "SIGTERM" });
      expect(readFileSync(evidence, "utf8")).toBe("SIGTERM\n");
      expect(source.listenerCount("SIGTERM")).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries a dying child's stderr out of the session, not only its last stdout line", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-child-"));
    try {
      let terminal = "";
      const outcome = await runForeground(
        process.execPath,
        [
          "-e",
          'process.stdout.write("thinking\\n"); process.stderr.write("codex: authentication expired\\n"); process.exitCode = 1',
        ],
        root,
        process.env,
        {
          out: (text) => {
            terminal += text;
          },
          err: (text) => {
            terminal += text;
          },
        },
        process,
        noWorktreeProcesses,
      );

      expect(outcome).toMatchObject({ started: true, code: 1, lastLine: "thinking" });
      // The one link the loop's access stop depends on.
      expect(outcome.tail).toContain("codex: authentication expired");
      expect(terminal).toContain("codex: authentication expired");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops an inherited-pipe descendant before resolving an abnormal session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-child-"));
    try {
      const evidence = join(root, "evidence");
      const descendant = join(root, "descendant.cjs");
      const leader = join(root, "leader.cjs");
      writeFileSync(
        descendant,
        `const fs = require("node:fs");
const evidence = process.argv[2];
process.on("SIGTERM", () => {
  fs.appendFileSync(evidence, "SIGTERM\\n");
  process.exit(0);
});
fs.appendFileSync(evidence, "ready\\n");
setTimeout(() => {
  fs.appendFileSync(evidence, "deadline\\n");
  process.exit(0);
}, 2000);
`,
      );
      writeFileSync(
        leader,
        `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const descendant = process.argv[2];
const evidence = process.argv[3];
spawn(process.execPath, [descendant, evidence], { stdio: "inherit" });
setTimeout(() => process.exit(24), 2000);
const ready = setInterval(() => {
  if (fs.existsSync(evidence)) {
    clearInterval(ready);
    process.exit(23);
  }
}, 10);
`,
      );

      const outcome = await runForeground(
        process.execPath,
        [leader, descendant, evidence],
        root,
        process.env,
        { out: () => {}, err: () => {} },
        process,
        noWorktreeProcesses,
      );

      expect(outcome).toMatchObject({ started: true, code: 23, interrupted: null });
      expect(readFileSync(evidence, "utf8")).toBe("ready\nSIGTERM\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("escalates and reaps a detached helper attributed to the session worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-child-"));
    const evidence = join(root, "evidence");
    const helper = join(root, "helper.cjs");
    const leader = join(root, "leader.cjs");
    let helperPid = 0;
    try {
      writeFileSync(
        helper,
        `const fs = require("node:fs");
const evidence = process.argv[2];
process.on("SIGTERM", () => fs.appendFileSync(evidence, "SIGTERM\\n"));
fs.writeFileSync(evidence, String(process.pid) + "\\n");
setInterval(() => {}, 1000);
setTimeout(() => {
  try {
    fs.rmSync(process.cwd(), { recursive: true, force: true });
  } finally {
    process.exit(0);
  }
}, 8000);
`,
      );
      writeFileSync(
        leader,
        `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const helper = process.argv[2];
const evidence = process.argv[3];
spawn(process.execPath, [helper, evidence], {
  cwd: process.cwd(),
  detached: true,
  stdio: "ignore",
}).unref();
const ready = setInterval(() => {
  if (fs.existsSync(evidence)) {
    clearInterval(ready);
    process.exit(0);
  }
}, 10);
`,
      );
      const worktreeProcesses: SessionProcesses = {
        inWorktree() {
          if (!existsSync(evidence)) return { pids: [] };
          helperPid = Number(readFileSync(evidence, "utf8").split(/\s/)[0]);
          try {
            process.kill(helperPid, 0);
            return { pids: [helperPid] };
          } catch {
            return { pids: [] };
          }
        },
        signal(pid, signal) {
          process.kill(pid, signal);
        },
      };

      const outcome = await runForeground(
        process.execPath,
        [leader, helper, evidence],
        root,
        process.env,
        { out: () => {}, err: () => {} },
        process,
        worktreeProcesses,
      );

      expect(outcome).toMatchObject({
        started: true,
        code: 0,
        interrupted: null,
        processCleanup: "terminated",
      });
      expect(readFileSync(evidence, "utf8")).toContain("SIGTERM\n");
      expect(() => process.kill(helperPid, 0)).toThrow();
    } finally {
      if (helperPid !== 0) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("does not call ordinary child shutdown an abandoned session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-child-"));
    try {
      const leader = join(root, "leader.cjs");
      writeFileSync(
        leader,
        `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => {}, 120)"], { stdio: "inherit" });
process.exit(0);
`,
      );

      const outcome = await runForeground(
        process.execPath,
        [leader],
        root,
        process.env,
        { out: () => {}, err: () => {} },
        process,
        noWorktreeProcesses,
      );

      expect(outcome).toMatchObject({ started: true, code: 0 });
      expect(outcome.processCleanup).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when session process absence cannot be established", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-child-"));
    try {
      const outcome = await runForeground(
        process.execPath,
        ["-e", "process.exit(0)"],
        root,
        process.env,
        { out: () => {}, err: () => {} },
        process,
        {
          inWorktree: () => ({ error: "test process lookup failed" }),
          signal: () => {},
        },
      );

      expect(outcome).toMatchObject({
        started: true,
        code: 0,
        processCleanup: "failed",
        detail: "test process lookup failed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers help before reading launch data or starting anything", async () => {
    let touched = false;
    const current = rig();
    current.services.loadData = () => {
      touched = true;
      throw new Error("must stay unread");
    };

    expect(await launchCommand(["implementer", "--help"], current.io, current.services)).toBe(0);
    expect(current.stdout()).toBe(LAUNCH_HELP);
    expect(current.stderr()).toBe("");
    expect(touched).toBe(false);
  });

  it("takes role defaults and an explicit --model from the launch interface", async () => {
    for (const [argv, expected] of [
      [["issue-preparer"], ["issue-preparer", "claude"]],
      [["implementer"], ["implementer", "codex"]],
      [["implementation-reviewer"], ["implementation-reviewer", "claude"]],
      [["implementation-reviewer", "--model", "codex"], ["implementation-reviewer", "codex"]],
      [["integrator", "--model", "codex"], ["integrator", "codex"]],
      [["implementer", "--model", "claude"], ["implementer", "claude"]],
    ] as const) {
      const current = rig();
      expect(await launchCommand([...argv], current.io, current.services)).toBe(130);
      expect(current.seen.sessions).toEqual([
        { role: expected[0], runtime: expected[1], base: "origin/main" },
      ]);
      expect(current.seen.preflight).toEqual([
        {
          runtime: expected[1],
          adapter: `.${expected[1]}/agents/${expected[0]}.${expected[1] === "claude" ? "md" : "toml"}`,
        },
      ]);
      expect(current.seen.dataLoads).toEqual([undefined, expected[1]]);
      expect(current.stdout()).toBe(
        `ub agents launch: ${expected[0]} on ${expected[1]} in ${REPO_ROOT}\n`,
      );
    }
  });

  it("refuses internal roles and an unknown --model before a child starts", async () => {
    for (const argv of [
      ["issue-adversary"],
      ["implementer", "--model", "gpt"],
      ["implementer", "--model"],
      ["implementer", "--codex"],
      ["implementer", "--unknown"],
    ]) {
      const current = rig();
      expect(await launchCommand(argv, current.io, current.services)).toBe(2);
      expect(current.seen.sessions).toEqual([]);
      expect(current.stderr()).toMatch(/entry role|unknown --model|Unknown option|argument missing/);
    }
  });

  it("prints one condensed line per session and idles on the role's own reason", async () => {
    const worked = rig({
      sessions: [
        result({ lastLine: "Worked implementer: issue #877 — opened PR #881" }),
        result({ lastLine: "Worked implementer: issue #12 — parked for owner decision." }),
        result({ interrupted: "SIGTERM" }),
      ],
    });
    expect(await launchCommand(["implementer"], worked.io, worked.services)).toBe(143);
    expect(worked.seen.waits).toEqual([]);
    expect(worked.stdout()).toContain("work: issue #877 — opened PR #881\n");
    expect(worked.stdout()).toContain("work: issue #12 — parked for owner decision\n");

    const unreported = rig({
      sessions: [
        result({ lastLine: "still waiting for review", transcript: "/tmp/session.log" }),
        result({ interrupted: "SIGTERM" }),
      ],
      waits: [null],
    });
    expect(await launchCommand(["implementer"], unreported.io, unreported.services)).toBe(143);
    expect(unreported.seen.waits).toEqual([5_000]);
    expect(unreported.stdout()).toContain(
      "work: implementer session reported no outcome; transcript at /tmp/session.log; retrying in 5s\n",
    );

    const empty = rig({
      sessions: [result({ lastLine: "No eligible implementer work: implementation lanes busy" })],
      waits: ["SIGINT"],
    });
    expect(await launchCommand(["implementer"], empty.io, empty.services)).toBe(130);
    expect(empty.seen.waits).toEqual([30 * 60 * 1_000]);
    expect(empty.stdout()).toContain("work: implementation lanes busy; will idle for 30min\n");
  });

  it("links item numbers only where the terminal takes a hyperlink", async () => {
    const linked = rig({
      linkBase: "https://github.com/uberblick-ai/uberblick-2",
      sessions: [result({ lastLine: "Worked integrator: PR #881 — merged." })],
      waits: ["SIGINT"],
      probes: [0, 1],
    });
    expect(await launchCommand(["integrator"], linked.io, linked.services)).toBe(130);
    expect(linked.stdout()).toContain(
      "\u001b]8;;https://github.com/uberblick-ai/uberblick-2/issues/881\u0007#881\u001b]8;;\u0007",
    );

    const plain = rig({
      sessions: [result({ lastLine: "Worked integrator: PR #881 — merged." })],
      waits: ["SIGINT"],
      probes: [0, 1],
    });
    expect(await launchCommand(["integrator"], plain.io, plain.services)).toBe(130);
    expect(plain.stdout()).toContain("work: PR #881 — merged\n");
    expect(plain.stdout()).not.toContain("\u001b");
  });

  it("uses the over-inclusive probe without turning it into queue policy", async () => {
    for (const probe of [1, 2]) {
      const current = rig({ probes: [probe], waits: ["SIGINT"] });
      expect(await launchCommand(["integrator"], current.io, current.services)).toBe(130);
      expect(current.seen.sessions).toEqual([]);
      expect(current.seen.waits).toEqual([30 * 60 * 1_000]);
      expect(current.seen.probes[0]).toEqual(["sh", "scripts/probe-work.sh", "integrator"]);
      expect(current.stdout()).toMatch(/will idle for 30min/);
    }
  });

  it("stops on a persistent access failure at every stage, and only on one", async () => {
    const refresh = rig({
      refresh: {
        detail: "could not fetch origin/main: fatal: Authentication failed for 'https://github.com/x'",
        retry: true,
      },
    });
    expect(await launchCommand(["implementer"], refresh.io, refresh.services)).toBe(1);
    expect(refresh.seen.waits).toEqual([]);
    expect(refresh.seen.sessions).toEqual([]);
    expect(refresh.stderr()).toMatch(/Authentication failed.*stopped — run `gh auth login`/);

    const probe = rig({ probes: [2], probeOutput: "gh: HTTP 401: Bad credentials\n" });
    expect(await launchCommand(["integrator"], probe.io, probe.services)).toBe(1);
    expect(probe.seen.waits).toEqual([]);
    expect(probe.stderr()).toMatch(/Bad credentials.*stopped — run `gh auth login`/);

    // A runtime that dies on its own credentials says so on stderr, which
    // never reaches the final stdout line.
    const runtime = rig({
      sessions: [
        result({
          code: 1,
          lastLine: "",
          tail:
            "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses\n",
        }),
      ],
    });
    expect(await launchCommand(["implementer"], runtime.io, runtime.services)).toBe(1);
    expect(runtime.seen.waits).toEqual([]);
    expect(runtime.seen.sessions).toHaveLength(1);
    expect(runtime.stderr()).toMatch(/401 Unauthorized.*stopped — run `codex login`/);

    // GitHub reports temporary rate limits with the same HTTP 403 shape as a
    // permission refusal. Waiting is the repair; re-authenticating is not.
    for (const output of [
      "gh: API rate limit exceeded for user ID 12345678. (HTTP 403)\n",
      "gh: You have exceeded a secondary rate limit. (HTTP 403)\n",
    ]) {
      const limited = rig({ probes: [2], probeOutput: output, waits: ["SIGINT"] });
      expect(await launchCommand(["integrator"], limited.io, limited.services)).toBe(130);
      expect(limited.seen.waits).toEqual([30 * 60 * 1_000]);
      expect(limited.stderr()).not.toMatch(/stopped|auth login/);
    }

    // A role blocked while exiting 0 says so in its own final line.
    const reported = rig({
      sessions: [result({ lastLine: "Blocked implementer: the deploy key was revoked." })],
    });
    expect(await launchCommand(["implementer"], reported.io, reported.services)).toBe(1);
    expect(reported.seen.waits).toEqual([]);
    expect(reported.stderr()).toMatch(
      /deploy key was revoked.*stopped — restore access/,
    );

    // One that reports it in loose prose instead would otherwise relaunch at
    // once, forever.
    const prose = rig({
      sessions: [
        result({
          lastLine: "Restore access before restarting.",
          tail: "GitHub permission denied.\nRestore access before restarting.\n",
        }),
      ],
    });
    expect(await launchCommand(["implementer"], prose.io, prose.services)).toBe(1);
    expect(prose.seen.sessions).toHaveLength(1);
    expect(prose.stderr()).toMatch(/permission denied.*stopped — run `gh auth login`/);

    // A role can be stopped by blocked access and still exit 0 — here inside
    // the empty-queue reason, which would otherwise idle for half an hour.
    const session = rig({
      sessions: [
        result({ lastLine: "No eligible implementer work: claude is not authenticated." }),
      ],
    });
    expect(await launchCommand(["implementer"], session.io, session.services)).toBe(1);
    expect(session.seen.waits).toEqual([]);
    expect(session.stderr()).toMatch(/not authenticated.*stopped — run `claude auth login`/);

    // A completed-work report is never mistaken for one.
    const worked = rig({
      sessions: [
        result({ lastLine: "Worked implementer: issue #388 — opened PR #900 for HTTP 401 handling." }),
        result({ interrupted: "SIGTERM" }),
      ],
    });
    expect(await launchCommand(["implementer"], worked.io, worked.services)).toBe(143);
    expect(worked.stderr()).not.toMatch(/stopped/);

    // An ordinary transient failure keeps the visible backoff.
    const transient = rig({
      refreshes: [{ detail: "could not fetch origin/main: fatal: unable to access", retry: true }, null],
      waits: [null],
    });
    expect(await launchCommand(["implementer"], transient.io, transient.services)).toBe(130);
    expect(transient.seen.waits).toEqual([5_000]);
    expect(transient.seen.sessions).toHaveLength(1);
  });

  it("backs off after transient failures and refuses a permanent refresh failure", async () => {
    const crashed = rig({
      sessions: [result({ code: 23, transcript: "/tmp/session.log" })],
      waits: ["SIGINT"],
    });
    expect(await launchCommand(["issue-preparer"], crashed.io, crashed.services)).toBe(130);
    expect(crashed.seen.waits).toEqual([5_000]);
    expect(crashed.stderr()).toMatch(/status 23.*transcript at \/tmp\/session\.log.*retrying in 5s/);

    const permanent = rig({ refresh: { detail: "run from the main checkout", retry: false } });
    expect(await launchCommand(["implementer"], permanent.io, permanent.services)).toBe(1);
    expect(permanent.seen.waits).toEqual([]);
    expect(permanent.seen.sessions).toEqual([]);
    expect(permanent.stderr()).toMatch(/main checkout/);
    expect(permanent.stderr()).not.toMatch(/retrying/);

    const preflight = rig({ preflight: "codex is not authenticated" });
    expect(await launchCommand(["implementer"], preflight.io, preflight.services)).toBe(1);
    expect(preflight.seen.sessions).toEqual([]);
    expect(preflight.seen.probes).toEqual([]);
    expect(preflight.stderr()).toMatch(/not authenticated/);
  });

  it("retries merge failures with Git's detail and permanently refuses only a non-main branch", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-refresh-"));
    try {
      const runGit = (args: string[]) =>
        spawnSync("git", args, { cwd: root, encoding: "utf8" });
      writeFileSync(join(root, "marker"), "base\n");
      for (const args of [
        ["init", "-b", "main"],
        ["add", "marker"],
        ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      ]) {
        const ran = runGit(args);
        expect(ran.status, ran.stderr).toBe(0);
      }
      const bin = join(root, ".git", "test-bin");
      mkdirSync(bin);
      const git = join(bin, "git");
      writeFileSync(
        git,
        `#!/bin/sh
case "$1" in
  fetch) exit 0 ;;
  merge) printf '%s\n' 'fatal: test fast-forward collision' >&2; exit 23 ;;
  *) PATH="$UB_TEST_GIT_PATH" exec git "$@" ;;
esac
`,
      );
      chmodSync(git, 0o755);
      const services = createLaunchServices(
        root,
        {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          UB_TEST_GIT_PATH: process.env.PATH ?? "",
        },
        { out: () => {}, err: () => {} },
      );

      writeFileSync(join(root, "marker"), "dirty\n");
      expect(services.refreshMain({ remote: "origin", branch: "main" })).toEqual({
        detail: "fatal: test fast-forward collision",
        retry: true,
      });

      expect(runGit(["switch", "-c", "topic"]).status).toBe(0);
      expect(services.refreshMain({ remote: "origin", branch: "main" })).toEqual({
        detail: "run `ub agents launch` from the project's `main` checkout",
        retry: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a retained interrupted worktree before stopping", async () => {
    const current = rig({
      sessions: [
        result({
          code: 130,
          interrupted: "SIGINT",
          detail: "session ended from SIGINT; worktree preserved at /tmp/ub-launch-test",
        }),
      ],
    });

    expect(await launchCommand(["implementer"], current.io, current.services)).toBe(130);
    expect(current.stderr()).toContain("worktree preserved at /tmp/ub-launch-test");
    expect(current.stderr()).not.toContain("retrying");
  });

  it("reports abandoned processes and stops without retry when cleanup cannot prove absence", async () => {
    const ended = rig({
      sessions: [
        result({
          processCleanup: "terminated",
          lastLine: "No eligible implementer work: test fixture.",
        }),
      ],
      waits: ["SIGINT"],
    });
    expect(await launchCommand(["implementer"], ended.io, ended.services)).toBe(130);
    expect(ended.stderr()).toContain(
      "launch: implementer codex session left processes running; ended them",
    );

    const failed = rig({
      sessions: [
        result({
          processCleanup: "failed",
          detail:
            "session processes remained reachable after SIGKILL; worktree preserved at /tmp/ub-launch-test",
        }),
      ],
    });
    expect(await launchCommand(["implementer"], failed.io, failed.services)).toBe(1);
    expect(failed.seen.sessions).toHaveLength(1);
    expect(failed.seen.waits).toEqual([]);
    expect(failed.stderr()).toContain("worktree preserved at /tmp/ub-launch-test");
    expect(failed.stderr()).toContain("; stopped");
    expect(failed.stderr()).not.toContain("retrying");
  });

  it("removes an ambient HUB_URL from the environment runtime children receive", () => {
    const box = sandbox();
    const env = launchEnvironment({ ...box.env, HUB_URL: "ws://ambient.invalid:9999" });
    expect(env.HUB_URL).toBeUndefined();
  });

  it.each([undefined, "1200000"])("runs Claude with background ceiling %s and retains at most one failed worktree", async (ceiling) => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-runtime-"));
    let preserved = "";
    try {
      const bin = join(root, "bin");
      const evidence = join(root, "evidence.json");
      const failure = join(root, "fail");
      mkdirSync(bin);
      writeFileSync(join(root, "marker"), "main\n");
      // The session reads its contract and adapter in its own worktree, so a
      // fixture that starts a runtime commits them like a real project does.
      for (const relative of [".agents/roles/issue-preparer.md", ".claude/agents/issue-preparer.md"]) {
        mkdirSync(dirname(join(root, relative)), { recursive: true });
        writeFileSync(join(root, relative), "declared by the fixture project\n");
      }
      for (const args of [
        ["init", "-b", "main"],
        ["add", "-A"],
        ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      ]) {
        const ran = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        expect(ran.status, ran.stderr).toBe(0);
      }
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
      expect(head.status, head.stderr).toBe(0);
      const remote = spawnSync("git", ["update-ref", "refs/remotes/origin/main", head.stdout.trim()], {
        cwd: root,
        encoding: "utf8",
      });
      expect(remote.status, remote.stderr).toBe(0);

      const fakeClaude = join(bin, "claude");
      writeFileSync(
        fakeClaude,
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.LAUNCH_EVIDENCE, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  hub: process.env.HUB_URL ?? null,
  backgroundWaitCeiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,
  marker: fs.readFileSync("marker", "utf8"),
}));
if (fs.existsSync(process.env.LAUNCH_FAILURE)) process.exit(23);
process.stdout.write("No eligible issue-preparer work: test fixture.\\n");
`,
      );
      chmodSync(fakeClaude, 0o755);
      let output = "";
      let processLookupFails = false;
      const sessionProcesses: SessionProcesses = {
        inWorktree: () =>
          processLookupFails ? { error: "test process lookup failed" } : { pids: [] },
        signal: () => {},
      };
      const services = createLaunchServices(
        root,
        launchEnvironment({
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HUB_URL: "ws://ambient.invalid:9999",
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: ceiling,
          LAUNCH_EVIDENCE: evidence,
          LAUNCH_FAILURE: failure,
        }),
        {
          out: (text) => {
            output += text;
          },
          err: () => {},
        },
        sessionProcesses,
      );
      const entry = readLaunchData(REPO_ROOT).entryRoles["issue-preparer"];
      expect(entry).toBeDefined();
      const outcome = await services.runSession(
        "issue-preparer",
        "claude",
        entry!,
        readLaunchData(REPO_ROOT).project,
      );
      const observed = JSON.parse(readFileSync(evidence, "utf8"));

      expect(outcome).toMatchObject({
        started: true,
        code: 0,
        lastLine: "No eligible issue-preparer work: test fixture.",
      });
      // The transcript is captured for diagnosis and kept off this terminal.
      expect(output).toBe("");
      expect(outcome.transcript).toBeDefined();
      expect(readFileSync(outcome.transcript as string, "utf8")).toContain(
        "No eligible issue-preparer work: test fixture.",
      );
      expect(observed.backgroundWaitCeiling).toBe(ceiling ?? "0");
      expect(observed.hub).not.toBe("ws://ambient.invalid:9999");
      expect(observed.cwd).not.toBe(root);
      expect(observed.marker).toBe("main\n");
      expect(observed.argv.slice(0, 5)).toEqual([
        "-p",
        "--agent",
        "issue-preparer",
        "--permission-mode",
        "auto",
      ]);
      const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(worktrees.status, worktrees.stderr).toBe(0);
      expect(worktrees.stdout.match(/^worktree /gm)).toHaveLength(1);

      writeFileSync(failure, "fail\n");
      processLookupFails = true;
      const firstFailure = await services.runSession(
        "issue-preparer",
        "claude",
        entry!,
        readLaunchData(REPO_ROOT).project,
      );
      processLookupFails = false;
      const secondFailure = await services.runSession(
        "issue-preparer",
        "claude",
        entry!,
        readLaunchData(REPO_ROOT).project,
      );
      expect(firstFailure).toMatchObject({
        started: true,
        code: 23,
        processCleanup: "failed",
      });
      expect(firstFailure.detail).toContain(
        "test process lookup failed; session exited with status 23; worktree preserved at",
      );
      expect(secondFailure).toMatchObject({ started: true, code: 23 });
      preserved = firstFailure.detail?.match(/worktree preserved at (.+)$/)?.[1] ?? "";
      expect(preserved).not.toBe("");
      expect(secondFailure.detail).toContain(`first failed worktree preserved at ${preserved}`);
      const afterFailures = spawnSync("git", ["worktree", "list", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(afterFailures.status, afterFailures.stderr).toBe(0);
      expect(afterFailures.stdout.match(/^worktree /gm)).toHaveLength(2);
    } finally {
      if (preserved !== "") {
        spawnSync("git", ["worktree", "remove", "--force", preserved], { cwd: root });
        rmSync(dirname(preserved), { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to start a session whose own worktree does not supply the validated files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-session-tree-"));
    try {
      const bin = join(root, "bin");
      const evidence = join(root, "started");
      fakeRuntime(bin, "claude");
      const sibling = join(root, "sibling");
      mkdirSync(sibling, { recursive: true });
      writeProject(sibling, { shipper: role({ role: "shipper" }) });
      const siblingAdapter = join(sibling, ".claude/agents/shipper.md");
      mkdirSync(dirname(siblingAdapter), { recursive: true });
      writeFileSync(siblingAdapter, "sibling project adapter\n");

      const services = (selected: string) =>
        createLaunchServices(
          selected,
          launchEnvironment({
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            LAUNCH_EVIDENCE: evidence,
          }),
          { out: () => {}, err: () => {} },
          noWorktreeProcesses,
        );

      // A safe uncommitted regular file masks a committed escaping symlink at
      // the same path: the control checks accept, and the fresh worktree of
      // origin/main is where the session would have read the sibling project.
      const masked = join(root, "masked");
      mkdirSync(masked);
      writeProject(masked, { shipper: role({ role: "shipper" }) });
      const maskedContract = join(masked, ".agents/roles/shipper.md");
      const maskedAdapter = join(masked, ".claude/agents/shipper.md");
      mkdirSync(dirname(maskedAdapter), { recursive: true });
      rmSync(maskedContract);
      symlinkSync(join(sibling, ".agents/roles/shipper.md"), maskedContract);
      symlinkSync(siblingAdapter, maskedAdapter);
      commitAsOriginMain(masked);
      for (const [path, text] of [
        [maskedContract, "selected project contract\n"],
        [maskedAdapter, "selected project adapter\n"],
      ] as const) {
        rmSync(path);
        writeFileSync(path, text);
      }
      expect(git(masked, ["status", "--porcelain"]).stdout).toContain(".agents/roles/shipper.md");
      const maskedEntry = readLaunchData(masked, "claude").entryRoles.shipper;
      expect(maskedEntry).toBeDefined();

      const maskedOutcome = await services(masked).runSession(
        "shipper",
        "claude",
        maskedEntry!,
        readLaunchData(masked).project,
      );
      expect(maskedOutcome).toMatchObject({ started: false, code: 1, malformed: true });
      expect(maskedOutcome.detail).toBe(
        "role contract .agents/roles/shipper.md is not a readable file inside the session's " +
          "worktree of origin/main; commit it inside the selected project before retrying",
      );
      expect(existsSync(evidence)).toBe(false);
      expect(
        git(masked, ["worktree", "list", "--porcelain"]).stdout.match(/^worktree /gm),
      ).toHaveLength(1);

      // The same divergence with nothing malicious in it: an adapter the
      // control checkout has and origin/main does not. `--agent <role>` would
      // resolve it in the worktree, where it is simply absent.
      const uncommitted = join(root, "uncommitted");
      mkdirSync(uncommitted);
      writeProject(uncommitted, { shipper: role({ role: "shipper" }) });
      commitAsOriginMain(uncommitted);
      const localAdapter = join(uncommitted, ".claude/agents/shipper.md");
      mkdirSync(dirname(localAdapter), { recursive: true });
      writeFileSync(localAdapter, "selected project adapter\n");
      const uncommittedEntry = readLaunchData(uncommitted, "claude").entryRoles.shipper;
      expect(uncommittedEntry).toBeDefined();

      const absent = await services(uncommitted).runSession(
        "shipper",
        "claude",
        uncommittedEntry!,
        readLaunchData(uncommitted).project,
      );
      expect(absent).toMatchObject({ started: false, code: 1, malformed: true });
      expect(absent.detail).toContain(
        "claude adapter .claude/agents/shipper.md is not a readable file inside the session's",
      );
      expect(existsSync(evidence)).toBe(false);
      expect(
        git(uncommitted, ["worktree", "list", "--porcelain"]).stdout.match(/^worktree /gm),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops the loop instead of retrying launch data the session tree cannot supply", async () => {
    const current = rig({
      sessions: [
        result({
          started: false,
          code: 1,
          lastLine: "",
          malformed: true,
          detail:
            "claude adapter .claude/agents/implementer.md is not a readable file inside the " +
            "session's worktree of origin/main; commit it inside the selected project before retrying",
        }),
      ],
    });

    expect(await launchCommand(["implementer"], current.io, current.services)).toBe(1);
    expect(current.seen.sessions).toHaveLength(1);
    expect(current.seen.waits).toEqual([]);
    expect(current.stderr()).toContain("worktree of origin/main");
    expect(current.stderr()).not.toContain("retrying in 5s");
  });
});

describe("launch data", () => {
  it("refuses a missing selected adapter during runtime preflight", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-preflight-"));
    try {
      const services = createLaunchServices(root, process.env, { out: () => {}, err: () => {} });
      expect(services.preflight("claude", ".claude/agents/integrator.md")).toMatch(
        /claude adapter .* is missing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses malformed data without requiring an excluded Claude adapter at runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-data-"));
    try {
      const launch = join(root, ".agents/launch.json");
      mkdirSync(dirname(launch), { recursive: true });
      writeFileSync(launch, "not json\n");
      // A refusal names the file it read, because the caller chose the project
      // and the whole failure is which project that turned out to be.
      expect(() => readLaunchData(root)).toThrow(launch);
      expect(() => readLaunchData(root)).toThrow(/invalid JSON/);

      writeFileSync(launch, JSON.stringify(launchData(role())));
      expect(() => readLaunchData(root)).toThrow(
        `names a role contract that is not a readable file: ${join(root, ".agents/roles/implementer.md")}`,
      );

      mkdirSync(join(root, ".agents/roles"), { recursive: true });
      mkdirSync(join(root, ".codex/agents"), { recursive: true });
      writeFileSync(join(root, ".agents/roles/implementer.md"), "# Implementer\n");
      writeFileSync(join(root, ".codex/agents/implementer.toml"), 'name = "implementer"\n');
      expect(readLaunchData(root).entryRoles.implementer).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses launch data that leaves the project's own bindings unsaid", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-bindings-"));
    try {
      const launch = join(root, ".agents/launch.json");
      const declared = role({ role: "shipper" });
      writeProject(root, { shipper: declared });
      const write = (project: unknown) =>
        writeFileSync(
          launch,
          `${JSON.stringify({ version: 1, project, entryRoles: { shipper: declared } })}\n`,
        );

      // No bindings at all is not "use the values some other project uses":
      // the launcher would otherwise ground, fetch and branch every session
      // against a tree nobody named.
      writeFileSync(launch, `${JSON.stringify({ version: 1, entryRoles: { shipper: declared } })}\n`);
      expect(() => readLaunchData(root)).toThrow(/must contain only version 1, a project object/);
      write({});
      expect(() => readLaunchData(root)).toThrow(/"project" must declare the bindings/);

      // The base ref is the one binding this launcher reads itself.
      for (const broken of [
        null,
        "origin/main",
        { remote: "origin" },
        { remote: "origin", branch: "main", extra: "no" },
        { remote: "or igin", branch: "main" },
        { remote: "origin/x", branch: "main" },
        { remote: "origin", branch: "-delete" },
        { remote: "origin", branch: "release/../etc" },
      ]) {
        write({ baseRef: broken });
        expect(() => readLaunchData(root), JSON.stringify(broken)).toThrow(
          /"project\.baseRef" must name a git "remote" and a "branch"/,
        );
      }

      // Everything else is shape-checked and passed through unread, so a
      // workflow may declare bindings this CLI has never heard of.
      write({ baseRef: { remote: "upstream", branch: "release/2.x" }, repository: {} });
      expect(() => readLaunchData(root)).toThrow(
        /"project\.repository" must be one value or a group of named values/,
      );
      write({ baseRef: { remote: "upstream", branch: "release/2.x" }, sessionBriefing: 7 });
      expect(() => readLaunchData(root)).toThrow(/"project\.sessionBriefing" must be text/);

      write({
        baseRef: { remote: "upstream", branch: "release/2.x" },
        repository: "atlas-ai/atlas",
        retrospectives: { implementation: 12 },
      });
      expect(readLaunchData(root).project).toEqual({
        baseRef: { remote: "upstream", branch: "release/2.x" },
        repository: "atlas-ai/atlas",
        retrospectives: { implementation: 12 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a tool approval that is not a list of tools the project grants", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-grants-"));
    try {
      const launch = join(root, ".agents/launch.json");
      const declared = role({ role: "shipper" });
      writeProject(root, { shipper: declared });
      for (const broken of ["Read", [], [""], ["Read", 7]]) {
        const granted = {
          ...declared,
          runtimes: {
            ...declared.runtimes,
            claude: { ...declared.runtimes.claude, allowedTools: broken },
          },
        };
        writeFileSync(
          launch,
          `${JSON.stringify({ version: 1, project: projectBindings(), entryRoles: { shipper: granted } })}\n`,
        );
        expect(() => readLaunchData(root), JSON.stringify(broken)).toThrow(
          /"allowedTools" must list the tools this project grants/,
        );
      }

      const granted = {
        ...declared,
        runtimes: {
          ...declared.runtimes,
          claude: { ...declared.runtimes.claude, allowedTools: ["Read", "Bash(git log:*)"] },
        },
      };
      writeFileSync(
        launch,
        `${JSON.stringify({ version: 1, project: projectBindings(), entryRoles: { shipper: granted } })}\n`,
      );
      expect(readLaunchData(root).entryRoles.shipper?.runtimes.claude.allowedTools).toEqual([
        "Read",
        "Bash(git log:*)",
      ]);
      // Declaring none stays declaring none.
      writeProject(root, { shipper: declared });
      expect(readLaunchData(root).entryRoles.shipper?.runtimes.claude.allowedTools).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fetches and branches from the base ref the project declared", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-baseref-"));
    try {
      writeProject(
        root,
        { shipper: role({ role: "shipper" }) },
        projectBindings({ baseRef: { remote: "upstream", branch: "trunk" } }),
      );
      commitAsOriginMain(root);
      const services = createLaunchServices(root, process.env, { out: () => {}, err: () => {} });
      // The checkout is on `main`, which is nothing to this project: what the
      // launcher refuses is a checkout that is not on the declared branch.
      expect(services.refreshMain({ remote: "upstream", branch: "trunk" })).toEqual({
        detail: "run `ub agents launch` from the project's `trunk` checkout",
        retry: false,
      });
      git(root, ["checkout", "-b", "trunk"]);
      expect(services.refreshMain({ remote: "upstream", branch: "trunk" })).toMatchObject({
        detail: expect.stringContaining("could not fetch upstream/trunk"),
        retry: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes the project's own paths, names and probe rather than a convention of its own", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-owned-"));
    try {
      const declared = role({
        contract: "workflow/roles/shipper.md",
        probe: ["node", "workflow/probe.mjs", "--role", "shipper"],
        role: "shipper",
      });
      writeProject(root, { shipper: declared });

      const entry = readLaunchData(root).entryRoles.shipper;
      expect(entry).toEqual({
        contract: "workflow/roles/shipper.md",
        defaultRuntime: "codex",
        probe: ["node", "workflow/probe.mjs", "--role", "shipper"],
        runtimes: {
          claude: {
            adapter: ".claude/agents/shipper.md",
            sandbox: "runtime",
            permissionMode: "auto",
          },
          codex: { adapter: ".codex/agents/shipper.toml", sandbox: "unsandboxed" },
        },
      });

      // The adapter is the one path the CLI does not take on trust: a Claude
      // session is started with `--agent <role>`, so a datum naming another
      // file would describe something no runtime opens.
      writeProject(root, { shipper: role({ role: "shipper", claudeAdapter: "workflow/claude/shipper.md" }) });
      expect(() => readLaunchData(root)).toThrow(/this runtime resolves \.claude\/agents\/shipper\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a launch datum that names a path outside the project", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-escape-"));
    try {
      for (const outside of ["../elsewhere/implementer.md", "/etc/passwd", "roles/../../out.md"]) {
        writeProject(root, { implementer: role({ contract: outside }) });
        expect(() => readLaunchData(root), outside).toThrow(/no "contract" path inside/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses launch data, contracts and adapters whose symlinks leave the project", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-symlink-"));
    try {
      const selected = join(root, "selected");
      const sibling = join(root, "sibling");
      mkdirSync(selected);
      mkdirSync(sibling);
      writeProject(selected, { implementer: role() });
      writeProject(sibling, { implementer: role() });

      const contract = join(selected, ".agents/roles/implementer.md");
      rmSync(contract);
      symlinkSync(join(sibling, ".agents/roles/implementer.md"), contract);
      expect(() => readLaunchData(selected)).toThrow(/role contract that is not a readable file/);

      rmSync(contract);
      writeProject(selected, { implementer: role() });
      const adapter = join(selected, ".codex/agents/implementer.toml");
      rmSync(adapter);
      symlinkSync(join(sibling, ".codex/agents/implementer.toml"), adapter);
      expect(() => readLaunchData(selected)).toThrow(/codex adapter that is not a readable file/);

      rmSync(adapter);
      writeProject(selected, { implementer: role() });
      const claudeAdapter = join(selected, ".claude/agents/implementer.md");
      const siblingClaudeAdapter = join(sibling, ".claude/agents/implementer.md");
      mkdirSync(dirname(claudeAdapter), { recursive: true });
      mkdirSync(dirname(siblingClaudeAdapter), { recursive: true });
      writeFileSync(claudeAdapter, "selected project adapter\n");
      writeFileSync(siblingClaudeAdapter, "sibling project adapter\n");
      expect(readLaunchData(selected, "claude").entryRoles.implementer).toBeDefined();

      // A normal fast-forward can replace the adapter after initial preflight.
      // The runtime-scoped reload must confine it again before starting work.
      rmSync(claudeAdapter);
      symlinkSync(siblingClaudeAdapter, claudeAdapter);
      expect(() => readLaunchData(selected, "claude")).toThrow(
        /claude adapter that is not a readable file/,
      );

      rmSync(claudeAdapter);
      const launch = join(selected, ".agents/launch.json");
      rmSync(launch);
      symlinkSync(join(sibling, ".agents/launch.json"), launch);
      expect(() => readLaunchData(selected)).toThrow(/not a readable file inside the selected project/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the selected project", () => {
  it("resolves the Git root at or above the working directory, and --project the same way", () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-project-"));
    try {
      const project = join(root, "project");
      const nested = join(project, "packages", "deep");
      mkdirSync(nested, { recursive: true });
      const outside = join(root, "outside");
      mkdirSync(outside);
      expect(spawnSync("git", ["init", "-b", "main"], { cwd: project }).status).toBe(0);

      // Every spelling lands on the same root, and none of them is this
      // executable's own directory.
      const real = realpathSync(project);
      expect(resolveProjectRoot(undefined, nested, process.env).project?.root).toBe(real);
      expect(resolveProjectRoot(".", project, process.env).project?.root).toBe(real);
      expect(resolveProjectRoot(project, outside, process.env).project?.root).toBe(real);
      expect(resolveProjectRoot("project/packages/deep", root, process.env).project?.root).toBe(real);

      const other = join(root, "other");
      mkdirSync(other);
      expect(spawnSync("git", ["init", "-b", "main"], { cwd: other }).status).toBe(0);
      expect(
        resolveProjectRoot(project, outside, {
          ...process.env,
          GIT_DIR: join(other, ".git"),
          GIT_WORK_TREE: other,
        }).project?.root,
      ).toBe(real);

      expect(resolveProjectRoot(undefined, outside, process.env).error).toBe(
        `no Git project at or above ${outside}`,
      );
      expect(resolveProjectRoot(join(root, "absent"), root, process.env).error).toMatch(
        /absent does not exist$/,
      );
      expect(resolveProjectRoot(join(project, ".git", "HEAD"), root, process.env).error).toMatch(
        /HEAD is not a directory$/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
