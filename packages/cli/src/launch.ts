/**
 * `ub agents launch <role>` — one foreground standing loop for one entry role.
 *
 * The CLI owns only transport: resolve the *selected project's* launch data,
 * start one fresh runtime session, wait for it, and repeat. The launched role
 * owns queue selection and every GitHub transition. In particular, the probe
 * named by the launch data is deliberately over-inclusive; its result can save
 * a session, but the session's own final line remains authoritative.
 *
 * That final line is also the whole of what this command understands about a
 * session's outcome. Each entry role ends with one of three exact lines —
 * `No eligible <role> work: <reason>.`, `Worked <role>: <item> — <outcome>.`,
 * or `Blocked <role>: <reason>.` — and the loop prints one condensed line for
 * it, or stops for the last one. The alternative, reading each role's own
 * claim and handoff grammar back off GitHub, would put a project's own
 * workflow policy inside a generic CLI, which is precisely what "Pipeline
 * ownership for ub launch" decided against. A session that ends any other way
 * is reported as an unconfirmed outcome rather than guessed at, and its
 * transcript — which no longer streams to stdout — is named on disk.
 *
 * The project is whatever `--project` or the working directory resolves to
 * (`project.ts`), never where this executable happens to live: an installed
 * `ub` carries no roles, no contracts and no workspace of its own, so two
 * projects that declare the same role name with different contracts each get
 * their own. Every path the loop reads, copies or writes comes out of that
 * project's launch data or the worktree it makes for the session, which is
 * resolution isolation and deliberately not an operating-system or credential
 * boundary — a runtime the project declares unsandboxed can still read the
 * machine it runs on.
 *
 * Grants stay where they were. `ub` writes no trust entry and copies no
 * credential: the human authenticates each runtime once, and each runtime
 * keeps its own per-project record in its own user-level configuration, which
 * a first launch for an unseen project path creates without an interactive
 * dialog and a runtime may rewrite later in the same session. That is the
 * supported setup, not a failure to suppress (owner decision, 2026-09-08). A
 * session is passed exactly the sandbox or permission mode its project
 * declared, and a missing or unauthenticated runtime stops the launch before
 * any child starts.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
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
import { resolveProjectRoot, withoutRepositorySelectors } from "./project.js";

export const LAUNCH_OPTIONS = {
  model: { type: "string" },
  project: { type: "string" },
} as const;

export const LAUNCH_HELP = `usage: ub agents launch <role> [--model claude|codex] [--project <dir>]

Keep one entry role of one project running in this terminal. One fresh session
runs at a time; completed work is followed immediately, while an empty queue
waits about 30 minutes. Ctrl-C stops the loop and its active session.

The roles, their contracts, adapters, default runtime and sandbox come from the
selected project's own .agents/launch.json — never from wherever this
executable was installed.

options:
  --model <name>   run the role with claude or codex; the role's own default
                   applies when this is left out
  --project <dir>  the project to launch: the Git root at or above <dir>. The
                   working directory is used when this is left out
  -h, --help       show this help

Authenticate claude and codex yourself; ub grants nothing on their behalf and
stops before starting a session when a runtime is missing or logged out. Each
runtime keeps its own record of the project paths it has seen, in its own
user-level configuration — expected, and not something ub writes or suppresses.
`;

const RUNTIMES = ["claude", "codex"] as const;

type Runtime = (typeof RUNTIMES)[number];
type Sandbox = "runtime" | "workspace-write" | "unsandboxed";

interface RuntimeLaunch {
  adapter: string;
  sandbox: Sandbox;
  permissionMode?: "auto";
  /** Tool approvals the project grants this runtime, passed through verbatim. */
  allowedTools?: string[];
}

interface RoleLaunch {
  contract: string;
  defaultRuntime: Runtime;
  probe: string[];
  runtimes: Record<Runtime, RuntimeLaunch>;
}

/** The remote and branch a project grounds, fetches and branches sessions from. */
interface BaseRef {
  remote: string;
  branch: string;
}

/**
 * What the project says about itself, for the workflow it adopted to read.
 *
 * The CLI uses exactly one of these — `baseRef`, because it fetches and creates
 * worktrees — and validates the shape of the rest without interpreting it. The
 * repository, owner, discussions, corpus documents and commands a role needs
 * are the project's own words to its own roles, not policy this launcher holds.
 */
interface ProjectBindings {
  baseRef: BaseRef;
  /** Every other binding, including the `sessionBriefing` text a session gets. */
  [binding: string]: unknown;
}

interface LaunchData {
  version: 1;
  project: ProjectBindings;
  entryRoles: Record<string, RoleLaunch>;
}

export interface SessionResult {
  started: boolean;
  code: number;
  signal: NodeJS.Signals | null;
  interrupted: NodeJS.Signals | null;
  lastLine: string;
  /** Present only when the session left reachable processes behind. */
  processCleanup?: "terminated" | "failed";
  /**
   * The launch data did not describe the tree the session would have run, so
   * no child started and no backoff repairs it: the loop exits 1, the class
   * the CLI contract already gives malformed launch data and an unusable
   * adapter, rather than retrying a fixed condition every few seconds.
   */
  malformed?: true;
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
   * `https://github.com/<owner>/<repo>` for the repository the project
   * declared, when this terminal can render a hyperlink and the project's base
   * remote is a GitHub one — and null when either is untrue, the one switch
   * between linked and plain `#123`.
   */
  linkBase: string | null;
  loadData(activeRuntime?: Runtime): LaunchData;
  preflight(runtime: Runtime, adapter: string): string | null;
  refreshMain(baseRef: BaseRef): { detail: string; retry: boolean } | null;
  runProbe(command: readonly string[]): Promise<ProbeResult>;
  runSession(
    role: string,
    runtime: Runtime,
    entry: RoleLaunch,
    project: ProjectBindings,
  ): Promise<SessionResult>;
  wait(milliseconds: number): Promise<NodeJS.Signals | null>;
  terminate(signal: NodeJS.Signals): boolean;
}

export interface LaunchSignals {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface SessionProcesses {
  /** PIDs whose current working directory is inside this session's private worktree. */
  inWorktree(root: string): { pids: number[]; error?: undefined } | { pids?: undefined; error: string };
  signal(pid: number, signal: NodeJS.Signals): void;
}

const IDLE_MS = 30 * 60 * 1_000;
const FAILURE_BACKOFF_MS = 5_000;
// Normal runtime children may still be closing their inherited stdio when the
// leader exits. Only processes that remain after this settle window count as
// abandoned work that the launcher had to end.
const SESSION_EXIT_SETTLE_MS = 500;
// A nested Codex supervisor uses up to 2.8s to stop and observe its own group.
const SESSION_TERMINATION_GRACE_MS = 4_000;
const SESSION_KILL_WAIT_MS = 1_000;
const SESSION_PROCESS_POLL_MS = 100;
const IDLE_LABEL = `${IDLE_MS / 60_000}min`;
const BACKOFF_LABEL = `${FAILURE_BACKOFF_MS / 1_000}s`;
const TAIL_LIMIT = 4_096;

const systemSessionProcesses: SessionProcesses = {
  inWorktree(root) {
    // The supported macOS host has no /proc, and helpers spawned by either
    // runtime may reparent into their own session. A cwd inside the unique
    // per-run worktree is therefore the attribution boundary. A helper that
    // also leaves that worktree is outside this launcher guarantee and belongs
    // to housekeeping rather than to an unsafe guess at process ownership.
    const uid = process.getuid?.();
    if (uid === undefined) {
      return { error: "cannot establish session process absence on this platform" };
    }
    const listed = spawnSync("lsof", ["-a", "-d", "cwd", "-u", String(uid), "-F", "pn"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 1_000,
    });
    if ((listed.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { error: "cannot establish session process absence because lsof is unavailable" };
    }
    if (listed.status !== 0) {
      const reason = listed.error?.message || listed.stderr.trim() || `lsof exited ${listed.status}`;
      return {
        error: `cannot establish session process absence (lsof status ${listed.status}): ${lastLine(reason)}`,
      };
    }
    const worktree = realpathSync(root);
    const pids = new Set<number>();
    let pid: number | undefined;
    for (const line of listed.stdout.split(/\r?\n/)) {
      if (/^p[1-9][0-9]*$/.test(line)) {
        pid = Number(line.slice(1));
      } else if (
        pid !== undefined &&
        line.startsWith("n") &&
        (line.slice(1) === worktree || line.slice(1).startsWith(`${worktree}${sep}`))
      ) {
        pids.add(pid);
      }
    }
    return { pids: [...pids] };
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
};

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
  /(?:http|status) (401|403)\b/i,
  /gh auth login/i,
  /not logged in/i,
];

/** A refusal that waiting can repair, even when it carries an HTTP 403. */
const TEMPORARY_ACCESS_SIGNATURES = [/rate limit/i, /\bquota\b/i];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

/** Every required key present, and nothing beyond the optional ones. */
function keysWithin(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

/** A binding value the launcher hands on unread: one non-empty scalar. */
function isBindingValue(value: unknown): boolean {
  return (
    (typeof value === "string" && value !== "") ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

/**
 * A ref name `git` will accept, checked here so a refusal costs no session.
 *
 * These are git's own rules for one ref component, not a looser approximation
 * of them: a name this accepts but `git check-ref-format` rejects would pass
 * the structural gate and then fail as an impossible checkout instruction,
 * which is the failure this gate exists to prevent.
 */
const REF_PART = /^[A-Za-z0-9._/-]+$/;

function isRefPart(value: unknown, slashes: boolean): value is string {
  if (typeof value !== "string" || !REF_PART.test(value)) return false;
  if (!slashes && value.includes("/")) return false;
  if (value.includes("..") || value.startsWith("-") || value.endsWith(".")) return false;
  return value
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** `<remote>/<branch>`, the one spelling every base-ref message and command uses. */
function baseRefName(baseRef: BaseRef): string {
  return `${baseRef.remote}/${baseRef.branch}`;
}

/** A binding name a role can actually address with the resolver beside this. */
const BINDING_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

function pathIsFile(root: string, relative: string): boolean {
  try {
    const project = realpathSync(root);
    const target = realpathSync(join(project, relative));
    return (
      (target === project || target.startsWith(`${project}${sep}`)) &&
      statSync(target).isFile()
    );
  } catch {
    return false;
  }
}

/**
 * The same confinement, applied to the tree the session actually reads.
 *
 * `readLaunchData` and `preflight` canonicalize files in the control checkout,
 * and a session runs a fresh detached worktree of the project's base ref. Those
 * are two
 * filesystems, and nothing makes them agree: an uncommitted regular file masks
 * a committed escaping symlink at the same path, a fast-forward that never
 * touches those paths keeps the mask, and an adapter that exists only in the
 * control checkout is simply absent where `--agent <role>` resolves it. So the
 * files that govern a session are canonicalized where they govern it, once the
 * worktree exists and before any runtime child reads them. The control checks
 * stay: they are what fails a launch early, with a message about the tree the
 * operator is looking at.
 */
function outsideSessionTree(
  worktree: string,
  runtime: Runtime,
  entry: RoleLaunch,
  base: string,
): string | null {
  for (const [named, relative] of [
    ["role contract", entry.contract],
    [`${runtime} adapter`, entry.runtimes[runtime].adapter],
  ] as const) {
    if (!pathIsFile(worktree, relative)) {
      return (
        `${named} ${relative} is not a readable file inside the session's worktree of ${base}; ` +
        "commit it inside the selected project before retrying"
      );
    }
  }
  return null;
}

/**
 * A project-relative path the launcher may follow, or null.
 *
 * Resolution isolation is a property of paths, so it is checked where a path is
 * read rather than trusted at each use: a launch datum may name a file *inside*
 * the project that declared it and nothing else, so an absolute path or one
 * that climbs out with `..` is malformed data, not a location to visit.
 */
function insideProject(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || isAbsolute(value)) return null;
  const normalized = normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.endsWith(sep)) {
    return null;
  }
  return normalized;
}

/** Where the launch data of `root` lives — the one path the CLI knows by name. */
function launchDataPath(root: string): string {
  return join(root, ".agents/launch.json");
}

/**
 * Parse and validate the selected project's launch map before any session starts.
 *
 * Every binding a session needs is read from here, so what this refuses is what
 * a project may not leave unsaid. The shapes are checked; the *values* are the
 * project's own — a role contract at any readable path inside it, its own probe
 * argv, its own default runtime and sandbox. Whether those match a naming
 * convention is the project's business to enforce (this repository's own
 * `scripts/check-agent-roles.mjs` does), not a rule a general CLI imposes on
 * every adopter. The adapter path is the one exception, and the reason it is
 * one is at the check itself.
 */
/**
 * The project's own bindings: shape-checked here, interpreted by its roles.
 *
 * A workflow a project adopts carries no repository, base ref, discussion,
 * owner or command of its own, so those values live here and a role resolves
 * the one it needs before the operation that needs it. This launcher reads only
 * `baseRef`, and refuses the file rather than defaulting: a launcher that
 * quietly fell back to some other project's branch would ground, fetch and
 * branch every session against the wrong tree. Everything else is checked to be
 * a named value or a flat group of named values — enough that a typo is caught
 * before a session starts, and not so much that the vocabulary of a workflow
 * this CLI does not run becomes something this CLI has to know.
 */
function readProjectBindings(path: string, value: unknown): ProjectBindings {
  const project = record(value);
  if (project === null || Object.keys(project).length === 0) {
    throw new Error(`${path} "project" must declare the bindings this project's roles read`);
  }
  const baseRef = record(project.baseRef);
  const remote = baseRef?.remote;
  const branch = baseRef?.branch;
  if (
    baseRef === null ||
    !exactKeys(baseRef, ["remote", "branch"]) ||
    !isRefPart(remote, false) ||
    !isRefPart(branch, true)
  ) {
    throw new Error(`${path} "project.baseRef" must name a git "remote" and a "branch"`);
  }
  if (project.sessionBriefing !== undefined && typeof project.sessionBriefing !== "string") {
    throw new Error(`${path} "project.sessionBriefing" must be text`);
  }
  for (const [binding, declared] of Object.entries(project)) {
    if (binding === "baseRef") continue;
    const group = record(declared);
    const wellFormed =
      group === null
        ? isBindingValue(declared)
        : Object.keys(group).length > 0 && Object.values(group).every(isBindingValue);
    if (!wellFormed) {
      throw new Error(
        `${path} "project.${binding}" must be one value or a group of named values`,
      );
    }
    // A binding nobody can name is a binding nobody can read: the resolver a
    // role uses addresses these by dotted path, so a key outside that grammar
    // is malformed data rather than a vocabulary this CLI declines to know.
    for (const key of [binding, ...Object.keys(group ?? {})]) {
      if (!BINDING_KEY.test(key)) {
        throw new Error(`${path} "project" declares a binding no role can name: ${JSON.stringify(key)}`);
      }
    }
  }
  return { ...project, baseRef: { remote, branch } };
}

export function readLaunchData(root: string, activeRuntime?: Runtime): LaunchData {
  const path = launchDataPath(root);
  let parsed: unknown;
  try {
    if (!pathIsFile(root, ".agents/launch.json")) {
      throw new Error("the path is not a readable file inside the selected project");
    }
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is missing or invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const top = record(parsed);
  const entries = record(top?.entryRoles);
  if (
    top === null ||
    !exactKeys(top, ["version", "project", "entryRoles"]) ||
    top.version !== 1 ||
    entries === null
  ) {
    throw new Error(`${path} must contain only version 1, a project object and an entryRoles object`);
  }
  if (Object.keys(entries).length === 0) {
    throw new Error(`${path} declares no entry roles`);
  }
  const project = readProjectBindings(path, top.project);

  const entryRoles: Record<string, RoleLaunch> = {};
  for (const [role, rawEntry] of Object.entries(entries)) {
    const named = `${path} entry ${JSON.stringify(role)}`;
    const entry = record(rawEntry);
    const runtimes = record(entry?.runtimes);
    if (
      entry === null ||
      !exactKeys(entry, ["contract", "defaultRuntime", "probe", "runtimes"]) ||
      runtimes === null ||
      !exactKeys(runtimes, ["claude", "codex"])
    ) {
      throw new Error(`${named} has a malformed shape`);
    }
    const contract = insideProject(entry.contract);
    if (contract === null) {
      throw new Error(`${named} names no "contract" path inside ${root}`);
    }
    if (!pathIsFile(root, contract)) {
      throw new Error(`${named} names a role contract that is not a readable file: ${join(root, contract)}`);
    }
    if (entry.defaultRuntime !== "claude" && entry.defaultRuntime !== "codex") {
      throw new Error(`${named} has an invalid "defaultRuntime"; choose ${RUNTIMES.join(" or ")}`);
    }
    if (
      !Array.isArray(entry.probe) ||
      entry.probe.length === 0 ||
      !entry.probe.every((part) => typeof part === "string" && part.length > 0)
    ) {
      throw new Error(`${named} has an invalid "probe" argv`);
    }

    const parsedRuntimes = {} as Record<Runtime, RuntimeLaunch>;
    for (const runtime of RUNTIMES) {
      const rawRuntime = record(runtimes[runtime]);
      const sandbox = rawRuntime?.sandbox;
      const permissionMode = rawRuntime?.permissionMode;
      // The sandbox and permission vocabularies are the ones this CLI can
      // actually pass to each runtime, so an unknown word is malformed data
      // rather than a grant to invent — and there is no value the CLI adds
      // when the project declared none.
      const sandboxValid =
        runtime === "claude"
          ? sandbox === "runtime"
          : sandbox === "workspace-write" || sandbox === "unsandboxed";
      if (
        rawRuntime === null ||
        !keysWithin(
          rawRuntime,
          runtime === "claude" ? ["adapter", "sandbox", "permissionMode"] : ["adapter", "sandbox"],
          runtime === "claude" ? ["allowedTools"] : [],
        ) ||
        !sandboxValid ||
        (runtime === "claude" && permissionMode !== "auto")
      ) {
        throw new Error(`${named} has invalid ${runtime} launch data`);
      }
      // A tool approval the project declared is a grant this launcher passes
      // on, never one it invents: an untrusted project's checked-in runtime
      // settings are ignored by the runtime itself, so the only approvals a
      // session reliably receives are the ones handed to it as arguments.
      const allowedTools = rawRuntime.allowedTools;
      if (
        allowedTools !== undefined &&
        (!Array.isArray(allowedTools) ||
          allowedTools.length === 0 ||
          !allowedTools.every((tool) => typeof tool === "string" && tool.trim() !== ""))
      ) {
        throw new Error(`${named} ${runtime} "allowedTools" must list the tools this project grants`);
      }
      // The adapter path is *not* free, and saying so is the honest thing: a
      // Claude session is started with `--agent <role>`, so the runtime — not
      // this CLI — resolves `.claude/agents/<role>.md` inside the project's own
      // worktree. Data that named a file the runtime will never open would be a
      // binding that can lie. What is the project's here is the file: two
      // projects declaring the same role each supply their own.
      const adapter = `.${runtime}/agents/${role}.${runtime === "claude" ? "md" : "toml"}`;
      if (rawRuntime.adapter !== adapter) {
        throw new Error(
          `${named} ${runtime} "adapter" is ${JSON.stringify(rawRuntime.adapter)}; this runtime resolves ${adapter}`,
        );
      }
      // Codex's adapter is always present in the project data we validate.
      // Claude's can be absent from build contexts that never select Claude,
      // so require it only once that runtime is active. The loop passes that
      // choice again after every refresh, before a probe or session can start.
      if ((runtime === "codex" || runtime === activeRuntime) && !pathIsFile(root, adapter)) {
        throw new Error(
          `${named} names a ${runtime} adapter that is not a readable file: ${join(root, adapter)}`,
        );
      }
      parsedRuntimes[runtime] = {
        adapter,
        sandbox,
        ...(runtime === "claude" ? { permissionMode: "auto" as const } : {}),
        ...(allowedTools === undefined ? {} : { allowedTools: [...(allowedTools as string[])] }),
      } as RuntimeLaunch;
    }
    entryRoles[role] = {
      contract,
      defaultRuntime: entry.defaultRuntime,
      probe: [...entry.probe],
      runtimes: parsedRuntimes,
    } as RoleLaunch;
  }
  return { version: 1, project, entryRoles };
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
/** `<owner>/<repo>`, the one shape a repository binding can be. */
const REPOSITORY = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/**
 * Where `#123` points: the project's declared repository, on the host its base
 * remote proves is GitHub. Without a declared repository the remote's own
 * repository is all there is, and without a GitHub remote there is no link.
 */
function repositoryLink(remoteBase: string | null, declared: string | null): string | null {
  if (remoteBase === null) return null;
  return declared === null ? remoteBase : `${new URL(remoteBase).origin}/${declared}`;
}

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
    .find(
      (line) =>
        !TEMPORARY_ACCESS_SIGNATURES.some((pattern) => pattern.test(line)) &&
        ACCESS_SIGNATURES.some((pattern) => pattern.test(line)),
    );
  if (found === undefined) return null;
  return found.length > 160 ? `${found.slice(0, 159)}…` : found;
}

/** How to repair the access this reason names. */
function recoveryFor(reason: string): string {
  if (/\bclaude\b/i.test(reason)) return "run `claude auth login`";
  if (/\bcodex\b|api\.openai\.com/i.test(reason)) return "run `codex login`";
  if (/\bgh\b|github/i.test(reason)) return "run `gh auth login`";
  return "restore access, then run `ub agents launch` again";
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
  if (!line.startsWith(prefix)) return null;
  const body = line.slice(prefix.length).replace(/\.$/, "").trim();
  return body === "" ? null : body;
}

export function runForeground(
  command: string,
  args: readonly string[],
  root: string,
  env: NodeJS.ProcessEnv,
  io: Io,
  signals: LaunchSignals = process,
  processes: SessionProcesses = systemSessionProcesses,
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
    let closeResult: { code: number; signal: NodeJS.Signals | null } | null = null;
    let exitResult: { code: number; signal: NodeJS.Signals | null } | null = null;
    let cleanupFinished = false;
    let processCleanup: SessionResult["processCleanup"];
    let cleanupDetail: string | undefined;
    const handlers = new Map(FORWARDED.map((signal) => [signal, () => forward(signal)]));

    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      try {
        if (child.pid === undefined) throw new Error("child has no process id");
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const reachable = (): { pids: number[]; error?: undefined } | { error: string; pids?: undefined } => {
      const found = processes.inWorktree(root);
      if (found.error !== undefined) return found;
      return { pids: found.pids.filter((pid) => pid !== process.pid && pid !== child.pid) };
    };
    const absence = (): { absent: boolean; error?: undefined } | { error: string; absent?: undefined } => {
      const found = reachable();
      if (found.error !== undefined) return found;
      return { absent: !signalGroup(0) && found.pids.length === 0 };
    };
    const waitForAbsence = async (
      milliseconds: number,
    ): Promise<{ absent: boolean; error?: undefined } | { error: string; absent?: undefined }> => {
      const limit = Date.now() + milliseconds;
      for (;;) {
        const result = absence();
        if (result.error !== undefined || result.absent || Date.now() >= limit) return result;
        await new Promise((resolveWait) => setTimeout(resolveWait, SESSION_PROCESS_POLL_MS));
      }
    };
    const signalReachable = (signal: NodeJS.Signals): string | undefined => {
      signalGroup(signal);
      const found = reachable();
      if (found.error !== undefined) return found.error;
      try {
        for (const pid of found.pids) processes.signal(pid, signal);
      } catch (error) {
        return `could not signal a session process: ${error instanceof Error ? error.message : String(error)}`;
      }
      return undefined;
    };
    const cleanupProcesses = async (): Promise<{
      outcome?: "terminated" | "failed";
      detail?: string;
    }> => {
      const settledNaturally = await waitForAbsence(SESSION_EXIT_SETTLE_MS);
      if (settledNaturally.error !== undefined) {
        return { outcome: "failed", detail: settledNaturally.error };
      }
      if (settledNaturally.absent) return {};

      const termFailure = signalReachable("SIGTERM");
      if (termFailure !== undefined) return { outcome: "failed", detail: termFailure };
      const afterTerm = await waitForAbsence(SESSION_TERMINATION_GRACE_MS);
      if (afterTerm.error !== undefined) return { outcome: "failed", detail: afterTerm.error };
      if (afterTerm.absent) return { outcome: "terminated" };

      const killFailure = signalReachable("SIGKILL");
      if (killFailure !== undefined) return { outcome: "failed", detail: killFailure };
      const afterKill = await waitForAbsence(SESSION_KILL_WAIT_MS);
      if (afterKill.error !== undefined) return { outcome: "failed", detail: afterKill.error };
      return afterKill.absent
        ? { outcome: "terminated" }
        : { outcome: "failed", detail: "session processes remained reachable after SIGKILL" };
    };

    const finish = (result: SessionResult): void => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) signals.off(signal, handler);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const finishWhenReady = (): void => {
      if (!cleanupFinished || exitResult === null) return;
      // A failed cleanup must not wait forever on a survivor holding inherited
      // stdio. finish() removes the listeners before runSession closes its fd.
      if (processCleanup !== "failed" && closeResult === null) return;
      const outcome = closeResult ?? exitResult;
      finish({
        started: true,
        code: outcome.code,
        signal: outcome.signal,
        interrupted,
        lastLine: lastLine(outputTail),
        tail,
        ...(processCleanup === undefined ? {} : { processCleanup }),
        ...(cleanupDetail === undefined ? {} : { detail: cleanupDetail }),
      });
    };
    const forward = (signal: NodeJS.Signals): void => {
      if (interrupted !== null) return;
      interrupted = signal;
      if (!signalGroup(signal) && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    for (const [signal, handler] of handlers) signals.on(signal, handler);

    const keepTail = (text: string): void => {
      tail = `${tail}${text}`.slice(-TAIL_LIMIT);
    };
    const onStdout = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      outputTail = `${outputTail}${text}`.slice(-65_536);
      keepTail(text);
      io.out(text);
    };
    const onStderr = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      keepTail(text);
      io.err(text);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
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
      exitResult = { code: code ?? 1, signal };
      void cleanupProcesses()
        .then((cleanup) => {
          processCleanup = cleanup.outcome;
          cleanupDetail = cleanup.detail;
        })
        .catch((error) => {
          processCleanup = "failed";
          cleanupDetail = `session process cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        })
        .finally(() => {
          cleanupFinished = true;
          finishWhenReady();
        });
    });
    child.once("close", (code, signal) => {
      closeResult = { code: code ?? 1, signal };
      finishWhenReady();
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

/**
 * The one thing a session is told: which contract to follow, and who it is.
 *
 * The contract path comes from the project's launch data rather than from a
 * shape this CLI knows, because naming a role's file is exactly the kind of
 * workflow policy a general launcher must not hold.
 */
export function launchAssignment(
  role: string,
  runId: string,
  contract: string,
  briefing?: string,
): string {
  return (
    `Claim and complete one eligible item for the \`${role}\` role per \`${contract}\`. ` +
    `Identifiers: role \`${role}\`, run id \`${runId}\`, launched by \`ub agents launch\`.\n\n` +
    // Anything beyond identity is the project's own words to its own sessions —
    // which MCP server to reach, how to spell a command — so it is read from the
    // project's `sessionBriefing` binding rather than written here.
    `${briefing === undefined || briefing.trim() === "" ? "" : `${briefing.trim()} `}` +
    "Write every durable comment from a file, removing that file first because the shell may use " +
    "noclobber. End with the role contract's final line.\n"
  );
}

/** Build the direct Codex invocation solely from the project's declared sandbox. */
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

/** Build the direct Claude invocation from the project's declared grants. */
export function claudeSessionArgs(
  role: string,
  prompt: string,
  permissionMode: RuntimeLaunch["permissionMode"],
  allowedTools?: readonly string[],
): string[] {
  if (permissionMode !== "auto") {
    throw new Error(`invalid Claude permission mode ${JSON.stringify(permissionMode)}`);
  }
  return [
    "-p",
    "--agent",
    role,
    "--permission-mode",
    permissionMode,
    // Only what the project declared, and nothing when it declared nothing: a
    // grant this launcher invented would widen an adopted one silently.
    ...(allowedTools === undefined || allowedTools.length === 0
      ? []
      : ["--allowedTools", allowedTools.join(",")]),
    prompt,
  ];
}

export function createLaunchServices(
  root: string,
  env: NodeJS.ProcessEnv,
  io: Io,
  processes: SessionProcesses = systemSessionProcesses,
): LaunchServices {
  let scratch: string | null = null;
  let preservedFailureWorktree: string | null = null;
  // This boundary is also called directly in tests and integrations. Keep all
  // project Git operations and their descendants independent of ambient
  // repository selectors even when the caller did not use launchEnvironment.
  const projectEnv = withoutRepositorySelectors(env);
  // Which repository a `#123` links into is the project's own answer, not
  // `origin`'s: a fork's remote names a different repository than the one every
  // role, probe and durable record uses, so an operator following the link
  // would land on a different issue with the same number. The declared
  // repository names it; the declared base remote's URL is what still says
  // these numbers are GitHub items at all. Unreadable launch data leaves no
  // link rather than a guessed one, and the launch refuses that data by name a
  // moment later.
  let bindings: ProjectBindings | null = null;
  try {
    bindings = readLaunchData(root).project;
  } catch {
    bindings = null;
  }
  const remote =
    bindings === null
      ? { status: 1, stdout: "" }
      : runSync("git", ["remote", "get-url", bindings.baseRef.remote], root, projectEnv);
  const declaredRepository =
    typeof bindings?.repository === "string" && REPOSITORY.test(bindings.repository)
      ? bindings.repository
      : null;

  return {
    root,
    linkBase:
      process.stdout.isTTY === true && remote.status === 0
        ? repositoryLink(gitHubBase(remote.stdout), declaredRepository)
        : null,
    loadData: (activeRuntime) => readLaunchData(root, activeRuntime),
    preflight(runtime, adapter) {
      if (!pathIsFile(root, adapter)) {
        return `${runtime} adapter ${adapter} is missing; restore it from the project's base ref before retrying`;
      }
      const version = runSync(runtime, ["--version"], root, projectEnv);
      if ((version.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return `${runtime} is not installed; install it and authenticate before retrying`;
      }
      if (version.status !== 0) {
        return `${runtime} could not start; repair the installation before retrying`;
      }
      const auth =
        runtime === "claude"
          ? runSync("claude", ["auth", "status", "--json"], root, projectEnv)
          : runSync("codex", ["login", "status"], root, projectEnv);
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
    refreshMain(baseRef) {
      const base = `${baseRef.remote}/${baseRef.branch}`;
      const branch = runSync("git", ["branch", "--show-current"], root, projectEnv);
      if (branch.status !== 0) {
        return {
          detail: "could not inspect the base checkout; retrying may resolve a concurrent git operation",
          retry: true,
        };
      }
      if (branch.stdout.trim() !== baseRef.branch) {
        return {
          detail: `run \`ub agents launch\` from the project's \`${baseRef.branch}\` checkout`,
          retry: false,
        };
      }
      const fetched = runSync("git", ["fetch", baseRef.remote, baseRef.branch], root, projectEnv);
      if (fetched.status !== 0) {
        // Git's own words, because they are what says whether waiting helps.
        return {
          detail: `could not fetch ${base}: ${fetched.stderr.trim() || "git fetch failed without an error message"}`,
          retry: true,
        };
      }
      const merged = runSync("git", ["merge", "--ff-only", base], root, projectEnv);
      if (merged.status !== 0) {
        return {
          detail: merged.stderr.trim() || `git merge --ff-only ${base} failed without an error message`,
          retry: true,
        };
      }
      return null;
    },
    async runProbe(command) {
      const [executable, ...args] = command;
      if (executable === undefined) return { status: 2, output: "probe command is empty" };
      const result = runSync(executable, args, root, projectEnv);
      if (result.stdout) io.out(result.stdout);
      return {
        status: result.status ?? 2,
        output: `${result.stderr ?? ""}${result.error === undefined ? "" : `\n${result.error.message}`}`,
      };
    },
    async runSession(role, runtime, entry, project) {
      const runId = makeRunId(runtime, role);
      const briefing = project.sessionBriefing;
      const prompt = launchAssignment(
        role,
        runId,
        entry.contract,
        typeof briefing === "string" ? briefing : undefined,
      );
      scratch ??= mkdtempSync(join(tmpdir(), "ub-launch-"));
      const worktree = join(scratch, runId);
      const base = `${project.baseRef.remote}/${project.baseRef.branch}`;
      const added = runSync(
        "git",
        ["worktree", "add", "--detach", worktree, base],
        root,
        projectEnv,
      );
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
      const escaping = outsideSessionTree(worktree, runtime, entry, base);
      if (escaping !== null) {
        const removed = runSync("git", ["worktree", "remove", "--force", worktree], root, projectEnv);
        return {
          started: false,
          code: 1,
          signal: null,
          interrupted: null,
          lastLine: "",
          malformed: true,
          detail:
            removed.status === 0 ? escaping : `${escaping}; worktree cleanup failed at ${worktree}`,
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
              claudeSessionArgs(
                role,
                prompt,
                entry.runtimes.claude.permissionMode,
                entry.runtimes.claude.allowedTools,
              ),
              worktree,
              {
                ...projectEnv,
                // Claude print mode otherwise kills background work after 600s.
                // Role-owned deadlines and claim renewal govern delegated work;
                // preserve an operator's explicit ceiling if one was supplied.
                CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:
                  projectEnv.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? "0",
              },
              capture,
              process,
              processes,
            )
          : await runForeground(
              "codex",
              codexSessionArgs(worktree, lastPath, prompt, entry.runtimes.codex.sandbox),
              worktree,
              projectEnv,
              capture,
              process,
              processes,
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
      const failedSession = !result.started || result.code !== 0 || result.signal !== null;
      const sessionFailure = result.signal === null
        ? `session exited with status ${result.code}`
        : `session ended from ${result.signal}`;
      if (result.processCleanup === "failed") {
        preservedFailureWorktree ??= worktree;
        return {
          ...withLastLine,
          detail: `${result.detail ?? "session process cleanup failed"}${
            failedSession ? `; ${sessionFailure}` : ""
          }; worktree preserved at ${worktree}`,
        };
      }
      if (failedSession) {
        const failure = result.detail ?? sessionFailure;
        if (preservedFailureWorktree === null) {
          preservedFailureWorktree = worktree;
          return {
            ...withLastLine,
            detail: `${failure}; worktree preserved at ${worktree}`,
          };
        }
        const removed = runSync(
          "git",
          ["worktree", "remove", "--force", worktree],
          root,
          projectEnv,
        );
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
      const removed = runSync(
        "git",
        ["worktree", "remove", "--force", worktree],
        root,
        projectEnv,
      );
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
  return withoutRepositorySelectors(resolveConfig({ env }).env);
}

interface Parsed {
  role: string;
  selected: Runtime | null;
  /** The directory the caller pointed at, or undefined for the working one. */
  project: string | undefined;
}

function parse(argv: string[], io: Io): Parsed | number {
  let values: { model?: string; project?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: LAUNCH_OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    io.err(`ub agents launch: ${error instanceof Error ? error.message : String(error)}\n\n${LAUNCH_HELP}`);
    return 2;
  }
  if (positionals.length !== 1) {
    io.err("ub agents launch: expected exactly one <role>\n\n");
    io.err(LAUNCH_HELP);
    return 2;
  }
  const model = values.model;
  if (model !== undefined && !RUNTIMES.includes(model as Runtime)) {
    io.err(`ub agents launch: unknown --model ${JSON.stringify(model)}; choose ${RUNTIMES.join(" or ")}\n\n`);
    io.err(LAUNCH_HELP);
    return 2;
  }
  if (values.project !== undefined && values.project.trim() === "") {
    io.err("ub agents launch: --project needs a directory\n\n");
    io.err(LAUNCH_HELP);
    return 2;
  }
  return {
    role: positionals[0] as string,
    selected: (model as Runtime | undefined) ?? null,
    project: values.project,
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
    const env = launchEnvironment(resolved.env);
    // Before anything else, and never from this executable's own location:
    // which project's roles are these? Everything below hangs off that answer.
    const selection = resolveProjectRoot(parsed.project, process.cwd(), env);
    if (selection.error !== undefined) {
      io.err(`ub agents launch: ${selection.error}\n`);
      return 1;
    }
    services = createLaunchServices(selection.project.root, env, io);
  }

  let data: LaunchData;
  try {
    data = services.loadData();
  } catch (error) {
    io.err(`ub agents launch: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let entry = data.entryRoles[parsed.role];
  if (entry === undefined) {
    io.err(
      `ub agents launch: ${JSON.stringify(parsed.role)} is not an entry role of ${services.root}; choose one from ${launchDataPath(services.root)}\n`,
    );
    return 2;
  }
  const runtime = parsed.selected ?? entry.defaultRuntime;
  const runtimeFailure = services.preflight(runtime, entry.runtimes[runtime].adapter);
  if (runtimeFailure !== null) {
    io.err(`ub agents launch: ${runtimeFailure}\n`);
    return 1;
  }
  // The project is named once, on the startup line: a run's own evidence that
  // the caller's selection — and not an installation directory — is in force.
  io.out(`ub agents launch: ${parsed.role} on ${runtime} in ${services.root}\n`);
  let project = data.project;
  for (;;) {
    const refreshed = baseRefName(project.baseRef);
    const refreshFailure = services.refreshMain(project.baseRef);
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
      const reloaded = services.loadData(runtime);
      project = reloaded.project;
      entry = reloaded.entryRoles[parsed.role];
    } catch (error) {
      io.err(`ub agents launch: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (entry === undefined) {
      io.err(`ub agents launch: ${JSON.stringify(parsed.role)} is no longer an entry role; restart the launcher\n`);
      return 1;
    }
    // The reload can move the base ref itself — that is what a project
    // migrating from one remote or branch to another looks like from here. The
    // ref just refreshed is then not the ref this session would be cut from, so
    // start the iteration again and refresh the new one rather than probing and
    // branching from a ref this run has never fetched.
    if (baseRefName(project.baseRef) !== refreshed) {
      io.err(
        `launch: base ref changed from ${refreshed} to ${baseRefName(project.baseRef)}; refreshing it before the next session\n`,
      );
      continue;
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

    const session = await services.runSession(parsed.role, runtime, entry, project);
    if (session.interrupted !== null) {
      if (session.detail !== undefined) {
        io.err(`launch: ${parsed.role} ${runtime} ${session.detail}${transcriptSuffix(session)}\n`);
      }
      return await stopFromSignal(services, session.interrupted);
    }
    if (session.processCleanup === "terminated") {
      io.err(`launch: ${parsed.role} ${runtime} session left processes running; ended them\n`);
    } else if (session.processCleanup === "failed") {
      io.err(
        `launch: ${parsed.role} ${runtime} ${session.detail ?? "session process cleanup failed"}${transcriptSuffix(session)}; stopped\n`,
      );
      return 1;
    }
    if (!session.started || session.code !== 0 || session.signal !== null) {
      const detail = session.detail ??
        (session.signal === null
          ? `session exited with status ${session.code}`
          : `session ended from ${session.signal}`);
      if (session.malformed === true) {
        io.err(`ub agents launch: ${detail}\n`);
        return 1;
      }
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
        `work: ${parsed.role} session reported no outcome${transcriptSuffix(session)}; retrying in ${BACKOFF_LABEL}\n`,
      );
      const stopped = await pause(services, FAILURE_BACKOFF_MS);
      if (stopped !== null) return stopped;
      continue;
    }
    // An empty queue is a reason, not a verdict on access.
    if (blocked(io, idle)) return 1;
    io.out(`work: ${idle}; will idle for ${IDLE_LABEL}\n`);
    const stopped = await pause(services, IDLE_MS);
    if (stopped !== null) return stopped;
  }
}
