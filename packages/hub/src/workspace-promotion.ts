/** Reserve a new workspace for one authenticated promotion, atomically. */
import type { MembershipRegistry } from "./memberships.js";
import type { HubDatabase } from "./persistence.js";

export type PromotionResult = "created" | "resumed" | "admin-required" | "workspace-conflict";

export class WorkspacePromotions {
  constructor(
    private readonly database: HubDatabase,
    private readonly memberships: MembershipRegistry,
    private readonly hasLiveDocuments: (workspaceId: string) => boolean,
  ) {
    database.connection.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_promotions (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT UNIQUE NOT NULL,
      principal_id TEXT NOT NULL
    )`);
  }

  reserve(workspaceId: string, attemptId: string, principalId: string): PromotionResult {
    const db = this.database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Current membership, not a credential's issuance snapshot, grants this
      // authority. A login alone cannot create workspaces.
      if (!this.memberships.workspacesFor(principalId).some(
        id => this.memberships.roleFor(id, principalId) === "admin",
      )) {
        db.exec("ROLLBACK");
        return "admin-required";
      }
      const receipt = db.prepare("SELECT * FROM hub_workspace_promotions WHERE attempt_id = ?").get(attemptId);
      if (receipt !== undefined) {
        const own = receipt.workspace_id === workspaceId && receipt.principal_id === principalId &&
          this.memberships.roleFor(workspaceId, principalId) === "admin";
        db.exec("ROLLBACK");
        return own ? "resumed" : "workspace-conflict";
      }
      const prefix = `${workspaceId}/`;
      if (this.memberships.hasMembership(workspaceId) || this.hasLiveDocuments(workspaceId) ||
        db.prepare("SELECT 1 FROM documents WHERE substr(name, 1, ?) = ? LIMIT 1").get(prefix.length, prefix) !== undefined ||
        db.prepare("SELECT 1 FROM hub_workspace_promotions WHERE workspace_id = ?").get(workspaceId) !== undefined) {
        db.exec("ROLLBACK");
        return "workspace-conflict";
      }
      this.memberships.grant({ workspaceId, principalId, role: "admin" });
      db.prepare("INSERT INTO hub_workspace_promotions (attempt_id, workspace_id, principal_id) VALUES (?, ?, ?)")
        .run(attemptId, workspaceId, principalId);
      db.exec("COMMIT");
      return "created";
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
