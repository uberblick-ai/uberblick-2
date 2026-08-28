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
 * No secret is ever printed. `credentialPresent` is the whole of what this
 * command says about the hub signing secret. The `storage` object is
 * directories and database paths, never anything out of `credentials.json`.
 */

import { parseArgs } from "node:util";
import { hubDatabasePath } from "@uberblick/hub/config";
import {
  collectSyncStatus,
  createMcpServer,
  resolveMcpConfig,
} from "@uberblick/mcp-server";
import type { SyncStatus } from "@uberblick/mcp-server";
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
  /** Whether a hub signing secret is configured. Never the secret itself. */
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

/** Collect the report without printing it. Exported for tests. */
export async function statusReport(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ report: StatusReport; warnings: string[] }> {
  const resolved = resolveConfig(options);
  // Throws when nothing configures a workspace, which `ub` reports as the
  // error it is: there is no default to fall back to, and `ub init` is named in
  // the message.
  const config = resolveMcpConfig(resolved.env);
  const instance = createMcpServer(config);
  try {
    const sync = await collectSyncStatus(instance.replicas);
    return {
      warnings: resolved.warnings,
      report: {
        version: cliVersion(),
        workspace: resolved.env.WORKSPACE_ID ?? config.workspaceId,
        workspaceUuid: config.workspaceId,
        hubUrl: config.hubUrl,
        databasePath: config.databasePath,
        credentialPresent: config.authSecret !== null,
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
  } finally {
    await instance.close();
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function field(name: string, value: string): string {
  return `${name.padEnd(12)}${value}\n`;
}

export function renderStatus(report: StatusReport): string {
  const hub = report.hub;
  const reason = hub.reason === undefined ? "" : ` — ${hub.reason}`;
  const credential = report.credentialPresent
    ? `configured (${report.credentialSource})`
    : "none — local-only, no hub sync";

  let text = `uberblick ${report.version}\n`;
  text += field(
    "workspace",
    `${report.workspace} (${ORIGIN_LABELS[report.sources.workspace]})`,
  );
  // Only when the spelling hides it. The slug is display; the uuid is what
  // rooms, tokens and the database are keyed by, and what to quote to somebody
  // else.
  if (report.workspaceUuid !== report.workspace) {
    text += field("uuid", report.workspaceUuid);
  }
  text += field(
    "hub",
    `${report.hubUrl} (${ORIGIN_LABELS[report.sources.hubUrl]})`,
  );
  text += field("sync", `${hub.status}${reason}`);
  // "credential", not "token": HUB_AUTH_TOKEN is the secret tokens are signed
  // with, and the two words must not blur into each other.
  text += field("credential", credential);
  // Only when something disagrees. The line above it says what is in force;
  // this one says what that overrode, which is the question `ub status` could
  // not answer while it reported the winner alone.
  for (const shadowed of report.shadowed ?? []) {
    text += field(
      "shadowed",
      `${shadowed.setting} in ${shadowed.layer} — the environment is in force`,
    );
  }
  text += field("database", report.databasePath);
  // The data root, named once: everything durable is under it, and "where is my
  // data" is the question this line exists to answer.
  text += field("storage", report.storage.data);
  // Two counts in two units, as `sync_status` reports them: rooms, and provider
  // sync messages. They are not expected to agree.
  text += field(
    "pending",
    `${plural(report.unsyncedChanges, "room")} unsynced, ` +
      `${plural(report.inFlightUpdates, "sync message")} unacked, ` +
      `${report.logEntries} log entries`,
  );
  // Naming the rooms under the count: "3 rooms unsynced" is an alarm, and the
  // next question is always which ones.
  for (const pending of report.pendingRooms) {
    text += `  ${pending.room}  waiting on seq ${pending.seq}\n`;
  }

  if (report.persistence !== null) {
    text += field("persistence", `FAILED: ${report.persistence.message}`);
  }

  text += field("rooms", `${plural(report.rooms.length, "room")} attached`);
  for (const room of report.rooms) {
    const synced = room.synced ? "synced" : "not synced";
    text += `  ${room.room}  applied seq ${room.appliedSeq}  ${synced}\n`;
  }
  return text;
}

/** Exported so the help below can be checked against the parser it describes. */
export const STATUS_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const STATUS_HELP = `usage: ub status [--json]

What this directory resolves to right now: the workspace and which layer chose
it, any layer that named something different and lost, the hub endpoint, whether
a signing secret is configured, the local database and the sync state of every
room attached to it. Reads only — nothing here changes any configuration.

options:
  --json            the same report as JSON on stdout, for a script to read
  -h, --help        show this help

The signing secret is never printed; the report says only whether one is there
and where it came from.
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
