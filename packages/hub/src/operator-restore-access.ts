import { copyFileSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DEVICE_CREDENTIAL_LIFETIME_MS } from "@uberblick/schema/token";

type AccessTable = "hub_principals" | "hub_credentials" | "hub_memberships" | "hub_admins";

function columns(database: DatabaseSync, table: AccessTable): Set<string> {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
}

function compareAccess(live: DatabaseSync, backup: DatabaseSync): string[] {
  const changes: string[] = [];
  const principals = new Map<string, string>();
  for (const database of [backup, live]) {
    if (columns(database, "hub_principals").size === 0) continue;
    for (const row of database.prepare("SELECT id, github_username, github_account_id FROM hub_principals").all()) {
      principals.set(String(row.id), `${JSON.stringify(row.github_username)} (GitHub account ${row.github_account_id})`);
    }
  }
  const account = (id: string) => {
    const identity = principals.get(id);
    if (identity === undefined) throw new Error("access record has no account identity");
    return identity;
  };

  const credentialColumns = columns(backup, "hub_credentials");
  if (columns(live, "hub_credentials").size > 0 && credentialColumns.has("public_key") &&
      !credentialColumns.has("signing_key")) {
    const revoked = new Set(live.prepare("SELECT id FROM hub_credentials WHERE revoked_at IS NOT NULL").all().map(row => row.id));
    const deviceName = credentialColumns.has("device_name") ? "device_name" : "NULL AS device_name";
    const replaced = credentialColumns.has("replaced_at") ? "AND replaced_at IS NULL" : "";
    const devices = new Set<string>();
    const credentials = backup.prepare(`SELECT id, principal_id, device_id, ${deviceName} FROM hub_credentials
      WHERE typeof(public_key) = 'blob' AND length(public_key) = 32
        AND revoked_at IS NULL ${replaced} AND issued_at > ?
      ORDER BY principal_id, device_id, id`).all(Date.now() - DEVICE_CREDENTIAL_LIFETIME_MS);
    for (const row of credentials) {
      const device = JSON.stringify([row.principal_id, row.device_id]);
      if (!revoked.has(row.id) || devices.has(device)) continue;
      devices.add(device);
      const name = row.device_name ? `${JSON.stringify(row.device_name)} (${row.device_id})` : String(row.device_id);
      changes.push(`device revocation: ${account(String(row.principal_id))}, device ${name}`);
    }
  }

  if (columns(live, "hub_memberships").size > 0 && columns(backup, "hub_memberships").size > 0) {
    const key = (row: Record<string, unknown>) => JSON.stringify([row.principal_id, row.workspace_id]);
    const memberships = new Set(live.prepare("SELECT principal_id, workspace_id FROM hub_memberships").all().map(key));
    for (const row of backup.prepare("SELECT principal_id, workspace_id FROM hub_memberships ORDER BY principal_id, workspace_id").all()) {
      if (!memberships.has(key(row))) {
        changes.push(`workspace member removal: ${account(String(row.principal_id))}, workspace ${row.workspace_id}`);
      }
    }
  }

  if (columns(live, "hub_admins").size > 0 && columns(backup, "hub_admins").size > 0) {
    const admins = new Set(live.prepare("SELECT principal_id FROM hub_admins").all().map(row => row.principal_id));
    for (const row of backup.prepare("SELECT principal_id FROM hub_admins ORDER BY principal_id").all()) {
      if (!admins.has(row.principal_id)) changes.push(`hub-admin removal: ${account(String(row.principal_id))}`);
    }
  }
  return changes;
}

/** Compare private copies: even a read-only SQLite WAL handle can create sidecars. */
export function restoreAccessChanges(livePath: string, backupPath: string, copyPath: string): string[] | undefined {
  let live: DatabaseSync | undefined;
  let backup: DatabaseSync | undefined;
  try {
    copyFileSync(livePath, copyPath);
    chmodSync(copyPath, 0o600);
    live = new DatabaseSync(copyPath, { readOnly: true });
    backup = new DatabaseSync(backupPath, { readOnly: true });
    return compareAccess(live, backup);
  } catch {
    return undefined;
  } finally {
    backup?.close();
    live?.close();
  }
}

export function writeAccessRecovery(writeLine: (line: string) => void): void {
  writeLine("After starting the restored hub:");
  writeLine("- Each account revokes its own lost devices again through Settings → User → Devices or ub auth logout --all-devices <hub>.");
  writeLine("- Workspace admins remove members again through ub workspace member remove or Workspace settings → Members.");
  writeLine("- Hub admins remove hub admins again through Hub → Admins.");
}
