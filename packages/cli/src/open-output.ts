import { defaultWorkspaceDatabasePath, readWorkspaceName } from "@uberblick/mcp-server";
import type { HubState } from "@uberblick/mcp-server";
import type { ProjectBinding } from "./project-binding.js";
import { endpointOf, isLocalHost } from "./probes.js";
import { displayWorkspaceHub, useField, workspaceLabel } from "./workspace-use-output.js";

interface OpenBanner {
  url: string;
  verbose: boolean;
  secretCreated: string | null;
  binding: ProjectBinding;
  databasePath: string | undefined;
  hubNote: string;
  signInRequired: boolean;
  showHubNote: boolean;
  deviceHub: boolean;
  hubUrl: string;
  hubState: HubState | null;
}

export function openBanner(input: OpenBanner): string {
  const databasePath = input.databasePath ?? defaultWorkspaceDatabasePath(input.binding.workspaceId);
  const name = readWorkspaceName(databasePath, input.binding.workspaceId) ?? input.binding.workspaceId;
  const unreachable = !input.signInRequired && input.hubState?.status === "hub-down";
  let note = input.hubNote;
  let showNote = input.showHubNote;
  const localDeviceHub = input.deviceHub && isLocalHost(endpointOf(input.hubUrl)?.host ?? "");
  if (input.signInRequired) {
    const display = localDeviceHub ? input.hubUrl : displayWorkspaceHub(input.hubUrl);
    note = `${display} (not signed in, changes stay here)`;
  } else if (input.deviceHub && !localDeviceHub) {
    note = `${displayWorkspaceHub(input.hubUrl)} (remote, nothing started here)`;
  } else if (input.hubState !== null && localDeviceHub) {
    const reason = unreachable ? "hub unreachable" : input.hubState.reason ?? "device-authenticated hub";
    note = `${input.hubUrl} (${reason}; nothing started here)`;
    showNote = input.hubState.status === "auth-failed" || input.hubState.status === "update-required";
  }
  let banner = "";
  if (input.verbose && input.secretCreated !== null) {
    banner += useField("secret", `created ${input.secretCreated} (0600)`);
  }
  banner += useField("web", input.url);
  if (input.verbose) {
    banner += useField("hub", note);
    if (input.signInRequired) banner += useField("", "  → ub auth login");
    banner += useField("workspace", workspaceLabel(input.binding, databasePath));
  } else {
    banner += useField("workspace", `${name} (${displayWorkspaceHub(input.binding.hubUrl)})`);
  }
  if (!input.verbose && input.signInRequired) {
    banner += useField("hub", "not signed in, changes stay on this machine");
    banner += useField("", "  → ub auth login");
  } else if (unreachable) {
    banner += useField("hub", "unreachable, changes stay on this machine until it is back");
  } else if (!input.verbose && showNote) {
    banner += useField("hub", note);
  }
  return `${banner}\nCtrl-C to stop.\n`;
}
