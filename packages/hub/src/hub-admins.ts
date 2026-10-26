/** Hub authority and inventory live only in the hub's private database. */
import { parseWorkspaceId, validateWorkspaceName } from "@uberblick/schema";
import type { HubDatabase } from "./persistence.js";
import { WorkspaceNameReader } from "./workspace-names.js";

export class HubAdminRefusal extends Error {
  constructor(readonly code: "hub-admin-required" | "self-admin" | "last-admin" | "admin-not-found" | "workspace-not-found" | "invalid-request") {
    super(`Hub administration: ${code}`);
    this.name = "HubAdminRefusal";
  }
}

export interface HubAdminRecord {
  principalId: string;
  githubAccountId: string;
  githubUsername: string;
  workspaces: number;
  lastSignedInAt: number | null;
  current: boolean;
}

export interface HubWorkspaceRecord {
  workspaceId: string;
  status: "active" | "suspended";
  name?: string;
  members: number;
  admins: string[];
}

const PAGE_BYTES = 49_152;
// Reserve the envelope and maximum cursor size before adding public rows.
const ROW_BYTES = PAGE_BYTES - 256;

function encodeCursor(position: number[]): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function readCursor(cursor: string | undefined, fields: 1 | 2): [number, number] {
  if (cursor === undefined) return [0, 0];
  try {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(cursor)) throw new Error();
    const position: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(position) || position.length !== fields ||
        !position.every(value => Number.isSafeInteger(value) && value >= 0) || encodeCursor(position) !== cursor) throw new Error();
    return [position[0] as number, fields === 2 ? position[1] as number : 0];
  } catch {
    throw new HubAdminRefusal("invalid-request");
  }
}

export class HubAdminRegistry {
  private readonly suspendListeners = new Set<(workspaceId: string) => void>();

  constructor(private readonly database: HubDatabase,
    private readonly workspaceNames = new WorkspaceNameReader(database)) {
    database.connection.exec(`CREATE TABLE IF NOT EXISTS hub_admins (
      principal_id TEXT PRIMARY KEY NOT NULL CHECK(length(principal_id) > 0)
    )`);
    database.connection.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_suspensions (
      workspace_id TEXT PRIMARY KEY NOT NULL
    )`);
  }

  /** Internal role grant; no client route calls this. */
  grant(principalId: string): void {
    if (typeof principalId !== "string" || principalId === "") throw new Error("Hub administration: principal is required");
    this.database.connection.prepare("INSERT INTO hub_admins (principal_id) VALUES (?) ON CONFLICT DO NOTHING").run(principalId);
  }

  isAdmin(principalId: string): boolean {
    return this.database.connection.prepare("SELECT 1 FROM hub_admins WHERE principal_id = ?").get(principalId) !== undefined;
  }

  requireAdmin(principalId: string): void {
    if (!this.isAdmin(principalId)) throw new HubAdminRefusal("hub-admin-required");
  }

  isSuspended(workspaceId: string): boolean {
    return this.database.connection.prepare("SELECT 1 FROM hub_workspace_suspensions WHERE workspace_id = ?")
      .get(workspaceId) !== undefined;
  }

  availableWorkspaces(workspaces: readonly string[]): string[] {
    return workspaces.filter(workspaceId => !this.isSuspended(workspaceId));
  }

  /** Commit before fencing every room. A retry repeats closure after a listener failure. */
  setWorkspaceStatus(workspaceId: string, status: "active" | "suspended"): void {
    if (!this.workspaceIds().includes(workspaceId)) throw new HubAdminRefusal("workspace-not-found");
    const db = this.database.connection;
    if (status === "active") {
      db.prepare("DELETE FROM hub_workspace_suspensions WHERE workspace_id = ?").run(workspaceId);
      return;
    }
    if (status !== "suspended") throw new HubAdminRefusal("invalid-request");
    db.prepare("INSERT INTO hub_workspace_suspensions (workspace_id) VALUES (?) ON CONFLICT DO NOTHING").run(workspaceId);
    const failures: unknown[] = [];
    for (const listener of this.suspendListeners) {
      try { listener(workspaceId); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Hub administration: suspension closure failed");
  }

  onSuspend(listener: (workspaceId: string) => void): () => void {
    this.suspendListeners.add(listener);
    return () => this.suspendListeners.delete(listener);
  }

  listAdmins(actorPrincipalId: string): HubAdminRecord[] {
    return this.database.connection.prepare(`SELECT admin.principal_id, principal.github_account_id, principal.github_username,
      (SELECT COUNT(*) FROM hub_memberships WHERE principal_id = admin.principal_id) AS workspaces,
      (SELECT history.issued_at FROM hub_credentials AS history
        WHERE history.principal_id = admin.principal_id AND history.rowid IN
          (SELECT MIN(original.rowid) FROM hub_credentials AS original
            WHERE original.principal_id = admin.principal_id GROUP BY original.device_id)
        ORDER BY history.rowid DESC LIMIT 1) AS last_signed_in_at
      FROM hub_admins AS admin JOIN hub_principals AS principal ON principal.id = admin.principal_id
      ORDER BY principal.github_username, admin.principal_id`).all().map(row => ({
      principalId: row.principal_id as string,
      githubAccountId: row.github_account_id as string,
      githubUsername: row.github_username as string,
      workspaces: row.workspaces as number,
      lastSignedInAt: row.last_signed_in_at as number | null,
      current: row.principal_id === actorPrincipalId,
    }));
  }

  pageAdmins(actorPrincipalId: string, cursor?: string): { admins: HubAdminRecord[]; nextCursor: string | null } {
    const rows = this.listAdmins(actorPrincipalId);
    let [index] = readCursor(cursor, 1);
    if (index > rows.length) throw new HubAdminRefusal("invalid-request");
    const admins: HubAdminRecord[] = [];
    let bytes = 0;
    for (; index < rows.length; index++) {
      const row = rows[index];
      if (row === undefined) break;
      const size = Buffer.byteLength(JSON.stringify(row)) + (admins.length > 0 ? 1 : 0);
      if (bytes + size > ROW_BYTES) break;
      admins.push(row);
      bytes += size;
    }
    if (admins.length === 0 && index < rows.length) throw new Error("Hub administration: admin row exceeds page bound");
    return { admins, nextCursor: index === rows.length ? null : encodeCursor([index]) };
  }

  /** Protect self-removal and the last admin in the removal transaction. */
  remove(actorPrincipalId: string, principalId: string): void {
    const db = this.database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (actorPrincipalId === principalId) throw new HubAdminRefusal("self-admin");
      if (!this.isAdmin(principalId)) throw new HubAdminRefusal("admin-not-found");
      if ((db.prepare("SELECT COUNT(*) AS count FROM hub_admins").get()?.count as number) <= 1) {
        throw new HubAdminRefusal("last-admin");
      }
      db.prepare("DELETE FROM hub_admins WHERE principal_id = ?").run(principalId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  listWorkspaces(): HubWorkspaceRecord[] {
    const db = this.database.connection;
    return this.workspaceIds().map(workspaceId => {
      let name: string | undefined;
      const storedName = this.workspaceNames.read(workspaceId);
      try {
        if (storedName !== null && validateWorkspaceName(storedName) === storedName) name = storedName;
      } catch { /* Invalid display data leaves the workspace unnamed. */ }
      const members = db.prepare("SELECT COUNT(*) AS count FROM hub_memberships WHERE workspace_id = ?").get(workspaceId)?.count as number;
      const admins = db.prepare(`SELECT principal.github_username FROM hub_memberships AS member
        JOIN hub_principals AS principal ON principal.id = member.principal_id
        WHERE member.workspace_id = ? AND member.role = 'admin' ORDER BY principal.github_username, principal.id`)
        .all(workspaceId).map(admin => admin.github_username as string);
      return { workspaceId, status: this.isSuspended(workspaceId) ? "suspended" : "active",
        ...(name === undefined ? {} : { name }), members, admins };
    });
  }

  hasWorkspace(workspaceId: string): boolean {
    return this.workspaceIds().includes(workspaceId);
  }

  private workspaceIds(): string[] {
    const db = this.database.connection;
    const sources = ["SELECT substr(name, 1, instr(name, '/') - 1) AS workspace_id FROM documents WHERE instr(name, '/') > 0"];
    for (const table of ["hub_memberships", "hub_workspace_promotions", "hub_admin_setup_grants", "hub_workspace_suspensions"] as const) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined) {
        sources.push(`SELECT workspace_id FROM ${table}`);
      }
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hub_claim_state'").get() !== undefined) {
      sources.push("SELECT default_workspace_id AS workspace_id FROM hub_claim_state WHERE default_workspace_id IS NOT NULL");
    }
    return db.prepare(sources.join(" UNION ")).all().flatMap(row => {
      const workspaceId = row.workspace_id as string;
      try { if (parseWorkspaceId(workspaceId).uuid !== workspaceId) return []; }
      catch { return []; }
      return [workspaceId];
    }).sort((left, right) => left.localeCompare(right));
  }

  pageWorkspaces(cursor?: string): { workspaces: HubWorkspaceRecord[]; nextCursor: string | null } {
    const rows = this.listWorkspaces();
    let [index, offset] = readCursor(cursor, 2);
    if (index > rows.length || offset > (rows[index]?.admins.length ?? 0)) throw new HubAdminRefusal("invalid-request");
    const workspaces: HubWorkspaceRecord[] = [];
    let bytes = 0;
    for (; index < rows.length; index++) {
      const row = rows[index];
      if (row === undefined) break;
      const fragment = { ...row, admins: [] as string[] };
      let size = Buffer.byteLength(JSON.stringify(fragment)) + (workspaces.length > 0 ? 1 : 0);
      if (bytes + size > ROW_BYTES) break;
      let end = offset;
      for (; end < row.admins.length; end++) {
        const handle = row.admins[end];
        if (handle === undefined) break;
        const handleBytes = Buffer.byteLength(JSON.stringify(handle)) + (end > offset ? 1 : 0);
        if (bytes + size + handleBytes > ROW_BYTES) break;
        fragment.admins.push(handle);
        size += handleBytes;
      }
      if (end === offset && offset < row.admins.length) break;
      workspaces.push(fragment);
      bytes += size;
      if (end < row.admins.length) {
        offset = end;
        break;
      }
      offset = 0;
    }
    if (workspaces.length === 0 && index < rows.length) throw new Error("Hub administration: workspace row exceeds page bound");
    return { workspaces, nextCursor: index === rows.length ? null : encodeCursor([index, offset]) };
  }
}
