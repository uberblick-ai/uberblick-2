import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type LaunchServices,
  type LaunchSignals,
  type SessionResult,
  LAUNCH_HELP,
  codexSessionArgs,
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
  refresh?: string | null;
  probes?: number[];
  sessions?: SessionResult[];
  waits?: Array<NodeJS.Signals | null>;
} = {}) {
  const data = readLaunchData(REPO_ROOT);
  const probes = [...(options.probes ?? [0])];
  const sessions = [...(options.sessions ?? [result({ interrupted: "SIGINT" })])];
  const waits = [...(options.waits ?? [])];
  const seen = {
    preflight: [] as string[],
    refreshes: 0,
    probes: [] as Array<readonly string[]>,
    sessions: [] as Array<{ role: string; runtime: string }>,
    waits: [] as number[],
    terminations: [] as NodeJS.Signals[],
  };
  const services: LaunchServices = {
    root: REPO_ROOT,
    loadData: () => data,
    preflight(runtime) {
      seen.preflight.push(runtime);
      return options.preflight ?? null;
    },
    refreshMain() {
      seen.refreshes++;
      return options.refresh ?? null;
    },
    async runProbe(command) {
      seen.probes.push(command);
      return probes.shift() ?? 0;
    },
    async runSession(role, runtime) {
      seen.sessions.push({ role, runtime });
      return sessions.shift() ?? result({ interrupted: "SIGINT" });
    },
    async wait(milliseconds) {
      seen.waits.push(milliseconds);
      return waits.shift() ?? "SIGINT";
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

  it("takes role defaults and explicit selectors from the launch interface", async () => {
    for (const [argv, expected] of [
      [["issue-preparer"], ["issue-preparer", "claude"]],
      [["implementer"], ["implementer", "codex"]],
      [["integrator", "--codex"], ["integrator", "codex"]],
      [["implementer", "--claude"], ["implementer", "claude"]],
    ] as const) {
      const current = rig();
      expect(await launchCommand([...argv], current.io, current.services)).toBe(130);
      expect(current.seen.sessions).toEqual([{ role: expected[0], runtime: expected[1] }]);
      expect(current.seen.preflight).toEqual([expected[1]]);
    }
  });

  it("refuses internal roles and contradictory selectors before a child starts", async () => {
    for (const argv of [
      ["implementation-reviewer"],
      ["issue-adversary"],
      ["implementer", "--codex", "--claude"],
      ["implementer", "--unknown"],
    ]) {
      const current = rig();
      expect(await launchCommand(argv, current.io, current.services)).toBe(2);
      expect(current.seen.sessions).toEqual([]);
      expect(current.stderr()).toMatch(/entry role|choose only one|Unknown option/);
    }
  });

  it("relaunches immediately after work and idles only on the role's exact sentinel", async () => {
    const worked = rig({
      sessions: [result({ lastLine: "Done: implementer codex run" }), result({ interrupted: "SIGTERM" })],
    });
    expect(await launchCommand(["implementer"], worked.io, worked.services)).toBe(143);
    expect(worked.seen.sessions).toHaveLength(2);
    expect(worked.seen.waits).toEqual([]);

    const empty = rig({
      sessions: [result({ lastLine: "No eligible implementer work: queue empty." })],
      waits: ["SIGINT"],
    });
    expect(await launchCommand(["implementer"], empty.io, empty.services)).toBe(130);
    expect(empty.seen.sessions).toHaveLength(1);
    expect(empty.seen.waits).toEqual([30 * 60 * 1_000]);
    expect(empty.stdout()).toMatch(/is idle/);
  });

  it("uses the over-inclusive probe without turning it into queue policy", async () => {
    for (const probe of [1, 2]) {
      const current = rig({ probes: [probe], waits: ["SIGINT"] });
      expect(await launchCommand(["integrator"], current.io, current.services)).toBe(130);
      expect(current.seen.sessions).toEqual([]);
      expect(current.seen.waits).toEqual([30 * 60 * 1_000]);
      expect(current.seen.probes[0]).toEqual(["sh", "scripts/probe-work.sh", "integrator"]);
    }
  });

  it("backs off after an abnormal session and keeps configuration failures separate", async () => {
    const crashed = rig({ sessions: [result({ code: 23 })], waits: ["SIGINT"] });
    expect(await launchCommand(["issue-preparer"], crashed.io, crashed.services)).toBe(130);
    expect(crashed.seen.waits).toEqual([5_000]);
    expect(crashed.stderr()).toMatch(/status 23.*short backoff/);

    for (const options of [
      { preflight: "codex is not authenticated" },
      { refresh: "main cannot fast-forward" },
    ]) {
      const current = rig(options);
      expect(await launchCommand(["implementer"], current.io, current.services)).toBe(1);
      expect(current.seen.sessions).toEqual([]);
      expect(current.seen.probes).toEqual([]);
      expect(current.stderr()).toMatch(/not authenticated|fast-forward/);
    }
  });

  it("removes an ambient HUB_URL from the environment runtime children receive", () => {
    const box = sandbox();
    const env = launchEnvironment({ ...box.env, HUB_URL: "ws://ambient.invalid:9999" });
    expect(env.HUB_URL).toBeUndefined();
  });
});

describe("launch data", () => {
  it("refuses malformed data and a missing adapter", () => {
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
                claude: { adapter: ".claude/agents/implementer.md", sandbox: "runtime" },
                codex: { adapter: ".codex/agents/implementer.toml", sandbox: "unsandboxed" },
              },
            },
          },
        }),
      );
      expect(() => readLaunchData(root)).toThrow(/readable role contract/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
