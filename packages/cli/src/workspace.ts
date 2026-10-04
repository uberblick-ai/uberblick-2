/** Workspace selection, local creation, promotion and joining. */

import { readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { WORKSPACE_DATABASE_FILE, resolveStorage } from "@uberblick/hub/storage";
import { defaultDatabasePath } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import type { Origin } from "./config.js";
import { resolveConfig } from "./config.js";
import { resolveProjectBinding, writeProjectBinding } from "./project-binding.js";
import { normalizeRemoteUrl } from "@uberblick/hub/remote-url";
import { takeHelp } from "./help.js";
import type { InitLock } from "./init-lock.js";
import { acquireInitLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { describeFsError } from "./safe-write.js";
import { ORIGIN_LABELS } from "./status.js";

import { createWorkspaceCommand } from "./workspace-create.js";
import { promoteWorkspaceCommand } from "./workspace-promote.js";
import { joinCommand } from "./remote.js";

export const WORKSPACE_HELP = `usage: ub workspace [command]

commands:
  (none)                      the workspace in force, and which layer chose it
  create <name>               create and select a separate local-only workspace
  promote <hub>               upload, verify and connect this local workspace
  join <connection-url>       join an existing hub workspace
  list [--json]               workspaces this machine has a database for
  use <id> --hub <url|local>  select a workspace and hub in this project

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
  /** The bare uuid. Self-described names arrive with a later issue. */
  uuid: string;
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

  const entries = [...uuids].sort().map((uuid) => ({
    uuid,
    active: uuid === current.uuid,
    databasePath: defaultDatabasePath(uuid, env),
  }));
  return { entries, warnings: current.warnings };
}

function warn(io: Io, warnings: readonly string[]): void {
  for (const warning of warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
}

function field(name: string, value: string): string {
  return `${name.padEnd(14)}${value}\n`;
}

// --- ub workspace ----------------------------------------------------------

function showWorkspace(io: Io): number {
  const current = inForce();
  warn(io, current.warnings);

  if (current.configured === null || current.uuid === null) {
    io.err(
      "ub workspace: no workspace configured. There is no default — a guessed " +
        "workspace would open a corpus nobody chose. Run `ub init` to create " +
        "one, or `ub workspace use <id> --hub <url|local>` to adopt one that exists.\n",
    );
    return 1;
  }

  let text = field(
    "workspace",
    `${current.configured} (${ORIGIN_LABELS[current.origin]})`,
  );
  // Only when the spelling hides it — the same rule `ub status` follows.
  if (current.uuid !== current.configured) {
    text += field("uuid", current.uuid);
  }
  text += field("hub", current.hubUrl ?? "local (this computer)");
  io.out(text);
  return 0;
}

// --- ub workspace list -----------------------------------------------------

/** Exported so the help below can be checked against the parser it describes. */
export const WORKSPACE_LIST_OPTIONS = {
  json: { type: "boolean", default: false },
} as const;

export const WORKSPACE_LIST_HELP = `usage: ub workspace list [--json]

Every workspace this machine has a local database for, with the one currently in
force marked. Reads the database directory only — a workspace that exists
elsewhere but has never been opened here is not listed.

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
    text += `${entry.active ? "*" : " "} ${entry.uuid}\n`;
  }
  io.out(text);
  return 0;
}

// --- ub workspace use ------------------------------------------------------

/**
 * What `<id>` names.
 *
 * A full id — bare or decorated — is taken as given, whether or not this machine
 * has heard of it: being handed a uuid *is* how you join a workspace, and the
 * replica hydrates the first time something serves it. Anything else has to
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
  known: readonly WorkspaceEntry[],
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
        "`ub workspace list` shows them; a full uuid is accepted even when it " +
        "is not among them",
    };
  }
  return {
    error:
      `${JSON.stringify(raw)} matches ${matches.length} workspaces:\n` +
      matches.map((entry) => `  ${entry.uuid}\n`).join(""),
  };
}

export const WORKSPACE_USE_HELP = `usage: ub workspace use <id> [--hub <url|local>]

Select a workspace and hub together in the nearest .uberblick.json, or create
one in the current directory. Terminal commands and project MCP sessions use it.

operands:
  <id>              a workspace <uuid>, a decorated <slug>-<uuid>, or a unique
                    prefix of a local UUID

options:
  --hub <url|local>  explicit hub URL, or local for this computer
  -h, --help        show this help

The hub is required unless the project file already selects this workspace. An existing local
database does not identify which hub owns it. This command moves no documents
and verifies no membership; use \`ub workspace join\` to hydrate a remote workspace.
Complete UB_WORKSPACE_ID and UB_HUB_URL environment overrides still take priority.
`;

async function useCommand(argv: string[], io: Io): Promise<number> {
  if (takeHelp(argv, io, WORKSPACE_USE_HELP)) return 0;

  let raw: string | undefined;
  let hub: string | null | undefined;
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      options: { hub: { type: "string" } },
      allowPositionals: true,
    });
    if (positionals.length !== 1) {
      throw new Error("expected exactly one workspace id");
    }
    raw = positionals[0];
    hub = values.hub === undefined ? undefined : values.hub === "local" ? null : normalizeRemoteUrl(values.hub);
  } catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    io.err("usage: ub workspace use <id> [--hub <url|local>]\n");
    return 2;
  }
  if (raw === undefined) {
    io.err("usage: ub workspace use <id> [--hub <url|local>]\n");
    return 2;
  }

  let entries: WorkspaceEntry[];
  try {
    entries = listWorkspaces().entries;
  } catch (error) {
    // Refused rather than resolved against a short list: a prefix that quietly
    // stopped matching would bind this directory to the wrong workspace.
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const resolved = resolveWorkspaceId(raw, entries);
  if ("error" in resolved) {
    io.err(`ub workspace use: ${resolved.error}\n`);
    return 2;
  }
  const id = resolved.id;

  // Environment overrides select this process, never a persistence default.
  const current = resolveProjectBinding({ env: {} }).binding;
  if (hub === undefined) {
    if (current === null || parseWorkspaceId(current.workspaceId).uuid !== parseWorkspaceId(id).uuid) {
      io.err("ub workspace use: specify --hub <url> or --hub local when selecting a different workspace.\n");
      return 2;
    }
    hub = current.hubUrl;
  }
  let path: string;

  let lock: InitLock;
  try {
    lock = await acquireInitLock();
  } catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    path = writeProjectBinding({ workspaceId: id, hubUrl: hub,
      ...(hub === current?.hubUrl && current.hubAdmission === "device" ? { hubAdmission: "device" } : {}),
    });
  } catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    lock.release();
  }

  const { uuid } = parseWorkspaceId(id);
  let text = field("workspace", id);
  if (uuid !== id) {
    text += field("uuid", uuid);
  }
  text += field("hub", hub ?? "local (this computer)");
  text += field("config", path);
  io.out(text);

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
  if (sub === "create") return createWorkspaceCommand(rest, io);
  if (sub === "promote") return promoteWorkspaceCommand(rest, io);
  if (sub === "join") return joinCommand(rest, io);
  if (sub === "list") {
    return listCommand(rest, io);
  }
  if (sub === "use") {
    return await useCommand(rest, io);
  }
  if (sub === undefined) {
    return showWorkspace(io);
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    io.out(WORKSPACE_HELP);
    return 0;
  }
  io.err(`ub workspace: unknown command ${JSON.stringify(sub)}\n\n${WORKSPACE_HELP}`);
  return 2;
}
