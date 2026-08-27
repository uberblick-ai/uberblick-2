/**
 * `ub doctor` — the local stack's documented failure modes, run as checks.
 *
 * Each check answers one question somebody would otherwise answer by finding,
 * reading and translating prose: which storage layout is in force, is a
 * workspace configured, is a signing secret usable, can the database be
 * written, does a hub answer, is this machine's clock close enough to the
 * hub's, do the two port settings agree, who holds the
 * port, is any MCP client wired up. Three of the
 * hub-side failures present identically as "offline" in the web UI, which is
 * the reason this command exists — it names the cause and the fix.
 *
 * **It diagnoses; it never repairs.** Nothing here writes a file, creates a
 * directory or opens the database. A failed check names the command that would
 * repair it and stops there.
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

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  CLOCK_SKEW_SECONDS,
  MAX_TOKEN_LIFETIME_SECONDS,
} from "@uberblick/hub/token";
import type { StoragePaths } from "@uberblick/hub/storage";
import {
  AmbiguousStorageError,
  MAC_ROOT_DISPLAY,
  resolveStorage,
} from "@uberblick/hub/storage";
import type { McpConfig } from "@uberblick/mcp-server";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import type { ResolvedConfig } from "./config.js";
import { readCredentials, resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import type { Scope } from "./mcp-config.js";
import {
  DEFAULT_ENTRY,
  TARGETS,
  UnusableConfig,
  inspect,
  targetFile,
} from "./mcp-config.js";
import type { Endpoint, HubReach } from "./probes.js";
import {
  dialHost,
  endpointOf,
  hubBind,
  isLocalHost,
  probeHub,
  probeHubClock,
  probePort,
} from "./probes.js";
import { ORIGIN_LABELS } from "./status.js";
import { cliVersion } from "./version.js";

/** Stable strings: `--json` prints them and a script will branch on them. */
export type CheckStatus = "pass" | "fail" | "skipped";

export interface Check {
  /** Stable name of the check. */
  name: string;
  status: CheckStatus;
  /** One line, and never a secret. */
  reason: string;
  /** The command that repairs it, or null when there is nothing to repair. */
  remedy: string | null;
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
  return { name, status: "pass", reason, remedy: null };
}

function fail(name: string, reason: string, remedy: string): Check {
  return { name, status: "fail", reason, remedy };
}

function skipped(name: string, reason: string, remedy: string | null = null): Check {
  return { name, status: "skipped", reason, remedy };
}

const WORKSPACE_REMEDY =
  "`ub init` creates a workspace; `ub workspace use <id>` adopts an existing one";

/** install.md: "set `PORT` for the hub and `HUB_URL` for the clients together." */
const PORT_REMEDY =
  "set PORT for the hub and HUB_URL for the clients together — the hub binds HUB_HOST:PORT and never reads HUB_URL";

// --- storage layout ----------------------------------------------------------

/**
 * Which of the three storage layouts is in force, and the refusal when that
 * cannot be answered.
 *
 * A Mac holding uberblick state in *both* `~/Library/Application Support` and
 * the legacy XDG defaults is the one configuration this command cannot report
 * around: every other check would have to open a file in one root or the
 * other, and choosing would hide a corpus. So it is a failure with both roots
 * named, and every check below it is skipped rather than run against a guess.
 */
function storageCheck(storage: StoragePaths): Check {
  const where = `config ${storage.configDir}, data ${storage.dataDir}`;
  if (storage.layout === "legacy-xdg") {
    return {
      name: "storage-layout",
      status: "pass",
      reason: `${storage.layout} — ${where}`,
      remedy: `\`ub storage migrate\` (#249) will move these under ${MAC_ROOT_DISPLAY}; nothing has moved yet, and nothing new was created`,
    };
  }
  return pass("storage-layout", `${storage.layout} — ${where}`);
}

/** The checks that need a resolved layout — every one of them, in order. */
const AFTER_STORAGE = [
  "workspace",
  "credential",
  "database",
  "hub",
  "clock",
  "port",
  "bind",
  "mcp",
] as const;

// --- workspace ---------------------------------------------------------------

function workspaceCheck(
  env: NodeJS.ProcessEnv,
  resolved: ResolvedConfig | null,
  config: McpConfig | null,
  error: string | null,
): Check {
  if (config === null || resolved === null) {
    // Nothing configured at all is the common case and gets a line of its own;
    // a value that *is* configured and was refused keeps the refusal's own
    // message, which names the layer the value came from.
    const configured = env.WORKSPACE_ID?.trim();
    const reason =
      configured === undefined || configured === ""
        ? "none configured — a workspace id names the rooms, the token claim and the local database, and there is no default"
        : (error ?? `${configured} was refused`);
    return fail("workspace", reason, WORKSPACE_REMEDY);
  }
  const spelling = resolved.env.WORKSPACE_ID ?? config.workspaceId;
  const origin = ORIGIN_LABELS[resolved.origins.workspace];
  const uuid = spelling === config.workspaceId ? "" : ` — uuid ${config.workspaceId}`;
  return pass("workspace", `${spelling} (${origin})${uuid}`);
}

// --- credential --------------------------------------------------------------

/** The permission bits, as install.md quotes them: `mode 0644`. */
function modeOf(path: string): string {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
  } catch {
    return "unreadable";
  }
}

/**
 * Present, refused, or absent — and absent is not a failure.
 *
 * A `credentials.json` other users can read is refused rather than used, so it
 * is the one credential state that *is* a failure: the secret exists, it went
 * unused, and one chmod restores hub sync. Having no secret at all only turns
 * sync off, and this server serves every tool without it.
 */
function credentialCheck(
  resolved: ResolvedConfig | null,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Check {
  const credentials = readCredentials(env, platform);
  if (credentials.exposed) {
    return fail(
      "credential",
      `refusing ${credentials.path}: mode ${modeOf(credentials.path)} lets other users read the hub signing secret, so it was not used`,
      `chmod 600 ${credentials.path}`,
    );
  }
  const origin = resolved?.origins.credential ?? null;
  if (origin !== null) {
    return pass("credential", `configured (${origin}), and never printed`);
  }
  return skipped(
    "credential",
    "no signing secret in force — hub sync is disabled, and every MCP tool still works",
    "`ub init` writes a local development signing secret",
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
  const problem = directoryProblem(dirname(path));
  if (problem === null) {
    return pass("database", path);
  }
  return fail(
    "database",
    `${path}: ${problem}`,
    "make that directory writable, or point UBERBLICK_DB at a path you can write",
  );
}

// --- hub, port, bind ---------------------------------------------------------

/**
 * One dial per endpoint, shared between the reachability check and the check
 * that asks who holds the port — which are usually the same endpoint, and a
 * second connection would only say the same thing more slowly.
 */
function hubProber(config: McpConfig): Dial {
  const seen = new Map<string, Promise<HubReach>>();
  return (url) => {
    const known = seen.get(url);
    if (known !== undefined) {
      return known;
    }
    const probe = probeHub(config, url);
    seen.set(url, probe);
    return probe;
  };
}

/** What both hub checks are handed: an endpoint in, what a client found out. */
type Dial = (url: string) => Promise<HubReach>;

async function hubCheck(
  config: McpConfig | null,
  endpoint: Endpoint | null,
  dial: Dial,
): Promise<Check> {
  if (config === null) {
    return skipped("hub", "no workspace configured, so no hub token could be minted");
  }
  if (config.authSecret === null) {
    return skipped(
      "hub",
      `no signing secret, so ${config.hubUrl} was not dialled — this machine is local-only`,
    );
  }
  // Which remedy applies is a property of the endpoint, not of the failure. A
  // hub on this machine is one `ub open` away; a remote one is somebody's
  // deployment, which this command can neither start nor pretend to.
  const local = endpoint !== null && isLocalHost(endpoint.host);
  const status = await dial(config.hubUrl);
  if (status === "connected") {
    return pass("hub", `${config.hubUrl} answered and served the directory room`);
  }
  if (status === "auth-failed") {
    // Narrower here than for a long-running client: this probe minted its
    // token seconds ago, in this process, in the current format, so the token's
    // *shape* is not in question. Two causes survive that — a secret the hub
    // does not share, and a clock far enough out that the hub's clamp refuses
    // an otherwise correct token. The check below reads the second one.
    return fail(
      "hub",
      `${config.hubUrl} refused the signing secret`,
      "give the hub and this machine the same secret — `ub status` says which layer this one came from — and read the clock check below, because a clock far enough out of step is refused the same way",
    );
  }
  if (status === "unsettled") {
    // Up, and not serving: the socket opened and the directory room never
    // arrived. Reporting this as reachable is how a client that will never sync
    // gets called healthy.
    return fail(
      "hub",
      `${config.hubUrl} answered but the directory room did not finish syncing`,
      local
        ? "check the hub's log — it accepted the connection without serving the room; restarting it (`ub open --no-browser` starts one on loopback) is the usual fix"
        : "check the deployment's log — it accepted the connection without serving the room; restarting the hub there is the usual fix",
    );
  }
  return fail(
    "hub",
    `nothing answered ${config.hubUrl}`,
    local
      ? "start a hub with `ub open --no-browser` — if one is running, the port check says whether HUB_URL disagrees with the port it bound"
      : "check that the deployment is running and that this machine can reach it — nothing is listening at that address from here",
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
 * It needs no credential: the reading comes from the `Date` header of an
 * unauthenticated GET, so it answers even on a machine that has never been
 * provisioned. A hub that does not answer is a skip, not a failure — the hub
 * check above is what reports an unreachable hub, and saying so twice would
 * only bury it.
 */
async function clockCheck(config: McpConfig | null): Promise<Check> {
  if (config === null) {
    return skipped("clock", "no workspace configured, so no hub was dialled");
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

/** Whether the two halves of the port configuration name the same socket. */
function portCheck(
  config: McpConfig | null,
  endpoint: Endpoint | null,
  env: NodeJS.ProcessEnv,
): Check {
  if (config === null) {
    return skipped("port", "no workspace configured, so no endpoint resolves");
  }
  if (endpoint === null) {
    return fail(
      "port",
      `HUB_URL is ${JSON.stringify(config.hubUrl)}, which is not a websocket URL`,
      "set HUB_URL to a ws:// or wss:// endpoint",
    );
  }
  if (!isLocalHost(endpoint.host)) {
    return skipped(
      "port",
      `${config.hubUrl} is not on this machine, so no local PORT applies to it`,
    );
  }
  const bind = hubBind(env);
  if (bind.port === null) {
    return fail(
      "port",
      `PORT is ${JSON.stringify(bind.raw)}, which is not a port number`,
      "set PORT to an integer in 0..65535, and HUB_URL to the same port",
    );
  }
  if (bind.port !== endpoint.port) {
    const source = bind.raw === null ? "the built-in default" : "PORT";
    return fail(
      "port",
      `the hub binds ${bind.host}:${bind.port} (${source}) but HUB_URL dials port ${endpoint.port}`,
      PORT_REMEDY,
    );
  }
  return pass("port", `HUB_URL and the hub's bind address agree on port ${bind.port}`);
}

/**
 * Who holds the port the hub binds.
 *
 * "Taken" is not by itself a problem — the normal case is that our own hub took
 * it — so the answer is only actionable once the two are told apart, and the way
 * to tell them apart is to dial it as a client: an uberblick hub completes the
 * handshake or refuses the token, and anything else does neither.
 */
async function bindCheck(
  config: McpConfig | null,
  endpoint: Endpoint | null,
  env: NodeJS.ProcessEnv,
  dial: Dial,
): Promise<Check> {
  if (config === null || endpoint === null) {
    return skipped("bind", "no local endpoint resolves, so no port was tested");
  }
  if (!isLocalHost(endpoint.host)) {
    return skipped(
      "bind",
      `${config.hubUrl} is not on this machine, so no local port holds it`,
    );
  }
  const bind = hubBind(env);
  if (bind.port === null) {
    return skipped("bind", "PORT is not a port number, so no address was tested");
  }

  const address = `${bind.host}:${bind.port}`;
  const probe = await probePort(bind.host, bind.port);
  if (probe.state === "free") {
    return pass("bind", `${address} is free — the hub can bind it`);
  }
  if (probe.state === "unknown") {
    return skipped("bind", `${address} could not be tested (${probe.code ?? "unknown error"})`);
  }
  if (config.authSecret === null) {
    return skipped(
      "bind",
      `${address} is in use; without a signing secret this cannot tell an uberblick hub from another process`,
    );
  }
  // When the clients dial the port the hub binds — the healthy arrangement —
  // this is the endpoint the reachability check already dialled, and the prober
  // hands back that answer instead of opening a second connection to say it.
  const status = await dial(
    bind.port === endpoint.port
      ? config.hubUrl
      : `ws://${dialHost(bind.host)}:${bind.port}`,
  );
  if (status === "connected") {
    return pass("bind", `${address} is held by an uberblick hub — it is already running`);
  }
  if (status === "auth-failed" || status === "unsettled") {
    // It speaks the protocol, and that is all it proved. Only a directory read
    // with our own token identifies our hub; anything else could be somebody
    // else's Hocuspocus server, and calling it ours would send a person looking
    // for a hub that is not there.
    return skipped(
      "bind",
      `${address} is held by something that speaks the protocol but did not serve this workspace with our credential`,
      "if it is your hub, give it and this machine the same signing secret; if it is not, set PORT for the hub and HUB_URL for the clients together",
    );
  }
  return fail(
    "bind",
    `${address} is in use by a process that is not an uberblick hub`,
    PORT_REMEDY,
  );
}

// --- MCP wiring --------------------------------------------------------------

/** Every file `ub mcp install` knows how to write, in the order it prefers them. */
const SCOPES: Scope[] = ["project", "user"];

function mcpCheck(env: NodeJS.ProcessEnv, cwd: string): Check {
  const registered: string[] = [];
  const unusable: string[] = [];
  let looked = 0;
  let custom = false;

  for (const target of TARGETS) {
    for (const scope of SCOPES) {
      const file = targetFile(target, scope, cwd, env);
      looked += 1;
      let text: string;
      try {
        text = readFileSync(file.path, "utf8");
      } catch {
        continue;
      }
      try {
        const found = inspect(file.format, text, DEFAULT_ENTRY);
        if (found.existing !== null) {
          registered.push(`${target} (${scope}): ${file.path}`);
          custom = custom || !found.matches;
        }
      } catch (error) {
        // Never the file's own bytes, and never the parser's message: a client
        // config is exactly where somebody keeps an API token.
        unusable.push(
          `${file.path} (${error instanceof UnusableConfig ? error.message : "could not be read"})`,
        );
      }
    }
  }

  const first = registered[0];
  if (first !== undefined) {
    const note = custom ? ", running a command of its own rather than `ub mcp serve`" : "";
    const more = registered.length > 1 ? ` (and ${registered.length - 1} more)` : "";
    return pass("mcp", `registered in ${first}${more}${note}`);
  }
  const refused = unusable.length === 0 ? "" : `; could not read ${unusable.join(", ")}`;
  return fail(
    "mcp",
    `no MCP client registers uberblick — looked in ${looked} configs for claude, codex and cursor${refused}`,
    "wire one up with `ub mcp install [claude|codex|cursor]`",
  );
}

// --- the report --------------------------------------------------------------

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** `process.platform` by default; injected so the Mac layout is testable. */
  platform?: NodeJS.Platform;
}

/** Run every check without printing anything. Exported for tests. */
export async function doctorReport(
  options: DoctorOptions = {},
): Promise<{ report: DoctorReport; warnings: string[] }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const warnings: string[] = [];

  // Before anything reads a file: which root the files are in. An ambiguous
  // answer stops the report here — nothing below it may open a database.
  let storage: StoragePaths;
  try {
    storage = resolveStorage({ env, platform });
  } catch (thrown) {
    if (!(thrown instanceof AmbiguousStorageError)) {
      throw thrown;
    }
    return {
      warnings,
      report: {
        version: cliVersion(),
        ok: false,
        checks: [
          // The error's own message sends a person to `ub doctor`; this *is*
          // `ub doctor`, so it states the roots and lets the remedy line do the
          // rest.
          fail(
            "storage-layout",
            `${thrown.macRoot} and the legacy ${thrown.legacyConfigDir} / ${thrown.legacyDataDir} both hold uberblick state`,
            thrown.remedy,
          ),
          ...AFTER_STORAGE.map((name) =>
            skipped(
              name,
              "the storage layout is ambiguous, so nothing was resolved and no database was opened",
            ),
          ),
        ],
      },
    };
  }

  // Resolution itself can refuse — a workspace id that is not a uuid is a
  // configuration error, and a command whose job is to report configuration
  // errors must report it rather than exit on it.
  let resolved: ResolvedConfig | null = null;
  let error: string | null = null;
  try {
    resolved = resolveConfig({ env, platform });
    warnings.push(...resolved.warnings);
  } catch (thrown) {
    error = message(thrown);
  }

  let config: McpConfig | null = null;
  if (resolved !== null) {
    try {
      config = resolveMcpConfig(resolved.env, platform);
    } catch (thrown) {
      error = message(thrown);
    }
  }

  const resolvedEnv = resolved?.env ?? env;
  const endpoint = config === null ? null : endpointOf(config.hubUrl);
  // Both hub checks take their config first, so a null one never dials.
  const dial: Dial =
    config === null ? async () => "disabled" : hubProber(config);

  const checks: Check[] = [
    storageCheck(storage),
    workspaceCheck(resolvedEnv, resolved, config, error),
    credentialCheck(resolved, resolvedEnv, platform),
    databaseCheck(config),
    await hubCheck(config, endpoint, dial),
    await clockCheck(config),
    portCheck(config, endpoint, resolvedEnv),
    await bindCheck(config, endpoint, resolvedEnv, dial),
    mcpCheck(resolvedEnv, cwd),
  ];

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
  fail: "FAIL",
  skipped: "skip",
};

export function renderDoctor(report: DoctorReport): string {
  let text = `uberblick ${report.version}\n\n`;
  for (const check of report.checks) {
    text += `${MARKERS[check.status].padEnd(6)}${check.name.padEnd(12)}${check.reason}\n`;
    if (check.remedy !== null) {
      // Indented under the line it repairs: the remedy is the answer, and it has
      // to be findable without reading the whole report.
      text += `${" ".repeat(6)}→ ${check.remedy}\n`;
    }
  }
  const counts = { pass: 0, fail: 0, skipped: 0 };
  for (const check of report.checks) {
    counts[check.status] += 1;
  }
  text += `\n${counts.fail} failed, ${counts.pass} passed, ${counts.skipped} skipped\n`;
  return text;
}

/** Exported so the help below can be checked against the parser it describes. */
export const DOCTOR_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const DOCTOR_HELP = `usage: ub doctor [--json]

Check the local stack against its known failure modes — configuration, the
signing secret and its file mode, the database, whether the hub is reachable
and agrees with this machine's clock, and the MCP client configs
\`ub mcp install\` writes. Reads only; it fixes nothing and names what to run
instead.

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
