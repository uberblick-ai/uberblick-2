import { useRemoteWorkspace } from "./remote.js";
import { assertHubTransport, parseJoinTarget } from "@uberblick/mcp-server/remote-url";
import { ORIGIN_LABELS, displayWorkspaceHub, useBindingLines } from "./workspace-use-output.js";

import { readdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { WORKSPACE_DATABASE_FILE, resolveStorage } from "@uberblick/mcp-server/storage";
import { acquireWorkspaceRemovalRole, defaultWorkspaceDatabasePath, readWorkspaceName, usesDeviceLogin } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import type { Origin } from "@uberblick/mcp-server/project-config";
import { resolveConfig, userConfigWarnings, writeHubAdmission } from "@uberblick/mcp-server/project-config";
import { type ProjectBinding, resolveProjectBinding, writeProjectBinding } from "@uberblick/mcp-server/project-binding";
import { forgetWorkspace, hasWorkspaceReplica, readWorkspaceHub, recordedWorkspaceIds, workspaceRegistryPath } from "@uberblick/mcp-server/workspace-registry";
import { type CommandArgs, UsageError, usageError } from "./command.js";
import type { InitLock } from "@uberblick/mcp-server/init-lock";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import type { Io } from "./io.js";
import { shellArgument, warn } from "./io.js";
import { describeFsError } from "@uberblick/mcp-server/safe-write";
import { fillMainRepositoryFromOrigin } from "./workspace-main-repository.js";

export const WORKSPACE_HELP = `usage: ub workspace [command]

commands:
  create <name>               create and select a separate local-only workspace
  fork                        copy this workspace independently and select the local copy
  promote <hub>               upload, verify and connect this local workspace
  member <command>            grant workspace access and manage members
  list [--json]               workspaces this machine has a database for
  use <link|id>               fetch a shared workspace or select a local replica
  remove <id|prefix> [--yes]  delete this computer's copy of a workspace

options:
  -h, --help             show this help; after a command, that command's help
`;

const UUID_PREFIX = /^[0-9a-f][0-9a-f-]*$/;

/** A full UUID or longer input cannot be a UUID prefix. */
const UUID_LENGTH = 36;

/** Delegate platform layout to the storage owner. */
function databaseDirectory(env: NodeJS.ProcessEnv): string {
  return resolveStorage({ env }).workspaceDir;
}

export interface WorkspaceEntry {
  /** The bare uuid. */
  uuid: string;
  /** The validated name in this machine's replica, when readable. */
  name: string | null;
  /** Whether this is the workspace configuration currently resolves to. */
  active: boolean;
  databasePath: string;
}

interface InForce {
  /** The spelling in force, or null when nothing configures a workspace. */
  configured: string | null;
  uuid: string | null;
  origin: Origin;
  hubUrl: string | null;
  warnings: string[];
  selectionNote: string | null;
}

/** Read the current selection and source without opening the database. */
function inForce(options: { env?: NodeJS.ProcessEnv } = {}): InForce {
  const resolved = resolveConfig({ ...options, warnLegacySelection: false });
  const configured = resolved.env.WORKSPACE_ID ?? null;
  return {
    configured,
    uuid: configured === null ? null : parseWorkspaceId(configured).uuid,
    origin: resolved.origins.workspace,
    hubUrl: resolved.binding?.hubUrl ?? null,
    warnings: resolved.warnings,
    selectionNote: configured !== null ? null : resolved.bindingProblem === undefined
      ? "No workspace selected (no .uberblick.json found)."
      : `No workspace selected. ${resolved.bindingProblem}`,
  };
}

export function listWorkspaces(
  options: { env?: NodeJS.ProcessEnv } = {},
): { entries: WorkspaceEntry[]; warnings: string[]; selectionNote: string | null } {
  const env = options.env ?? process.env;
  const current = inForce(options);

  const uuids = new Set<string>();
  const directory = databaseDirectory(env);
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch (error) {
    // Only absence means an empty inventory; other errors would corrupt prefix lookup.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot list ${directory}: ${describeFsError(error)}`);
    }
  }
  for (const name of names) {
    const match = WORKSPACE_DATABASE_FILE.exec(name);
    if (match?.[1] !== undefined) {
      uuids.add(match[1]);
    }
  }
  if (current.uuid !== null) {
    uuids.add(current.uuid);
  }

  const entries = [...uuids].sort().map((uuid) => {
    const databasePath = defaultWorkspaceDatabasePath(uuid, env);
    return {
      uuid,
      name: readWorkspaceName(databasePath, uuid),
      active: uuid === current.uuid,
      databasePath,
    };
  });
  return { entries, warnings: current.warnings, selectionNote: current.selectionNote };
}

export const WORKSPACE_REMOVE_OPTIONS = {
  yes: { type: "boolean", default: false },
} as const;

export const WORKSPACE_REMOVE_HELP = `usage: ub workspace remove <id|prefix> [--yes]

Delete this computer's database files and record for one workspace. Accepts a
workspace UUID, decorated <slug>-<uuid>, or a unique UUID prefix from this
machine's databases and records. Switch away with \`ub workspace use\` first,
and stop any \`ub open\` serving it. Open MCP sessions then refuse writes;
restart them after fetching the workspace again.

A recorded hub keeps the workspace; \`ub workspace use <link>\` fetches it again.
Local changes the hub has not acknowledged are lost. A local-only workspace
has no other copy. With no hub record, this may be the only copy.
Project bindings, logins, hubs and other workspaces are untouched.

options:
  --yes             delete without asking; required without terminal stdin
  -h, --help        show this help
`;

export async function removeWorkspaceCommand({ positionals, values }: CommandArgs<typeof WORKSPACE_REMOVE_OPTIONS>, io: Io): Promise<number> {
  const raw = positionals[0] ?? "";
  const yes = values.yes;

  try {
    const ids = new Set([...listWorkspaces().entries.map(entry => entry.uuid), ...recordedWorkspaceIds()]);
    const resolved = resolveWorkspaceId(raw, [...ids].map(uuid => ({ uuid })));
    if ("error" in resolved) {
      usageError(resolved.error);
    }
    const id = parseWorkspaceId(resolved.id).uuid;
    if (!ids.has(id)) {
      throw new Error("no workspace on this machine has that id; `ub workspace list` shows replicas; fetch a shared workspace with `ub workspace use <link>`");
    }
    const refuseSelected = (): void => {
      if (inForce().uuid === id) {
        throw new Error("this workspace is in use here; `ub workspace use` another workspace first");
      }
    };
    refuseSelected();
    const databasePath = defaultWorkspaceDatabasePath(id);
    const hub = readWorkspaceHub(id);
    if (!yes) {
      if (!process.stdin.isTTY) {
        throw new Error("removing a workspace requires confirmation at a terminal; pass --yes to delete without asking");
      }
      const loss = hub === undefined
        ? "This computer cannot tell whether a hub keeps it, so this may be the only copy."
        : hub === null
          ? "This is the only copy of this local-only workspace."
          : `The hub keeps the workspace; fetch it again with \`ub workspace use ${shellArgument(`${displayWorkspaceHub(hub).replace(/\/$/, "")}/${id}`)}\`. ` +
            "Any local changes the hub has not acknowledged would be lost.";
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      let answer: string;
      try {
        answer = await terminal.question(`Delete this computer's copy of workspace ${id}? ${loss} [y/N] `);
      } catch {
        throw new Error("confirmation ended; nothing was removed");
      } finally {
        terminal.close();
      }
      if (!/^(y|yes)$/i.test(answer.trim())) {
        io.out("cancelled; nothing was removed\n");
        return 0;
      }
    }

    const lock = await acquireInitLock(process.env, { command: `ub workspace remove ${id}` });
    try {
      refuseSelected();
      // Confirmation must cover the current loss even if a peer changed the record.
      if (!yes && readWorkspaceHub(id) !== hub) {
        throw new Error("the workspace changed during confirmation; nothing was removed, run the command again");
      }
      const role = acquireWorkspaceRemovalRole(databasePath);
      try {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
        forgetWorkspace(id);
        // Keep the role held through every unlink; a live serving lock is never removed.
        rmSync(`${databasePath}.serving-lock`, { force: true });
      } finally {
        role.close();
      }
    } finally {
      lock.release();
    }
    io.out(`removed ${id} from this computer\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    io.err(`ub workspace remove: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export const WORKSPACE_LIST_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const WORKSPACE_LIST_HELP = `usage: ub workspace list [--json]

Every workspace this machine has a local database for, plus the configured one,
with the one currently in force marked. Shows names from readable local replicas
without changing them or connecting to a hub. A workspace that exists elsewhere
but has never been opened here is not listed unless configured.

The last field is the hub this machine recorded, or local for a replica with
no hub record. A known hub stays recorded even when unavailable. If the configured
workspace has neither replica nor record, its selected hub or local is shown.
Recorded hubs can differ from the active selection. JSON adds hub: the endpoint
or "local". Listing never records an association or reconnects a replica.

options:
  --json            the same list as JSON on stdout, for a script to read
  -h, --help        show this help
`;

export function listWorkspacesCommand({ values }: CommandArgs<typeof WORKSPACE_LIST_OPTIONS>, io: Io): number {
  const json = values.json;

  let listed: { entries: (WorkspaceEntry & { hub: string })[]; warnings: string[]; selectionNote: string | null };
  try {
    const inventory = listWorkspaces();
    const current = inForce();
    // Validate records even for an empty inventory. Keep this CLI-only read out
    // of listWorkspaces(), whose install and browser callers need only IDs/names.
    recordedWorkspaceIds();
    listed = {
      ...inventory,
      entries: inventory.entries.map((entry) => {
        const recorded = readWorkspaceHub(entry.uuid);
        const hub = recorded === undefined && entry.active && !hasWorkspaceReplica(entry.uuid)
          ? current.hubUrl : recorded;
        return { ...entry, hub: hub ?? "local" };
      }),
    };
  } catch (error) {
    io.err(`ub workspace list: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { entries, warnings, selectionNote } = listed;
  warn(io, warnings);
  if (selectionNote !== null) io.err(`${selectionNote}\n`);

  if (json) {
    io.out(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    io.out("no workspaces on this machine — run `ub workspace create <name>` to create one\n");
    return 0;
  }
  const nameWidth = entries.reduce((width, entry) => Math.max(width, entry.name?.length ?? 0), 0);
  let text = "";
  for (const entry of entries) {
    const hub = entry.hub === "local" ? "local" : displayWorkspaceHub(entry.hub);
    text += `${entry.active ? "*" : " "} ${entry.uuid} | ${(entry.name ?? "").padEnd(nameWidth)} | ${hub}\n`;
  }
  io.out(text);
  return 0;
}

/**
 * Parse full IDs without an inventory; `use` checks their records afterward.
 * Distinguish invalid syntax from a valid prefix missing from this machine.
 */
export function resolveWorkspaceId(
  raw: string,
  known: readonly Pick<WorkspaceEntry, "uuid">[],
): { id: string } | { error: string } {
  try {
    parseWorkspaceId(raw);
    return { id: raw };
  } catch {
    // Not a full id. It may still be a prefix of one.
  }

  if (!UUID_PREFIX.test(raw) || raw.length >= UUID_LENGTH) {
    return {
      error:
        `${JSON.stringify(raw)} is not a workspace id: expected a uuid, a ` +
        "decorated <slug>-<uuid>, or a unique prefix of a uuid `ub workspace " +
        "list` shows",
    };
  }

  const matches = known.filter((entry) => entry.uuid.startsWith(raw));
  const [only] = matches;
  if (only !== undefined && matches.length === 1) {
    return { id: only.uuid };
  }
  if (matches.length === 0) {
    return {
      error:
        `no workspace on this machine starts with ${JSON.stringify(raw)}. ` +
        "`ub workspace list` shows replicas; fetch a shared workspace with " +
        "`ub workspace use <link>`",
    };
  }
  return {
    error:
      `${JSON.stringify(raw)} matches ${matches.length} workspaces:\n` +
      matches.map((entry) => `  ${entry.uuid}\n`).join(""),
  };
}

export const WORKSPACE_USE_OPTIONS = {
  verbose: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
} as const;

export const WORKSPACE_USE_HELP = `usage: ub workspace use <link|id> [--verbose] [--json]

Bind this project to a workspace in the nearest .uberblick.json, or create one
in the current directory. Terminal commands and project MCP sessions use it.

operands:
  <link>            a hub link with the workspace id as its last path segment,
                    such as https://hub.example.test/<workspace-id>, a bare
                    hub.example.test/<workspace-id>, or ws(s)://endpoint/<id>.
                    Browser document URLs are not workspace links.
  <id>              a workspace <uuid>, a decorated <slug>-<uuid>, or a unique
                    prefix of a UUID from this machine's workspaces

options:
  --verbose         add fetched documents, verification details and config paths
  --json            only JSON on stdout: binding, previous binding and fetched documents
  -h, --help        show this help

A link requires a stored sign-in from \`ub auth login <hub>\` first. This command
never starts sign-in. A loopback development hub with this machine's local
signing secret keeps that admission and needs no sign-in.
It fetches and reconciles this workspace's replica, verifies it, records its hub
and only then writes the project binding. It never merges two workspaces.

Verification means the hub acknowledged the writes, then a fresh client read
the full directory back and compared every document's directory entry. Every
archived document's content is read back, plus one live document's content when
the workspace has any. It does not establish that the hub flushed the writes to
disk or that other clients have converged. Later writes to an old hub are outside
the verified snapshot.

An id uses the hub this machine recorded for the workspace, or local; it moves
no documents, verifies no membership and never replaces that hub record.
An existing replica with no hub record is selected and recorded as local.
Hub sync resumes only through explicit promotion or \`ub workspace use <link>\`.
A workspace with neither replica nor record must first be fetched with a link.
UB_WORKSPACE_ID selects the workspace for this shell; a differing UB_HUB_URL
is refused. Clear both variables to follow the project binding again.
`;

export async function useWorkspaceCommand({ positionals, values }: CommandArgs<typeof WORKSPACE_USE_OPTIONS>, io: Io): Promise<number> {
  const raw = positionals[0] ?? "";
  const { json, verbose } = values;

  if (raw.includes("/")) {
    let target: ReturnType<typeof parseJoinTarget>;
    try {
      target = parseJoinTarget(raw);
      assertHubTransport(raw);
    }
    catch (error) {
      // The URL parser deliberately does not echo potentially secret operands.
      usageError(error instanceof Error ? error.message : String(error), "Run again: ub workspace use <link>");
    }
    return useRemoteWorkspace(target, `ub workspace use ${shellArgument(raw)}`, io, { json, verbose });
  }

  let entries: Pick<WorkspaceEntry, "uuid">[];
  try {
    const ids = new Set([...listWorkspaces().entries.map(entry => entry.uuid), ...recordedWorkspaceIds()]);
    entries = [...ids].map(uuid => ({ uuid }));
  } catch (error) {
    // An incomplete inventory could make a prefix bind to the wrong workspace.
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const resolved = resolveWorkspaceId(raw, entries);
  if ("error" in resolved) {
    usageError(resolved.error);
  }
  const id = resolved.id;

  let hub = readWorkspaceHub(id);
  if (hub === undefined && !hasWorkspaceReplica(id)) {
    io.err(
      "ub workspace use: this machine has no hub record for that workspace. " +
      "Fetch a shared workspace with `ub workspace use <link>`.\n",
    );
    return 1;
  }
  let path: string;
  let previous: ProjectBinding | null;
  let text: string;
  let written: string[];

  let lock: InitLock;
  try {
    lock = await acquireInitLock();
  } catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    previous = resolveProjectBinding({ env: {} }).binding;
    // A promotion/fetch may have finished while this command waited for the lock.
    hub = readWorkspaceHub(id);
    if (hub === undefined && !hasWorkspaceReplica(id)) {
      throw new Error("workspace has neither replica nor record; fetch it with `ub workspace use <link>`");
    }
    const registersSelected = hub === undefined;
    hub ??= null;
    const admission = hub !== null && usesDeviceLogin(hub, { ...process.env, HUB_ADMISSION: undefined })
      ? writeHubAdmission(hub, true)
      : { written: [], warnings: userConfigWarnings() };
    warn(io, admission.warnings);
    const registersPrevious = previous !== null && readWorkspaceHub(previous.workspaceId) === undefined;
    path = writeProjectBinding({ workspaceId: id, hubUrl: hub });
    await fillMainRepositoryFromOrigin(id, hub);
    written = [...admission.written, ...(registersSelected || registersPrevious ? [workspaceRegistryPath()] : []), path];
    text = useBindingLines({ workspaceId: id, hubUrl: hub }, previous, path);
  } catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    lock.release();
  }

  if (json) {
    io.out(`${JSON.stringify({ binding: { workspaceId: id, hubUrl: hub }, previous }, null, 2)}\n`);
  } else {
    if (verbose) text += `\nConfiguration files written:\n${written.map(file => `  ${file}\n`).join("")}`;
    io.out(text);
  }

  // Warn when a higher layer overrules the binding just written.
  const after = inForce();
  if (after.configured !== id || resolveProjectBinding().binding?.hubUrl !== hub) {
    io.err(
      `ub: warning: ${ORIGIN_LABELS[after.origin]} sets ${
        after.configured ?? "no workspace"
      }, which takes precedence over ${path}\n`,
    );
  }

  return 0;
}
