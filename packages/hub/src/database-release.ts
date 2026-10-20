import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { HubLogger } from "./log.js";
import { backupDatabase } from "./database-backup.js";

/** Published images use only stable MAJOR.MINOR.PATCH versions. */
function releaseParts(version: string): [bigint, bigint, bigint] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`invalid hub database release version: ${version}`);
  }
  const [major = "", minor = "", patch = ""] = version.split(".");
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

/** Read-only until a verified copy has been published and its path logged. */
export async function prepareDatabaseRelease(databasePath: string, version: string, log: HubLogger): Promise<void> {
  const current = releaseParts(version);
  if (!existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (tables.length === 0) return;
    let previous: string | null = null;
    if (tables.some(row => row.name === "hub_release")) {
      const rows = database.prepare("SELECT version FROM hub_release").all();
      if (rows.length !== 1 || typeof rows[0]?.version !== "string") {
        throw new Error("invalid hub database release record; the database was unchanged");
      }
      previous = rows[0].version;
      const recorded = releaseParts(previous);
      for (const index of [0, 1, 2] as const) {
        if (recorded[index] > current[index]) {
          throw new Error(`this database was last written by hub release ${previous}; run hub release ${previous} instead; the database was unchanged`);
        }
        if (recorded[index] < current[index]) break;
        if (index === 2) return;
      }
    }
    let path: string;
    try {
      path = await backupDatabase(database, databasePath);
    } catch (error) {
      throw new Error(`cannot back up the database before hub release ${version}: ${String(error)}; the database was unchanged`, { cause: error });
    }
    log({ event: "hub.database.backup", database: databasePath, backup: path, previousRelease: previous, release: version });
  } finally {
    database.close();
  }
}

/** The release record is the first write, before any core or registry migration. */
export function writeDatabaseRelease(database: DatabaseSync, version: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("CREATE TABLE IF NOT EXISTS hub_release (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL)");
    database.prepare("INSERT INTO hub_release (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version").run(version);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
