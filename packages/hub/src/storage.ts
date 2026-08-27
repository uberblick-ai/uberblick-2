/**
 * Where uberblick keeps a user's files — one answer, for every process.
 *
 * Three layouts, and which one is in force is a resolution, not a setting:
 *
 * - **`mac`** — macOS with nothing overriding it. Everything lives under
 *   `~/Library/Application Support/Uberblick`: `config.json`,
 *   `credentials.json`, `data/hub.sqlite`, `data/workspaces/<uuid>.sqlite`.
 *   That is where Apple's file-system guide puts app-managed durable data, and
 *   it is the only location a Homebrew or tarball upgrade cannot replace —
 *   which is the whole reason this module exists, because the hub's database
 *   used to live inside the package it shipped in.
 * - **`xdg`** — everywhere else, and *anywhere* `XDG_CONFIG_HOME` or
 *   `XDG_DATA_HOME` is set: `<config home>/uberblick/{config,credentials}.json`
 *   and `<data home>/uberblick/{hub,<uuid>}.sqlite`. Setting either variable is
 *   a deliberate act by an operator, so it moves the *whole* layout rather than
 *   half of it: one installation, one pair of roots, never a split.
 * - **`legacy-xdg`** — a macOS machine that already has state in the implicit
 *   XDG defaults (`~/.config/uberblick`, `~/.local/share/uberblick`) from
 *   before the Mac layout existed. It keeps every one of those paths, and says
 *   so once. Moving files is `ub storage migrate` — never something a
 *   read command does behind someone's back, and never half a move.
 *
 * **The refusal.** If a Mac has state in *both* roots, nothing here guesses:
 * resolution throws {@link AmbiguousStorageError}, `ub doctor` fails its
 * `storage-layout` check, and no database is opened. Picking one root would
 * silently strand the documents in the other.
 *
 * **Nothing here creates anything.** Resolution is `existsSync` and string
 * joins; the writers (`ub init`, the replicas) create directories when they
 * write, so `ub status` on a legacy machine leaves the Mac root untouched.
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

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Which of the three layouts resolution landed on. Stable: `--json` prints it. */
export type StorageLayout = "mac" | "xdg" | "legacy-xdg";

export interface StorageOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * `process.platform` by default. A parameter rather than a global anything:
   * the Mac layout has to be provable on the machine that runs the tests.
   */
  platform?: NodeJS.Platform;
}

export interface StoragePaths {
  layout: StorageLayout;
  /** Holds `config.json`, `credentials.json` and `ub init`'s lock. */
  configDir: string;
  /** The data root: everything durable is under it, and it is what to name. */
  dataDir: string;
  /** The hub's document persistence, absent `HUB_DB_PATH`. */
  hubDatabase: string;
  /** Holds `<workspaceUuid>.sqlite`, absent `UBERBLICK_DB`. */
  workspaceDir: string;
  /**
   * The one migration note on a `legacy-xdg` machine, and empty otherwise.
   * Warnings go to stderr; nothing here writes to stdout.
   */
  warnings: string[];
}

/** The XDG directory name, and the Application Support one. */
const XDG_DIR = "uberblick";
const MAC_DIR = "Uberblick";

/**
 * What `ub storage migrate` leaves in the Mac root when it has finished, and
 * the reason a migrated machine is not the ambiguous one below.
 *
 * A migration copies rather than moves — the originals are what makes it
 * reversible — so afterwards *both* roots hold uberblick files, which is
 * exactly the configuration this module otherwise refuses to guess about. This
 * file is the answer somebody already gave: the Mac root is live, the legacy
 * pair is a retained original. Presence is the whole signal; nothing here opens
 * or parses it, because a resolution that could fail to parse would be a
 * machine that cannot find its own documents.
 */
export const MIGRATION_RECEIPT = "migration.json";

/**
 * How the Mac root is written in prose — a remedy line, a document. The
 * resolved path is `home()`-specific; this is the spelling a person recognises.
 */
export const MAC_ROOT_DISPLAY = "~/Library/Application Support/Uberblick";

/** Named files that make a directory recognisably uberblick's. */
const CONFIG_FILES = ["config.json", "credentials.json"] as const;
const HUB_DATABASE = "hub.sqlite";
const WORKSPACES_DIR = "workspaces";

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
 * config and databases in as many places as the command is started from — and
 * on a Mac, a stray relative value would silently take an installation off the
 * layout it is actually living in. Ignored means *unset*, so such a value is
 * not an override either.
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
 * process that made `Uberblick/` at the umask's 0755 would leave every later
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

function xdgLayout(env: NodeJS.ProcessEnv): StoragePaths {
  const configHome = xdgDir(env.XDG_CONFIG_HOME) ?? join(home(env), ".config");
  const dataHome =
    xdgDir(env.XDG_DATA_HOME) ?? join(home(env), ".local", "share");
  const dataDir = join(dataHome, XDG_DIR);
  return {
    layout: "xdg",
    configDir: join(configHome, XDG_DIR),
    dataDir,
    hubDatabase: join(dataDir, HUB_DATABASE),
    // Flat, exactly as it has always been: a `workspaces/` subdirectory here
    // would move every existing replica on every existing machine, which is
    // `ub storage migrate`'s job and not a side effect of an upgrade.
    workspaceDir: dataDir,
    warnings: [],
  };
}

/**
 * The Mac layout's paths, whatever layout is actually in force.
 *
 * Exported for one caller: `ub storage migrate`, whose whole job is to write
 * into a root that resolution is — correctly — not returning yet, because the
 * files are still in the legacy one. Nothing else should ask; every reader
 * wants {@link resolveStorage}, which answers where the files *are*.
 *
 * `platform` is ignored, and takes the same options type only so callers do not
 * have to build a second one: this *is* the Mac layout, and asking for it on a
 * Linux box is what the tests do.
 */
export function macStorage(options: StorageOptions = {}): StoragePaths {
  return macLayout(options.env ?? process.env);
}

function macLayout(env: NodeJS.ProcessEnv): StoragePaths {
  const root = join(home(env), "Library", "Application Support", MAC_DIR);
  const dataDir = join(root, "data");
  return {
    layout: "mac",
    configDir: root,
    dataDir,
    hubDatabase: join(dataDir, HUB_DATABASE),
    workspaceDir: join(dataDir, WORKSPACES_DIR),
    warnings: [],
  };
}

function hasWorkspaceDatabase(directory: string): boolean {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    // Absent, or unreadable. Either way it is not state this can act on, and a
    // resolution is not the place to raise an I/O error about a directory
    // nobody has asked to open yet.
    return false;
  }
  return names.some((name) => WORKSPACE_DATABASE_FILE.test(name));
}

/**
 * Whether a layout's roots hold anything uberblick put there.
 *
 * By name, never by content: a `config.json` that does not parse is still this
 * installation's config file, and the question here is which root a machine is
 * living in, not whether its files are healthy. Anything else in those
 * directories — an editor's backup, a note, a file from another program — is
 * not ours and does not make a root count as populated.
 */
function holdsState(paths: StoragePaths): boolean {
  return (
    CONFIG_FILES.some((file) => existsSync(join(paths.configDir, file))) ||
    existsSync(paths.hubDatabase) ||
    hasWorkspaceDatabase(paths.workspaceDir)
  );
}

/** How to move a legacy installation, named wherever the legacy layout is. */
const MIGRATE = "`ub storage migrate` will move it";

/**
 * The one line a migrated machine says: where its files are now, and that the
 * originals are still there for whoever wants to check them before removing
 * them. Nothing suggests removing them automatically — see `ub storage
 * migrate`, which deletes nothing by design.
 */
function migratedWarning(mac: StoragePaths, legacy: StoragePaths): string {
  return (
    `migrated: uberblick's files are in ${mac.configDir}. The originals in ` +
    `${legacy.configDir} and ${legacy.dataDir} were left in place by ` +
    "`ub storage migrate` and are no longer read — remove them yourself once " +
    "you are satisfied with the migrated copies."
  );
}

function migrationWarning(mac: StoragePaths, legacy: StoragePaths): string {
  return (
    `using the legacy layout: uberblick's files are in ${legacy.configDir} and ` +
    `${legacy.dataDir}, where this machine put them before ` +
    `${mac.configDir} was the default. Nothing was moved and nothing new was ` +
    `created — ${MIGRATE}.`
  );
}

/**
 * Two roots hold state and neither is more right than the other.
 *
 * Thrown rather than resolved to a guess: opening one of them would leave the
 * documents in the other invisible, and a half-visible corpus is the one
 * outcome worse than a command that refuses to run.
 */
export class AmbiguousStorageError extends Error {
  readonly macRoot: string;
  readonly legacyConfigDir: string;
  readonly legacyDataDir: string;
  /** The line `ub doctor` prints under the failed check. */
  readonly remedy: string;

  constructor(mac: StoragePaths, legacy: StoragePaths) {
    super(
      `refusing to guess where uberblick's files are: ${mac.configDir} and the ` +
        `legacy ${legacy.configDir} / ${legacy.dataDir} both hold state — run ` +
        "`ub doctor`, which names both roots and the way out",
    );
    this.name = "AmbiguousStorageError";
    this.macRoot = mac.configDir;
    this.legacyConfigDir = legacy.configDir;
    this.legacyDataDir = legacy.dataDir;
    this.remedy =
      `keep one: move what you want to keep into ${mac.configDir} and remove ` +
      "the rest — or empty that root, and `ub storage migrate` will fill it " +
      "from the legacy pair, which it never does over files already there. " +
      "Setting XDG_CONFIG_HOME and XDG_DATA_HOME pins the legacy pair " +
      "explicitly";
  }
}

/**
 * Resolve the layout in force.
 *
 * @throws {AmbiguousStorageError} when a Mac holds state in both roots.
 */
export function resolveStorage(options: StorageOptions = {}): StoragePaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const xdg = xdgLayout(env);

  // An explicit XDG variable is an operator's choice and outranks the platform
  // — on macOS too, and for *both* halves of the layout: setting only
  // XDG_DATA_HOME must not leave the config in Application Support and the
  // databases somewhere else.
  const explicit =
    xdgDir(env.XDG_CONFIG_HOME) !== null || xdgDir(env.XDG_DATA_HOME) !== null;
  if (platform !== "darwin" || explicit) {
    return xdg;
  }

  const mac = macLayout(env);
  if (!holdsState(xdg)) {
    return mac;
  }
  // A completed migration is the one case where both roots holding files is not
  // an ambiguity: somebody ran `ub storage migrate`, which copied rather than
  // moved so that the originals stay as a rollback.
  if (existsSync(join(mac.configDir, MIGRATION_RECEIPT))) {
    return { ...mac, warnings: [migratedWarning(mac, xdg)] };
  }
  if (holdsState(mac)) {
    throw new AmbiguousStorageError(mac, xdg);
  }
  return { ...xdg, layout: "legacy-xdg", warnings: [migrationWarning(mac, xdg)] };
}
