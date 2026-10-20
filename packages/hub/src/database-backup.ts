import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/** Check every returned row: a damaged database can report multiple problems. */
export function checkDatabaseIntegrity(database: DatabaseSync): void {
  const verdicts = database.prepare("PRAGMA integrity_check").all();
  if (verdicts.length !== 1 || Object.values(verdicts[0] ?? {})[0] !== "ok") {
    throw new Error(`integrity_check failed: ${verdicts.map((row) => Object.values(row)[0]).join("; ")}`);
  }
}

export function syncDatabaseFile(path: string): void {
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
    syncDatabaseFile(stage);
    beforePublish?.();
    signal?.throwIfAborted();
    // A hard link publishes the verified file atomically and refuses an existing name.
    linkSync(stage, published);
    return published;
  } finally {
    try { rmSync(stageDirectory, { recursive: true, force: true }); } catch { /* inert temporary copy */ }
  }
}
