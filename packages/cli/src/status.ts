import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isGithubUsername } from "@uberblick/schema/github-identity";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { readDeviceLogin } from "@uberblick/mcp-server/device-login";
import { sanitizeHubVersion } from "@uberblick/mcp-server/management-client";
import { authenticationOrigin, hubTransportProblem } from "@uberblick/mcp-server/remote-url";
import { collectSyncStatus, formatHubFailure, openWorkspaceReplicas, readStoredSyncStatus, readWorkspaceName } from "@uberblick/mcp-server";
import type { McpConfig, SyncStatus, WorkspaceReplicaSet } from "@uberblick/mcp-server";
import { displayUsername } from "./auth.js";
import { resolveMcpConfig } from "./budget.js";
import type { Origin } from "@uberblick/mcp-server/project-config";
import { resolveConfig } from "@uberblick/mcp-server/project-config";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { field, plural, timeAgo } from "./strings.js";
import { NO_BINDING, type ProjectBinding } from "@uberblick/mcp-server/project-binding";
import { cliVersion } from "./version.js";
import { recentDevicesNotice, requestRecentDevices, type RecentDevice } from "./recent-devices.js";
import { ensureWorkspaceBinding, WorkspaceBindingMismatch } from "@uberblick/mcp-server/workspace-registry";

/** What `ub status` text and `--json` are rendered from. */
export interface StatusReport {
  binding: ProjectBinding;
  projectConfig: string | null;
  version: string;
  hubVersion?: string | null;
  /** Bare identity for room names, token claims and database paths; no display slug. */
  workspaceUuid: string;
  workspaceOrigin: Origin;
  /** Validated local refusal, kept separate from untrusted hub reasons. */
  hubTransportProblem?: { reason: string; fix: string };
  bindingProblem?: { reason: string; fix: string };
  /** The account stored on this computer, independent of live hub acceptance. */
  account: { login: string; provider: "github" } | null;
  databasePath: string;
  /** `disabled` means no signing secret, so this machine is local-only. */
  hub: SyncStatus["hub"];
  /** Rooms holding local changes the hub has not acknowledged. Counts ROOMS. */
  unsyncedChanges: number;
  /** Last time this replica was caught up with its hub; null for local workspaces. */
  lastSync: SyncStatus["lastSync"];
  persistence: SyncStatus["persistence"];
}

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

export interface UnboundStatusReport {
  binding: null;
  message: string;
}

/** Keep workspace name and recent devices outside the report. */
export async function statusReport(
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{
  report: StatusReport | UnboundStatusReport;
  warnings: string[];
  accountOrigin?: string;
  workspaceName?: string | null;
  recentDevices?: RecentDevice[] | null;
}> {
  const resolved = resolveConfig(options);
  if (resolved.binding === null) {
    return { warnings: resolved.warnings, report: { binding: null, message: resolved.bindingProblem ?? NO_BINDING } };
  }
  const config = resolveMcpConfig(resolved.env);
  let bindingProblem: WorkspaceBindingMismatch | undefined;
  try {
    await ensureWorkspaceBinding(resolved.binding, resolved.env, resolved.paths.projectConfig ?? "environment");
  } catch (error) {
    if (!(error instanceof WorkspaceBindingMismatch)) throw error;
    bindingProblem = error;
  }
  const transport = hubTransportProblem(config.hubUrl, resolved.env);
  const stored = bindingProblem === undefined ? undefined : readStoredSyncStatus(config.databasePath, config.workspaceId);
  const [sync, deviceReading] = await Promise.all([
    stored === undefined ? readSyncStatus(config) : {
      hub: { status: "disabled", url: null, protocolVersion: SYNC_PROTOCOL_VERSION },
      unsyncedChanges: stored.pendingRooms.length,
      lastSync: stored.lastSync === null ? null : new Date(stored.lastSync).toISOString().replace(/\.\d{3}Z$/, "Z"),
      persistence: null,
    } satisfies Partial<SyncStatus>,
    bindingProblem !== undefined || config.deviceLogin === undefined || transport !== null ? null
      : requestRecentDevices({ ...resolved.binding, env: resolved.env }, AbortSignal.timeout(Math.floor(config.connectTimeoutMs))),
  ]);
  // Read the stored account without login or renewal, even after a hub refusal.
  const deviceLogin = bindingProblem !== undefined || config.deviceLogin === undefined
    ? undefined : readDeviceLogin(config.hubUrl, config.workspaceId, resolved.env);
  const accountOrigin = resolved.binding.hubUrl === null ? undefined : deviceLogin?.origin;
  return {
    warnings: resolved.warnings,
    recentDevices: deviceReading?.devices ?? null,
    workspaceName: readWorkspaceName(config.databasePath, config.workspaceId),
    ...(accountOrigin === undefined ? {} : { accountOrigin }),
    report: {
      binding: resolved.binding,
      projectConfig: resolved.paths.projectConfig,
      version: cliVersion(),
      hubVersion: deviceReading?.hubVersion ?? null,
      workspaceUuid: config.workspaceId,
      workspaceOrigin: resolved.origins.workspace,
      ...(transport === null ? {} : { hubTransportProblem: transport }),
      ...(bindingProblem === undefined ? {} : { bindingProblem: { reason: bindingProblem.reason, fix: bindingProblem.fix } }),
      account: accountOrigin !== undefined && deviceLogin?.status === "ready"
        ? { login: deviceLogin.login.identity.githubUsername, provider: "github" } : null,
      databasePath: config.databasePath,
      hub: sync.hub,
      unsyncedChanges: sync.unsyncedChanges,
      lastSync: resolved.binding.hubUrl === null && bindingProblem === undefined ? null : sync.lastSync,
      persistence: sync.persistence,
    },
  };
}

/** The public `ub status --json` contract. */
export interface ShortStatusReport {
  workspace: { id: string; name: string | null };
  hub: string | null;
  version: { client: string; hub: string | null };
  account: StatusReport["account"];
  chosenBy: { source: "project-config" | "environment"; path: string | null };
  storedIn: string;
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

function connectionState(report: StatusReport): NonNullable<ShortStatusReport["connection"]>["state"] {
  if (report.bindingProblem !== undefined || report.hubTransportProblem !== undefined) return "refused";
  if (report.hub.status === "connected") return "connected";
  if (report.hub.status === "auth-failed" || report.hub.status === "update-required") return "refused";
  return "failed";
}

function workspaceSelection(report: StatusReport): ShortStatusReport["chosenBy"] {
  return report.workspaceOrigin === "project config" && report.projectConfig !== null
    ? { source: "project-config", path: report.projectConfig }
    : { source: "environment", path: null };
}

function statusVersion(report: StatusReport): ShortStatusReport["version"] {
  return { client: report.version, hub: report.binding.hubUrl !== null && connectionState(report) === "connected"
    ? sanitizeHubVersion(report.hubVersion) ?? null : null };
}

export function shortStatusReport(
  report: StatusReport, workspaceName: string | null = null, recentDevices: RecentDevice[] | null = null,
): ShortStatusReport {
  const origin = report.binding.hubUrl === null ? null : authenticationOrigin(report.binding.hubUrl);
  const local = origin === null && report.bindingProblem === undefined;
  const hub = report.hub;
  const state = connectionState(report);
  // The shared formatter validates the locally recorded evidence. Neither the
  // raw reason nor malformed detail can reach text or JSON.
  const recorded = state !== "connected" && formatHubFailure(hub) !== undefined;
  const problems: ShortStatusReport["problems"] = [];
  if (report.bindingProblem !== undefined) {
    problems.push({ name: "workspace-hub-mismatch", fix: `${report.bindingProblem.reason} ${report.bindingProblem.fix}` });
  } else if (origin !== null) {
    if (report.hubTransportProblem !== undefined) {
      problems.push({ name: "insecure-hub", fix: report.hubTransportProblem.fix });
    } else switch (hub.status) {
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
    version: statusVersion(report),
    account: origin === null ? null : report.account,
    chosenBy: workspaceSelection(report),
    storedIn: resolve(report.databasePath),
    connection: origin === null && report.bindingProblem === undefined ? null : {
      state,
      cause: recorded ? hub.cause ?? null : null,
      detail: recorded ? hub.detail ?? null : null,
    },
    pending: { count: local ? 0 : report.unsyncedChanges },
    lastSync: local ? null : report.lastSync,
    recentDevices: origin === null ? null : recentDevices,
    problems,
  };
}

function connectionText(report: StatusReport): string {
  if (report.bindingProblem !== undefined) return "refused: workspace hub mismatch";
  if (report.hubTransportProblem !== undefined) return report.hubTransportProblem.reason;
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
  "workspace-hub-mismatch": "workspace hub does not match this machine",
  "insecure-hub": "unencrypted hub connection refused",
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
  report: StatusReport,
  accountOrigin?: string,
  workspaceName: string | null = null,
  recentDevices: RecentDevice[] | null = null,
): string {
  const short = shortStatusReport(report, workspaceName);
  let text = field("workspace", short.workspace.name === null
    ? short.workspace.id : `${short.workspace.name} (${short.workspace.id})`);
  text += field("hub", short.hub ?? "local, this computer only");
  text += field("version", `client ${short.version.client}` +
    (short.connection === null ? "" : `, hub ${short.version.hub ?? "unknown"}`));
  if (short.hub === null) {
    text += field("account", "none needed for a local workspace");
  } else if (short.account !== null) {
    text += field("account", `@${displayUsername(short.account.login)} (GitHub)`);
  } else if (accountOrigin !== undefined) {
    text += field("account", `not signed in to ${short.hub}`);
  }
  text += field("chosen by", short.chosenBy.path === null
    ? "environment" : `project config in ${dirname(short.chosenBy.path)}`);
  text += field("stored in", short.storedIn);
  if (short.hub !== null || report.bindingProblem !== undefined) {
    text += field("connection", connectionText(report));
    text += field("pending", short.pending.count === 0
      ? "none" : `${plural(short.pending.count, "change")} not yet on the hub`);
    text += field("last sync", short.lastSync === null ? "never" : timeAgo(short.lastSync));
    if (short.hub !== null) text += recentDevicesNotice(recentDevices, short.hub);
  }
  if (short.problems.length === 0) return text + field("problems", "none");
  for (const [index, problem] of short.problems.entries()) {
    const phrase = problem.name === "hub-unreachable" && short.connection?.cause != null
      ? `hub unreachable: ${UNREACHABLE_CAUSES[short.connection.cause]}`
      : PROBLEM_PHRASES[problem.name] ?? "sync refused";
    text += field(index === 0 ? "problems" : "", phrase);
    text += `              → ${problem.fix.replace(/\n/g, "\n                ")}\n`;
  }
  return text;
}

export const STATUS_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const STATUS_HELP = `usage: ub status [--json]

Show this project's workspace, selection source, local storage and sync status.

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
    io.err(`${report.message === NO_BINDING ? "no .uberblick.json here or in any parent directory" : report.message}\n` +
      "  → ub workspace create <name>, or ub workspace use <link|id>\n");
    return 1;
  }
  io.out(json ? `${JSON.stringify(shortStatusReport(report, workspaceName, recentDevices), null, 2)}\n`
    : renderStatus(report, accountOrigin, workspaceName, recentDevices));
  return 0;
}
