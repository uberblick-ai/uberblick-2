import { randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { adminSocketPath } from "./admin-setup.js";
import { restoreAccessChanges, writeAccessRecovery } from "./operator-restore-access.js";
import { checkDatabaseIntegrity, syncDatabaseFile } from "./database-backup.js";

export { backupDatabase, checkDatabaseIntegrity } from "./database-backup.js";

const PRIVATE_ACCESS_TABLES = [
  "hub_principals",
  "hub_credentials",
  "hub_memberships",
  "hub_admin_setup_grants",
  "hub_claim_state",
];

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
  options: {
    signal?: AbortSignal;
    yes?: boolean;
    writeLine?: (line: string) => void;
    confirm?: (signal?: AbortSignal) => Promise<boolean>;
  } = {},
): Promise<void> {
  const { signal, writeLine = console.log } = options;
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
    const changes = restoreAccessChanges(databasePath, candidate, join(checkDirectory, "live.sqlite"));
    if (changes === undefined) {
      writeLine("Newer device revocations, workspace member removals and hub-admin removals can't be determined: the live database is absent or can't be read.");
      writeAccessRecovery(writeLine);
    } else if (changes.length === 0) {
      writeLine("Nothing would be undone: no device revocations, workspace member removals or hub-admin removals.");
    } else {
      writeLine("This restore would undo:");
      for (const change of changes) writeLine(`- ${change}`);
      writeAccessRecovery(writeLine);
      if (!options.yes && !await options.confirm?.(signal)) {
        throw new Error("restore was not confirmed; confirm at a terminal or rerun ub-hub restore --yes <file|->");
      }
    }
    signal?.throwIfAborted();
    stage = join(dirname(resolve(databasePath)), `.hub-restoring-${randomUUID()}.sqlite`);
    await pipeline(createReadStream(candidate), createWriteStream(stage, { flags: "wx", mode: 0o600 }), { signal });
    signal?.throwIfAborted();
    chmodSync(stage, 0o600);
    verifyCandidate(stage);
    syncDatabaseFile(stage);
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
