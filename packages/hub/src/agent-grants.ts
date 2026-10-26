import type { StatementSync } from "node:sqlite";
import { parseWorkspaceId } from "@uberblick/schema";
import { isTokenScope, type TokenScope } from "@uberblick/schema/token";
import type { HubDatabase } from "./persistence.js";

export interface AgentGrantRecord {
  id: string;
  clientId: string;
  principalId: string;
  workspaceId: string;
  scope: TokenScope;
  deviceId: string;
  revokedAt: number | null;
}

export interface CreateAgentGrantRequest {
  clientId: string;
  principalId: string;
  workspaceId: string;
  scope: TokenScope;
}

function fromRow(row: Record<string, unknown>): AgentGrantRecord {
  return {
    id: row.id as string,
    clientId: row.client_id as string,
    principalId: row.principal_id as string,
    workspaceId: row.workspace_id as string,
    scope: row.scope as TokenScope,
    deviceId: row.device_id as string,
    revokedAt: row.revoked_at as number | null,
  };
}

/** Consent grants are private hub data; one persisted device identity follows each grant. */
export class AgentGrantRegistry {
  private readonly insert: StatementSync;
  private readonly select: StatementSync;
  private readonly markRevoked: StatementSync;

  constructor(database: HubDatabase, private readonly now: () => number = Date.now) {
    const db = database.connection;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_agent_grants (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL CHECK(length(client_id) > 0),
      principal_id TEXT NOT NULL CHECK(length(principal_id) > 0),
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('read-only', 'read-write')),
      device_id TEXT UNIQUE NOT NULL,
      revoked_at INTEGER
    )`);
    this.insert = db.prepare(`INSERT INTO hub_agent_grants
      (id, client_id, principal_id, workspace_id, scope, device_id)
      VALUES ($id, $clientId, $principalId, $workspaceId, $scope, $deviceId)
      RETURNING *`);
    this.select = db.prepare("SELECT * FROM hub_agent_grants WHERE id = $id");
    this.markRevoked = db.prepare(`UPDATE hub_agent_grants SET revoked_at = $revokedAt
      WHERE id = $id AND revoked_at IS NULL`);
  }

  /** The consent caller may commit this insert with its other changes on the shared handle. */
  create(request: CreateAgentGrantRequest): AgentGrantRecord {
    if (typeof request.clientId !== "string" || request.clientId === "" ||
      typeof request.principalId !== "string" || request.principalId === "") {
      throw new Error("AgentGrantRegistry.create: clientId and principalId must not be empty");
    }
    try {
      if (parseWorkspaceId(request.workspaceId).uuid !== request.workspaceId) throw new Error();
    } catch {
      throw new Error("AgentGrantRegistry.create: workspaceId must be a bare UUID");
    }
    if (!isTokenScope(request.scope)) {
      throw new Error("AgentGrantRegistry.create: scope must be read-only or read-write");
    }
    const row = this.insert.get({ id: crypto.randomUUID(), clientId: request.clientId,
      principalId: request.principalId, workspaceId: request.workspaceId, scope: request.scope,
      deviceId: crypto.randomUUID() });
    if (row === undefined) throw new Error("AgentGrantRegistry.create: grant was not persisted");
    return fromRow(row);
  }

  get(id: string): AgentGrantRecord | null {
    const row = this.select.get({ id });
    return row === undefined ? null : fromRow(row);
  }

  revoke(id: string): boolean {
    return this.markRevoked.run({ id, revokedAt: this.now() }).changes > 0;
  }
}
