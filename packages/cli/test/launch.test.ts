import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type LaunchServices,
  type LaunchSignals,
  type SessionResult,
  LAUNCH_HELP,
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
import { REPO_ROOT, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

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
    preflight: [] as Array<{ runtime: string; adapter: string }>,
    refreshes: 0,
    probes: [] as Array<readonly string[]>,
    sessions: [] as Array<{ role: string; runtime: string }>,
    waits: [] as number[],
    terminations: [] as NodeJS.Signals[],
  };
  const services: LaunchServices = {
    root: REPO_ROOT,
    linkBase: options.linkBase ?? null,
    loadData: () => data,
    preflight(runtime, adapter) {
      seen.preflight.push({ runtime, adapter });
      return options.preflight ?? null;
    },
    refreshMain() {
      seen.refreshes++;
      if (refreshes.length > 0) return refreshes.shift()!;
      return options.refresh ?? null;
    },
    async runProbe(command) {
      seen.probes.push(command);
      return { status: probes.shift() ?? 0, output: options.probeOutput ?? "" };
    },
    async runSession(role, runtime) {
      seen.sessions.push({ role, runtime });
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

describe("ub launch", () => {
  it("builds a fresh runtime identity and a contract-scoped assignment", () => {
    const runId = makeRunId("codex", "implementer");
    expect(runId).toMatch(/^codex-implementer-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    expect(launchAssignment("implementer", runId)).toContain(
      `role \`implementer\`, run id \`${runId}\``,
    );
    expect(launchAssignment("implementer", runId)).toContain(
      ".agents/roles/implementer.md",
    );
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
      );

      expect(outcome).toMatchObject({ started: true, code: 23, interrupted: null });
      expect(readFileSync(evidence, "utf8")).toBe("ready\nSIGTERM\n");
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
      [["integrator", "--model", "codex"], ["integrator", "codex"]],
      [["implementer", "--model", "claude"], ["implementer", "claude"]],
    ] as const) {
      const current = rig();
      expect(await launchCommand([...argv], current.io, current.services)).toBe(130);
      expect(current.seen.sessions).toEqual([{ role: expected[0], runtime: expected[1] }]);
      expect(current.seen.preflight).toEqual([
        {
          runtime: expected[1],
          adapter: `.${expected[1]}/agents/${expected[0]}.${expected[1] === "claude" ? "md" : "toml"}`,
        },
      ]);
      expect(current.stdout()).toBe(`ub launch: ${expected[0]} on ${expected[1]}\n`);
    }
  });

  it("refuses internal roles and an unknown --model before a child starts", async () => {
    for (const argv of [
      ["implementation-reviewer"],
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
      expect(services.refreshMain()).toEqual({
        detail: "fatal: test fast-forward collision",
        retry: true,
      });

      expect(runGit(["switch", "-c", "topic"]).status).toBe(0);
      expect(services.refreshMain()).toEqual({
        detail: "run `ub launch` from the repository's `main` checkout",
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

  it("removes an ambient HUB_URL from the environment runtime children receive", () => {
    const box = sandbox();
    const env = launchEnvironment({ ...box.env, HUB_URL: "ws://ambient.invalid:9999" });
    expect(env.HUB_URL).toBeUndefined();
  });

  it("runs Claude in a fresh worktree and retains at most one failed worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ub-launch-runtime-"));
    let preserved = "";
    try {
      const bin = join(root, "bin");
      const evidence = join(root, "evidence.json");
      const failure = join(root, "fail");
      mkdirSync(bin);
      writeFileSync(join(root, "marker"), "main\n");
      for (const args of [
        ["init", "-b", "main"],
        ["add", "marker"],
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
  marker: fs.readFileSync("marker", "utf8"),
}));
if (fs.existsSync(process.env.LAUNCH_FAILURE)) process.exit(23);
process.stdout.write("No eligible issue-preparer work: test fixture.\\n");
`,
      );
      chmodSync(fakeClaude, 0o755);
      let output = "";
      const services = createLaunchServices(
        root,
        launchEnvironment({
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HUB_URL: "ws://ambient.invalid:9999",
          LAUNCH_EVIDENCE: evidence,
          LAUNCH_FAILURE: failure,
        }),
        {
          out: (text) => {
            output += text;
          },
          err: () => {},
        },
      );
      const entry = readLaunchData(REPO_ROOT).entryRoles["issue-preparer"];
      expect(entry).toBeDefined();
      const outcome = await services.runSession("issue-preparer", "claude", entry!);
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
      const firstFailure = await services.runSession("issue-preparer", "claude", entry!);
      const secondFailure = await services.runSession("issue-preparer", "claude", entry!);
      expect(firstFailure).toMatchObject({ started: true, code: 23 });
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
      expect(() => readLaunchData(root)).toThrow(/invalid JSON/);

      writeFileSync(
        launch,
        JSON.stringify({
          version: 1,
          entryRoles: {
            implementer: {
              contract: ".agents/roles/implementer.md",
              defaultRuntime: "codex",
              probe: ["sh", "scripts/probe-work.sh", "implementer"],
              runtimes: {
                claude: {
                  adapter: ".claude/agents/implementer.md",
                  sandbox: "runtime",
                  permissionMode: "auto",
                },
                codex: { adapter: ".codex/agents/implementer.toml", sandbox: "unsandboxed" },
              },
            },
          },
        }),
      );
      expect(() => readLaunchData(root)).toThrow(/readable role contract/);

      mkdirSync(join(root, ".agents/roles"), { recursive: true });
      mkdirSync(join(root, ".codex/agents"), { recursive: true });
      writeFileSync(join(root, ".agents/roles/implementer.md"), "# Implementer\n");
      writeFileSync(join(root, ".codex/agents/implementer.toml"), 'name = "implementer"\n');
      expect(readLaunchData(root).entryRoles.implementer).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
