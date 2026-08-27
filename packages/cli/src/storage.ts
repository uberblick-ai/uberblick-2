/**
 * `ub storage migrate` — the one deliberate move of a legacy macOS
 * installation into Application Support.
 *
 * A Mac that had uberblick before the Mac layout existed keeps every path it
 * had (`~/.config/uberblick`, `~/.local/share/uberblick`) — see
 * `@uberblick/hub/storage`, which resolves that as `legacy-xdg` and moves
 * nothing. This is the command that moves it, and it is the only one.
 *
 * **Copy, verify, then publish — in that order, once.** Everything is staged
 * into a sibling directory of the destination root and published with a single
 * `rename`, so there is no moment at which `~/Library/Application
 * Support/Uberblick` half exists. Nothing is deleted: the legacy files stay
 * exactly where they were, which is what makes the whole operation reversible
 * by removing one directory.
 *
 * **Databases are copied by SQLite, never by the filesystem.** A replica is a
 * WAL database: its most recent commits live in `-wal` until a checkpoint folds
 * them in, so `cp file.sqlite` is a copy that silently loses the last minutes
 * of work, and copying `-wal`/`-shm` as ordinary files pairs a WAL with a
 * database it may not match. `node:sqlite`'s backup API reads a consistent
 * snapshot through an open connection — WAL included — and writes one file.
 *
 * **A database another process has open is a refusal, not a race.** Each source
 * is opened in `locking_mode = EXCLUSIVE` with no busy timeout before it is
 * copied: a hub, an MCP client or the web app holding it open makes that fail,
 * and the run stops naming the file. Every one of those locks is then **held
 * until the new root has been published**, so a database this run has already
 * copied cannot be written to while the rest are still being copied — a commit
 * landing in that window would otherwise be stranded in a root nothing reads
 * the moment the rename makes the copies live.
 *
 * **The checks that can refuse a source run read-only, first.** Closing a
 * read-write connection to a database whose last writer crashed makes SQLite
 * fold the leftover `-wal` into the file. That is content-preserving and it is
 * what any reader does — `ub status` included — but it is still a write, so it
 * must not happen to a database this command is about to refuse *for some other
 * file's sake*. Integrity and the workspace claim are therefore read through a
 * read-only connection, which replays the same uncheckpointed data into a
 * private page cache and leaves the file alone; only a source that is actually
 * being copied is ever opened read-write. Reports say "content unchanged"
 * rather than "unchanged" for that reason.
 *
 * **The receipt is what makes the result unambiguous.** After a migration both
 * roots hold uberblick files, which is the one configuration `resolveStorage`
 * refuses to guess about. `migration.json` in the new root settles it — the Mac
 * root is live, the legacy pair is a retained original — and it is also the
 * recorded inventory a re-run checks the target against before reporting
 * "already migrated".
 *
 * **`--dry-run` writes nothing at all**, and that rules out opening a database:
 * opening one folds a `-wal` left behind by an unclean shutdown into the
 * database file, which is a write. So a dry run reports what it can see from
 * the filesystem — the exact paths, the counts, and every refusal that does not
 * need a database open — and says which checks the run itself performs.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { parseArgs } from "node:util";
import type { StoragePaths } from "@uberblick/hub/storage";
import type { MigrationReceipt } from "@uberblick/hub/storage";
import {
  AmbiguousStorageError,
  MAC_ROOT_DISPLAY,
  MIGRATION_RECEIPT,
  WORKSPACE_DATABASE_FILE,
  createDataDirectory,
  macStorage,
  readMigrationReceipt,
  resolveStorage,
} from "@uberblick/hub/storage";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { cliVersion } from "./version.js";

/** Owner-only, like every other file this CLI writes. */
const OWNER_ONLY = 0o600;

/** The first bytes of every SQLite database file, including the terminator. */
const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * How often to wake the event loop while a backup is running.
 *
 * Node resolves `backup()` from a handle that does not itself wake an idle
 * event loop, so a process blocked waiting on some *other* timer does not
 * advance the copy until that timer fires: a two-page backup with a 20 s timer
 * pending takes 20,020 ms. A timer of our own bounds that wait to one tick. It
 * is unref'd, so it can never be the reason a process stays alive.
 *
 * Raising `rate` so the whole file copies in one step does **not** avoid it —
 * measured 20,014 ms against 20,020 ms for the default — because the stall is
 * in the wake-up, not the number of steps. So the rate is left at the default:
 * with the loop awake, a 4 MB database copies in 20 ms either way.
 */
const BACKUP_WAKE_MS = 1;

/** The two files the config root holds. Everything else is a database. */
const CONFIG_FILE = "config.json";
const CREDENTIALS_FILE = "credentials.json";

// --- what a migration is made of ---------------------------------------------

/** Which of the four kinds of file a copy is. Stable: `--json` prints it. */
export type CopyKind = "config" | "credentials" | "workspace" | "hub";

export interface PlannedCopy {
  kind: CopyKind;
  source: string;
  /** Relative to the Application Support root, so a report can show both. */
  target: string;
  /** SQLite goes through the backup API; the two JSON files are bytes. */
  database: boolean;
  /** The uuid in the filename, for a workspace replica. */
  workspace?: string;
}

/** One reason the command will not run, and the one thing to do about it. */
export interface Refusal {
  reason: string;
  remedy: string;
}

/** Stable strings: `--json` prints them and a script will branch on them. */
export type MigrationState =
  | "ready"
  | "refused"
  | "nothing-to-migrate"
  | "already-migrated";

export interface MigrationPlan {
  state: MigrationState;
  /** The legacy roots, or null when there is no legacy installation. */
  from: { configDir: string; dataDir: string } | null;
  /** The Application Support root. */
  to: string;
  copies: PlannedCopy[];
  workspaces: number;
  /** The hub database being moved, or null when none was supplied or found. */
  hub: string | null;
  refusals: Refusal[];
  /** Present only for `already-migrated`. */
  receipt?: MigrationReceipt;
}

export interface MigrationReport extends MigrationPlan {
  version: string;
  dryRun: boolean;
  /** What was actually written, once a migration ran. Empty otherwise. */
  migrated: MigrationReceipt["files"];
}

// --- refusals ----------------------------------------------------------------

/** A refusal raised from inside the copy phase, where only one can happen. */
class Refused extends Error {
  readonly remedy: string;

  constructor(reason: string, remedy: string) {
    super(reason);
    this.name = "Refused";
    this.remedy = remedy;
  }

  get refusal(): Refusal {
    return { reason: this.message, remedy: this.remedy };
  }
}

const CLOSE_CLIENTS =
  "close everything using uberblick — an MCP client, `ub open`, a hub, the " +
  "web app — and run `ub storage migrate` again";

// --- reading the source ------------------------------------------------------

/**
 * Used to prove a staged copy matches what was read, and for nothing else.
 *
 * Deliberately not recorded in the receipt: a digest nothing verifies later is
 * dead weight, and one of the files here is `credentials.json` — publishing a
 * hash of a file whose whole content is a secret buys an offline oracle and no
 * safety.
 */
function digest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Whether a file starts with SQLite's header.
 *
 * Bytes, never an open: this answers "did you point `--hub-db` at a database?"
 * for a path outside the layout, and it has to answer it in a dry run, where
 * opening a database is itself a write.
 */
function looksLikeSqlite(path: string): boolean {
  let fd: number;
  try {
    // A directory opens happily and then fails the *read* with EISDIR, so the
    // question "is this a regular file" has to be asked first: `--hub-db`
    // pointed at a directory is a wrong path, not a crash.
    if (!statSync(path).isFile()) {
      return false;
    }
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const read = readSync(fd, header, 0, header.length, 0);
    return read === header.length && header.toString("latin1") === SQLITE_MAGIC;
  } finally {
    closeSync(fd);
  }
}

/** The two JSON files, as far as this command reads them. */
function parsesAsObject(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Whether anyone but the owner can read a file. The credentials rule. */
function isExposed(path: string): boolean {
  return (statSync(path).mode & 0o077) !== 0;
}

// --- planning ----------------------------------------------------------------

export interface MigrateOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** `process.platform` by default; injected so the Mac layout is testable. */
  platform?: NodeJS.Platform;
  /** The explicitly named checkout-local hub database, or undefined. */
  hubDb?: string | undefined;
}

/**
 * Where each copy lands, named relative to the destination root.
 *
 * Derived from the Mac layout rather than spelled out here: `data/hub.sqlite`
 * and `data/workspaces/` are that module's decisions, and a second copy of them
 * in this file would be a second answer to where a migrated file goes.
 */
function targetIn(mac: StoragePaths, path: string): string {
  return relative(mac.configDir, path);
}

function refusedPlan(to: string, ...refusals: Refusal[]): MigrationPlan {
  return {
    state: "refused",
    from: null,
    to,
    copies: [],
    workspaces: 0,
    hub: null,
    refusals,
  };
}

/**
 * What the command would do, and everything it can refuse without opening a
 * database. Exported for tests and used by both `--dry-run` and the run.
 */
export function planMigration(options: MigrateOptions = {}): MigrationPlan {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;

  if (platform !== "darwin") {
    return refusedPlan(MAC_ROOT_DISPLAY, {
      reason: `this machine is ${platform}, not macOS, and ${MAC_ROOT_DISPLAY} is a macOS location`,
      remedy:
        "nothing needs migrating: on every other platform the XDG layout is " +
        "the layout — `ub status` names the roots in force",
    });
  }

  const mac = macStorage({ env });
  const to = mac.configDir;
  const explicit = ["XDG_CONFIG_HOME", "XDG_DATA_HOME"].filter((name) => {
    const value = env[name]?.trim();
    return value !== undefined && value !== "" && isAbsolute(value);
  });
  if (explicit.length > 0) {
    return refusedPlan(to, {
      reason: `${explicit.join(" and ")} ${explicit.length === 1 ? "is" : "are"} set, which pins this installation to the XDG layout deliberately`,
      remedy:
        "unset them and run `ub storage migrate` again, or keep the XDG " +
        "layout — an explicit setting outranks the platform on purpose",
    });
  }

  let storage: StoragePaths;
  try {
    storage = resolveStorage({ env, platform });
  } catch (thrown) {
    if (!(thrown instanceof AmbiguousStorageError)) {
      throw thrown;
    }
    // A destination that records a migration but has lost part of it gets the
    // refusal that names the files, not the generic one about two roots: the
    // thing to do about it is completely different, and only one of the two
    // messages says which files went missing.
    if (thrown.missing.length > 0) {
      return refusedPlan(to, {
        reason: `${to} records a completed migration but no longer holds ${thrown.missing.length === 1 ? "a file" : "files"} it recorded: ${thrown.missing.join(", ")}`,
        remedy: thrown.remedy,
      });
    }
    return refusedPlan(to, {
      reason: `${to} already holds uberblick files, and so do ${thrown.legacyConfigDir} and ${thrown.legacyDataDir}`,
      remedy:
        "this command moves a legacy installation into an empty destination " +
        "and never merges two — move aside or remove whichever of the two " +
        `roots is not the one you want to keep, then run \`ub storage migrate\``,
    });
  }

  if (storage.layout !== "legacy-xdg") {
    const migrated = existsSync(join(to, MIGRATION_RECEIPT));
    const plan: MigrationPlan = {
      state: migrated ? "already-migrated" : "nothing-to-migrate",
      from: null,
      to,
      copies: [],
      workspaces: 0,
      hub: null,
      refusals: [],
    };
    if (!migrated) {
      return plan;
    }
    const receipt = readMigrationReceipt(to);
    if (receipt === null) {
      return refusedPlan(to, {
        reason: `${join(to, MIGRATION_RECEIPT)} records a completed migration but could not be read`,
        remedy:
          "nothing was changed. The files in that root are the live ones; " +
          "restore or remove the receipt to say so again",
      });
    }
    const missing = verifyReceipt(to, receipt);
    if (missing.length > 0) {
      return refusedPlan(to, {
        reason: `${to} no longer holds ${missing.length === 1 ? "a file" : "files"} the completed migration recorded: ${missing.join(", ")}`,
        remedy:
          "nothing was changed, and the originals are still in " +
          `${receipt.from.configDir} and ${receipt.from.dataDir}. Restore the ` +
          "missing files, or remove the destination root entirely and run " +
          "`ub storage migrate` again",
      });
    }
    return { ...plan, from: receipt.from, receipt };
  }

  // A legacy installation. From here on the question is what to copy and what
  // stops it.
  const refusals: Refusal[] = [];
  const copies: PlannedCopy[] = [];

  const configSource = join(storage.configDir, CONFIG_FILE);
  if (existsSync(configSource)) {
    if (parsesAsObject(configSource)) {
      copies.push({
        kind: "config",
        source: configSource,
        target: CONFIG_FILE,
        database: false,
      });
    } else {
      refusals.push({
        reason: `${configSource} is not a JSON object, so what it configures cannot be carried over`,
        remedy:
          "fix or remove it — `ub status` reads the same file and says the " +
          "same thing — then run `ub storage migrate` again",
      });
    }
  }

  const credentialsSource = join(storage.configDir, CREDENTIALS_FILE);
  if (existsSync(credentialsSource)) {
    if (isExposed(credentialsSource)) {
      const mode = (statSync(credentialsSource).mode & 0o777)
        .toString(8)
        .padStart(4, "0");
      refusals.push({
        reason: `${credentialsSource} is mode ${mode}: other users can read the hub signing secret, and copying it would carry that exposure into the new root`,
        remedy: `chmod 600 ${credentialsSource}, then run \`ub storage migrate\` again`,
      });
    } else if (!parsesAsObject(credentialsSource)) {
      refusals.push({
        reason: `${credentialsSource} is not a JSON object`,
        remedy:
          "nothing here prints or repairs it. Fix it, or move it aside and " +
          "let `ub init` write a new signing secret after the migration",
      });
    } else {
      copies.push({
        kind: "credentials",
        source: credentialsSource,
        target: CREDENTIALS_FILE,
        database: false,
      });
    }
  }

  for (const name of listWorkspaceFiles(storage.workspaceDir)) {
    const uuid = WORKSPACE_DATABASE_FILE.exec(name)?.[1] as string;
    copies.push({
      kind: "workspace",
      source: join(storage.workspaceDir, name),
      target: targetIn(mac, join(mac.workspaceDir, name)),
      database: true,
      workspace: uuid,
    });
  }

  // The hub, which is the one thing this command will not guess at. The
  // layout's own `hub.sqlite` is part of what is being migrated; `--hub-db`
  // names one outside the layout, which is where a checkout's is. Both would
  // become the same file, so two is a refusal rather than a choice.
  const layoutHub = existsSync(storage.hubDatabase) ? storage.hubDatabase : null;
  const supplied = namedHub(options.hubDb, cwd);
  const hub = suppliedOrLayoutHub(supplied, layoutHub, mac, refusals);
  if (hub !== null) {
    copies.push({
      kind: "hub",
      source: hub,
      target: targetIn(mac, mac.hubDatabase),
      database: true,
    });
  }

  return {
    state:
      refusals.length > 0
        ? "refused"
        : // A legacy layout is one that holds something this command copies, so
          // an empty plan means the layout answered "legacy" about files that
          // are not ours. Publishing a root holding nothing but a receipt would
          // claim a migration that never happened.
          copies.length === 0
          ? "nothing-to-migrate"
          : "ready",
    from: { configDir: storage.configDir, dataDir: storage.dataDir },
    to,
    copies,
    workspaces: copies.filter((copy) => copy.kind === "workspace").length,
    hub,
    refusals,
  };
}

/** `<uuid>.sqlite` files in a directory that may not exist. Sorted, so a report is stable. */
function listWorkspaceFiles(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names.filter((name) => WORKSPACE_DATABASE_FILE.test(name)).sort();
}

/** The `--hub-db` path, resolved against the working directory it was typed in. */
function namedHub(value: string | undefined, cwd: string): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : resolve(cwd, text);
}

/**
 * Which hub database is being migrated, if any — and every way that question
 * refuses to have one answer.
 */
function suppliedOrLayoutHub(
  supplied: string | null,
  layoutHub: string | null,
  mac: StoragePaths,
  refusals: Refusal[],
): string | null {
  if (supplied === null) {
    return layoutHub;
  }
  if (supplied === resolve(mac.hubDatabase)) {
    refusals.push({
      reason: `--hub-db ${supplied} is the file the migration would write`,
      remedy:
        "name the database you are migrating *from* — in a checkout that is " +
        "the file `[env] HUB_DB_PATH` in `mise.toml` points at",
    });
    return null;
  }
  if (!existsSync(supplied)) {
    refusals.push({
      reason: `--hub-db ${supplied} does not exist`,
      remedy:
        "name an existing hub database, or leave `--hub-db` off — the " +
        "migration then moves no local hub, and says so",
    });
    return null;
  }
  if (!looksLikeSqlite(supplied)) {
    refusals.push({
      reason: `--hub-db ${supplied} is not a SQLite database`,
      remedy:
        "name the hub's `.sqlite` file itself, never its `-wal`, its `-shm` " +
        "or the directory holding it",
    });
    return null;
  }
  if (layoutHub !== null && resolve(layoutHub) !== supplied) {
    refusals.push({
      reason: `two hub databases would both become ${targetIn(mac, mac.hubDatabase)}: ${layoutHub} in the legacy layout, and --hub-db ${supplied}`,
      remedy:
        "keep one. Move aside the one you do not want and run " +
        "`ub storage migrate` again — this command never merges two hubs",
    });
    return null;
  }
  return supplied;
}

// --- the receipt -------------------------------------------------------------

/**
 * The recorded files a completed migration's target no longer holds.
 *
 * Presence, not contents: a replica changes the moment it is used again, and a
 * migration that is working is exactly the case where it has. What must never
 * have happened is a recorded file *disappearing*, because then "already
 * migrated" would be a claim about a corpus that is no longer all there.
 */
function verifyReceipt(root: string, receipt: MigrationReceipt): string[] {
  return receipt.files
    .filter((file) => !existsSync(join(root, file.target)))
    .map((file) => file.target);
}

// --- copying -----------------------------------------------------------------

/** Write every byte, however many `write(2)` calls it takes. */
function writeAll(fd: number, contents: Buffer): void {
  let written = 0;
  while (written < contents.length) {
    written += writeSync(fd, contents, written, contents.length - written);
  }
}

/**
 * Copy an ordinary file into the staging tree, owner-only, and prove the copy.
 *
 * Bytes rather than a parsed round trip: `config.json` may hold fields this
 * version does not know about, and re-serialising would quietly drop them.
 */
function stageFile(source: string, destination: string): { bytes: number } {
  const contents = readFileSync(source);
  const fd = openSync(destination, "wx", OWNER_ONLY);
  try {
    writeAll(fd, contents);
  } finally {
    closeSync(fd);
  }
  const written = readFileSync(destination);
  if (digest(written) !== digest(contents)) {
    throw new Refused(
      `the copy of ${source} does not match what was read`,
      "nothing was published. Try again; if it repeats, the destination " +
        "filesystem is the thing to look at",
    );
  }
  return { bytes: contents.length };
}

/** Row counts per table, without interpreting a single one of them. */
function tableCounts(db: DatabaseSync): Record<string, number> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`)
      .get() as { n: number };
    counts[name] = Number(row.n);
  }
  return counts;
}

/** The workspace this replica says it holds, or null when it has never said. */
function recordedWorkspace(db: DatabaseSync): string | null {
  const meta = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'")
    .get();
  if (meta === undefined) {
    return null;
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function integrityOf(db: DatabaseSync, path: string): void {
  const rows = db.prepare("PRAGMA integrity_check").all() as {
    integrity_check: string;
  }[];
  const first = rows[0]?.integrity_check;
  if (rows.length !== 1 || first !== "ok") {
    throw new Refused(
      `${path} fails SQLite's integrity check: ${first ?? "no answer"}`,
      "nothing was published and nothing was changed. A damaged database has " +
        "to be dealt with before it can be moved",
    );
  }
}

/**
 * Run SQLite work against a file, turning any failure into a refusal.
 *
 * `integrity_check` and the row counts read pages, so a corrupt database raises
 * `SQLITE_CORRUPT` from whichever statement happens to touch the damage. Left
 * alone that reaches the user as a bare "database disk image is malformed" with
 * no path and nothing to do about it — and, not being a {@link Refused}, as a
 * thrown exception rather than a refusal with an exit code.
 */
function refusing<T>(path: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof Refused) {
      throw error;
    }
    throw new Refused(
      `${path} could not be read by SQLite: ${message(error)}`,
      "nothing was published and nothing was changed. A database SQLite " +
        "cannot read has to be dealt with before it can be moved; the " +
        "original is still where it was",
    );
  }
}

/**
 * Open a source database exclusively, or refuse.
 *
 * `locking_mode = EXCLUSIVE` with no busy timeout is the whole check: in WAL
 * mode it cannot be taken while any other connection is open, which is exactly
 * the question "is something using this file". The connection is then held for
 * the copy, so no writer can appear between the check and the backup.
 */
function openExclusively(path: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (error) {
    throw new Refused(
      `${path} could not be opened: ${message(error)}`,
      "nothing was published. Check that the file is yours and readable",
    );
  }
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch (error) {
    // Always close: a connection left open here is itself what would make the
    // next attempt fail, and the message would then name the wrong culprit.
    db.close();
    throw new Refused(
      `${path} is open in another process, so it cannot be copied safely: ${message(error)}`,
      CLOSE_CLIENTS,
    );
  }
  return db;
}

/**
 * The checks that can refuse a source, run without writing to it.
 *
 * Read-only, and that is the whole point: closing a *read-write* connection to
 * a database whose last writer crashed makes SQLite fold the leftover
 * write-ahead log into the file, so running these checks read-write would
 * modify every source examined before whichever source turns out to be the
 * reason to refuse. A read-only connection reads that same uncheckpointed data
 * — the `-wal` is replayed into a private page cache — and leaves the database
 * file byte for byte as it found it.
 */
function inspectSource(copy: PlannedCopy): string | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(copy.source, { readOnly: true });
  } catch (error) {
    throw new Refused(
      `${copy.source} could not be opened: ${message(error)}`,
      "nothing was published. Check that the file is yours and readable",
    );
  }
  try {
    return refusing(copy.source, () => {
      integrityOf(db, copy.source);
      const claim = recordedWorkspace(db);
      if (copy.kind === "workspace" && claim !== null && claim !== copy.workspace) {
        throw new Refused(
          `${copy.source} is the replica of workspace ${claim}, which its filename does not name`,
          "one database holds one workspace. Rename it to " +
            `${claim}.sqlite, or move it aside — a file copied under the wrong ` +
            "name would serve two corpora as one",
        );
      }
      return claim;
    });
  } finally {
    db.close();
  }
}

/**
 * Copy one database through SQLite and verify the copy against the original.
 *
 * Two connections, in this order: a read-only one for the checks that can
 * refuse (see {@link inspectSource}), then the exclusive one that does the
 * copying. Only the second can be refused for the file being in use, and only
 * the second can write to it — so a run that stops because some *other*
 * database is open has read these and modified none of them.
 *
 * The row counts are taken on the exclusive connection rather than the
 * read-only one, so the file they describe is the file being copied, with
 * nothing able to write to it in between.
 */
async function stageDatabase(
  copy: PlannedCopy,
  destination: string,
  locked: DatabaseSync[],
): Promise<{ bytes: number }> {
  const claim = inspectSource(copy);

  const source = openExclusively(copy.source);
  // Registered before anything that can throw, and deliberately *not* closed
  // here: the caller holds every source's lock until the whole root has been
  // published. See {@link runMigration}. Pushing first is what keeps a failure
  // below from leaking a connection nobody can close.
  locked.push(source);
  const counts = refusing(copy.source, () => tableCounts(source));
  // A timer of our own for as long as the copy runs — see BACKUP_WAKE_MS.
  const wake = setInterval(() => {}, BACKUP_WAKE_MS);
  wake.unref();
  try {
    await backup(source, destination);
  } catch (error) {
    throw new Refused(
      `copying ${copy.source} failed: ${message(error)}`,
      "nothing was published and the original is untouched",
    );
  } finally {
    clearInterval(wake);
  }

  // The backup API creates the file at the umask; it is inside a 0700 staging
  // directory until publication, and this is where it stops being anyone's
  // business but the owner's.
  chmodSync(destination, OWNER_ONLY);

  const copied = new DatabaseSync(destination);
  try {
    refusing(destination, () => integrityOf(copied, destination));
    const copiedCounts = refusing(destination, () => tableCounts(copied));
    for (const [table, rows] of Object.entries(counts)) {
      if (copiedCounts[table] !== rows) {
        throw new Refused(
          `the copy of ${copy.source} holds ${copiedCounts[table] ?? 0} rows in ${table}, not ${rows}`,
          "nothing was published. The original is untouched; run " +
            "`ub storage migrate` again",
        );
      }
    }
    if (refusing(destination, () => recordedWorkspace(copied)) !== claim) {
      throw new Refused(
        `the copy of ${copy.source} does not record the workspace the original does`,
        "nothing was published. The original is untouched",
      );
    }
    // Read-write, and closed here on purpose: SQLite removes the `-wal` and
    // `-shm` it created for this connection, so the staged tree holds nothing
    // but the databases themselves.
  } finally {
    copied.close();
  }

  return { bytes: statSync(destination).size };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- running -----------------------------------------------------------------

/**
 * Stage every copy, verify it, and publish the root in one `rename`.
 *
 * Exported for tests, which is also why it takes its environment: the Mac
 * layout has to be provable on the machine that runs them.
 */
export async function runMigration(
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const plan = planMigration(options);
  const base: MigrationReport = {
    ...plan,
    version: cliVersion(),
    dryRun: false,
    migrated: [],
  };
  // `from` is set for every plan that reached "ready"; the check is what tells
  // the type checker so, and it costs a line.
  if (plan.state !== "ready" || plan.from === null) {
    return base;
  }
  const from = plan.from;

  // Staging happens beside the destination, because `rename` is atomic only
  // within one filesystem. On a Mac the directory holding it is always there;
  // when it is not, a run that refuses puts it back the way it found it.
  const parent = dirname(plan.to);
  const created = missingAncestors(parent);
  createDataDirectory(parent);
  const prefix = `.${basename(plan.to)}.`;
  sweepStaging(parent, prefix);
  const staging = join(
    parent,
    `${prefix}${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  createDataDirectory(staging);
  const files: MigrationReceipt["files"] = [];
  // Every source database's exclusive lock, held from its own copy until the
  // whole root is published.
  //
  // Releasing each one after its own backup would leave a window with teeth:
  // while the *later* files are still being copied, a client could open a
  // legacy database this run had already copied and commit to it, and the
  // publication would then make a stale copy live while those commits sat in a
  // root nothing reads any more. Held to the end, the only thing such a client
  // can do is fail to open the file — which is the honest answer, because the
  // migration really is using it.
  const locked: DatabaseSync[] = [];
  try {
    for (const copy of plan.copies) {
      const destination = join(staging, copy.target);
      createDataDirectory(dirname(destination));
      const written = copy.database
        ? await stageDatabase(copy, destination, locked)
        : stageFile(copy.source, destination);
      files.push({
        kind: copy.kind,
        source: copy.source,
        target: copy.target,
        bytes: written.bytes,
      });
    }

    const receipt: MigrationReceipt = {
      version: 1,
      migratedAt: new Date().toISOString(),
      from,
      files,
    };
    stageReceipt(staging, receipt);
    publish(staging, plan.to);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    removeIfEmpty(created);
    if (error instanceof Refused) {
      return { ...base, state: "refused", refusals: [error.refusal] };
    }
    throw error;
  } finally {
    // After the publication, or after the refusal that cancelled it. Not
    // before: the whole point is that no source is writable while a copy of it
    // is waiting to become the live one.
    for (const source of locked) {
      source.close();
    }
  }

  return { ...base, migrated: files };
}

/**
 * The directories on the way to `path` that do not exist yet, deepest first.
 *
 * A refusal must leave the filesystem as it found it, and `mkdir -p` on
 * `~/Library/Application Support` may create two directories, not one.
 */
function missingAncestors(path: string): string[] {
  const missing: string[] = [];
  for (let current = path; !existsSync(current); current = dirname(current)) {
    missing.push(current);
    if (dirname(current) === current) break;
  }
  return missing;
}

/** Undo {@link missingAncestors}, stopping at the first one somebody uses. */
function removeIfEmpty(directories: string[]): void {
  for (const directory of directories) {
    try {
      rmdirSync(directory);
    } catch {
      // Not empty, or not there: either way not ours to remove.
      return;
    }
  }
}

/**
 * Remove staging directories a previous run died inside.
 *
 * A run killed between staging `credentials.json` and publishing leaves a
 * hidden directory holding a copy of the signing secret, and nothing would ever
 * come back for it. Only directories whose recorded pid is gone are swept, so a
 * second `ub storage migrate` running right now keeps its own.
 */
function sweepStaging(parent: string, prefix: string): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) {
      continue;
    }
    const pid = Number(name.slice(prefix.length).split(".")[0]);
    // Strictly positive: `process.kill(0, …)` addresses the whole process
    // group, which is not a question anyone here means to ask.
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    try {
      // Signal 0 tests for the process without touching it. EPERM means it is
      // alive and someone else's; only ESRCH — no such process — is ours to
      // clean up after.
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        continue;
      }
    }
    rmSync(join(parent, name), { recursive: true, force: true });
  }
}

function stageReceipt(staging: string, receipt: MigrationReceipt): void {
  const path = join(staging, MIGRATION_RECEIPT);
  const fd = openSync(path, "wx", OWNER_ONLY);
  try {
    writeAll(fd, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
  } finally {
    closeSync(fd);
  }
}

/**
 * One `rename`, which either moves the whole staged root into place or does
 * nothing at all. It cannot overwrite: a destination that exists and holds
 * anything makes `rename` fail, which is the last line of defence behind the
 * populated-target refusal — and the one that covers a second `ub storage
 * migrate` that started while this one was copying.
 */
function publish(staging: string, to: string): void {
  try {
    renameSync(staging, to);
  } catch (error) {
    throw new Refused(
      `${to} could not be created: ${message(error)}`,
      `nothing was published and the originals are untouched. If ${to} now ` +
        "holds files, something else created it while this ran",
    );
  }
}

// --- reporting ---------------------------------------------------------------

/** A size a person reads rather than counts. */
function size(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} kB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderRefusals(refusals: Refusal[]): string {
  let text = "";
  for (const refusal of refusals) {
    text += `refused  ${refusal.reason}\n         → ${refusal.remedy}\n`;
  }
  return text;
}

/**
 * The retained originals, and the sentence that has to come with them.
 *
 * "content unchanged" rather than "unchanged": copying a database means opening
 * it, and closing a read-write connection to one whose last writer crashed
 * makes SQLite fold the leftover write-ahead log into the file. No row changes
 * — it is the same fold `ub status` performs on the same file — but the bytes
 * do, and a report that claimed otherwise would be wrong for exactly the
 * machines this command exists for.
 */
function renderSources(from: { configDir: string; dataDir: string }): string {
  return (
    "\nThe originals are retained, content unchanged, and no longer read:\n" +
    `  ${from.configDir}\n  ${from.dataDir}\n` +
    "Check the migrated copies first — `ub status`, `ub doctor`,\n" +
    "`ub workspace list` — and only then remove them yourself. Nothing here\n" +
    "deletes anything.\n"
  );
}

export function renderMigration(report: MigrationReport): string {
  let text = `uberblick ${report.version}\n\n`;

  if (report.state === "nothing-to-migrate") {
    return `${text}nothing to migrate: this machine already keeps its files in ${report.to}\n`;
  }
  if (report.state === "already-migrated") {
    text += `already migrated to ${report.to}\n`;
    for (const file of report.receipt?.files ?? []) {
      text += `  ${file.target}\n`;
    }
    return report.from === null ? text : text + renderSources(report.from);
  }
  if (report.state === "refused") {
    return text + renderRefusals(report.refusals);
  }

  text += report.dryRun ? "would migrate\n" : "migrated\n";
  text += `  from  ${report.from?.configDir ?? "?"}\n`;
  text += `        ${report.from?.dataDir ?? "?"}\n`;
  text += `    to  ${report.to}\n\n`;
  // Destination above source, indented under it: the question a person is
  // checking is "did the right file end up in the right place", and the
  // destination is the half they have not seen before.
  const written = new Map(report.migrated.map((file) => [file.target, file]));
  for (const copy of report.copies) {
    const file = written.get(copy.target);
    text += `  ${copy.target}${file === undefined ? "" : `  (${size(file.bytes)})`}\n`;
    text += `      ← ${copy.source}\n`;
  }
  const hub =
    report.hub === null
      ? "no local hub database was moved — none was found in the\nlayout and none was named with --hub-db"
      : `the hub database from\n${report.hub}`;
  text += `\n${report.workspaces} workspace${report.workspaces === 1 ? "" : "s"}, and ${hub}\n`;

  if (report.dryRun) {
    text +=
      "\nNothing was written: this is a dry run, and it does not open a\n" +
      "database — opening one folds a leftover write-ahead log into it. The\n" +
      "run itself opens every database exclusively (anything else holding one\n" +
      "open refuses the run), checks its integrity, checks each replica's\n" +
      "recorded workspace against its filename, and verifies every copy\n" +
      "before it publishes anything.\n";
    return text;
  }
  return report.from === null ? text : text + renderSources(report.from);
}

// --- the command -------------------------------------------------------------

/** Exported so the help below can be checked against the parser it describes. */
export const MIGRATE_OPTIONS = {
  "hub-db": { type: "string" },
  "dry-run": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
} as const;

export const MIGRATE_HELP = `usage: ub storage migrate [--hub-db <path>] [--dry-run] [--json]

Move a macOS installation that still keeps its files in the old XDG defaults
(~/.config/uberblick, ~/.local/share/uberblick) into ${MAC_ROOT_DISPLAY}.

Everything is copied — never moved — and the originals are left exactly as they
were, so the whole operation is undone by removing the new root. Databases go
through SQLite's own backup, which carries the write-ahead log a file copy would
lose; a database another process has open refuses the run rather than risking a
torn copy. The new root is published in one atomic step, after every copy has
been verified.

Close anything using uberblick first: MCP clients, \`ub open\`, a hub, the web
app.

options:
  --hub-db <path>   also migrate this hub database, as data/hub.sqlite. In a
                    checkout that is the file mise's HUB_DB_PATH points at.
                    Nothing is searched for or guessed: with no --hub-db and no
                    hub database in the layout, no local hub is moved
  --dry-run         print the exact paths, counts and refusals; write nothing
  --json            the same report as JSON on stdout, for a script to read
  -h, --help        show this help

The hub signing secret is copied but never printed, and a credentials.json other
users can read refuses the run instead of carrying that exposure over.
`;

export const STORAGE_HELP = `usage: ub storage <command>

commands:
  migrate [options]      move a legacy macOS installation into
                         ${MAC_ROOT_DISPLAY}

options:
  -h, --help             show this help; after a command, that command's help
`;

async function migrateCommand(argv: string[], io: Io): Promise<number> {
  if (takeHelp(argv, io, MIGRATE_HELP)) return 0;

  let values: {
    "hub-db"?: string | undefined;
    "dry-run"?: boolean | undefined;
    json?: boolean | undefined;
  };
  try {
    values = parseArgs({
      args: argv,
      options: MIGRATE_OPTIONS,
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`ub storage migrate: ${message(error)}\n`);
    return 2;
  }

  const dryRun = values["dry-run"] === true;
  const options: MigrateOptions = { hubDb: values["hub-db"] };
  const report: MigrationReport = dryRun
    ? { ...planMigration(options), version: cliVersion(), dryRun: true, migrated: [] }
    : await runMigration(options);

  io.out(
    values.json === true
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMigration(report),
  );
  return report.state === "refused" ? 1 : 0;
}

export async function storageCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  // The subcommand first, so `ub storage migrate --help` reaches the leaf's own
  // help rather than being answered by the group — the rule every group here
  // follows.
  const [sub, ...rest] = argv;
  if (sub === "migrate") {
    return await migrateCommand(rest, io);
  }
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    io.out(STORAGE_HELP);
    return 0;
  }
  io.err(`ub storage: unknown command ${JSON.stringify(sub)}\n\n${STORAGE_HELP}`);
  return 2;
}
