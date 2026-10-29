import type { StatementSync } from "node:sqlite";
import { parseWorkspaceId } from "@uberblick/schema";
import { isTokenScope, type TokenScope } from "@uberblick/schema/token";
import { MembershipRegistry } from "./memberships.js";
import type { HubDatabase } from "./persistence.js";

export interface AgentGrantRecord {
  id: string;
  clientId: string;
  clientName: string;
  principalId: string;
  workspaceId: string;
  scope: TokenScope;
  deviceId: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface CreateAgentGrantRequest {
  clientId: string;
  clientName: string;
  principalId: string;
  workspaceId: string;
  scope: TokenScope;
}

function fromRow(row: Record<string, unknown>): AgentGrantRecord {
  return {
    id: row.id as string,
    clientId: row.client_id as string,
    clientName: row.client_name as string,
    principalId: row.principal_id as string,
    workspaceId: row.workspace_id as string,
    scope: row.scope as TokenScope,
    deviceId: row.device_id as string,
    createdAt: row.created_at as number,
    revokedAt: row.revoked_at as number | null,
  };
}

/** Consent grants are private hub data; one persisted device identity follows each grant. */
export class AgentGrantRegistry {
  private readonly insert: StatementSync;
  private readonly select: StatementSync;
  private readonly selectDevice: StatementSync;
  private readonly selectPrincipal: StatementSync;
  private readonly markRevoked: StatementSync;
  private readonly memberships: MembershipRegistry;

  constructor(database: HubDatabase, private readonly now: () => number = Date.now) {
    const db = database.connection;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_agent_grants (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL CHECK(length(client_id) > 0),
      client_name TEXT NOT NULL CHECK(length(client_name) > 0),
      principal_id TEXT NOT NULL CHECK(length(principal_id) > 0),
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('read-only', 'read-write')),
      device_id TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
    const columns = db.prepare("PRAGMA table_info(hub_agent_grants)").all();
    if (!columns.some(column => column.name === "created_at")) {
      // Older grants did not record consent time; zero retains that unknown date.
      db.exec("ALTER TABLE hub_agent_grants ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    }
    this.memberships = new MembershipRegistry(database);
    this.insert = db.prepare(`INSERT INTO hub_agent_grants
      (id, client_id, client_name, principal_id, workspace_id, scope, device_id, created_at)
      VALUES ($id, $clientId, $clientName, $principalId, $workspaceId, $scope, $deviceId, $createdAt)
      RETURNING *`);
    this.select = db.prepare("SELECT * FROM hub_agent_grants WHERE id = $id");
    this.selectDevice = db.prepare(`SELECT * FROM hub_agent_grants
      WHERE principal_id = $principalId AND device_id = $deviceId`);
    this.selectPrincipal = db.prepare(`SELECT * FROM hub_agent_grants
      WHERE principal_id = $principalId AND revoked_at IS NULL ORDER BY device_id`);
    this.markRevoked = db.prepare(`UPDATE hub_agent_grants SET revoked_at = $revokedAt
      WHERE id = $id AND revoked_at IS NULL`);
  }

  /** The consent caller may commit this insert with its other changes on the shared handle. */
  create(request: CreateAgentGrantRequest): AgentGrantRecord {
    if (typeof request.clientId !== "string" || request.clientId === "" ||
      typeof request.clientName !== "string" || request.clientName === "" ||
      typeof request.principalId !== "string" || request.principalId === "") {
      throw new Error("AgentGrantRegistry.create: clientId, clientName and principalId must not be empty");
    }
    try {
      if (parseWorkspaceId(request.workspaceId).uuid !== request.workspaceId) throw new Error();
    } catch {
      throw new Error("AgentGrantRegistry.create: workspaceId must be a bare UUID");
    }
    if (!isTokenScope(request.scope)) {
      throw new Error("AgentGrantRegistry.create: scope must be read-only or read-write");
    }
    const row = this.insert.get({ id: crypto.randomUUID(), clientId: request.clientId, clientName: request.clientName,
      principalId: request.principalId, workspaceId: request.workspaceId, scope: request.scope,
      deviceId: crypto.randomUUID(), createdAt: this.now() });
    if (row === undefined) throw new Error("AgentGrantRegistry.create: grant was not persisted");
    return fromRow(row);
  }

  get(id: string): AgentGrantRecord | null {
    const row = this.select.get({ id });
    return row === undefined ? null : fromRow(row);
  }

  getForDevice(principalId: string, deviceId: string): AgentGrantRecord | null {
    const row = this.selectDevice.get({ principalId, deviceId });
    return row === undefined ? null : fromRow(row);
  }

  /** Own-device management remains available after workspace membership ends. */
  listForPrincipal(principalId: string): AgentGrantRecord[] {
    return this.selectPrincipal.all({ principalId }).map(fromRow);
  }

  isLive(id: string): boolean {
    const grant = this.get(id);
    return grant !== null && grant.revokedAt === null &&
      this.memberships.roleFor(grant.workspaceId, grant.principalId) !== null;
  }

  /** Storage mutation; end access through CredentialRegistry.revokeDevice to include credentials and rooms. */
  revoke(id: string): boolean {
    return this.markRevoked.run({ id, revokedAt: this.now() }).changes > 0;
  }
}
