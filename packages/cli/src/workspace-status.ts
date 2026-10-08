/** The explicit check of which workspace an agent started here will use. */
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
import { displayUsername } from "./auth.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { statusReport, type StatusReport } from "./status.js";

export const WORKSPACE_STATUS_HELP = `usage: ub workspace status

Show the workspace selected here: name, id, hub or local, stored GitHub account
for a hub workspace, selection source, replica database path and sync state.
Connects briefly to a configured hub; up to date means every local change was
acknowledged by the hub, not that it was durably stored there.
With no binding, suggests \`ub workspace create\` and exits 1 without opening a
workspace. Never selects a workspace or starts a sign-in.

options:
  -h, --help        show this help
`;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function syncSummary(report: StatusReport, caughtUp: boolean): string {
  if (report.persistence !== null) return "local persistence failed — run ub doctor";
  if (report.binding.hubUrl === null) return "local only, no hub sync";
  if (caughtUp) return "up to date";
  const pending: string[] = [];
  if (report.unsyncedChanges > 0) {
    pending.push(`${plural(report.unsyncedChanges, "room")} with unacknowledged local changes`);
  }
  if (report.inFlightUpdates > 0) {
    pending.push(`${plural(report.inFlightUpdates, "sync message")} unacknowledged`);
  }
  if (report.hub.status !== "connected") {
    pending.push(report.hub.reason ?? report.hub.status);
  }
  return pending.length === 0 ? "waiting for full workspace acknowledgement" : pending.join("; ");
}

export function renderWorkspaceStatus(
  report: StatusReport,
  name: string | null,
  caughtUp: boolean,
  accountOrigin?: string,
): string {
  const field = (label: string, value: string): string => `${label.padEnd(11)}${value}\n`;
  let text = field("workspace", name ?? report.workspace);
  text += field("id", report.workspaceUuid);
  text += field("hub", report.binding.hubUrl ?? "local (this computer)");
  if (report.binding.hubUrl !== null) {
    text += field("account", report.account === null
      ? `not signed in, run ub auth login ${accountOrigin ?? authenticationOrigin(report.binding.hubUrl)}`
      : `@${displayUsername(report.account.login)} (GitHub)`);
  }
  text += field("chosen by", report.sources.workspace === "project config" && report.projectConfig !== null
    ? `project config in ${dirname(report.projectConfig)}` : report.sources.workspace);
  text += field("stored in", report.databasePath);
  return text + field("sync", syncSummary(report, caughtUp));
}

export async function workspaceStatusCommand(argv: string[], io: Io = processIo): Promise<number> {
  if (takeHelp(argv, io, WORKSPACE_STATUS_HELP)) return 0;
  try {
    parseArgs({ args: argv, options: {}, allowPositionals: false });
  } catch (error) {
    io.err(`ub workspace status: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const { report, warnings, accountOrigin, workspaceName, caughtUp } =
    await statusReport({ workspaceStatus: true });
  for (const warning of warnings) io.err(`ub: warning: ${warning}\n`);
  if (report.binding === null) {
    io.err("ub workspace status: No workspace selected. Run `ub workspace create <name>` to create one.\n");
    return 1;
  }
  io.out(renderWorkspaceStatus(report, workspaceName ?? null, caughtUp === true, accountOrigin));
  return 0;
}
