/**
 * `ub launch <role>` — one foreground standing loop for one entry role.
 *
 * The CLI owns only transport: resolve repository launch data, start one fresh
 * runtime session, wait for it, and repeat. The launched role owns queue
 * selection and every GitHub transition. In particular, the probe named by the
 * launch data is deliberately over-inclusive; its result can save a session,
 * but the session's own `No eligible … work:` line remains authoritative.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  FORWARDED,
  reraise,
  SIGNAL_DELIVERY_GRACE_MS,
  signalExitCode,
} from "./child.js";
import { resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";

export const LAUNCH_OPTIONS = {
  codex: { type: "boolean" },
  claude: { type: "boolean" },
} as const;

export const LAUNCH_HELP = `usage: ub launch <role> [--codex|--claude]

Keep one entry role running in this terminal. One fresh session runs at a time;
completed work is followed immediately, while an empty queue waits about 30
minutes. Ctrl-C stops the loop and its active session.

options:
  --codex          run the role with Codex
  --claude         run the role with Claude
  -h, --help       show this help
`;

type Runtime = "claude" | "codex";
type Sandbox = "runtime" | "workspace-write" | "unsandboxed";

interface RuntimeLaunch {
  adapter: string;
  sandbox: Sandbox;
  permissionMode?: "auto";
}

interface RoleLaunch {
  contract: string;
  defaultRuntime: Runtime;
  probe: string[];
  runtimes: Record<Runtime, RuntimeLaunch>;
}

interface LaunchData {
  version: 1;
  entryRoles: Record<string, RoleLaunch>;
}

export interface SessionResult {
  started: boolean;
  code: number;
  signal: NodeJS.Signals | null;
  interrupted: NodeJS.Signals | null;
  lastLine: string;
  detail?: string;
}

export interface LaunchServices {
  root: string;
  loadData(): LaunchData;
  preflight(runtime: Runtime, adapter: string): string | null;
  refreshMain(): { detail: string; retry: boolean } | null;
  runProbe(command: readonly string[]): Promise<number>;
  runSession(role: string, runtime: Runtime, entry: RoleLaunch): Promise<SessionResult>;
  wait(milliseconds: number): Promise<NodeJS.Signals | null>;
  terminate(signal: NodeJS.Signals): boolean;
}

export interface LaunchSignals {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const IDLE_MS = 30 * 60 * 1_000;
const FAILURE_BACKOFF_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function pathIsFile(root: string, relative: string): boolean {
  try {
    return statSync(join(root, relative)).isFile();
  } catch {
    return false;
  }
}

/** Parse and validate the repository-owned launch map before any session starts. */
export function readLaunchData(root: string): LaunchData {
  const path = join(root, ".agents/launch.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `.agents/launch.json is missing or invalid JSON — restore it from origin/main (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const top = record(parsed);
  const entries = record(top?.entryRoles);
  if (top === null || !exactKeys(top, ["version", "entryRoles"]) || top.version !== 1 || entries === null) {
    throw new Error(".agents/launch.json must contain only version 1 and an entryRoles object — restore it from origin/main");
  }
  if (Object.keys(entries).length === 0) {
    throw new Error(".agents/launch.json entryRoles is empty — restore it from origin/main");
  }

  const entryRoles: Record<string, RoleLaunch> = {};
  for (const [role, rawEntry] of Object.entries(entries)) {
    const entry = record(rawEntry);
    const runtimes = record(entry?.runtimes);
    if (
      entry === null ||
      !exactKeys(entry, ["contract", "defaultRuntime", "probe", "runtimes"]) ||
      runtimes === null ||
      !exactKeys(runtimes, ["claude", "codex"])
    ) {
      throw new Error(`.agents/launch.json entry ${JSON.stringify(role)} has a malformed shape`);
    }
    if (entry.contract !== `.agents/roles/${role}.md` || !pathIsFile(root, entry.contract)) {
      throw new Error(`.agents/launch.json entry ${JSON.stringify(role)} does not name its readable role contract`);
    }
    if (entry.defaultRuntime !== "claude" && entry.defaultRuntime !== "codex") {
      throw new Error(`.agents/launch.json entry ${JSON.stringify(role)} has an invalid defaultRuntime`);
    }
    if (
      !Array.isArray(entry.probe) ||
      entry.probe.length === 0 ||
      !entry.probe.every((part) => typeof part === "string" && part.length > 0) ||
      entry.probe.at(-1) !== role
    ) {
      throw new Error(`.agents/launch.json entry ${JSON.stringify(role)} has an invalid probe argv`);
    }

    const parsedRuntimes = {} as Record<Runtime, RuntimeLaunch>;
    for (const runtime of ["claude", "codex"] as const) {
      const rawRuntime = record(runtimes[runtime]);
      const adapter = rawRuntime?.adapter;
      const sandbox = rawRuntime?.sandbox;
      const expectedAdapter = `.${runtime}/agents/${role}.${runtime === "claude" ? "md" : "toml"}`;
      const permissionMode = rawRuntime?.permissionMode;
      const sandboxValid =
        runtime === "claude"
          ? sandbox === "runtime"
          : sandbox === "workspace-write" || sandbox === "unsandboxed";
      if (
        rawRuntime === null ||
        !exactKeys(
          rawRuntime,
          runtime === "claude" ? ["adapter", "sandbox", "permissionMode"] : ["adapter", "sandbox"],
        ) ||
        adapter !== expectedAdapter ||
        (runtime === "codex" && !pathIsFile(root, expectedAdapter)) ||
        !sandboxValid ||
        (runtime === "claude" && permissionMode !== "auto")
      ) {
        throw new Error(`.agents/launch.json entry ${JSON.stringify(role)} has invalid ${runtime} launch data`);
      }
      parsedRuntimes[runtime] = {
        adapter,
        sandbox,
        ...(runtime === "claude" ? { permissionMode: "auto" as const } : {}),
      } as RuntimeLaunch;
    }
    entryRoles[role] = {
      contract: entry.contract,
      defaultRuntime: entry.defaultRuntime,
      probe: [...entry.probe],
      runtimes: parsedRuntimes,
    } as RoleLaunch;
  }
  return { version: 1, entryRoles };
}

function runSync(command: string, args: readonly string[], root: string, env: NodeJS.ProcessEnv) {
  return spawnSync(command, [...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function lastLine(text: string): string {
  return text.trimEnd().split(/\r?\n/).at(-1) ?? "";
}

export function runForeground(
  command: string,
  args: readonly string[],
  root: string,
  env: NodeJS.ProcessEnv,
  io: Io,
  signals: LaunchSignals = process,
): Promise<SessionResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: root,
      detached: true,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let outputTail = "";
    let interrupted: NodeJS.Signals | null = null;
    let settled = false;
    const handlers = new Map(FORWARDED.map((signal) => [signal, () => forward(signal)]));

    const sendToGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid === undefined) throw new Error("child has no process id");
        process.kill(-child.pid, signal);
      } catch {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      }
    };

    const finish = (result: SessionResult): void => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) signals.off(signal, handler);
      resolve(result);
    };
    const forward = (signal: NodeJS.Signals): void => {
      if (interrupted !== null) return;
      interrupted = signal;
      sendToGroup(signal);
    };
    for (const [signal, handler] of handlers) signals.on(signal, handler);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      outputTail = `${outputTail}${text}`.slice(-65_536);
      io.out(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => io.err(chunk.toString("utf8")));
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        started: false,
        code: 1,
        signal: null,
        interrupted,
        lastLine: "",
        detail: error.code === "ENOENT" ? `${command}: command not found` : error.message,
      });
    });
    child.once("exit", (code, signal) => {
      if (interrupted === null && (code !== 0 || signal !== null)) {
        sendToGroup("SIGTERM");
      }
    });
    child.once("close", (code, signal) => {
      finish({
        started: true,
        code: code ?? 1,
        signal,
        interrupted,
        lastLine: lastLine(outputTail),
      });
    });
  });
}

function waitForSignal(milliseconds: number): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    let settled = false;
    const handlers = new Map(FORWARDED.map((signal) => [signal, () => finish(signal)]));
    const finish = (signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [name, handler] of handlers) process.off(name, handler);
      resolve(signal);
    };
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const timer = setTimeout(() => finish(null), milliseconds);
  });
}

export function makeRunId(runtime: Runtime, role: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${runtime}-${role}-${timestamp}-${randomBytes(3).toString("hex")}`;
}

export function launchAssignment(role: string, runId: string): string {
  return (
    `Claim and complete one eligible item for the \`${role}\` role per \`.agents/roles/${role}.md\`. ` +
    `Identifiers: role \`${role}\`, run id \`${runId}\`, launched by \`ub launch\`.\n\n` +
    "MCP route: use the registered uberblick server. If it cannot start outside mise, use the throwaway " +
    "stdio route `mise x -- ub mcp serve` from scratch outside the committed worktree. Write every durable " +
    "comment from a file, removing that file first because the shell may use noclobber. End with the role " +
    "contract's final line.\n"
  );
}

/** Build the direct Codex invocation solely from the repository launch mode. */
export function codexSessionArgs(
  worktree: string,
  lastPath: string,
  prompt: string,
  sandbox: Sandbox,
): string[] {
  const args = ["exec", "-C", worktree];
  if (sandbox === "unsandboxed") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (sandbox === "workspace-write") {
    args.push("-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true");
  } else {
    throw new Error(`invalid Codex sandbox ${JSON.stringify(sandbox)}`);
  }
  args.push("-o", lastPath, prompt);
  return args;
}

/** Build the direct Claude invocation from the repository permission mode. */
export function claudeSessionArgs(
  role: string,
  prompt: string,
  permissionMode: RuntimeLaunch["permissionMode"],
): string[] {
  if (permissionMode !== "auto") {
    throw new Error(`invalid Claude permission mode ${JSON.stringify(permissionMode)}`);
  }
  return ["-p", "--agent", role, "--permission-mode", permissionMode, prompt];
}

export function createLaunchServices(
  root: string,
  env: NodeJS.ProcessEnv,
  io: Io,
): LaunchServices {
  let scratch: string | null = null;
  let preservedFailureWorktree: string | null = null;

  return {
    root,
    loadData: () => readLaunchData(root),
    preflight(runtime, adapter) {
      if (!pathIsFile(root, adapter)) {
        return `${runtime} adapter ${adapter} is missing; restore it from origin/main before retrying`;
      }
      const version = runSync(runtime, ["--version"], root, env);
      if ((version.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return `${runtime} is not installed; install it and authenticate before retrying`;
      }
      if (version.status !== 0) {
        return `${runtime} could not start; repair the installation before retrying`;
      }
      const auth =
        runtime === "claude"
          ? runSync("claude", ["auth", "status", "--json"], root, env)
          : runSync("codex", ["login", "status"], root, env);
      if (auth.status !== 0) {
        return `${runtime} is not authenticated; log in with ${runtime} before retrying`;
      }
      if (runtime === "claude") {
        try {
          if (JSON.parse(auth.stdout).loggedIn !== true) {
            return "claude is not authenticated; run `claude auth login` before retrying";
          }
        } catch {
          return "claude authentication status was unreadable; run `claude auth status` before retrying";
        }
      }
      return null;
    },
    refreshMain() {
      const branch = runSync("git", ["branch", "--show-current"], root, env);
      if (branch.status !== 0 || branch.stdout.trim() !== "main") {
        return {
          detail: "run `ub launch` from the repository's clean `main` checkout",
          retry: false,
        };
      }
      const status = runSync("git", ["status", "--porcelain"], root, env);
      if (status.status !== 0 || status.stdout.trim() !== "") {
        return {
          detail: "the main checkout has local changes; commit or move them before running `ub launch`",
          retry: false,
        };
      }
      const fetched = runSync("git", ["fetch", "origin", "main"], root, env);
      if (fetched.status !== 0) {
        return {
          detail: "could not fetch origin/main; restore GitHub access and retry",
          retry: true,
        };
      }
      const merged = runSync("git", ["merge", "--ff-only", "origin/main"], root, env);
      if (merged.status !== 0) {
        return {
          detail: "main cannot fast-forward to origin/main; reconcile it before retrying",
          retry: false,
        };
      }
      return null;
    },
    async runProbe(command) {
      const [executable, ...args] = command;
      if (executable === undefined) return 2;
      const result = runSync(executable, args, root, env);
      if (result.stdout) io.out(result.stdout);
      if (result.stderr) io.err(result.stderr);
      return result.status ?? 2;
    },
    async runSession(role, runtime, entry) {
      const runId = makeRunId(runtime, role);
      const prompt = launchAssignment(role, runId);
      scratch ??= mkdtempSync(join(tmpdir(), "ub-launch-"));
      const worktree = join(scratch, runId);
      const added = runSync("git", ["worktree", "add", "--detach", worktree, "origin/main"], root, env);
      if (added.status !== 0) {
        return {
          started: false,
          code: 1,
          signal: null,
          interrupted: null,
          lastLine: "",
          detail: "could not create the fresh runtime worktree; run `git worktree list` and repair it before retrying",
        };
      }
      const lastPath = join(scratch, `${runId}.last`);
      const result = runtime === "claude"
        ? await runForeground(
            "claude",
            claudeSessionArgs(role, prompt, entry.runtimes.claude.permissionMode),
            worktree,
            env,
            io,
          )
        : await runForeground(
            "codex",
            codexSessionArgs(worktree, lastPath, prompt, entry.runtimes.codex.sandbox),
            worktree,
            env,
            io,
          );
      const withLastLine = {
        ...result,
        lastLine: runtime === "codex" && existsSync(lastPath)
          ? lastLine(readFileSync(lastPath, "utf8"))
          : result.lastLine,
      };
      if (!result.started || result.code !== 0 || result.signal !== null) {
        const failure = result.detail ??
          (result.signal === null
            ? `session exited with status ${result.code}`
            : `session ended from ${result.signal}`);
        if (preservedFailureWorktree === null) {
          preservedFailureWorktree = worktree;
          return {
            ...withLastLine,
            detail: `${failure}; worktree preserved at ${worktree}`,
          };
        }
        const removed = runSync("git", ["worktree", "remove", "--force", worktree], root, env);
        if (removed.status !== 0) {
          return {
            ...withLastLine,
            detail: `${failure}; worktree cleanup failed at ${worktree}; first failed worktree remains at ${preservedFailureWorktree}`,
          };
        }
        return {
          ...withLastLine,
          detail: `${failure}; first failed worktree preserved at ${preservedFailureWorktree}`,
        };
      }
      const removed = runSync("git", ["worktree", "remove", "--force", worktree], root, env);
      if (removed.status !== 0) {
        return {
          ...withLastLine,
          code: 1,
          detail: `session completed but worktree cleanup failed; repair ${worktree} before it is pruned`,
        };
      }
      return withLastLine;
    },
    wait: waitForSignal,
    terminate(signal) {
      return reraise(signal);
    },
  };
}

/** The environment every probe and runtime child inherits. */
export function launchEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return resolveConfig({ env }).env;
}

function parse(argv: string[], io: Io): { role: string; selected: Runtime | null } | number {
  let values: { codex?: boolean; claude?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: LAUNCH_OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    io.err(`ub launch: ${error instanceof Error ? error.message : String(error)}\n\n${LAUNCH_HELP}`);
    return 2;
  }
  if (positionals.length !== 1) {
    io.err("ub launch: expected exactly one <role>\n\n");
    io.err(LAUNCH_HELP);
    return 2;
  }
  if (values.codex === true && values.claude === true) {
    io.err("ub launch: choose only one of --codex or --claude\n\n");
    io.err(LAUNCH_HELP);
    return 2;
  }
  return {
    role: positionals[0] as string,
    selected: values.codex === true ? "codex" : values.claude === true ? "claude" : null,
  };
}

function emptyQueueLine(role: string, line: string): boolean {
  return line.startsWith(`No eligible ${role} work: `) && line.endsWith(".");
}

async function pause(
  services: LaunchServices,
  milliseconds: number,
): Promise<number | null> {
  const signal = await services.wait(milliseconds);
  if (signal === null) return null;
  return stopFromSignal(services, signal);
}

async function stopFromSignal(
  services: LaunchServices,
  signal: NodeJS.Signals,
): Promise<number> {
  if (services.terminate(signal)) {
    await new Promise((resolve) => setTimeout(resolve, SIGNAL_DELIVERY_GRACE_MS));
  }
  return signalExitCode(signal);
}

/** Run the standing loop. It returns only for usage/configuration failure or a signal fallback. */
export async function launchCommand(
  argv: string[],
  io: Io,
  supplied?: LaunchServices,
): Promise<number> {
  if (takeHelp(argv, io, LAUNCH_HELP)) return 0;
  const parsed = parse(argv, io);
  if (typeof parsed === "number") return parsed;

  let services = supplied;
  if (services === undefined) {
    const resolved = resolveConfig();
    for (const warning of resolved.warnings) io.err(`ub: warning: ${warning}\n`);
    services = createLaunchServices(repositoryRoot, launchEnvironment(resolved.env), io);
  }

  let data: LaunchData;
  try {
    data = services.loadData();
  } catch (error) {
    io.err(`ub launch: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let entry = data.entryRoles[parsed.role];
  if (entry === undefined) {
    io.err(`ub launch: ${JSON.stringify(parsed.role)} is not an entry role; choose one from .agents/launch.json\n`);
    return 2;
  }
  const runtime = parsed.selected ?? entry.defaultRuntime;
  const runtimeFailure = services.preflight(runtime, entry.runtimes[runtime].adapter);
  if (runtimeFailure !== null) {
    io.err(`ub launch: ${runtimeFailure}\n`);
    return 1;
  }
  io.out(`ub launch: ${parsed.role} on ${runtime}; Ctrl-C stops the loop\n`);
  for (;;) {
    const refreshFailure = services.refreshMain();
    if (refreshFailure !== null) {
      if (!refreshFailure.retry) {
        io.err(`ub launch: ${refreshFailure.detail}\n`);
        return 1;
      }
      io.err(`ub launch: ${refreshFailure.detail}; retrying after a short backoff\n`);
      const stopped = await pause(services, FAILURE_BACKOFF_MS);
      if (stopped !== null) return stopped;
      continue;
    }
    try {
      entry = services.loadData().entryRoles[parsed.role];
    } catch (error) {
      io.err(`ub launch: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (entry === undefined) {
      io.err(`ub launch: ${JSON.stringify(parsed.role)} is no longer an entry role; restart the launcher\n`);
      return 1;
    }
    const probe = await services.runProbe(entry.probe);
    if (probe !== 0) {
      io.out(
        probe === 1
          ? `ub launch: no ${parsed.role} candidate; checking again in about 30 minutes\n`
          : `ub launch: ${parsed.role} probe failed; checking again in about 30 minutes\n`,
      );
      const stopped = await pause(services, IDLE_MS);
      if (stopped !== null) return stopped;
      continue;
    }

    const session = await services.runSession(parsed.role, runtime, entry);
    if (session.interrupted !== null) {
      if (session.detail !== undefined) {
        io.err(`ub launch: ${parsed.role} ${runtime} ${session.detail}\n`);
      }
      return await stopFromSignal(services, session.interrupted);
    }
    if (!session.started || session.code !== 0 || session.signal !== null) {
      const detail = session.detail ??
        (session.signal === null
          ? `session exited with status ${session.code}`
          : `session ended from ${session.signal}`);
      io.err(`ub launch: ${parsed.role} ${runtime} ${detail}; retrying after a short backoff\n`);
      const stopped = await pause(services, FAILURE_BACKOFF_MS);
      if (stopped !== null) return stopped;
      continue;
    }
    if (emptyQueueLine(parsed.role, session.lastLine)) {
      io.out(`ub launch: ${parsed.role} is idle; checking again in about 30 minutes\n`);
      const stopped = await pause(services, IDLE_MS);
      if (stopped !== null) return stopped;
    }
  }
}
