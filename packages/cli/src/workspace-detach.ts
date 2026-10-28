import { existsSync } from "node:fs";
import { purgeDetachedDocumentCopies } from "@uberblick/hub";
import { DEFAULT_HOST, DEFAULT_PORT } from "@uberblick/hub/config";
import { DEFAULT_HUB_URL, acquireWorkspaceRemovalRole, defaultWorkspaceDatabasePath, detachWorkspaceCopy } from "@uberblick/mcp-server";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import { resolveProjectBinding, writeProjectBinding } from "@uberblick/mcp-server/project-binding";
import { readWorkspaceHub, recordedWorkspaceIds, withWorkspaceBindings } from "@uberblick/mcp-server/workspace-registry";
import { parseWorkspaceId } from "@uberblick/schema";
import { type CommandArgs, UsageError, usageError } from "./command.js";
import { hubDatabasePath } from "./hub-config.js";
import { type Io, shellArgument } from "./io.js";
import { endpointOf, hubBind, probePort } from "./probes.js";
import { listWorkspaces, resolveWorkspaceId } from "./workspace.js";
import { displayWorkspaceHub, useField, workspaceLabel } from "./workspace-use-output.js";

export const WORKSPACE_DETACH_HELP = `usage: ub workspace detach <id|prefix>

Make this computer's existing copy of a hub workspace local, keeping its UUID,
documents, settings and changes the hub has not acknowledged. Downloaded history
is discarded. The hub keeps the workspace and its members.

Works offline without sign-in. Stop any ub open serving this workspace and this
computer's local hub first. Running agent sessions stop syncing and must restart.
The nearest .uberblick.json you own is made local only if it selects this workspace.
Reconnect explicitly with ub workspace use <link>.

options:
  -h, --help        show this help
`;

async function requireLocalHubStopped(): Promise<void> {
  const endpoint = endpointOf(DEFAULT_HUB_URL);
  if (endpoint === null) throw new Error("cannot determine the default local hub port");
  const configured = hubBind();
  if (configured.port === null) throw new Error("cannot determine the local hub port; correct PORT before detaching");
  const endpoints = [endpoint, { host: DEFAULT_HOST, port: DEFAULT_PORT }];
  if (!endpoints.some(target => target.host === configured.host && target.port === configured.port)) {
    endpoints.push({ host: configured.host, port: configured.port });
  }
  for (const target of endpoints) {
    const probe = await probePort(target.host, target.port);
    if (probe.state !== "free") {
      throw new Error(`stop this computer's local hub before detaching; its port ${target.host}:${target.port} is ${probe.state}`);
    }
  }
}

export async function detachWorkspaceCommand({ positionals }: CommandArgs<Record<string, never>>, io: Io): Promise<number> {
  try {
    const lock = await acquireInitLock(process.env, { command: "ub workspace detach" });
    let output: string;
    try {
      const ids = new Set([...listWorkspaces().entries.map(entry => entry.uuid), ...recordedWorkspaceIds()]);
      const resolved = resolveWorkspaceId(positionals[0] ?? "", [...ids].map(uuid => ({ uuid })));
      if ("error" in resolved) usageError(resolved.error);
      const id = parseWorkspaceId(resolved.id).uuid;
      const databasePath = process.env.UBERBLICK_DB?.trim() || defaultWorkspaceDatabasePath(id);
      if (!existsSync(databasePath)) throw new Error("this computer has no copy of that workspace; detach changes nothing");
      const hub = readWorkspaceHub(id);
      if (hub === undefined || hub === null) throw new Error("this computer's copy is already local; no hub is recorded");
      const project = resolveProjectBinding({ env: {} });
      const selected = project.binding !== null && parseWorkspaceId(project.binding.workspaceId).uuid === id ? project.binding : null;
      const binding = { workspaceId: selected?.workspaceId ?? id, hubUrl: null };
      const role = acquireWorkspaceRemovalRole(databasePath, "detaching");
      try {
        await requireLocalHubStopped();
        let path: string | undefined;
        detachWorkspaceCopy(databasePath, id, deletedUuids => {
          purgeDetachedDocumentCopies(hubDatabasePath(), id, deletedUuids);
          withWorkspaceBindings([binding], () => {
            if (selected !== null && project.path !== null) path = writeProjectBinding(binding, { path: project.path, record: false });
          }, process.env, id);
        });
        output = useField("detached", workspaceLabel(binding, databasePath));
        if (path !== undefined) output += useField("wrote", path);
        const displayHub = displayWorkspaceHub(hub);
        output += `${displayHub} keeps the workspace; this computer no longer syncs with it.\n` +
          `reconnect with: ub workspace use ${shellArgument(`${displayHub.replace(/\/$/, "")}/${id}`)}\n`;
      } finally { role.close(); }
    } finally { lock.release(); }
    io.out(output);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    io.err(`ub workspace detach: ${error instanceof Error ? error.message : "detach failed"}\n`);
    return 1;
  }
}
