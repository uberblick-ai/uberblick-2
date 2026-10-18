/** One-time bootstrap authority, private to the deployed hub's database. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { seedTagCatalog, setWorkspaceName } from "@uberblick/schema";
import * as Y from "yjs";
import type { MembershipRegistry } from "./memberships.js";
import type { HubDatabase } from "./persistence.js";
import { HubAdminRegistry } from "./hub-admins.js";
import type { DeviceFlowLease } from "./github-device-flow.js";

const HUB_DATA_TABLES = [
  "documents", "hub_principals", "hub_credentials", "hub_memberships", "hub_admin_setup_grants", "hub_admins", "hub_workspace_promotions",
] as const;

export class HubClaimState {
  private code: string | undefined;
  private reservation: DeviceFlowLease | undefined;
  constructor(private readonly database: HubDatabase,
    private readonly admins = new HubAdminRegistry(database),
    private readonly now: () => number = Date.now) {
    const db = database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS hub_claim_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        default_workspace_id TEXT,
        unclaimed INTEGER NOT NULL CHECK(unclaimed IN (0, 1)),
        CHECK(unclaimed = 0 OR default_workspace_id IS NOT NULL)
      )`);
      if (db.prepare("SELECT 1 FROM hub_claim_state WHERE id = 1").get() === undefined) {
        // Schema presence and file existence say nothing about freshness. A
        // sealed row records the upgrade even if its old data is later removed.
        const existing = HUB_DATA_TABLES.some((table) =>
          db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined &&
          db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined);
        const workspaceId = existing ? null : crypto.randomUUID();
        if (workspaceId !== null) {
          const settings = new Y.Doc();
          try {
            setWorkspaceName(settings, "Default workspace");
            seedTagCatalog(settings);
            db.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
              .run(`${workspaceId}/_settings`, Y.encodeStateAsUpdate(settings));
          } finally { settings.destroy(); }
        }
        db.prepare("INSERT INTO hub_claim_state (id, default_workspace_id, unclaimed) VALUES (1, ?, ?)")
          .run(workspaceId, existing ? 0 : 1);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  state(githubConfigured: boolean): { unclaimed: boolean; canClaim: boolean } {
    const unclaimed = this.database.connection.prepare("SELECT unclaimed FROM hub_claim_state WHERE id = 1")
      .get()?.unclaimed === 1;
    return { unclaimed, canClaim: unclaimed && githubConfigured };
  }

  /** Only the host's private operator socket may disclose this value. */
  operatorClaimCode(): string | undefined {
    if (!this.state(false).unclaimed) return undefined;
    if (this.reservation !== undefined && this.now() >= this.reservation.expiresAt) this.reservation.release();
    if (this.reservation !== undefined) return undefined;
    this.code ??= randomBytes(32).toString("hex");
    return this.code;
  }

  reserve(code: string): DeviceFlowLease | undefined {
    const available = this.operatorClaimCode();
    if (available === undefined || !/^[a-f0-9]{64}$/.test(code) ||
        !timingSafeEqual(Buffer.from(code), Buffer.from(available))) return undefined;
    const lease: DeviceFlowLease = { expiresAt: Infinity, release: () => {
      if (this.reservation === lease) this.reservation = undefined;
    } };
    this.code = undefined;
    this.reservation = lease;
    return lease;
  }

  /** Caller holds the sign-in transaction through credential issuance. */
  claim(principalId: string, memberships: MembershipRegistry, lease?: DeviceFlowLease): string | undefined {
    if (lease === undefined || lease !== this.reservation || this.now() >= lease.expiresAt) return undefined;
    const row = this.database.connection.prepare(
      "SELECT default_workspace_id FROM hub_claim_state WHERE id = 1 AND unclaimed = 1",
    ).get();
    if (row === undefined) return undefined;
    const workspaceId = row.default_workspace_id as string;
    memberships.grant({ workspaceId, principalId, role: "admin" });
    this.admins.grant(principalId);
    this.close();
    return workspaceId;
  }

  /** Caller commits this together with its first-admin grant and receipt. */
  close(): void {
    this.database.connection.prepare("UPDATE hub_claim_state SET unclaimed = 0 WHERE id = 1 AND unclaimed = 1").run();
  }
}

/** Credential-free, read-only and deliberately limited to two facts. */
export function handleHubClaimState(
  claims: HubClaimState | undefined, githubConfigured: boolean,
  request: IncomingMessage, response: ServerResponse,
): boolean {
  if (request.url !== "/auth/claim-state") return false;
  const valid = request.method === "GET";
  response.writeHead(valid ? 200 : 405, {
    "Content-Type": "application/json", "Cache-Control": "no-store",
    ...(valid ? {} : { Allow: "GET" }),
  });
  response.end(JSON.stringify(valid
    ? claims?.state(githubConfigured) ?? { unclaimed: false, canClaim: false }
    : { status: "invalid-request" }));
  return true;
}
