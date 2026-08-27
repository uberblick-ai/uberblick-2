/**
 * Where uberblick keeps a user's files — one answer, for every process and
 * every platform.
 *
 * **One layout.** `XDG_CONFIG_HOME` and `XDG_DATA_HOME` when they name absolute
 * directories, and `~/.config` / `~/.local/share` otherwise:
 * `<config home>/uberblick/{config,credentials}.json` and
 * `<data home>/uberblick/{hub,<uuid>}.sqlite`. macOS included — there is no
 * platform branch, so a resolution has no `platform` to be told, cannot depend
 * on where the tests run, and cannot fail.
 *
 * Setting either variable is a deliberate act by an operator, so it moves the
 * *whole* layout rather than half of it: one installation, one pair of roots,
 * never a split.
 *
 * **Nothing here creates anything.** Resolution is string joins; the writers
 * (`ub init`, the replicas, the hub) create directories when they write.
 *
 * **Why this module is in `@uberblick/hub`.** The cli, the MCP server and the
 * hub must agree on one layout, and the hub is the lowest of the three in the
 * dependency graph (cli → mcp-server → hub → schema). A package of its own for
 * four path functions buys nothing but a manifest; `@uberblick/hub/storage`
 * costs a line in the exports map. It imports node builtins and nothing else.
 *
 * `HUB_DB_PATH` and `UBERBLICK_DB` are unchanged and untouched by any of this:
 * they name a file outright, and a file someone named outright is not a layout
 * question. They are applied by their own packages, above this default.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface StorageOptions {
  env?: NodeJS.ProcessEnv;
}

export interface StoragePaths {
  /** Holds `config.json`, `credentials.json` and `ub init`'s lock. */
  configDir: string;
  /** The data root: everything durable is under it, and it is what to name. */
  dataDir: string;
  /** The hub's document persistence, absent `HUB_DB_PATH`. */
  hubDatabase: string;
  /** Holds `<workspaceUuid>.sqlite`, absent `UBERBLICK_DB`. */
  workspaceDir: string;
}

/** The directory name both roots end in. */
const XDG_DIR = "uberblick";

const HUB_DATABASE = "hub.sqlite";

/**
 * `<uuid>.sqlite` — the workspace database filenames this layout produces.
 *
 * Exported because `ub workspace list` enumerates them: the module that decides
 * what the files are called is the one that says how to recognise them, and two
 * copies of this pattern would be two answers to "is this file ours".
 */
export const WORKSPACE_DATABASE_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite$/;

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * An `XDG_*` value, or null when there is none to honour.
 *
 * The XDG base directory spec says a relative value "must be ignored", and it
 * is right: resolving one against the working directory would put a machine's
 * config and databases in as many places as the command is started from.
 * Ignored means *unset*, so such a value is not an override either.
 */
function xdgDir(value: string | undefined): string | null {
  const text = trimmed(value);
  return text === null || !isAbsolute(text) ? null : text;
}

/**
 * Create a directory in the user's storage tree, owner-only, parents included.
 *
 * The first writer is whoever runs first — the hub opening `hub.sqlite`, a
 * replica opening its workspace file, `ub init` writing `credentials.json` —
 * and `mkdirSync` applies its mode only to directories it creates. So a
 * process that made `uberblick/` at the umask's 0755 would leave every later
 * `mode: 0o700` a no-op on a directory anyone can already read. One helper, so
 * that whichever of them is first creates the same thing. (`0o700` is safe
 * under any umask: a umask can only clear permission bits, never add them.)
 */
export function createDataDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * The home directory, from the environment being resolved rather than from the
 * process. On POSIX `os.homedir()` reads exactly this variable; taking it from
 * the environment argument is what makes a resolution against a throwaway home
 * possible without touching the process's own.
 */
function home(env: NodeJS.ProcessEnv): string {
  return trimmed(env.HOME) ?? homedir();
}

/** Resolve the layout. It is the same one everywhere, and it cannot throw. */
export function resolveStorage(options: StorageOptions = {}): StoragePaths {
  const env = options.env ?? process.env;
  const configHome = xdgDir(env.XDG_CONFIG_HOME) ?? join(home(env), ".config");
  const dataHome =
    xdgDir(env.XDG_DATA_HOME) ?? join(home(env), ".local", "share");
  const dataDir = join(dataHome, XDG_DIR);
  return {
    configDir: join(configHome, XDG_DIR),
    dataDir,
    hubDatabase: join(dataDir, HUB_DATABASE),
    workspaceDir: dataDir,
  };
}
