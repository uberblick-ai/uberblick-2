/**
 * `ub doctor` checks this project's Uberblick setup and names each fix.
 * Product wording follows CLI: ub doctor intents and examples.
 *
 * **It diagnoses; it never repairs.** The database check reads an existing
 * store without a replica, hub connection, migration or write. Nothing creates
 * an absent database, configuration file or directory. A failed check names
 * the recovery.
 *
 * `--json` prints exactly one object to stdout and nothing else; warnings and
 * the MCP server's own logging go to stderr. No check ever prints the signing
 * secret: that one is configured, and which layer it came from, is the whole of
 * what is said about it.
 */


import { readDeviceLogin, type DeviceLoginResult } from "@uberblick/hub/device-login";
import { isGithubUsername } from "@uberblick/hub";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  CLOCK_SKEW_SECONDS,
  REQUEST_PROOF_LIFETIME_SECONDS,
} from "@uberblick/hub/token";
import { protocolSkew } from "@uberblick/hub/protocol";
import { parseWorkspaceId } from "@uberblick/schema";
import type { McpConfig } from "@uberblick/mcp-server";
import { formatHubFailure, inspectExistingStore, readWorkspaceName } from "@uberblick/mcp-server";
import { displayUsername } from "./auth.js";
import { resolveMcpConfig } from "./budget.js";
import type { ResolvedConfig } from "./config.js";
import { readCredentials, resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import type { DoctorEntry, TargetFile, TargetName } from "./mcp-config.js";
import { TARGETS, claudeDoctorEntries, doctorEntry, targetFile } from "./mcp-config.js";
import { DEFAULT_WEB_PORT, WEB_HOST, whoHoldsPort, whyNotStartable } from "./open.js";
import { findProjectConfig, resolveProjectBinding } from "./project-binding.js";
import type { Endpoint, HubProbe } from "./probes.js";
import {
  endpointOf,
  hubBind,
  probeHubState,
  probeHubClock,
  probePort,
} from "./probes.js";
import { cliVersion } from "./version.js";

/** Stable strings: `--json` prints them and a script will branch on them. */
export type CheckStatus = "pass" | "warn" | "fail" | "skipped";

export interface Check {
  /** Stable name of the check. */
  name: string;
  status: CheckStatus;
  /** One line, and never a secret. */
  reason: string;
  /** How to repair a warning or failure; null for a pass or skip. */
  fix: string | null;
  /** Listener details when the two local listeners give different verdicts. */
  listeners?: Check[];
}

export interface DoctorReport {
  version: string;
  /** False when any check failed — the same condition as the exit code. */
  ok: boolean;
  checks: Check[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pass(name: string, reason: string): Check {
  return { name, status: "pass", reason, fix: null };
}

function warn(name: string, reason: string, fix: string): Check {
  return { name, status: "warn", reason, fix };
}

function fail(name: string, reason: string, fix: string): Check {
  return { name, status: "fail", reason, fix };
}

function skipped(name: string, reason: string): Check {
  return { name, status: "skipped", reason, fix: null };
}

const WORKSPACE_REMEDY = "ub workspace create <name>, or ub workspace use <link|id>";

/** Resolver errors remain shared; doctor separates a short refusal from its fix. */
function bindingRefusal(error: unknown, env: NodeJS.ProcessEnv, cwd: string): string {
  const reason = message(error).replaceAll("`", "");
  if (env.UB_WORKSPACE_ID !== undefined || env.UB_HUB_URL !== undefined) {
    if (!env.UB_WORKSPACE_ID?.trim()) return "UB_WORKSPACE_ID must not be empty; UB_HUB_URL requires UB_WORKSPACE_ID";
    try { parseWorkspaceId(env.UB_WORKSPACE_ID); }
    catch { return "UB_WORKSPACE_ID is not a valid workspace id"; }
    if (env.UB_HUB_URL !== undefined && !env.UB_HUB_URL.trim()) return "UB_HUB_URL must not be empty";
    if (reason.startsWith("This machine has no hub record")) return "this computer has no hub record for UB_WORKSPACE_ID and no UB_HUB_URL";
    return /UB_WORKSPACE_ID|UB_HUB_URL/.test(reason) ? reason : `UB_HUB_URL: ${reason}`;
  }
  if (env.WORKSPACE_ID?.trim() || env.HUB_URL?.trim()) return "legacy WORKSPACE_ID / HUB_URL variables are no longer supported";
  try {
    const path = findProjectConfig(cwd);
    return path === null || reason.includes(path) ? reason : `${path}: ${reason}`;
  } catch {
    return reason;
  }
}

// --- workspace ---------------------------------------------------------------

function workspaceCheck(
  resolved: ResolvedConfig | null,
  config: McpConfig | null,
  error: string | null,
  workspaceName: string | null,
  deviceLogin: DeviceLoginResult | null,
  env: NodeJS.ProcessEnv,
): Check {
  if (config === null || resolved === null) {
    // Nothing configured at all is the common case and gets a line of its own;
    // a value that *is* configured and was refused keeps the refusal's own
    // message, which names the layer the value came from.
    const reason = error ?? "no .uberblick.json here or in any parent directory";
    return fail("workspace", reason, WORKSPACE_REMEDY);
  }
  const name = workspaceName
    ?? (deviceLogin?.status === "ready" ? deviceLogin.login.credential.workspaceNames?.[config.workspaceId] : undefined);
  const source = resolved.origins.workspace === "environment"
    ? `UB_WORKSPACE_ID${env.UB_HUB_URL === undefined ? "" : " and UB_HUB_URL"}`
    : resolved.paths.projectConfig;
  return pass("workspace", `${name === undefined || name === null ? config.workspaceId : `${name} (${config.workspaceId})`}, from ${source}`);
}

// --- login -------------------------------------------------------------------

/** Keep auth's quoting, escaping backticks so diagnostic lines have no markup. */
function doctorUsername(username: string): string {
  return displayUsername(username).replaceAll("`", "\\u0060");
}

/** The permission bits, as install.md quotes them: `mode 0644`. */
function modeOf(path: string): string {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
  } catch {
    return "unreadable";
  }
}

/** Device admission, including a loopback deployment, requires a stored login. */
function loginCheck(
  config: McpConfig | null,
  login: DeviceLoginResult | null,
): Check {
  if (login !== null) {
    if (login.status === "ready") return pass("login", `${doctorUsername(login.login.identity.githubUsername)} on ${login.origin}`);
    if (login.status === "sign-in-required") return fail("login", `not signed in to ${login.origin}`, `ub auth login ${login.origin}`);
    return fail("login", login.reason ?? `could not read the stored login for ${login.origin}`, login.fix ?? `ub auth login ${login.origin}`);
  }
  return skipped(
    "login",
    config === null ? "no workspace configured, so no login applies" : "local workspace, so no hub login applies",
  );
}

// --- database ----------------------------------------------------------------

/** The nearest ancestor that exists: what a create would actually be refused by. */
function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function directoryProblem(path: string): string | null {
  const base = nearestExisting(path);
  try {
    if (!statSync(base).isDirectory()) {
      return `${base} is not a directory`;
    }
    accessSync(base, constants.W_OK | constants.X_OK);
    return null;
  } catch {
    return `${base} is not writable`;
  }
}

interface DatabaseCheckResult {
  check: Check;
  workspaceName: string | null;
}

function databaseCheck(config: McpConfig | null): DatabaseCheckResult {
  const unread = (check: Check): DatabaseCheckResult => ({ check, workspaceName: null });
  if (config === null) {
    return unread(skipped("database", "no workspace configured, so no database path resolves"));
  }
  const path = config.databasePath;
  try {
    if (!statSync(path).isFile()) {
      return unread(fail(
        "database",
        `${path} is not a database file`,
        "point UBERBLICK_DB at this workspace's existing database",
      ));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return unread(fail(
        "database",
        `${path}: cannot inspect the store (${message(error)})`,
        "restore access to this workspace's database",
      ));
    }
  }

  const problem = directoryProblem(dirname(path));
  if (problem !== null) {
    return unread(fail(
      "database",
      `${path}: ${problem}`,
      "make that directory writable, or point UBERBLICK_DB at a path you can write",
    ));
  }
  if (!existsSync(path)) {
    return unread(skipped("database", `${path} does not exist yet; its nearest existing directory is writable`));
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
  } catch {
    return unread(fail(
      "database",
      `${path}: this user cannot read and write the store`,
      "restore access to this workspace's database",
    ));
  }
  let check: Check;
  try {
    inspectExistingStore(path, config.workspaceId);
    check = pass("database", path);
  } catch (error) {
    check = fail(
      "database",
      `${path}: could not read the store (${message(error)})`,
      "restore access to a valid database for this workspace",
    );
  }
  // Read only after the same preconditions that permit the database inspection.
  // Both readers may leave SQLite WAL sidecars, but neither constructs a store.
  return { check, workspaceName: readWorkspaceName(path, config.workspaceId) };
}

// --- hub and local listeners -------------------------------------------------

/** An endpoint in, what a client found out. */
type Dial = (url: string) => Promise<HubProbe>;

interface HubCheckResult {
  check: Check;
  status: HubProbe["status"] | "skipped";
}

async function hubCheck(
  config: McpConfig | null,
  login: Check,
  deviceLogin: DeviceLoginResult | null,
  dial: Dial,
): Promise<HubCheckResult> {
  if (config === null || config.deviceLogin === undefined) {
    return {
      check: skipped("hub", config === null
        ? "no workspace configured, so no hub token could be minted"
        : `local workspace; ${config.hubUrl} is checked under local hub`),
      status: "skipped",
    };
  }
  if (login.status === "fail") {
    return { check: skipped("hub", "needs login"), status: "skipped" };
  }
  const hub = await dial(config.hubUrl);
  return { check: hubVerdict(config, hub, "hub", deviceLogin), status: hub.status };
}

function hubVerdict(config: McpConfig, hub: HubProbe, name = "hub", deviceLogin: DeviceLoginResult | null = null): Check {
  const local = config.deviceLogin === undefined;
  const origin = local ? config.hubUrl : authenticationOrigin(config.hubUrl);
  const username = deviceLogin?.status === "ready" ? deviceLogin.login.identity.githubUsername : null;
  const user = username === null ? "this account" : doctorUsername(username);
  const status = hub.status;
  if (status === "connected") {
    return pass(name, local ? `${origin} answered and served the directory room` : `connected to ${origin}; ${user} has access`);
  }
  if (status === "auth-failed") {
    if (config.deviceLogin !== undefined || hub.authRecovery !== undefined) {
      switch (hub.authRecovery) {
        case "no-workspace-access":
          return fail(name, `${user} has no access to ${config.workspaceId}, or it doesn't exist on this hub`,
            username !== null && isGithubUsername(username)
              ? `ask a workspace admin to run: ub workspace member add ${username}`
              : "ask a workspace admin for access");
        case "credential-store": {
          const stored = readDeviceLogin(config.hubUrl, config.workspaceId, config.deviceLogin?.env);
          return fail(name, stored.status !== "ready" && stored.reason !== undefined ? stored.reason : `the stored login for ${origin} could not be read`,
            stored.status !== "ready" && stored.fix !== undefined ? stored.fix : `repair the credential store, then run ub auth login ${origin}`);
        }
        case "renewal-unavailable":
          return fail(name, `${origin} could not renew ${user}'s login`, `ask whoever runs ${origin} to repair credential renewal`);
        case "sign-in-required":
          return fail(name, `${origin} no longer accepts ${user}'s login`, `ub auth login ${origin}`);
        default:
          return fail(name, `${origin} refused ${user}'s login`, `ub auth login ${origin}`);
      }
    }
    // Narrower here than for a long-running client: this probe minted its
    // token seconds ago, in this process, in the current format, so the token's
    // *shape* is not in question. Three causes survive that — a secret the hub
    // does not share, a clock far enough out that the hub's clamp refuses an
    // otherwise correct token, and a hub older than this client, which reads
    // our envelope as unparseable and answers exactly as a wrong secret does.
    return fail(
      name,
      `${config.hubUrl} refused the signing secret`,
      "give the hub and this computer the same signing secret",
    );
  }
  if (status === "update-required") {
    // A version refusal always carries the hub's integer. Compose the fix
    // locally rather than rendering an authentication server's arbitrary text.
    const versions =
      hub.hubProtocolVersion === undefined
        ? `this client speaks sync protocol ${hub.protocolVersion}; the hub's version was not reported`
        : protocolSkew(hub.hubProtocolVersion, hub.protocolVersion);
    return fail(
      name,
      `${origin}: ${versions}`,
      hub.hubProtocolVersion === undefined
        ? `check the version on ${origin} with its operator and update the older side`
        : hub.hubProtocolVersion > hub.protocolVersion
          ? "ub update, then restart ub open and running agents"
          : `ask whoever runs ${origin} to update the hub`,
    );
  }
  if (status === "unsettled") {
    // Up, and not serving: the socket opened and the directory room never
    // arrived. Reporting this as reachable is how a client that will never sync
    // gets called healthy.
    return (local ? fail : warn)(
      name,
      `${origin} answered but the directory room did not finish syncing`,
      local
        ? "restart the local hub with ub open --no-browser"
        : `ask whoever runs ${origin} to restart the hub`,
    );
  }
  return warn(
    name,
    formatHubFailure(hub) ?? `${origin} does not answer`,
    "check your network or VPN, or ask whoever runs the hub; your work stays here and syncs once it is back",
  );
}

/** Device proofs fail when issued too far ahead or expired on arrival. */
async function clockCheck(config: McpConfig | null, hub: HubCheckResult): Promise<Check> {
  if (config !== null && config.deviceLogin === undefined) {
    return skipped("clock", "local workspace, so no hub clock comparison applies");
  }
  if (
    config === null ||
    hub.status === "skipped" ||
    hub.status === "hub-down" ||
    hub.status === "connecting" ||
    hub.status === "disabled"
  ) {
    return skipped("clock", "needs the hub");
  }
  const skew = await probeHubClock(config.hubUrl);
  if (skew === null) {
    return skipped(
      "clock",
      `${authenticationOrigin(config.hubUrl)} did not provide a clock reading`,
    );
  }
  // The probe reports how far the hub reads ahead of us; both bounds below are
  // stated from this machine's side, so flip it once, here.
  const ahead = -skew;
  const offset = Math.abs(ahead);
  const limit = ahead > 0 ? CLOCK_SKEW_SECONDS : REQUEST_PROOF_LIFETIME_SECONDS;
  if (Math.abs(ahead) <= limit) {
    return pass("clock", `within ${offset}s of the hub`);
  }
  const measured = offset >= 120 && offset % 60 === 0 ? `${offset / 60} min` : `${offset}s`;
  return fail(
    "clock",
    `${measured} ${ahead > 0 ? "ahead of" : "behind"} ${authenticationOrigin(config.hubUrl)}`,
    "turn on automatic time in your system settings",
  );
}

/** The web listener is relevant even when the workspace lives on a remote hub. */
async function webServerCheck(): Promise<Check> {
  const name = "web server";
  const address = `${WEB_HOST}:${DEFAULT_WEB_PORT}`;
  const port = await probePort(WEB_HOST, DEFAULT_WEB_PORT);
  if (port.state === "free") {
    return skipped(name, `${address} is not running; ub open starts it`);
  }
  if (port.state === "unknown") {
    return skipped(name, `${address} could not be tested (${port.code ?? "unknown error"})`);
  }
  const holder = await whoHoldsPort(DEFAULT_WEB_PORT);
  if (holder === "ub-open") {
    return pass(name, `${address} is already serving an uberblick web app`);
  }
  if (holder === "unidentified") {
    return skipped(name, `${address} is in use, but its holder could not be identified`);
  }
  return fail(name, `${address} is in use by a process that is not ub open`, "stop that process, then run ub open");
}

/** The local hub's configuration and holder are one listener verdict. */
async function localHubListenerCheck(
  config: McpConfig,
  endpoint: Endpoint | null,
  env: NodeJS.ProcessEnv,
  dial: Dial,
): Promise<Check> {
  const name = "hub listener";
  const credentials = readCredentials(env);
  if (credentials.exposed) {
    return fail(
      name,
      `refusing ${credentials.path}: mode ${modeOf(credentials.path)} lets other users read the hub signing secret, so it was not used`,
      `delete ${credentials.path}, then run ub open and restart running agents; run ub auth login again if the file held hub logins`,
    );
  }
  if (endpoint === null || !["ws:", "wss:"].includes(new URL(config.hubUrl).protocol)) {
    return fail(
      name,
      `the configured endpoint ${JSON.stringify(config.hubUrl)} is not a websocket URL`,
      "ub workspace use <link|id>",
    );
  }
  const bind = hubBind(env);
  if (bind.port === null) {
    return fail(
      name,
      `PORT is ${JSON.stringify(bind.raw)}, which is not a port number`,
      "unset PORT, then run ub open",
    );
  }
  if (bind.port !== endpoint.port) {
    const source = bind.raw === null ? "the built-in default" : "PORT";
    return fail(
      name,
      `the hub binds ${bind.host}:${bind.port} (${source}) but the configured endpoint dials port ${endpoint.port}`,
      bind.raw === null ? "ub workspace use <link|id>" : "unset PORT, then run ub open",
    );
  }

  // `ub open` binds the endpoint's host, which can differ from HUB_HOST.
  // A real answer settles identity before any bind probe can hide it.
  const address = `${new URL(config.hubUrl).hostname}:${endpoint.port}`;
  if (config.authSecret !== null) {
    const hub = await dial(config.hubUrl);
    if (hub.status === "connected") {
      return pass(name, `${address} is held by an uberblick hub — it is already running`);
    }
    if (hub.status === "auth-failed" || hub.status === "unsettled" || hub.status === "update-required") {
      return hubVerdict(config, hub, name);
    }
  }
  const probe = await probePort(endpoint.host, endpoint.port);
  if (probe.state === "free") {
    if (config.authSecret === null) {
      return skipped(name, `${address} is not running; no signing secret in force — hub sync is disabled, and every MCP tool still works; ub open creates a local signing secret`);
    }
    // Reuse the starter's refusal so a skip never promises a hub it cannot start.
    const refusal = whyNotStartable(config.hubUrl, new URL(config.hubUrl));
    return skipped(name, refusal?.replaceAll("`", "") ?? `${address} is not running; ub open starts it at ${config.hubUrl}`);
  }
  if (probe.state === "unknown") {
    return skipped(name, `${address} could not be tested (${probe.code ?? "unknown error"})`);
  }
  if (config.authSecret === null) {
    return skipped(
      name,
      `${address} is in use; without a signing secret this cannot tell an uberblick hub from another process`,
    );
  }
  return fail(name, `${address} is in use by a process that is not an uberblick hub`, "stop that process, then run ub open");
}

async function localHubCheck(
  config: McpConfig | null,
  endpoint: Endpoint | null,
  env: NodeJS.ProcessEnv,
  dial: Dial,
): Promise<Check> {
  const web = await webServerCheck();
  if (config === null || config.deviceLogin !== undefined) {
    return { ...web, name: "local hub" };
  }
  const hub = await localHubListenerCheck(config, endpoint, env, dial);
  const listeners = [web, hub];
  // A partly running stack passes unless either listener fails. Skips alone
  // stay skipped, and the seven-check summary counts the combined verdict once.
  const status = listeners.some(listener => listener.status === "fail") ? "fail"
    : listeners.some(listener => listener.status === "pass") ? "pass" : "skipped";
  const fixes = listeners.flatMap(listener => listener.fix === null ? [] : [listener.fix]);
  return {
    name: "local hub",
    status,
    reason: listeners.map(listener => `${listener.name}: ${listener.reason}`).join("; "),
    fix: fixes.length === 0 ? null : fixes.join("; "),
    ...(web.status === hub.status ? {} : { listeners }),
  };
}

// --- MCP wiring --------------------------------------------------------------

const CLIENT_NAMES: Record<TargetName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Claude Code shares local scope with the main checkout of a linked worktree. */
function claudeProjectKey(projectRoot: string): string {
  const git = (args: string[]) => spawnSync(
    "git",
    ["-C", projectRoot, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000 },
  );
  const metadata = git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
  if (metadata.status !== 0) return projectRoot;
  const [directory, common, root] = metadata.stdout.split("\n");
  if (directory === common) return root ?? projectRoot;
  // Main worktree first, with NUL-delimited paths rather than quoted text.
  // Comparing metadata distinguishes linked worktrees from separate Git dirs.
  const worktrees = git(["worktree", "list", "--porcelain", "-z"]);
  const first = worktrees.stdout?.split("\0")[0];
  return worktrees.status === 0 && first?.startsWith("worktree ")
    ? first.slice("worktree ".length)
    : projectRoot;
}

function mcpCheck(env: NodeJS.ProcessEnv, cwd: string, resolved: ResolvedConfig | null): Check {
  if (resolved === null || resolved.binding === null) return skipped("mcp", "needs a workspace");
  const binding = resolved.binding;
  const projectRoot = resolved.paths.projectConfig === null
    ? resolve(cwd)
    : dirname(resolved.paths.projectConfig);
  const setup: string[] = [];
  const problems: string[] = [];
  let unreadable = false;

  const inspect = (target: TargetName, file: TargetFile, entry: DoctorEntry, project: boolean) => {
    if (entry.status === "absent") return;
    const path = project ? relative(projectRoot, file.path) : file.path;
    const client = `${CLIENT_NAMES[target]} (${path})`;
    if (entry.status !== "entry") {
      problems.push(`could not read ${client}`);
      unreadable = true;
      return;
    }
    // An unpinned entry follows this project regardless of its spawn command.
    if (Object.keys(entry.env).length === 0) {
      setup.push(client);
      return;
    }
    try {
      // A legacy-only pin (even empty) must not fall through to a project file.
      if (entry.env.UB_WORKSPACE_ID === undefined && entry.env.UB_HUB_URL === undefined) {
        throw new Error("legacy pin");
      }
      const pinned = resolveProjectBinding({ env: entry.env }).binding;
      if (pinned === null) throw new Error("unreadable pin");
      if (
        parseWorkspaceId(pinned.workspaceId).uuid === parseWorkspaceId(binding.workspaceId).uuid &&
        pinned.hubUrl === binding.hubUrl
      ) {
        setup.push(client);
      } else {
        problems.push(`${client} is pinned to another workspace or hub`);
      }
    } catch {
      // Never quote an entry's values or the resolver's parser messages.
      problems.push(`could not read workspace pin in ${client}`);
      unreadable = true;
    }
  };

  for (const target of TARGETS) {
    const project = targetFile(target, "project", projectRoot, env);
    const user = targetFile(target, "user", projectRoot, env);
    if (target === "claude") {
      const held = claudeDoctorEntries(user, claudeProjectKey(projectRoot));
      // Same-name entries do not merge; local hides project, which hides user.
      if (held.local.status !== "absent") inspect(target, user, held.local, false);
      else {
        const entry = doctorEntry(project);
        if (entry.status !== "absent") inspect(target, project, entry, true);
        else inspect(target, user, held.user, false);
      }
    } else {
      inspect(target, project, doctorEntry(project), true);
      if (user.path !== project.path) inspect(target, user, doctorEntry(user), false);
    }
  }

  const install = "ub mcp install claude   (or codex)";
  if (problems.length > 0) {
    return warn(
      "mcp",
      problems.join("; "),
      unreadable
        ? `repair or move the file named above, then ${install}`
        : "remove or update the workspace pin in the file named above, then restart the agent",
    );
  }
  if (setup.length > 0) return pass("mcp", setup.join(", "));
  return warn("mcp", "MCP client is not set up for this project", install);
}

// --- the report --------------------------------------------------------------

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Run every check without printing anything. Exported for tests. */
export async function doctorReport(
  options: DoctorOptions = {},
): Promise<{ report: DoctorReport; warnings: string[] }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];

  // Resolution itself can refuse — a workspace id that is not a uuid is a
  // configuration error, and a command whose job is to report configuration
  // errors must report it rather than exit on it.
  let resolved: ResolvedConfig | null = null;
  let error: string | null = null;
  try {
    resolved = resolveConfig({ env, cwd });
    warnings.push(...resolved.warnings);
  } catch (thrown) {
    error = bindingRefusal(thrown, env, cwd);
  }

  let config: McpConfig | null = null;
  if (resolved !== null) {
    try {
      if (resolved.binding !== null) {
        config = resolveMcpConfig(resolved.env);
      }
    } catch (thrown) {
      error = bindingRefusal(thrown, env, cwd);
    }
  }

  const resolvedEnv = resolved?.env ?? env;
  const endpoint = config === null ? null : endpointOf(config.hubUrl);
  // The hub checks take their config first, so a null one never dials.
  const dial: Dial =
    config === null
      ? async () => {
          throw new Error("no workspace configured");
        }
      : url => probeHubState(config, url);

  const deviceLogin = config?.deviceLogin === undefined ? null : readDeviceLogin(config.hubUrl, config.workspaceId, resolvedEnv);
  const login = loginCheck(config, deviceLogin);
  const database = databaseCheck(config);
  const checks: Check[] = [
    workspaceCheck(resolved, config, error, database.workspaceName, deviceLogin, env),
    login,
    database.check,
  ];
  const hub = await hubCheck(config, login, deviceLogin, dial);
  checks.push(
    hub.check,
    await clockCheck(config, hub),
    await localHubCheck(config, endpoint, resolvedEnv, dial),
    mcpCheck(resolvedEnv, cwd, config === null ? null : resolved),
  );

  return {
    warnings,
    report: {
      version: cliVersion(),
      ok: !checks.some((check) => check.status === "fail"),
      checks,
    },
  };
}

const MARKERS: Record<CheckStatus, string> = {
  pass: "ok",
  warn: "warn",
  fail: "FAIL",
  skipped: "skip",
};

export function renderDoctor(report: DoctorReport, env: NodeJS.ProcessEnv = process.env): string {
  const home = resolve(env.HOME?.trim() || homedir());
  const humanPath = (value: string) => value.replaceAll(`${home}${sep}`, (prefix, offset: number) =>
    offset === 0 || /[\s("'=:]/.test(value[offset - 1] ?? "") ? `~${sep}` : prefix);
  let text = `uberblick ${report.version}\n\n`;
  for (const check of report.checks) {
    for (const line of check.listeners ?? [check]) {
      const reason = check.listeners === undefined ? line.reason : `${line.name}: ${line.reason}`;
      text += `${MARKERS[line.status].padEnd(6)}${check.name.padEnd(12)}${humanPath(reason)}\n`;
      if (line.status === "warn" || line.status === "fail") {
        text += `${" ".repeat(6)}→ ${humanPath(line.fix ?? "")}\n`;
      }
    }
  }
  const counts = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  for (const check of report.checks) {
    counts[check.status] += 1;
  }
  text += `\n${counts.fail} failed, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.pass} passed, ${counts.skipped} skipped\n`;
  return text;
}

/** Exported so the help below can be checked against the parser it describes. */
export const DOCTOR_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const DOCTOR_HELP = `usage: ub doctor [--json]

Check this project's Uberblick setup and name the fix for each problem.

options:
  --json            The same checks as JSON on stdout, for scripts
  -h, --help        show this help
`;

export async function doctorCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  if (takeHelp(argv, io, DOCTOR_HELP)) return 0;

  let json = false;
  try {
    json =
      parseArgs({
        args: argv,
        options: DOCTOR_OPTIONS,
        allowPositionals: false,
      }).values.json === true;
  } catch (error) {
    io.err(`ub doctor: ${message(error)}\n`);
    return 2;
  }

  const { report, warnings } = await doctorReport();
  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  io.out(json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report));
  // Non-zero on any failure: `ub doctor` is meant to be usable as a gate.
  return report.ok ? 0 : 1;
}
