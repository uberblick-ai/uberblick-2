import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { adminSocketPath } from "./admin-setup.js";

const PRIVATE_ACCESS_TABLES = [
  "hub_principals",
  "hub_credentials",
  "hub_memberships",
  "hub_admin_setup_grants",
  "hub_claim_state",
];

/** Check every returned row: a damaged database can report multiple problems. */
export function checkDatabaseIntegrity(database: DatabaseSync): void {
  const verdicts = database.prepare("PRAGMA integrity_check").all();
  if (verdicts.length !== 1 || Object.values(verdicts[0] ?? {})[0] !== "ok") {
    throw new Error(`integrity_check failed: ${verdicts.map((row) => Object.values(row)[0]).join("; ")}`);
  }
}

function verifyCandidate(path: string): void {
  // SQLite skips CHECK constraints on a read-only handle; this path is a private copy.
  const database = new DatabaseSync(path);
  try {
    checkDatabaseIntegrity(database);
    const hasDocuments = database.prepare("SELECT 1 FROM documents LIMIT 1").get() !== undefined;
    const hasAccessState = PRIVATE_ACCESS_TABLES.some((table) =>
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined &&
      database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined,
    );
    if (!hasDocuments && !hasAccessState) {
      throw new Error("the hub has no documents or private access state, so this empty backup would restore nothing");
    }
  } finally {
    database.close();
  }
}

function syncFile(path: string): void {
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
}

/** The shared connection remains usable while SQLite copies its committed state. */
export async function backupDatabase(
  database: DatabaseSync,
  databasePath: string,
  signal?: AbortSignal,
  beforePublish?: () => void,
): Promise<string> {
  signal?.throwIfAborted();
  const directory = dirname(resolve(databasePath));
  const stageDirectory = mkdtempSync(join(directory, ".hub-backup-"));
  const stage = join(stageDirectory, "database.sqlite");
  const published = join(directory, `hub-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.sqlite`);
  try {
    closeSync(openSync(stage, "wx", 0o600));
    await backup(database, stage, { progress: () => signal?.throwIfAborted() });
    signal?.throwIfAborted();
    // Verify the copy on its own handle; never open a second writer to the live file.
    const copy = new DatabaseSync(stage);
    try { checkDatabaseIntegrity(copy); } finally { copy.close(); }
    chmodSync(stage, 0o600);
    syncFile(stage);
    beforePublish?.();
    signal?.throwIfAborted();
    // A hard link publishes the verified file atomically and refuses an existing name.
    linkSync(stage, published);
    return published;
  } finally {
    try { rmSync(stageDirectory, { recursive: true, force: true }); } catch { /* inert temporary copy */ }
  }
}

/** Preserve all SQLite sidecars as one unit rather than guessing which are expendable. */
export function hasRollbackJournal(databasePath: string): boolean {
  try {
    return readdirSync(dirname(databasePath)).some((name) => name.startsWith(`${basename(databasePath)}-`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Only an absent/refused socket proves there is no answering hub; other errors refuse. */
export async function probeRunningHub(
  databasePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  return new Promise<boolean>((accept, reject) => {
    const socket = createConnection({ path: adminSocketPath(databasePath) });
    let ended = false;
    const finish = (error: unknown, running?: boolean) => {
      if (ended) return;
      ended = true;
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      if (error !== undefined) reject(error); else accept(running === true);
    };
    const cancel = () => finish(signal?.reason ?? new Error("interrupted"));
    signal?.addEventListener("abort", cancel, { once: true });
    socket.setTimeout(1000, () => finish(new Error("the hub control socket did not answer; stop the hub with docker compose stop hub before restoring")));
    socket.once("connect", () => finish(undefined, true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish(undefined, false);
      else finish(new Error(`could not check the hub control socket: ${error.message}; run docker compose stop hub before restoring`, { cause: error }));
    });
  });
}

async function refuseUnsafeRestore(databasePath: string, signal?: AbortSignal): Promise<void> {
  if (await probeRunningHub(databasePath, signal)) {
    throw new Error("a running hub serves this database; run docker compose stop hub before restoring");
  }
  if (hasRollbackJournal(databasePath)) {
    throw new Error("there is a rollback journal beside the hub database; let SQLite recover it by running docker compose start hub, then docker compose stop hub, and retry restore");
  }
}

/** Validate outside the volume, then replace only a complete private file with one rename. */
export async function restoreDatabase(
  databasePath: string,
  input: string | NodeJS.ReadableStream,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = options;
  signal?.throwIfAborted();
  const checkDirectory = mkdtempSync(join(tmpdir(), "ub-hub-restore-"));
  const candidate = join(checkDirectory, "candidate.sqlite");
  let stage: string | undefined;
  let replaced = false;
  try {
    await pipeline(
      typeof input === "string" ? createReadStream(input) : input,
      createWriteStream(candidate, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    signal?.throwIfAborted();
    verifyCandidate(candidate);
    await refuseUnsafeRestore(databasePath, signal);
    stage = join(dirname(resolve(databasePath)), `.hub-restoring-${randomUUID()}.sqlite`);
    await pipeline(createReadStream(candidate), createWriteStream(stage, { flags: "wx", mode: 0o600 }), { signal });
    signal?.throwIfAborted();
    chmodSync(stage, 0o600);
    verifyCandidate(stage);
    syncFile(stage);
    await refuseUnsafeRestore(databasePath, signal);
    signal?.throwIfAborted();
    renameSync(stage, databasePath);
    replaced = true;
    stage = undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; ${replaced ? "the database was replaced" : "the live database was unchanged"}`, { cause: error });
  } finally {
    try { if (stage !== undefined) rmSync(stage, { force: true }); } catch { /* inert staging file */ }
    try { rmSync(checkDirectory, { recursive: true, force: true }); } catch { /* outside the data volume */ }
  }
}
