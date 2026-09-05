/**
 * `ub launch <role>` — one foreground standing loop for one entry role.
 *
 * The CLI owns only transport: resolve repository launch data, start one fresh
 * runtime session, wait for it, and repeat. The launched role owns queue
 * selection and every GitHub transition. In particular, the probe named by the
 * launch data is deliberately over-inclusive; its result can save a session,
 * but the session's own final line remains authoritative.
 *
 * That final line is also the whole of what this command understands about a
 * session's outcome. Each entry role ends with one of three exact lines —
 * `No eligible <role> work: <reason>.`, `Worked <role>: <item> — <outcome>.`,
 * or `Blocked <role>: <reason>.` — and the loop prints one condensed line for
 * it, or stops for the last one. The alternative, reading each role's own
 * claim and handoff grammar back off GitHub, would put the repository's
 * workflow policy inside a generic CLI, which is precisely what "Pipeline
 * ownership for ub launch" decided against. A session that ends any other way
 * is reported as an unconfirmed outcome rather than guessed at, and its
 * transcript — which no longer streams to stdout — is named on disk.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
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
  model: { type: "string" },
} as const;

export const LAUNCH_HELP = `usage: ub launch <role> [--model claude|codex]

Keep one entry role running in this terminal. One fresh session runs at a time;
completed work is followed immediately, while an empty queue waits about 30
minutes. Ctrl-C stops the loop and its active session.

options:
  --model <name>   run the role with claude or codex; the role's own default
                   applies when this is left out
  -h, --help       show this help
`;

const RUNTIMES = ["claude", "codex"] as const;

type Runtime = (typeof RUNTIMES)[number];
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
  /** The end of both captured streams — read only when the session failed. */
  tail?: string;
  /** Where this session's captured output was written, when it was captured. */
  transcript?: string;
}

export interface ProbeResult {
  status: number;
  /** Whatever the probe said about a failure; empty when it succeeded. */
  output: string;
}

export interface LaunchServices {
  root: string;
  /**
   * `https://github.com/<owner>/<repo>` when this terminal can render a
   * hyperlink and `origin` is a GitHub remote, and null when either is untrue —
   * the one switch between linked and plain `#123`.
   */
  linkBase: string | null;
  loadData(): LaunchData;
  preflight(runtime: Runtime, adapter: string): string | null;
  refreshMain(): { detail: string; retry: boolean } | null;
  runProbe(command: readonly string[]): Promise<ProbeResult>;
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
const IDLE_LABEL = `${IDLE_MS / 60_000}min`;
const BACKOFF_LABEL = `${FAILURE_BACKOFF_MS / 1_000}s`;
const TAIL_LIMIT = 4_096;

/**
 * A failure no amount of waiting repairs: the loop stops instead of retrying.
 *
 * Deliberately narrow. Everything else — a dropped network, a busy index, a
 * crashed session — keeps the ordinary visible backoff, because a wrong stop
 * costs the owner a restart while a wrong retry only costs a few seconds.
 */
const ACCESS_SIGNATURES = [
  /permission denied/i,
  /authentication failed/i,
  /not authenticated/i,
  /authentication expired/i,
  /bad credentials/i,
  /could not read username/i,
  /http (401|403)/i,
  /gh auth login/i,
  /not logged in/i,
];

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

/** The `https://github.com/<owner>/<repo>` behind a remote URL, or null. */
function gitHubBase(remote: string): string | null {
  const matched = /^(?:https:\/\/github\.com\/|git@github\.com:)(\S+?\/\S+?)(?:\.git)?$/.exec(
    remote.trim(),
  );
  const slug = matched?.[1];
  return slug === undefined ? null : `https://github.com/${slug}`;
}

/** Make every `#123` an OSC 8 hyperlink; plain text when there is no base. */
function linkItems(text: string, base: string | null): string {
  if (base === null) return text;
  return text.replace(
    /#(\d+)\b/g,
    (item, number) => `\u001b]8;;${base}/issues/${number}\u0007${item}\u001b]8;;\u0007`,
  );
}

/**
 * The persistent access failure in `text` — or null.
 *
 * One classifier for every stage where nobody said so in words: the main
 * refresh, the probe, and the end of a failed session's output.
 */
function accessReason(text: string): string | null {
  const found = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => ACCESS_SIGNATURES.some((pattern) => pattern.test(line)));
  if (found === undefined) return null;
  return found.length > 160 ? `${found.slice(0, 159)}…` : found;
}

/** How to repair the access this reason names. */
function recoveryFor(reason: string): string {
  if (/\bclaude\b/i.test(reason)) return "run `claude auth login`";
  if (/\bcodex\b/i.test(reason)) return "run `codex login`";
  if (/\bgh\b|github/i.test(reason)) return "run `gh auth login`";
  return "restore access, then run `ub launch` again";
}

/** The role's own reason for an empty queue, from its exact sentinel line. */
function idleReason(role: string, line: string): string | null {
  return sentinelBody(`No eligible ${role} work: `, line);
}

/** What the role says it worked on, from its exact completed-work line. */
function workedItem(role: string, line: string): string | null {
  return sentinelBody(`Worked ${role}: `, line);
}

/** The role saying in words that access, not the queue, stopped it. */
function blockedReason(role: string, line: string): string | null {
  return sentinelBody(`Blocked ${role}: `, line);
}

/** A session's closing words — enough to catch a report, not its reasoning. */
function closingLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .join("\n");
}

function sentinelBody(prefix: string, line: string): string | null {
  if (!line.startsWith(prefix) || !line.endsWith(".")) return null;
  const body = line.slice(prefix.length, -1).trim();
  return body === "" ? null : body;
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
    // Both streams in arrival order, kept short: how a runtime that died says
    // why, when its final stdout line says nothing. Only a failed session is
    // read from it, so a role's earlier prose never reaches the classifier.
    let tail = "";
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

    const keepTail = (text: string): void => {
      tail = `${tail}${text}`.slice(-TAIL_LIMIT);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      outputTail = `${outputTail}${text}`.slice(-65_536);
      keepTail(text);
      io.out(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      keepTail(text);
      io.err(text);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        started: false,
        code: 1,
        signal: null,
        interrupted,
        lastLine: "",
        tail,
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
        tail,
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
  const remote = runSync("git", ["remote", "get-url", "origin"], root, env);

  return {
    root,
    linkBase:
      process.stdout.isTTY === true && remote.status === 0
        ? gitHubBase(remote.stdout)
        : null,
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
      if (branch.status !== 0) {
        return {
          detail: "could not inspect the main checkout; retrying may resolve a concurrent git operation",
          retry: true,
        };
      }
      if (branch.stdout.trim() !== "main") {
        return { detail: "run `ub launch` from the repository's `main` checkout", retry: false };
      }
      const fetched = runSync("git", ["fetch", "origin", "main"], root, env);
      if (fetched.status !== 0) {
        // Git's own words, because they are what says whether waiting helps.
        return {
          detail: `could not fetch origin/main: ${fetched.stderr.trim() || "git fetch failed without an error message"}`,
          retry: true,
        };
      }
      const merged = runSync("git", ["merge", "--ff-only", "origin/main"], root, env);
      if (merged.status !== 0) {
        return {
          detail: merged.stderr.trim() || "git merge --ff-only origin/main failed without an error message",
          retry: true,
        };
      }
      return null;
    },
    async runProbe(command) {
      const [executable, ...args] = command;
      if (executable === undefined) return { status: 2, output: "probe command is empty" };
      const result = runSync(executable, args, root, env);
      if (result.stdout) io.out(result.stdout);
      return {
        status: result.status ?? 2,
        output: `${result.stderr ?? ""}${result.error === undefined ? "" : `\n${result.error.message}`}`,
      };
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
      // The session's raw transcript goes to a file, not to this terminal: the
      // loop reports outcomes, and a failure names this path for diagnosis.
      const transcript = join(scratch, `${runId}.log`);
      const handle = openSync(transcript, "a");
      const capture: Io = {
        out: (text) => void writeSync(handle, text),
        err: (text) => void writeSync(handle, text),
      };
      let result: SessionResult;
      try {
        result = runtime === "claude"
          ? await runForeground(
              "claude",
              claudeSessionArgs(role, prompt, entry.runtimes.claude.permissionMode),
              worktree,
              env,
              capture,
            )
          : await runForeground(
              "codex",
              codexSessionArgs(worktree, lastPath, prompt, entry.runtimes.codex.sandbox),
              worktree,
              env,
              capture,
            );
      } finally {
        closeSync(handle);
      }
      const withLastLine = {
        ...result,
        transcript,
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
  let values: { model?: string };
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
  const model = values.model;
  if (model !== undefined && !RUNTIMES.includes(model as Runtime)) {
    io.err(`ub launch: unknown --model ${JSON.stringify(model)}; choose ${RUNTIMES.join(" or ")}\n\n`);
    io.err(LAUNCH_HELP);
    return 2;
  }
  return {
    role: positionals[0] as string,
    selected: (model as Runtime | undefined) ?? null,
  };
}

/** The loop's one stop for a failure waiting cannot repair. */
function stopFor(io: Io, reason: string): number {
  io.err(`launch: ${reason}; stopped — ${recoveryFor(reason)}\n`);
  return 1;
}

/** Whether `text` shows a persistent access failure; reports it if it does. */
function blocked(io: Io, text: string): boolean {
  const reason = accessReason(text);
  if (reason === null) return false;
  stopFor(io, reason);
  return true;
}

function transcriptSuffix(session: SessionResult): string {
  return session.transcript === undefined ? "" : `; transcript at ${session.transcript}`;
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
  io.out(`ub launch: ${parsed.role} on ${runtime}\n`);
  for (;;) {
    const refreshFailure = services.refreshMain();
    if (refreshFailure !== null) {
      if (blocked(io, refreshFailure.detail)) return 1;
      if (!refreshFailure.retry) {
        io.err(`launch: ${refreshFailure.detail}\n`);
        return 1;
      }
      io.err(`launch: ${refreshFailure.detail}; retrying in ${BACKOFF_LABEL}\n`);
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
    if (probe.status !== 0) {
      if (blocked(io, probe.output)) return 1;
      const reason = probe.status === 1
        ? `no eligible ${parsed.role} work`
        : `probe failed${probe.output.trim() === "" ? "" : `: ${lastLine(probe.output)}`}`;
      io.out(`work: ${reason}; will idle for ${IDLE_LABEL}\n`);
      const stopped = await pause(services, IDLE_MS);
      if (stopped !== null) return stopped;
      continue;
    }

    const session = await services.runSession(parsed.role, runtime, entry);
    if (session.interrupted !== null) {
      if (session.detail !== undefined) {
        io.err(`launch: ${parsed.role} ${runtime} ${session.detail}${transcriptSuffix(session)}\n`);
      }
      return await stopFromSignal(services, session.interrupted);
    }
    if (!session.started || session.code !== 0 || session.signal !== null) {
      const detail = session.detail ??
        (session.signal === null
          ? `session exited with status ${session.code}`
          : `session ended from ${session.signal}`);
      // The runtime's own dying words are usually on stderr, so the end of
      // both captured streams is what says whether waiting can help.
      if (blocked(io, `${detail}\n${session.tail ?? session.lastLine}`)) return 1;
      io.err(
        `launch: ${parsed.role} ${runtime} ${detail}${transcriptSuffix(session)}; retrying in ${BACKOFF_LABEL}\n`,
      );
      const stopped = await pause(services, FAILURE_BACKOFF_MS);
      if (stopped !== null) return stopped;
      continue;
    }
    // A role stopped by blocked access exits 0 like any other, so it says so
    // in words rather than leaving the loop to read that out of its prose.
    const cannot = blockedReason(parsed.role, session.lastLine);
    if (cannot !== null) return stopFor(io, cannot);
    const worked = workedItem(parsed.role, session.lastLine);
    if (worked !== null) {
      io.out(`work: ${linkItems(worked, services.linkBase)}\n`);
      continue;
    }
    const idle = idleReason(parsed.role, session.lastLine);
    if (idle === null) {
      // No contract line at all, so the role's closing words are the only
      // evidence left; without this a session blocked in prose would relaunch
      // at once, forever. Only the closing words — the rest is its reasoning.
      if (blocked(io, closingLines(session.tail ?? session.lastLine, 5))) return 1;
      io.out(
        `work: ${parsed.role} session reported no outcome${transcriptSuffix(session)}\n`,
      );
      continue;
    }
    // An empty queue is a reason, not a verdict on access.
    if (blocked(io, idle)) return 1;
    io.out(`work: ${idle}; will idle for ${IDLE_LABEL}\n`);
    const stopped = await pause(services, IDLE_MS);
    if (stopped !== null) return stopped;
  }
}
