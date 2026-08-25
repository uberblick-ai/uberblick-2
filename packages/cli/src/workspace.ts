/**
 * `ub workspace` — which workspace this directory works in, and how to change it.
 *
 * Three forms and no more: the one in force, the ones this machine has a
 * database for, and the binding verb.
 *
 * Nothing here opens a hub connection or a Y.Doc. `list` reads a directory
 * listing, `use` writes one JSON file — the whole command is local bookkeeping,
 * the way `git remote` is, and it stays fast and offline for the same reason.
 *
 * **`use` writes `./uberblick.json`, not the user config.** That is the missing
 * half of the layout: the directory file is what binds one checkout to one
 * workspace, and until now the only command that persisted a workspace was
 * `ub init`, which writes the *user-global* config — a trap the moment two
 * checkouts want two workspaces. `--user` asks for the old behaviour
 * explicitly: bind the machine rather than the directory.
 *
 * **`use` stores the string as typed.** A `<slug>-<uuid>` spelling is kept whole,
 * because the slug is what makes a config file readable, and only what reaches a
 * room, a token or the database is the bare uuid. A *prefix* is resolved to the
 * uuid it names, because a prefix is a way of typing an id, not an id.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { defaultDatabasePath } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import type { Origin } from "./config.js";
import {
  DIRECTORY_FILE,
  resolveConfig,
  userConfigPath,
  writeUserConfig,
} from "./config.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { describeFsError, publishOwnerOnly } from "./safe-write.js";
import { ORIGIN_LABELS } from "./status.js";

export const WORKSPACE_HELP = `usage: ub workspace [command]

commands:
  (none)                 the workspace in force, and which layer chose it
  list [--json]          workspaces this machine has a database for
  use <id> [--user]      bind this directory to a workspace; --user binds the
                         machine instead, by writing the user config

<id> is any of three things:
  <uuid>                 a workspace uuid — accepted even if this machine has
                         never seen it; the replica hydrates on next use
  <slug>-<uuid>          a decorated id, stored exactly as you type it
  <prefix>               a unique prefix of a uuid \`ub workspace list\` shows
`;

/** `<uuid>.sqlite` — the filenames `defaultDatabasePath` produces. */
const DATABASE_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite$/;

/** As much of a uuid as someone can have typed so far. */
const UUID_PREFIX = /^[0-9a-f][0-9a-f-]*$/;

/** A uuid is 36 characters; anything longer is not a prefix of one. */
const UUID_LENGTH = 36;

/**
 * Where `<uuid>.sqlite` files live.
 *
 * Asked of the module that owns the layout rather than restated here — the
 * answer wanted is the directory, so the uuid handed in is a placeholder.
 */
function databaseDirectory(env: NodeJS.ProcessEnv): string {
  return dirname(defaultDatabasePath("00000000-0000-0000-0000-000000000000", env));
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
  warnings: string[];
}

/**
 * The workspace configuration resolves to — the same value and the same origin
 * `ub status` reports, without opening the database to get it.
 */
function inForce(options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): InForce {
  const resolved = resolveConfig(options);
  const configured = resolved.env.WORKSPACE_ID ?? null;
  return {
    configured,
    // resolveConfig already refused anything that is not a workspace id.
    uuid: configured === null ? null : parseWorkspaceId(configured).uuid,
    origin: resolved.origins.workspace,
    warnings: resolved.warnings,
  };
}

/**
 * Every workspace this machine knows: one with a database, plus the configured
 * one — which may have neither a database nor a document yet, and is still the
 * workspace you are in.
 */
export function listWorkspaces(
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
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
    const match = DATABASE_FILE.exec(name);
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
        "one, or `ub workspace use <id>` to bind this directory to one that " +
        "exists.\n",
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
  io.out(text);
  return 0;
}

// --- ub workspace list -----------------------------------------------------

function listCommand(argv: string[], io: Io): number {
  let json = false;
  try {
    json =
      parseArgs({
        args: argv,
        options: { json: { type: "boolean", default: false } },
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

/**
 * A config file as it is on disk, for merging into.
 *
 * A file that exists but cannot be believed is a refusal, not a default: this
 * command replaces one field and republishes the whole file, so treating an
 * unparseable one as an empty object would throw away everything else its
 * author put in it. That is as true of `config.json` — an identity, an
 * endpoint — as of `./uberblick.json`, which is why both go through here.
 */
function readMergeTarget(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message quotes the file around the syntax error, and this
    // one is committable — nothing from it is repeated onto a stream.
    throw new Error(
      `refusing to rewrite ${path}: it is not valid JSON. Fix it, or move it ` +
        "aside and run `ub workspace use` again",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`refusing to rewrite ${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function useCommand(argv: string[], io: Io): number {
  let user = false;
  let raw: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { user: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    user = values.user === true;
    if (positionals.length !== 1) {
      throw new Error("expected exactly one workspace id");
    }
    raw = positionals[0];
  } catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    io.err("usage: ub workspace use <id> [--user]\n");
    return 2;
  }
  if (raw === undefined) {
    io.err("usage: ub workspace use <id> [--user]\n");
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

  const cwd = process.cwd();
  const path = user ? userConfigPath() : join(cwd, DIRECTORY_FILE);
  try {
    if (user) {
      // Merged over what is on disk: identity and the endpoint are not this
      // command's to drop — and neither is a file that did not parse, which is
      // refused rather than quietly replaced with a one-field file.
      writeUserConfig({ ...readMergeTarget(path), workspace: id });
    } else {
      // Owner-only like every other file this CLI publishes. Nothing in here is
      // a secret and git does not record the mode, so one writer with one rule
      // is worth more than a second rule for the committable file.
      publishOwnerOnly(
        path,
        serialize({ ...readMergeTarget(path), workspace: id }),
        "ub workspace use",
      );
    }
  } catch (error) {
    io.err(`ub workspace use: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const { uuid } = parseWorkspaceId(id);
  let text = field("workspace", id);
  if (uuid !== id) {
    text += field("uuid", uuid);
  }
  text += field("config", path);
  io.out(text);

  // Written, and possibly overruled: a higher layer means this file changed
  // nothing anyone will observe, and printing the binding without saying so
  // would be the lie `ub status` then contradicts.
  const after = inForce({ cwd });
  if (after.configured !== id) {
    io.err(
      `ub: warning: ${ORIGIN_LABELS[after.origin]} sets ${
        after.configured ?? "no workspace"
      }, which takes precedence over ${path}\n`,
    );
  }
  return 0;
}

export function workspaceCommand(argv: string[], io: Io = processIo): number {
  const [sub, ...rest] = argv;
  if (sub === undefined) {
    return showWorkspace(io);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    io.out(WORKSPACE_HELP);
    return 0;
  }
  if (sub === "list") {
    return listCommand(rest, io);
  }
  if (sub === "use") {
    return useCommand(rest, io);
  }
  io.err(`ub workspace: unknown command ${JSON.stringify(sub)}\n\n${WORKSPACE_HELP}`);
  return 2;
}
