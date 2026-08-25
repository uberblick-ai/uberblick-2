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
 * command says about the hub signing secret.
 */

import { parseArgs } from "node:util";
import {
  collectSyncStatus,
  createMcpServer,
  resolveMcpConfig,
} from "@uberblick/mcp-server";
import type { SyncStatus } from "@uberblick/mcp-server";
import type { CredentialOrigin, Origin } from "./config.js";
import { DIRECTORY_FILE, resolveConfig } from "./config.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { cliVersion } from "./version.js";

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
}

/** How an origin reads in the human output. Shared with `ub workspace`. */
export const ORIGIN_LABELS: Record<Origin, string> = {
  environment: "environment",
  "directory file": `./${DIRECTORY_FILE}`,
  "user config": "user config",
  default: "built-in default",
};

/** Collect the report without printing it. Exported for tests. */
export async function statusReport(
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
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
        hub: sync.hub,
        rooms: sync.rooms,
        unsyncedChanges: sync.unsyncedChanges,
        pendingRooms: sync.pendingRooms,
        inFlightUpdates: sync.inFlightUpdates,
        logEntries: sync.logEntries,
        persistence: sync.persistence,
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
  text += field("database", report.databasePath);
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

export async function statusCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  let json = false;
  try {
    json =
      parseArgs({
        args: argv,
        options: { json: { type: "boolean", default: false } },
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
