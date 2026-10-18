import type { DatabaseSync } from "node:sqlite";

export const CREDENTIAL_SCHEMA = `CREATE TABLE IF NOT EXISTS hub_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT,
  workspaces TEXT NOT NULL,
  public_key BLOB CHECK(public_key IS NULL OR length(public_key) = 32),
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER,
  replaced_at INTEGER
)`;

/** Run on every database open, including a restored database without sign-in configured. */
export function revokeHmacCredentials(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(hub_credentials)").all();
  if (!columns.some((column) => column.name === "signing_key")) return;
  const deviceName = columns.some((column) => column.name === "device_name") ? "device_name" : "NULL";
  const replacedAt = columns.some((column) => column.name === "replaced_at") ? "replaced_at" : "NULL";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE hub_credentials RENAME TO hub_hmac_credentials");
    db.exec(CREDENTIAL_SCHEMA);
    // Keep insertion order: it identifies each device's first sign-in.
    db.prepare(`INSERT INTO hub_credentials
      (id, principal_id, device_id, device_name, workspaces, issued_at, revoked_at, replaced_at)
      SELECT id, principal_id, device_id, ${deviceName}, workspaces, issued_at,
        COALESCE(revoked_at, $now), ${replacedAt} FROM hub_hmac_credentials ORDER BY rowid`)
      .run({ now: Date.now() });
    db.exec("DROP TABLE hub_hmac_credentials");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
