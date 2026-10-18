import { parseArgs } from "node:util";
import { isGithubUsername } from "@uberblick/schema/github-identity";
import { hubDatabasePath } from "./hub-config.js";
import { readDeviceLogin } from "@uberblick/mcp-server/device-login";
import { authenticationOrigin } from "@uberblick/mcp-server/remote-url";
import { collectSyncStatus, formatHubFailure, openWorkspaceReplicas, readWorkspaceName } from "@uberblick/mcp-server";
import type { McpConfig, SyncStatus, WorkspaceReplicaSet } from "@uberblick/mcp-server";
import { displayUsername } from "./auth.js";
import { resolveMcpConfig } from "./budget.js";
import type { CredentialOrigin, Origin, ShadowedLayer } from "./config.js";
import { resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { NO_BINDING, type ProjectBinding } from "./project-binding.js";
import { cliVersion } from "./version.js";
import { recentDevicesNotice, requestRecentDevices, type RecentDevice } from "./recent-devices.js";

/** Diagnostic paths contain no credentials or values read from them. */
export interface StorageReport {
  /** Keep the constant field for consumers; it does not detect a platform. */
  layout: "xdg";
  /** The user config file, `config.json`. `credentials.json` sits beside it. */
  config: string;
  /** The data root: the one directory to name when somebody asks. */
  data: string;
  /** The database a hub started here would open (`HUB_DB_PATH` wins). */
  hub: string;
  /** This workspace's replica (`UBERBLICK_DB` wins) — the same as `databasePath`. */
  workspace: string;
}

/** Diagnostic input retained for `ub workspace status`, separate from public JSON. */
export interface StatusReport {
  binding: ProjectBinding;
  projectConfig: string | null;
  version: string;
  /** The workspace id as configured — the spelling its owner typed. */
  workspace: string;
  /** Bare identity for room names, token claims and database paths; no display slug. */
  workspaceUuid: string;
  /** Configured endpoint, even when absent credentials make `hub.url` null. */
  hubUrl: string;
  /** The account stored on this computer, independent of live hub acceptance. */
  account: { login: string; provider: "github" } | null;
  databasePath: string;
  /** Whether the endpoint’s local secret or stored device login is present. */
  credentialPresent: boolean;
  credentialSource: CredentialOrigin | null;
  sources: { workspace: Origin; hubUrl: Origin };
  /** Absent unless a lower configuration layer disagrees with the winning value. */
  shadowed?: ShadowedLayer[] | undefined;
  /** `disabled` means no signing secret, so this machine is local-only. */
  hub: SyncStatus["hub"];
  rooms: SyncStatus["rooms"];
  /** Rooms holding local changes the hub has not acknowledged. Counts ROOMS. */
  unsyncedChanges: number;
  /** Unacknowledged log sequences grouped by room. */
  pendingRooms: SyncStatus["pendingRooms"];
  /** Last time this replica was caught up with its hub; null for local workspaces. */
  lastSync: SyncStatus["lastSync"];
  /** Provider sync MESSAGES awaiting acknowledgement. Not a count of updates. */
  inFlightUpdates: number;
  logEntries: number;
  persistence: SyncStatus["persistence"];
  storage: StorageReport;
}

/** How an origin reads in the human output. Shared with `ub workspace`. */
export const ORIGIN_LABELS: Record<Origin, string> = {
  environment: "environment",
  "user config": "user config",
  "project config": "project config",
  default: "built-in default",
};

/** Use MCP's replica set and diagnostic snapshot; always release the replica. */
export async function readSyncStatus(
  config: McpConfig,
  inspect?: (replicas: WorkspaceReplicaSet["replicas"]) => void,
): Promise<SyncStatus> {
  const instance = openWorkspaceReplicas(config);
  try {
    const status = await collectSyncStatus(instance.replicas);
    inspect?.(instance.replicas);
    return status;
  } finally {
    await instance.close();
  }
}

/**
 * Read store cuts and pending markers together: a peer can clear a marker
 * before this replica applies its cut, and counts alone miss attach drain.
 */
export function workspaceCaughtUp(replicas: WorkspaceReplicaSet["replicas"]): boolean {
  const attached = replicas.attachedReplicas();
  const snapshot = replicas.store.syncSnapshot(
    attached.map(({ room, lastSeq }) => ({ room, throughSeq: lastSeq })),
  );
  return replicas.persistenceError() === null &&
    replicas.sync.state().status === "connected" &&
    !replicas.sync.isDraining() &&
    snapshot.pendingRooms.length === 0 &&
    attached.every(({ room }) => !snapshot.unappliedRooms.has(room) && replicas.isRoomQuiet(room));
}

export interface UnboundStatusReport {
  version: string;
  workspace: null;
  binding: null;
  hubUrl: null;
  account: null;
  lastSync: null;
  projectConfig: null;
  message: string;
}

/**
 * Keep name and acknowledgement metadata outside the diagnostic report.
 * Workspace status also reads stored accounts for shared-secret hubs.
 */
export async function statusReport(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; workspaceStatus?: boolean } = {},
): Promise<{
  report: StatusReport | UnboundStatusReport;
  warnings: string[];
  accountOrigin?: string;
  workspaceName?: string | null;
  caughtUp?: boolean;
  recentDevices?: RecentDevice[] | null;
}> {
  const resolved = resolveConfig(options);
  if (resolved.binding === null) {
    return { warnings: resolved.warnings, report: {
      version: cliVersion(), workspace: null, binding: null, hubUrl: null,
      account: null, lastSync: null, projectConfig: null, message: NO_BINDING,
    } };
  }
  const config = resolveMcpConfig(resolved.env);
  let caughtUp = false;
  const [sync, recentDevices] = await Promise.all([
    readSyncStatus(config, options.workspaceStatus === true
      ? replicas => { caughtUp = workspaceCaughtUp(replicas); } : undefined),
    options.workspaceStatus === true || config.deviceLogin === undefined ? null
      : requestRecentDevices({ ...resolved.binding, env: resolved.env }, AbortSignal.timeout(Math.floor(config.connectTimeoutMs))),
  ]);
  // Read the stored account without login or renewal, even after a hub refusal.
  const deviceLogin = config.deviceLogin === undefined &&
    !(options.workspaceStatus === true && resolved.binding.hubUrl !== null)
    ? undefined : readDeviceLogin(config.hubUrl, config.workspaceId, resolved.env);
  const accountOrigin = resolved.binding.hubUrl === null ? undefined : deviceLogin?.origin;
  return {
    warnings: resolved.warnings,
    recentDevices,
    workspaceName: readWorkspaceName(config.databasePath, config.workspaceId),
    ...(options.workspaceStatus === true ? { caughtUp } : {}),
    ...(accountOrigin === undefined ? {} : { accountOrigin }),
    report: {
      binding: resolved.binding,
      projectConfig: resolved.paths.projectConfig,
      version: cliVersion(),
      workspace: resolved.env.WORKSPACE_ID ?? config.workspaceId,
      workspaceUuid: config.workspaceId,
      hubUrl: config.hubUrl,
      account: accountOrigin !== undefined && deviceLogin?.status === "ready"
        ? { login: deviceLogin.login.identity.githubUsername, provider: "github" } : null,
      databasePath: config.databasePath,
      credentialPresent: deviceLogin === undefined ? config.authSecret !== null : deviceLogin.status === "ready",
      credentialSource: resolved.origins.credential,
      sources: {
        workspace: resolved.origins.workspace,
        hubUrl: resolved.origins.hubUrl,
      },
      ...(resolved.shadowed.length === 0
        ? {}
        : { shadowed: resolved.shadowed }),
      hub: sync.hub,
      rooms: sync.rooms,
      unsyncedChanges: sync.unsyncedChanges,
      pendingRooms: sync.pendingRooms,
      lastSync: resolved.binding.hubUrl === null ? null : sync.lastSync,
      inFlightUpdates: sync.inFlightUpdates,
      logEntries: sync.logEntries,
      persistence: sync.persistence,
      storage: {
        layout: "xdg",
        config: resolved.paths.userConfig,
        data: resolved.storage.dataDir,
        // Use the hub's own path resolver so its reported and opened paths agree.
        hub: hubDatabasePath(resolved.env),
        workspace: config.databasePath,
      },
    },
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function field(name: string, value: string): string {
  return `${name.padEnd(12)}${value}\n`;
}

function lastSyncAge(lastSync: string | null): string {
  if (lastSync === null) return "never";
  const seconds = Math.floor((Date.now() - Date.parse(lastSync)) / 1_000);
  if (seconds < 5) return "just now";
  for (const [unit, duration] of [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const) {
    if (seconds >= duration) return `${plural(Math.floor(seconds / duration), unit)} ago`;
  }
  return `${plural(seconds, "second")} ago`;
}

/** The public `ub status --json` contract, independent of diagnostics. */
export interface ShortStatusReport {
  workspace: { id: string; name: string | null };
  hub: string | null;
  account: StatusReport["account"];
  connection: {
    state: "connected" | "refused" | "failed";
    cause: NonNullable<SyncStatus["hub"]["cause"]> | null;
    detail: string | null;
  } | null;
  pending: { count: number };
  lastSync: string | null;
  recentDevices: RecentDevice[] | null;
  problems: { name: string; fix: string }[];
}

function olderHub(hub: SyncStatus["hub"]): boolean {
  return hub.hubProtocolVersion !== undefined && hub.hubProtocolVersion < hub.protocolVersion;
}

export function shortStatusReport(
  report: StatusReport, workspaceName: string | null = null, recentDevices: RecentDevice[] | null = null,
): ShortStatusReport {
  const origin = report.binding.hubUrl === null ? null : authenticationOrigin(report.binding.hubUrl);
  const hub = report.hub;
  const state = hub.status === "connected" ? "connected"
    : hub.status === "auth-failed" || hub.status === "update-required" ? "refused" : "failed";
  // The shared formatter validates the locally recorded evidence. Neither the
  // raw reason nor malformed detail can reach text or JSON.
  const recorded = state !== "connected" && formatHubFailure(hub) !== undefined;
  const problems: ShortStatusReport["problems"] = [];
  if (origin !== null) {
    switch (hub.status) {
      case "hub-down":
        problems.push({ name: "hub-unreachable", fix: "check DNS, network or VPN; ub doctor for details" });
        break;
      case "auth-failed":
        switch (hub.authRecovery) {
          case "sign-in-required":
            problems.push({ name: "not-signed-in", fix: `ub auth login ${origin}` });
            break;
          case "no-workspace-access": {
            const login = report.account?.login;
            problems.push({ name: "no-workspace-access", fix: login !== undefined && isGithubUsername(login)
              ? `ask a workspace admin to run: ub workspace member add ${login}`
              : "ask a workspace admin for access" });
            break;
          }
          default:
            problems.push({ name: hub.authRecovery ?? "sign-in-refused", fix: "ub doctor for details" });
        }
        break;
      case "update-required":
        problems.push({ name: "update-required", fix: olderHub(hub)
          ? `ask whoever runs ${origin} to update the hub` : "ub update" });
        break;
      case "disabled":
        problems.push({ name: "sync-disabled", fix: "ub doctor for details" });
        break;
    }
  }
  if (report.persistence !== null || hub.status === "quarantined") {
    problems.push({ name: "persistence-failed", fix: "ub doctor for details" });
  }
  return {
    workspace: { id: report.workspaceUuid, name: workspaceName },
    hub: origin,
    account: origin === null ? null : report.account,
    connection: origin === null ? null : {
      state,
      cause: recorded ? hub.cause ?? null : null,
      detail: recorded ? hub.detail ?? null : null,
    },
    pending: { count: origin === null ? 0 : report.unsyncedChanges },
    lastSync: origin === null ? null : report.lastSync,
    recentDevices: origin === null ? null : recentDevices,
    problems,
  };
}

function connectionText(report: StatusReport): string {
  const hub = report.hub;
  switch (hub.status) {
    case "connected": return "connected";
    case "connecting": return "no answer yet";
    case "update-required": return olderHub(hub)
      ? "refused: the hub runs an older Uberblick" : "refused: the hub needs a newer Uberblick";
    case "auth-failed": return hub.cause === "closed" ? formatHubFailure(hub) ?? "refused" : "refused";
    default: return formatHubFailure(hub) ?? "hub does not answer";
  }
}

const PROBLEM_PHRASES: Record<string, string> = {
  "hub-unreachable": "hub unreachable",
  "not-signed-in": "not signed in",
  "no-workspace-access": "no workspace access",
  "update-required": "update required",
  "persistence-failed": "local persistence failed",
  "credential-store": "stored login could not be read",
  "renewal-unavailable": "login could not be renewed",
  "sign-in-refused": "sign-in or signing secret refused",
  "sync-disabled": "sync disabled",
};

const UNREACHABLE_CAUSES: Record<NonNullable<SyncStatus["hub"]["cause"]>, string> = {
  dns: "DNS lookup failed",
  refused: "TCP connection refused",
  timeout: "TCP connect timed out",
  tls: "TLS failed",
  http: "HTTP upgrade failed",
  closed: "connection closed",
};

export function renderStatus(
  report: StatusReport | UnboundStatusReport,
  accountOrigin?: string,
  workspaceName: string | null = null,
  recentDevices: RecentDevice[] | null = null,
): string {
  if (report.binding === null) return "";
  const short = shortStatusReport(report, workspaceName);
  let text = field("workspace", short.workspace.name === null
    ? short.workspace.id : `${short.workspace.name} (${short.workspace.id})`);
  text += field("hub", short.hub ?? "local, this computer only");
  if (short.hub === null) {
    text += field("account", "none needed for a local workspace");
  } else if (short.account !== null) {
    text += field("account", `@${displayUsername(short.account.login)} (GitHub)`);
  } else if (accountOrigin !== undefined) {
    text += field("account", `not signed in to ${short.hub}`);
  }
  if (short.hub !== null) {
    text += field("connection", connectionText(report));
    text += field("pending", short.pending.count === 0
      ? "none" : `${plural(short.pending.count, "change")} not yet on the hub`);
    text += field("last sync", lastSyncAge(short.lastSync));
    text += recentDevicesNotice(recentDevices, short.hub);
  }
  if (short.problems.length === 0) return text + field("problems", "none");
  for (const [index, problem] of short.problems.entries()) {
    const phrase = problem.name === "hub-unreachable" && short.connection?.cause != null
      ? `hub unreachable: ${UNREACHABLE_CAUSES[short.connection.cause]}`
      : PROBLEM_PHRASES[problem.name] ?? "sync refused";
    text += field(index === 0 ? "problems" : "", phrase);
    text += `              → ${problem.fix}\n`;
  }
  return text;
}

export const STATUS_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const STATUS_HELP = `usage: ub status [--json]

Show whether this project's work is syncing: workspace, hub, sign-in, pending changes and problems.

options:
  --json            the same report as JSON on stdout, for scripts
  -h, --help        show this help

It connects briefly to the hub for a live answer. Last sync is the last full
replica acknowledgement, not durable hub storage. Each problem names its fix;
\`ub doctor\` gives details. Warnings remain on stderr.
`;

export async function statusCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  if (takeHelp(argv, io, STATUS_HELP)) return 0;

  let json = false;
  try {
    json =
      parseArgs({
        args: argv,
        options: STATUS_OPTIONS,
        allowPositionals: false,
      }).values.json === true;
  } catch (error) {
    io.err(`ub status: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const { report, warnings, accountOrigin, workspaceName, recentDevices } = await statusReport();
  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  if (report.binding === null) {
    io.err("no .uberblick.json here or in any parent directory\n" +
      "  → ub workspace create <name>, or ub workspace use <link|id>\n");
    return 1;
  }
  io.out(json ? `${JSON.stringify(shortStatusReport(report, workspaceName, recentDevices), null, 2)}\n`
    : renderStatus(report, accountOrigin, workspaceName, recentDevices));
  return 0;
}
