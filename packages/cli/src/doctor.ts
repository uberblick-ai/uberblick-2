/**
 * `ub doctor` — the local stack's documented failure modes, run as checks.
 *
 * Each check answers one question somebody would otherwise answer by finding,
 * reading and translating prose: is a workspace configured, is a signing secret
 * usable, can the existing database be read and written,
 * does a hub answer, is this machine's clock close enough to the hub's,
 * do the endpoint and the hub's port agree,
 * who holds the port, is any MCP client wired up. Three of the
 * hub-side failures present identically as "offline" in the web UI, which is
 * the reason this command exists — it names the cause and the fix.
 *
 * **It diagnoses; it never repairs.** The database check reads an existing
 * store without a replica, hub connection, migration or write. Nothing creates
 * an absent database, configuration file or directory. A failed check names
 * the recovery.
 *
 * **The wording is the Install and run document's**, whose "If it fails"
 * section is the specification for the hub, port and credential checks. It is
 * quoted rather than paraphrased, so the command and the document cannot drift
 * into saying subtly different things.
 *
 * **Nothing here requires configuration.** With no files present at all every
 * check still reports, against the built-in defaults: an unconfigured workspace
 * is a failed check rather than a thrown error, and an absent signing secret is
 * a skip that says hub sync is disabled and every MCP tool still works — the
 * MCP server is offline-first by construction, so that is a supported state and
 * not a defect.
 *
 * `--json` prints exactly one object to stdout and nothing else; warnings and
 * the MCP server's own logging go to stderr. No check ever prints the signing
 * secret: that one is configured, and which layer it came from, is the whole of
 * what is said about it.
 */


import { readDeviceLogin } from "@uberblick/hub/device-login";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  CLOCK_SKEW_SECONDS,
  MAX_TOKEN_LIFETIME_SECONDS,
} from "@uberblick/hub/token";
import { AUTH_REJECTED, protocolSkew } from "@uberblick/hub/protocol";
import type { McpConfig } from "@uberblick/mcp-server";
import { inspectExistingStore } from "@uberblick/mcp-server";
import { resolveMcpConfig } from "./budget.js";
import type { ResolvedConfig } from "./config.js";
import { readCredentials, resolveConfig, requireBinding } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import type { Scope } from "./mcp-config.js";
import { DEFAULT_ENTRY, TARGETS, presence, targetFile } from "./mcp-config.js";
import { DEFAULT_WEB_PORT, WEB_HOST, whoHoldsPort, whyNotStartable } from "./open.js";
import type { Endpoint, HubProbe } from "./probes.js";
import {
  endpointOf,
  hubBind,
  probeHubState,
  probeHubClock,
  probePort,
} from "./probes.js";
import { ORIGIN_LABELS } from "./status.js";
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

const WORKSPACE_REMEDY =
  "`ub init` creates a workspace; `ub workspace join <hub>/<workspace-id>` binds " +
  "this project to one that already exists; `ub workspace use <id> --hub <url|local>` adopts one " +
  "this machine already has";

/**
 * The hub's bind address and the endpoint the clients dial are two settings, and
 * only one of them is an environment variable: the endpoint lives in this
 * machine's config, written by `ub init` or `ub workspace join`.
 */
const PORT_REMEDY =
  "the hub binds HUB_HOST:PORT — set PORT to the port the configured endpoint dials, or point this machine at the hub you meant with `ub workspace join <endpoint>/<workspace-id>`";

// --- workspace ---------------------------------------------------------------

function workspaceCheck(
  resolved: ResolvedConfig | null,
  config: McpConfig | null,
  error: string | null,
): Check {
  if (config === null || resolved === null) {
    // Nothing configured at all is the common case and gets a line of its own;
    // a value that *is* configured and was refused keeps the refusal's own
    // message, which names the layer the value came from.
    const reason = error ?? "No workspace selected; choose a complete project or environment binding";
    return fail("workspace", reason, WORKSPACE_REMEDY);
  }
  const spelling = resolved.env.WORKSPACE_ID ?? config.workspaceId;
  const origin = ORIGIN_LABELS[resolved.origins.workspace];
  const uuid = spelling === config.workspaceId ? "" : ` — uuid ${config.workspaceId}`;
  return pass("workspace", `${spelling} (${origin})${uuid}`);
}

// --- login -------------------------------------------------------------------

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
  env: NodeJS.ProcessEnv,
  config: McpConfig | null,
): Check {
  if (config?.deviceLogin !== undefined) {
    const login = readDeviceLogin(config.hubUrl, config.workspaceId, env);
    return login.status === "ready"
      ? pass("login", "stored device login; hub acceptance is checked below")
      : fail("login", login.message, login.message);
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

function databaseCheck(config: McpConfig | null): Check {
  if (config === null) {
    return skipped("database", "no workspace configured, so no database path resolves");
  }
  const path = config.databasePath;
  try {
    if (!statSync(path).isFile()) {
      return fail(
        "database",
        `${path} is not a database file`,
        "point UBERBLICK_DB at this workspace's existing database",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return fail(
        "database",
        `${path}: cannot inspect the store (${message(error)})`,
        "restore access to this workspace's database, then run `ub doctor` again",
      );
    }
  }

  const problem = directoryProblem(dirname(path));
  if (problem !== null) {
    return fail(
      "database",
      `${path}: ${problem}`,
      "make that directory writable, or point UBERBLICK_DB at a path you can write",
    );
  }
  if (!existsSync(path)) {
    return skipped("database", `${path} does not exist yet; its nearest existing directory is writable`);
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
  } catch {
    return fail(
      "database",
      `${path}: this user cannot read and write the store`,
      "restore access to this workspace's database, then run `ub doctor` again",
    );
  }
  try {
    inspectExistingStore(path, config.workspaceId);
    return pass("database", path);
  } catch (error) {
    return fail(
      "database",
      `${path}: could not read the store (${message(error)})`,
      "restore access to a valid database for this workspace, then run `ub doctor` again",
    );
  }
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
  return { check: hubVerdict(config, hub), status: hub.status };
}

function hubVerdict(config: McpConfig, hub: HubProbe, name = "hub"): Check {
  const local = config.deviceLogin === undefined;
  const status = hub.status;
  if (status === "connected") {
    return pass(name, `${config.hubUrl} answered and served the directory room`);
  }
  if (status === "auth-failed") {
    if (config.deviceLogin !== undefined || hub.authRecovery !== undefined) {
      return fail(name, `${config.hubUrl} refused remote sync`, hub.reason ?? "Run `ub auth login <hub>` and obtain workspace access.");
    }
    // Narrower here than for a long-running client: this probe minted its
    // token seconds ago, in this process, in the current format, so the token's
    // *shape* is not in question. Three causes survive that — a secret the hub
    // does not share, a clock far enough out that the hub's clamp refuses an
    // otherwise correct token, and a hub older than this client, which reads
    // our envelope as unparseable and answers exactly as a wrong secret does.
    // The third is why the fix carries AUTH_REJECTED, since no probe can tell
    // it from the first.
    return fail(
      name,
      `${config.hubUrl} refused the signing secret`,
      `${AUTH_REJECTED}. Give the hub and this machine the same secret — a clock far enough out of step is refused the same way`,
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
      `${config.hubUrl}: ${versions}`,
      "update the older side, then restart this client — a hub and a client on different sync protocols exchange nothing at all, so no credential and no retry changes this",
    );
  }
  if (status === "unsettled") {
    // Up, and not serving: the socket opened and the directory room never
    // arrived. Reporting this as reachable is how a client that will never sync
    // gets called healthy.
    return (local ? fail : warn)(
      name,
      `${config.hubUrl} answered but the directory room did not finish syncing`,
      local
        ? "check the hub's log — it accepted the connection without serving the room; restarting it (`ub open --no-browser` starts one on loopback) is the usual fix"
        : "check the deployment's log — it accepted the connection without serving the room; restarting the hub there is the usual fix",
    );
  }
  return warn(
    name,
    `${config.hubUrl} does not answer`,
    "check your network or ask whoever runs the hub; your work stays here and syncs once the hub is back",
  );
}

/**
 * Whether this machine's clock is close enough to the hub's to be trusted.
 *
 * Tokens carry `exp`, and the hub refuses one issued more than
 * `CLOCK_SKEW_SECONDS` ahead of its own clock or already expired — so a machine
 * whose clock has drifted cannot connect at all, and the failure it sees is an
 * indistinguishable "invalid token". Naming the real cause is the only reason
 * this check exists.
 *
 * **Two thresholds, because the two directions break differently.** A machine
 * running fast trips `iat > now + CLOCK_SKEW_SECONDS`, which is 60 s. A machine
 * running slow mints a token that is *already expired* when the hub reads it —
 * `now > exp` — and since a room token is minted for
 * {@link MAX_TOKEN_LIFETIME_SECONDS}, that is 900 s of room before it breaks.
 * Neither bound is this command's invention; both are the clamp's, read from
 * the same constants the hub applies.
 *
 * The reading comes from the `Date` header of an unauthenticated GET, but only
 * after the hub check reached the hub. A skipped or unreachable hub skips this
 * check without another dial; the hub check already reports what it needs.
 */
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
      `${config.hubUrl} answered no HTTP date, so the clocks were not compared`,
    );
  }
  // The probe reports how far the hub reads ahead of us; both bounds below are
  // stated from this machine's side, so flip it once, here.
  const ahead = -skew;
  const measured =
    ahead === 0
      ? `in step with ${config.hubUrl}`
      : `${Math.abs(ahead)}s ${ahead > 0 ? "ahead of" : "behind"} ${config.hubUrl}`;

  // Asymmetric because the two failures are different ones: running fast trips
  // the 60s issued-in-the-future bound, running slow mints a token that has
  // already expired, which takes a whole token lifetime to reach.
  const limit = ahead > 0 ? CLOCK_SKEW_SECONDS : MAX_TOKEN_LIFETIME_SECONDS;
  if (Math.abs(ahead) <= limit) {
    return pass("clock", `this machine's clock is ${measured}`);
  }
  const rule =
    ahead > 0
      ? `more than the ${CLOCK_SKEW_SECONDS}s the hub tolerates ahead of its own`
      : `more than the ${MAX_TOKEN_LIFETIME_SECONDS}s a token lives, so this machine mints tokens that have already expired`;
  return fail(
    "clock",
    `this machine's clock is ${measured}, ${rule}`,
    "synchronise this machine's clock — every token carries an expiry, and the hub refuses one issued ahead of its own time or already past it (`sudo timedatectl set-ntp true` on Linux, System Settings > General > Date & Time on macOS). The reading is an HTTP `Date` header, so a reverse proxy in front of the hub is whose clock this compares against",
  );
}

/** The web listener is relevant even when the workspace lives on a remote hub. */
async function webServerCheck(): Promise<Check> {
  const name = "web server";
  const address = `${WEB_HOST}:${DEFAULT_WEB_PORT}`;
  const port = await probePort(WEB_HOST, DEFAULT_WEB_PORT);
  if (port.state === "free") {
    return skipped(name, `${address} is not running; \`ub open\` starts it`);
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
  return fail(name, `${address} is in use by a process that is not \`ub open\``, "stop that process, then run `ub open`");
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
      `chmod 600 ${credentials.path}`,
    );
  }
  if (endpoint === null || !["ws:", "wss:"].includes(new URL(config.hubUrl).protocol)) {
    return fail(
      name,
      `the configured endpoint ${JSON.stringify(config.hubUrl)} is not a websocket URL`,
      "give this machine a ws:// or wss:// endpoint with `ub workspace join <endpoint>/<workspace-id>`",
    );
  }
  const bind = hubBind(env);
  if (bind.port === null) {
    return fail(
      name,
      `PORT is ${JSON.stringify(bind.raw)}, which is not a port number`,
      "set PORT to an integer in 0..65535 — the same port the configured endpoint dials",
    );
  }
  if (bind.port !== endpoint.port) {
    const source = bind.raw === null ? "the built-in default" : "PORT";
    return fail(
      name,
      `the hub binds ${bind.host}:${bind.port} (${source}) but the configured endpoint dials port ${endpoint.port}`,
      PORT_REMEDY,
    );
  }

  const address = `${bind.host}:${bind.port}`;
  const probe = await probePort(bind.host, bind.port);
  if (probe.state === "free") {
    if (config.authSecret === null) {
      return skipped(name, `${address} is not running; no signing secret in force — hub sync is disabled, and every MCP tool still works; \`ub init\` writes a local development signing secret`);
    }
    // Reuse the starter's refusal so a skip never promises a hub it cannot start.
    const refusal = whyNotStartable(config.hubUrl, new URL(config.hubUrl));
    return skipped(name, refusal ?? `${address} is not running; \`ub open\` starts it at ${config.hubUrl}`);
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
  const hub = await dial(config.hubUrl);
  if (hub.status === "connected") {
    return pass(name, `${address} is held by an uberblick hub — it is already running`);
  }
  if (hub.status === "auth-failed" || hub.status === "unsettled" || hub.status === "update-required") {
    return hubVerdict(config, hub, name);
  }
  return fail(name, `${address} is in use by a process that is not an uberblick hub`, PORT_REMEDY);
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

/** Every scope `ub mcp install` can target, in the order it prefers them. */
const SCOPES: Scope[] = ["project", "user"];

function mcpCheck(env: NodeJS.ProcessEnv, cwd: string, resolved: ResolvedConfig | null): Check {
  const binding = resolved?.binding;
  const wanted = binding == null ? DEFAULT_ENTRY : { ...DEFAULT_ENTRY, env: { UB_HUB_URL: binding.hubUrl ?? "local", UB_WORKSPACE_ID: binding.workspaceId } };
  const registered: string[] = [];
  const unusable: string[] = [];
  let looked = 0;
  let custom = false;

  for (const target of TARGETS) {
    for (const scope of SCOPES) {
      const file = targetFile(target, scope, cwd, env);
      looked += 1;
      // The same presence probe `ub mcp install` decides with, so the two
      // commands cannot disagree about what is wired up. Nothing is quoted back
      // out of a config file — not its contents, and not a parser's complaint
      // about them: a file that is there and will not read is named by path.
      const found = presence(file, wanted);
      if (found === "absent") {
        continue;
      }
      if (found === "unusable") {
        unusable.push(file.path);
        continue;
      }
      registered.push(`${target} (${scope}): ${file.path}`);
      custom = custom || found === "foreign";
    }
  }

  // Reported whether or not something else is wired up: a config a command
  // cannot read is a fact about this machine either way, and "no client
  // registers uberblick" would be an answer this check does not have.
  const unread =
    unusable.length === 0 ? "" : `; could not read ${unusable.join(", ")}`;
  const first = registered[0];
  if (first !== undefined) {
    const note = custom ? ", registration differs from the selected binding or command" : "";
    const more = registered.length > 1 ? ` (and ${registered.length - 1} more)` : "";
    return pass("mcp", `registered in ${first}${more}${note}${unread}`);
  }
  return fail(
    "mcp",
    `no MCP client registers uberblick — looked in ${looked} configs for claude, codex and cursor${unread}`,
    unusable.length === 0
      ? "wire one up with `ub mcp install [claude|codex|cursor]`"
      : "repair or move the file named above, then `ub mcp install [claude|codex|cursor]`",
  );
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
    error = message(thrown);
  }

  let config: McpConfig | null = null;
  if (resolved !== null) {
    try {
      requireBinding(resolved);
      config = resolveMcpConfig(resolved.env);
    } catch (thrown) {
      error = message(thrown);
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

  const login = loginCheck(resolvedEnv, config);
  const checks: Check[] = [
    workspaceCheck(resolved, config, error),
    login,
    databaseCheck(config),
  ];
  const hub = await hubCheck(config, login, dial);
  checks.push(
    hub.check,
    await clockCheck(config, hub),
    await localHubCheck(config, endpoint, resolvedEnv, dial),
    mcpCheck(resolvedEnv, cwd, resolved),
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

export function renderDoctor(report: DoctorReport): string {
  let text = `uberblick ${report.version}\n\n`;
  for (const check of report.checks) {
    for (const line of check.listeners ?? [check]) {
      const reason = check.listeners === undefined ? line.reason : `${line.name}: ${line.reason}`;
      text += `${MARKERS[line.status].padEnd(6)}${check.name.padEnd(12)}${reason}\n`;
      if (line.status === "warn" || line.status === "fail") {
        text += `${" ".repeat(6)}→ ${line.fix}\n`;
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

Check the local stack against its known failure modes — configuration, the
stored remote login or local signing secret and its file mode, the database,
whether the hub is reachable and agrees with this machine's clock, both local
listeners, and the MCP client configs \`ub mcp install\` targets. Diagnoses, never
repairs. The database reading is offline and leaves the existing store unchanged;
it never creates an absent database, configuration file or directory.
Failures name their recovery.

options:
  --json            the same checks as JSON on stdout, for a script to read
  -h, --help        show this help

Exits non-zero when any check fails, so it works as a gate in a script.
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
