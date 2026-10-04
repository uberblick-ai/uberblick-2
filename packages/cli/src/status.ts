/**
 * `ub status` — what this machine is configured to do, and what it actually did.
 *
 * The command boots the same replica set the MCP server boots and reads the same
 * snapshot the `sync_status` tool returns (`collectSyncStatus`), so a human and
 * an agent see one answer, not two. That is also why it opens the real database
 * and gives the hub a bounded chance to answer: a status command that reported
 * only the configuration would say "fine" while nothing syncs.
 *
 * `--json` prints exactly one object to stdout and nothing else. Warnings,
 * diagnostics and the MCP server's own logging all go to stderr, so the JSON
 * stays parseable by a pipe.
 *
 * No secret or key is ever printed. `credentialPresent` states whether a
 * local secret or selected remote login is available. The `storage` object is
 * directories and database paths, never anything out of `credentials.json`.
 */

import { parseArgs } from "node:util";
import { hubDatabasePath } from "@uberblick/hub/config";
import { readDeviceLogin } from "@uberblick/hub/device-login";
import { collectSyncStatus, createMcpServer } from "@uberblick/mcp-server";
import type { McpConfig, SyncStatus } from "@uberblick/mcp-server";
import { resolveMcpConfig } from "./budget.js";
import type { CredentialOrigin, Origin, ShadowedLayer } from "./config.js";
import { resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { cliVersion } from "./version.js";

/**
 * Where this machine keeps its files.
 *
 * A stable object: a script reads the paths to find the files without
 * re-deriving anyone's rules. Directories and database files only — no
 * credential, and no value out of one.
 */
export interface StorageReport {
  /**
   * Always `"xdg"` — there is one layout on every platform (#385). The field
   * stays because a script that reads this object should not have to handle a
   * key disappearing; it is a constant, not a detection.
   */
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

export interface StatusReport {
  version: string;
  /** The workspace id as configured — the spelling its owner typed. */
  workspace: string;
  /**
   * The identity behind that spelling. Equal to `workspace` unless it carries a
   * display slug, and the only half that names a room, a token claim or the
   * database file — so it is what you quote when you tell somebody which
   * workspace this is.
   */
  workspaceUuid: string;
  /**
   * The endpoint that would be dialled. Reported whether or not sync is on —
   * `hub.url` is null when no signing secret makes it local-only.
   */
  hubUrl: string;
  databasePath: string;
  /** Whether the endpoint’s local secret or stored device login is present. */
  credentialPresent: boolean;
  credentialSource: CredentialOrigin | null;
  sources: { workspace: Origin; hubUrl: Origin };
  /**
   * The layers that lost to a *different* value above them — which is what
   * `sources` and `credentialSource` name. Absent unless something disagrees,
   * so a reader of the JSON can treat the key's presence as the conflict.
   */
  shadowed?: ShadowedLayer[] | undefined;
  /** `disabled` means no signing secret, so this machine is local-only. */
  hub: SyncStatus["hub"];
  rooms: SyncStatus["rooms"];
  /** Rooms holding local changes the hub has not acknowledged. Counts ROOMS. */
  unsyncedChanges: number;
  /**
   * Which rooms those are, with the log sequence still unacknowledged. The
   * count alone answers "is anything at risk"; this answers "what", which is
   * what someone about to close their laptop actually needs.
   */
  pendingRooms: SyncStatus["pendingRooms"];
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
  default: "built-in default",
};

/** The live diagnostic reading, shared with `ub doctor`. Always releases it. */
export async function readSyncStatus(config: McpConfig): Promise<SyncStatus> {
  const instance = createMcpServer(config);
  try {
    return await collectSyncStatus(instance.replicas);
  } finally {
    await instance.close();
  }
}

/** Collect the report without printing it. Exported for tests. */
export async function statusReport(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ report: StatusReport; warnings: string[] }> {
  const resolved = resolveConfig(options);
  // Throws when nothing configures a workspace, which `ub` reports as the
  // error it is: there is no default to fall back to, and `ub init` is named in
  // the message.
  const config = resolveMcpConfig(resolved.env);
  const sync = await readSyncStatus(config);
  return {
    warnings: resolved.warnings,
    report: {
      version: cliVersion(),
      workspace: resolved.env.WORKSPACE_ID ?? config.workspaceId,
      workspaceUuid: config.workspaceId,
      hubUrl: config.hubUrl,
      databasePath: config.databasePath,
      credentialPresent: config.deviceLogin === undefined ? config.authSecret !== null : readDeviceLogin(config.hubUrl, config.workspaceId, resolved.env).status === "ready",
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
      inFlightUpdates: sync.inFlightUpdates,
      logEntries: sync.logEntries,
      persistence: sync.persistence,
      storage: {
        layout: "xdg",
        config: resolved.paths.userConfig,
        data: resolved.storage.dataDir,
        // Asked of the hub package, so that what this reports and what a hub
        // started here would open cannot drift apart.
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

export function renderStatus(report: StatusReport): string {
  const hub = report.hub;
  const hubFailure =
    hub.status === "auth-failed" ||
    hub.status === "update-required" ||
    hub.status === "hub-down" ||
    (hub.status === "quarantined" && report.persistence === null);
  const failureCount = Number(report.persistence !== null) + Number(hubFailure);

  let text = `uberblick ${report.version}\n`;
  text += field("workspace", report.workspace);
  // Only when the spelling hides it. The slug is display; the uuid is what
  // rooms, tokens and the database are keyed by, and what to quote to somebody
  // else.
  if (report.workspaceUuid !== report.workspace) {
    text += field("uuid", report.workspaceUuid);
  }
  text += field("hub", report.hubUrl);
  text += field("connection", hub.status);
  if (hub.reason !== undefined) text += field("recovery", hub.reason);
  // Two counts in two units, as `sync_status` reports them: rooms, and provider
  // sync messages. They are not expected to agree.
  text += field(
    "pending",
    `${plural(report.unsyncedChanges, "room")} with unacknowledged local changes, ` +
      `${plural(report.inFlightUpdates, "sync message")} unacknowledged`,
  );
  text += field("rooms", `${plural(report.rooms.length, "room")} attached`);
  text += field("local log", `${plural(report.logEntries, "update record")} stored`);
  const failures =
    hub.status === "connecting" && failureCount === 0
      ? "hub state not yet known"
      : `${plural(failureCount, "detected failure")}${failureCount === 0 ? "" : " — run `ub doctor`"}` +
        (hub.status === "connecting" ? "; hub state not yet known" : "");
  text += field("failures", failures);
  return text;
}

/** Exported so the help below can be checked against the parser it describes. */
export const STATUS_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const STATUS_HELP = `usage: ub status [--json]

Overview of this machine's workspace, configured hub endpoint, connection state,
pending rooms and sync messages, attached rooms, records stored in the local log and
detected failures. Connection does not mean the hub acknowledged every change.
Recovery names the next action; \`ub doctor\` gives further diagnostics.
Workspace and hub bindings stay unchanged; renewal may update the stored login.

options:
  --json            full report as JSON, including rooms, configuration and paths
  -h, --help        show this help

The JSON report includes configuration sources and credential presence; the
signing secret is never printed. Warnings remain on stderr.
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

  const { report, warnings } = await statusReport();
  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  io.out(json ? `${JSON.stringify(report, null, 2)}\n` : renderStatus(report));
  return 0;
}
