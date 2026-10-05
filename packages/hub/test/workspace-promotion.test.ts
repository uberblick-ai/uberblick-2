import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { HubClaimState } from "../src/hub-claim.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { WorkspacePromotions } from "../src/workspace-promotion.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

afterEach(removeTempDatabases);

it("persists receipts through restart without touching default workspace or claim state", () => {
  const path = tempDatabasePath();
  const db = new HubDatabase(path, error => { throw error; });
  db.open();
  const claims = new HubClaimState(db);
  const members = new MembershipRegistry(db);
  const principal = randomUUID();
  const authority = randomUUID();
  members.grant({ workspaceId: authority, principalId: principal, role: "admin" });
  const promotions = new WorkspacePromotions(db, members, () => false);
  const workspace = randomUUID();
  const attempt = randomUUID();
  const before = db.connection.prepare("SELECT * FROM hub_claim_state").all();
  const defaultId = before[0]!.default_workspace_id as string;
  expect(promotions.reserve(defaultId, randomUUID(), principal)).toBe("workspace-conflict");
  expect(promotions.reserve(workspace, attempt, principal)).toBe("created");
  expect(claims.state(true)).toEqual({ unclaimed: true, canClaim: true });
  expect(db.connection.prepare("SELECT * FROM hub_claim_state").all()).toEqual(before);
  db.close();
  const reopened = new HubDatabase(path, error => { throw error; });
  reopened.open();
  try {
    const registry = new MembershipRegistry(reopened);
    const resumed = new WorkspacePromotions(reopened, registry, () => true);
    expect(resumed.reserve(workspace, attempt, principal)).toBe("resumed");
    expect(registry.listMembers(workspace, principal)).toHaveLength(1);
  } finally { reopened.close(); }
});

it("refuses live or persisted rooms and rolls back a grant if receipt persistence fails", () => {
  const db = new HubDatabase(tempDatabasePath(), error => { throw error; });
  db.open();
  try {
    const members = new MembershipRegistry(db);
    const principal = randomUUID();
    members.grant({ workspaceId: randomUUID(), principalId: principal, role: "admin" });
    const live = randomUUID();
    const stored = randomUUID();
    db.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)").run(`${stored}/_directory`, new Uint8Array());
    const promotions = new WorkspacePromotions(db, members, id => id === live);
    for (const id of [live, stored]) {
      expect(promotions.reserve(id, randomUUID(), principal)).toBe("workspace-conflict");
      expect(members.hasMembership(id)).toBe(false);
    }
    db.connection.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON hub_workspace_promotions BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    const fresh = randomUUID();
    expect(() => promotions.reserve(fresh, randomUUID(), principal)).toThrow();
    expect(members.hasMembership(fresh)).toBe(false);
    expect(db.connection.prepare("SELECT * FROM hub_workspace_promotions").all()).toEqual([]);
  } finally { db.close(); }
});
