/** Hub-owned workspace access, outside synchronized document content. */

import type { StatementSync } from "node:sqlite";
import { parseWorkspaceId } from "@uberblick/schema";
import type { HubDatabase } from "./persistence.js";

export type MembershipRole = "admin" | "member";

export interface MembershipRecord {
  workspaceId: string;
  principalId: string;
  role: MembershipRole;
}

export interface ChangeMembershipRoleRequest extends MembershipRecord {
  actorPrincipalId: string;
}

export interface RemoveMembershipRequest {
  workspaceId: string;
  actorPrincipalId: string;
  principalId: string;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS hub_memberships (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL CHECK(length(principal_id) > 0),
  role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  PRIMARY KEY (workspace_id, principal_id)
)`;

function validateIdentity(workspaceId: string, principalId: string): void {
  try {
    if (parseWorkspaceId(workspaceId).uuid !== workspaceId) throw new Error();
  } catch {
    throw new Error("MembershipRegistry: workspaceId must be a bare UUID");
  }
  if (typeof principalId !== "string" || principalId === "") {
    throw new Error("MembershipRegistry: principalId must not be empty");
  }
}

function validateRole(role: MembershipRole): void {
  if (role !== "admin" && role !== "member") {
    throw new Error("MembershipRegistry: role must be admin or member");
  }
}

/**
 * Only trusted hub callers grant a membership. Actor-facing operations cannot
 * add one, and read the actor's current authority from this database. Admission
 * and management must share this instance so removal reaches its subscribers.
 * Checks and each single-statement mutation stay synchronous on the hub's one
 * database connection, so another operation cannot interleave between them.
 * The live hub does not construct or install this authority yet.
 */
export class MembershipRegistry {
  private readonly insert: StatementSync;
  private readonly selectRole: StatementSync;
  private readonly selectMembers: StatementSync;
  private readonly countAdmins: StatementSync;
  private readonly updateRole: StatementSync;
  private readonly deleteMember: StatementSync;
  private readonly removeListeners = new Set<(workspaceId: string, principalId: string) => void>();

  constructor(database: HubDatabase) {
    const db = database.connection;
    db.exec(SCHEMA);
    this.insert = db.prepare(`
      INSERT INTO hub_memberships (workspace_id, principal_id, role)
      VALUES ($workspaceId, $principalId, $role)
    `);
    this.selectRole = db.prepare(`
      SELECT role FROM hub_memberships
      WHERE workspace_id = $workspaceId AND principal_id = $principalId
    `);
    this.selectMembers = db.prepare(`
      SELECT principal_id, role FROM hub_memberships
      WHERE workspace_id = $workspaceId ORDER BY principal_id
    `);
    this.countAdmins = db.prepare(`
      SELECT COUNT(*) AS count FROM hub_memberships
      WHERE workspace_id = $workspaceId AND role = 'admin'
    `);
    this.updateRole = db.prepare(`
      UPDATE hub_memberships SET role = $role
      WHERE workspace_id = $workspaceId AND principal_id = $principalId
    `);
    this.deleteMember = db.prepare(`
      DELETE FROM hub_memberships
      WHERE workspace_id = $workspaceId AND principal_id = $principalId
    `);
  }

  /** Internal grant for first-admin setup and invitation acceptance. */
  grant(record: MembershipRecord): void {
    validateIdentity(record.workspaceId, record.principalId);
    validateRole(record.role);
    // A duplicate grant never overwrites an existing role.
    this.insert.run({
      workspaceId: record.workspaceId,
      principalId: record.principalId,
      role: record.role,
    });
  }

  /** Internal admission lookup; neither role changes document access. */
  roleFor(workspaceId: string, principalId: string): MembershipRole | null {
    validateIdentity(workspaceId, principalId);
    return (this.selectRole.get({ workspaceId, principalId })?.role as MembershipRole | undefined) ?? null;
  }

  /** Reusable by invitation creation and other workspace access management. */
  requireAdmin(workspaceId: string, actorPrincipalId: string): void {
    if (this.roleFor(workspaceId, actorPrincipalId) !== "admin") {
      throw new Error("MembershipRegistry: workspace admin required");
    }
  }

  ownRole(workspaceId: string, actorPrincipalId: string): MembershipRole {
    const role = this.roleFor(workspaceId, actorPrincipalId);
    if (role === null) throw new Error("MembershipRegistry: workspace member required");
    return role;
  }

  listMembers(workspaceId: string, actorPrincipalId: string): MembershipRecord[] {
    this.requireAdmin(workspaceId, actorPrincipalId);
    return this.selectMembers.all({ workspaceId }).map((row) => ({
      workspaceId,
      principalId: row.principal_id as string,
      role: row.role as MembershipRole,
    }));
  }

  changeRole(request: ChangeMembershipRoleRequest): void {
    validateIdentity(request.workspaceId, request.principalId);
    validateRole(request.role);
    this.requireAdmin(request.workspaceId, request.actorPrincipalId);
    const previousRole = this.roleFor(request.workspaceId, request.principalId);
    if (previousRole === null) throw new Error("MembershipRegistry: member not found");
    if (request.role !== "admin") this.protectLastAdmin(request.workspaceId, previousRole);
    this.updateRole.run({
      workspaceId: request.workspaceId,
      principalId: request.principalId,
      role: request.role,
    });
  }

  /**
   * Commit removal before synchronously fencing and closing every subscriber.
   * Listener failures remain visible without restoring access. An authorized
   * retry on an absent member repeats closure to repair an earlier failure.
   */
  remove(request: RemoveMembershipRequest): boolean {
    validateIdentity(request.workspaceId, request.principalId);
    this.requireAdmin(request.workspaceId, request.actorPrincipalId);
    const previousRole = this.roleFor(request.workspaceId, request.principalId);
    this.protectLastAdmin(request.workspaceId, previousRole);
    const changed = this.deleteMember.run({
      workspaceId: request.workspaceId,
      principalId: request.principalId,
    }).changes !== 0;
    const failures: unknown[] = [];
    for (const listener of this.removeListeners) {
      try {
        listener(request.workspaceId, request.principalId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "MembershipRegistry.remove: closure failed");
    }
    return changed;
  }

  onRemove(listener: (workspaceId: string, principalId: string) => void): () => void {
    this.removeListeners.add(listener);
    return () => this.removeListeners.delete(listener);
  }

  private protectLastAdmin(workspaceId: string, previousRole: MembershipRole | null): void {
    if (previousRole === "admin" && this.countAdmins.get({ workspaceId })?.count === 1) {
      throw new Error("MembershipRegistry: final workspace admin must remain");
    }
  }
}
