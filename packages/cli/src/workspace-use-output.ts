/** The two forms of use report the same complete project selection. */
import { defaultDatabasePath, readWorkspaceName } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import type { ProjectBinding } from "./project-binding.js";
import { readWorkspaceHub } from "./workspace-registry.js";
import { shellArgument } from "./io.js";

export function displayWorkspaceHub(hub: string | null): string {
  if (hub === null) return "local";
  const url = new URL(hub);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  // /ws is the deployed connection route; other proxy routes remain visible.
  return url.pathname === "/ws" || url.pathname === "/" ? url.origin : url.href;
}

export function workspaceLabel(binding: ProjectBinding): string {
  const name = readWorkspaceName(defaultDatabasePath(binding.workspaceId), binding.workspaceId);
  const hub = displayWorkspaceHub(binding.hubUrl);
  return name === null ? `${binding.workspaceId} (${hub})` : `${name} (${binding.workspaceId}, ${hub})`;
}

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
