/** Workspace inspection and explicit project selection; never a machine default. */

import { createWorkspaceCommand } from "./workspace-create.js";
import { promoteWorkspaceCommand } from "./workspace-promote.js";
import { parseJoinTarget, useRemoteWorkspace } from "./remote.js";
import { useBindingLines } from "./workspace-use-output.js";

import { readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { WORKSPACE_DATABASE_FILE, resolveStorage } from "@uberblick/hub/storage";
import { defaultDatabasePath, readWorkspaceName, usesDeviceLogin } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import type { Origin } from "./config.js";
import { migrateHubAdmissions, resolveConfig, writeHubAdmission } from "./config.js";
import { type ProjectBinding, resolveProjectBinding, writeProjectBinding } from "./project-binding.js";
import { readWorkspaceHub, recordedWorkspaceIds, workspaceRegistryPath } from "./workspace-registry.js";
import { takeHelp } from "./help.js";
import { workspaceMemberCommand } from "./workspace-member.js";
import type { InitLock } from "./init-lock.js";
import { acquireInitLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { processIo, shellArgument } from "./io.js";
import { describeFsError } from "./safe-write.js";
import { ORIGIN_LABELS } from "./status.js";
import { workspaceStatusCommand } from "./workspace-status.js";

export const WORKSPACE_HELP = `usage: ub workspace [command]

commands:
  status                      the workspace in use, its selection, storage and sync
  create <name>               create and select a separate local-only workspace
  promote <hub>               upload, verify and connect this local workspace
  member <command>            grant workspace access and manage members
  list [--json]               workspaces this machine has a database for
  use <link|id>               fetch a shared workspace or select a recorded one

options:
  -h, --help             show this help; after a command, that command's help
`;

/** As much of a uuid as someone can have typed so far. */
const UUID_PREFIX = /^[0-9a-f][0-9a-f-]*$/;

/** A uuid is 36 characters; anything longer is not a prefix of one. */
const UUID_LENGTH = 36;

/**
 * Where `<uuid>.sqlite` files live.
 *
 * Asked of the module that owns the layout rather than restated here: it is
 * `$XDG_DATA_HOME/uberblick` on an XDG machine and
 * `~/Library/Application Support/Uberblick/data/workspaces` on a Mac, and this
 * command has no business knowing which.
 */
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
}

/**
 * The workspace configuration resolves to — the same value and the same origin
 * `ub status` reports, without opening the database to get it.
 */
function inForce(options: { env?: NodeJS.ProcessEnv } = {}): InForce {
  const resolved = resolveConfig(options);
  const configured = resolved.env.WORKSPACE_ID ?? null;
  return {
    configured,
    // resolveConfig already refused anything that is not a workspace id.
    uuid: configured === null ? null : parseWorkspaceId(configured).uuid,
    origin: resolved.origins.workspace,
    hubUrl: resolved.binding?.hubUrl ?? null,
    warnings: resolved.warnings,
  };
}

/**
 * Every workspace this machine knows: one with a database, plus the configured
 * one — which may have neither a database nor a document yet, and is still the
 * workspace you are in.
 */
export function listWorkspaces(
  options: { env?: NodeJS.ProcessEnv } = {},
): { entries: WorkspaceEntry[]; warnings: string[] } {
  const env = options.env ?? process.env;
  const current = inForce(options);

  const uuids = new Set<string>();
  const directory = databaseDirectory(env);
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch (error) {
    // A missing data directory means no databases, which is a fresh machine.
    // Anything else — a permission, an I/O error — means the answer would be
    // *short*, and a short list is not a harmless one: `use` resolves prefixes
    // against it, so a swallowed error becomes "no workspace starts with that"
    // for a workspace that is sitting right there.
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
    const databasePath = defaultDatabasePath(uuid, env);
    return {
      uuid,
      name: readWorkspaceName(databasePath, uuid),
      active: uuid === current.uuid,
      databasePath,
    };
  });
  return { entries, warnings: current.warnings };
}

function warn(io: Io, warnings: readonly string[]): void {
  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
}

// --- ub workspace list -----------------------------------------------------

/** Exported so the help below can be checked against the parser it describes. */
export const WORKSPACE_LIST_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const WORKSPACE_LIST_HELP = `usage: ub workspace list [--json]

Every workspace this machine has a local database for, plus the configured one,
with the one currently in force marked. Shows names from readable local replicas
without changing them or connecting to a hub. A workspace that exists elsewhere
but has never been opened here is not listed unless configured.

options:
  --json            the same list as JSON on stdout, for a script to read
  -h, --help        show this help
`;

function listCommand(argv: string[], io: Io): number {
  if (takeHelp(argv, io, WORKSPACE_LIST_HELP)) return 0;

  let json = false;
  try {
    json =
      parseArgs({
        args: argv,
        options: WORKSPACE_LIST_OPTIONS,
        allowPositionals: false,
      }).values.json === true;
  } catch (error) {
    io.err(`ub workspace list: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let listed: { entries: WorkspaceEntry[]; warnings: string[] };
  try {
    listed = listWorkspaces();
  } catch (error) {
    io.err(`ub workspace list: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { entries, warnings } = listed;
  warn(io, warnings);

  if (json) {
    io.out(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    io.out("no workspaces on this machine — run `ub init` to create one\n");
    return 0;
  }
  let text = "";
  for (const entry of entries) {
    text += `${entry.active ? "*" : " "} ${entry.uuid}${entry.name === null ? "" : ` | ${entry.name}`}\n`;
  }
  io.out(text);
  return 0;
}

// --- ub workspace use ------------------------------------------------------

/**
 * What `<id>` names.
 *
 * A full id — bare or decorated — is parsed independently of machine knowledge.
 * `use` checks its record afterward; `mcp install --workspace` can still pin a
 * complete binding before this machine has served it. Anything else has to
 * resolve against what `list` knows, and the two ways that fails are told apart
 * on purpose: "that is not a uuid" sends you to check what you pasted, "nothing
 * here starts with that" sends you to `ub workspace list`.
 *
 * Exported because `ub mcp install --workspace` writes a workspace id into a
 * client config, and a prefix that meant one thing there and another here would
 * be a config pinned to a workspace nobody chose.
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
                    prefix of a recorded UUID

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
An unknown workspace must first be fetched with \`ub workspace use <link>\`.
UB_WORKSPACE_ID and UB_HUB_URL environment overrides still take priority.
`;

async function useCommand(argv: string[], io: Io): Promise<number> {
  if (takeHelp(argv, io, WORKSPACE_USE_HELP)) return 0;

  let raw: string | undefined;
  let json = false;
  let verbose = false;
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      options: WORKSPACE_USE_OPTIONS,
      allowPositionals: true,
    });
    if (positionals.length !== 1) {
      throw new Error("expected exactly one workspace link or id");
    }
    raw = positionals[0];
    json = values.json;
    verbose = values.verbose;
  } catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    io.err("usage: ub workspace use <link|id> [--verbose] [--json]\n");
    return 2;
  }
  if (raw === undefined) {
    io.err("usage: ub workspace use <link|id> [--verbose] [--json]\n");
    return 2;
  }

  if (raw.includes("/")) {
    let target: ReturnType<typeof parseJoinTarget>;
    try { target = parseJoinTarget(raw); }
    catch (error) {
      // The URL parser deliberately does not echo potentially secret operands.
      io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\nusage: ub workspace use <link|id> [--verbose] [--json]\nRun again: ub workspace use <link>\n`);
      return 2;
    }
    return useRemoteWorkspace(target, `ub workspace use ${shellArgument(raw)}`, io, { json, verbose });
  }

  let entries: Pick<WorkspaceEntry, "uuid">[];
  try {
    const ids = new Set([...listWorkspaces().entries.map(entry => entry.uuid), ...recordedWorkspaceIds()]);
    entries = [...ids].map(uuid => ({ uuid }));
  } catch (error) {
    // Refused rather than resolved against a short list: a prefix that quietly
    // stopped matching would bind this directory to the wrong workspace.
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const resolved = resolveWorkspaceId(raw, entries);
  if ("error" in resolved) {
    io.err(`ub workspace use: ${resolved.error}\n`);
    io.err("usage: ub workspace use <link|id> [--verbose] [--json]\n");
    return 2;
  }
  const id = resolved.id;

  let hub = readWorkspaceHub(id);
  if (hub === undefined) {
    io.err(
      "ub workspace use: this machine has no hub record for that workspace. " +
      "Fetch a shared workspace with `ub workspace use <link>`. " +
      `To register an existing local replica, serve it once with \`UB_WORKSPACE_ID=${id} UB_HUB_URL=local ub mcp serve\`; ` +
      "set `UB_HUB_URL=<hub>` for a hub replica.\n",
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
    if (hub === undefined) throw new Error("workspace record disappeared; fetch it with `ub workspace use <link>`");
    // Preserve endpoint metadata before the user removes obsolete selection keys.
    const admission = hub !== null && usesDeviceLogin(hub, { ...process.env, HUB_ADMISSION: undefined })
      ? writeHubAdmission(hub, true)
      : migrateHubAdmissions();
    warn(io, admission.warnings);
    const registersPrevious = previous !== null && readWorkspaceHub(previous.workspaceId) === undefined;
    path = writeProjectBinding({ workspaceId: id, hubUrl: hub });
    written = [...admission.written, ...(registersPrevious ? [workspaceRegistryPath()] : []), path];
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

  // Written, and possibly overruled: a higher layer means this file changed
  // nothing anyone will observe, and printing the binding without saying so
  // would be the lie `ub status` then contradicts.
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

export async function workspaceCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  // The subcommand first, so `ub workspace use --help` reaches the help of the
  // leaf it names rather than being answered by the group. A group's own
  // argument is that one word, so only that word can ask for help — an unknown
  // command is still an unknown command, `--help` after it or not, which is what
  // the top level does too.
  const [sub, ...rest] = argv;
  if (sub === "status") return workspaceStatusCommand(rest, io);
  if (sub === "create") return createWorkspaceCommand(rest, io);
  if (sub === "promote") return promoteWorkspaceCommand(rest, io);
  if (sub === "member") return workspaceMemberCommand(rest, io);
  if (sub === "list") {
    return listCommand(rest, io);
  }
  if (sub === "use") {
    return await useCommand(rest, io);
  }
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    io.out(WORKSPACE_HELP);
    return 0;
  }
  io.err(`ub workspace: unknown command ${JSON.stringify(sub)}\n\n${WORKSPACE_HELP}`);
  return 2;
}
