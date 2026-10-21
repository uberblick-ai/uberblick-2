import { defaultWorkspaceDatabasePath, readWorkspaceName } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import type { ProjectBinding } from "@uberblick/mcp-server/project-binding";
import type { Origin } from "@uberblick/mcp-server/project-config";
import { readWorkspaceHub } from "@uberblick/mcp-server/workspace-registry";
import { shellArgument } from "./io.js";

export function displayWorkspaceHub(hub: string | null): string {
  if (hub === null) return "local";
  const url = new URL(hub);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  // /ws is the deployed connection route; other proxy routes remain visible.
  return url.pathname === "/ws" || url.pathname === "/" ? url.origin : url.href;
}

export function workspaceLabel(binding: ProjectBinding, databasePath = defaultWorkspaceDatabasePath(binding.workspaceId)): string {
  const name = readWorkspaceName(databasePath, binding.workspaceId);
  const hub = displayWorkspaceHub(binding.hubUrl);
  return name === null ? `${binding.workspaceId} (${hub})` : `${name} (${binding.workspaceId}, ${hub})`;
}

/** How a binding origin reads in `ub workspace` output. */
export const ORIGIN_LABELS: Record<Origin, string> = {
  environment: "environment",
  "user config": "user config",
  "project config": "project config",
  default: "built-in default",
};

export function useField(label: string, value: string): string {
  return `${label.padEnd(11)}${value}\n`;
}

/** Called under the binding lock, after publication has registered both pairs. */
export function useBindingLines(binding: ProjectBinding, previous: ProjectBinding | null, path: string): string {
  let text = useField("using", workspaceLabel(binding)) + useField("wrote", path);
  if (previous === null || (parseWorkspaceId(previous.workspaceId).uuid === parseWorkspaceId(binding.workspaceId).uuid &&
      previous.hubUrl === binding.hubUrl)) return text;
  text += useField("previous", workspaceLabel(previous));
  if (readWorkspaceHub(previous.workspaceId) === previous.hubUrl) {
    text += `switch back with: ub workspace use ${shellArgument(previous.workspaceId)}\n`;
  } else if (previous.hubUrl !== null) {
    text += `switch back with: ub workspace use ${shellArgument(`${previous.hubUrl}/${previous.workspaceId}`)}\n`;
  } else {
    text += `Switch back for this session: UB_WORKSPACE_ID=${previous.workspaceId} UB_HUB_URL=local ub open\n`;
  }
  return text;
}
