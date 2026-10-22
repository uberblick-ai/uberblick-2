import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { HubClaimState } from "../src/hub-claim.js";
import { HubAdminRegistry } from "../src/hub-admins.js";
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
  new HubAdminRegistry(db).grant(principal);
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
    expect(registry.listMembers(workspace)).toHaveLength(1);
  } finally { reopened.close(); }
});

it("refuses live or persisted rooms and rolls back a grant if receipt persistence fails", () => {
  const db = new HubDatabase(tempDatabasePath(), error => { throw error; });
  db.open();
  try {
    const members = new MembershipRegistry(db);
    const principal = randomUUID();
    new HubAdminRegistry(db).grant(principal);
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

it("suspension blocks a new reservation and the committed receipt, then restores the same interrupted attempt", () => {
  const path = tempDatabasePath();
  const database = new HubDatabase(path, error => { throw error; });
  database.open();
  const memberships = new MembershipRegistry(database);
  const registry = new HubAdminRegistry(database);
  registry.grant("owner");
  registry.grant("backup");
  const promotions = new WorkspacePromotions(database, memberships, () => false, registry);
  const workspaceId = randomUUID();
  const attemptId = randomUUID();
  expect(promotions.reserve(workspaceId, attemptId, "owner")).toBe("created");
  registry.setWorkspaceStatus(workspaceId, "suspended");
  const before = database.connection.prepare("SELECT * FROM hub_workspace_promotions").all();
  registry.remove("backup", "owner");
  expect(promotions.reserve(workspaceId, attemptId, "owner")).toBe("workspace-suspended");
  expect(promotions.reserve(workspaceId, randomUUID(), "owner")).toBe("hub-admin-required");
  expect(promotions.reserve(workspaceId, randomUUID(), "backup")).toBe("workspace-suspended");
  expect(database.connection.prepare("SELECT * FROM hub_workspace_promotions").all()).toEqual(before);
  expect(memberships.roleFor(workspaceId, "owner")).toBe("admin");
  database.close();
  const reopened = new HubDatabase(path, error => { throw error; });
  reopened.open();
  try {
    const restored = new HubAdminRegistry(reopened);
    const resumed = new WorkspacePromotions(reopened, new MembershipRegistry(reopened), () => false, restored);
    expect(resumed.reserve(workspaceId, attemptId, "owner")).toBe("workspace-suspended");
    restored.setWorkspaceStatus(workspaceId, "active");
    expect(resumed.reserve(workspaceId, attemptId, "owner")).toBe("resumed");
    expect(reopened.connection.prepare("SELECT * FROM hub_workspace_promotions").all()).toEqual(before);
  } finally { reopened.close(); }
});

it("refuses callers without hub administration or their own target receipt before disclosing suspension", () => {
  const database = new HubDatabase(tempDatabasePath(), error => { throw error; });
  database.open();
  try {
    const memberships = new MembershipRegistry(database);
    const registry = new HubAdminRegistry(database);
    registry.grant("owner");
    registry.grant("backup");
    const promotions = new WorkspacePromotions(database, memberships, () => false, registry);
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const attemptId = randomUUID();
    expect(promotions.reserve(workspaceId, attemptId, "owner")).toBe("created");
    memberships.grant({ workspaceId: otherWorkspaceId, principalId: "outsider", role: "admin" });
    registry.remove("backup", "owner");
    const before = database.connection.prepare("SELECT * FROM hub_workspace_promotions").all();
    const membersBefore = database.connection.prepare("SELECT * FROM hub_memberships").all();
    for (const status of ["active", "suspended"] as const) {
      registry.setWorkspaceStatus(workspaceId, status);
      registry.setWorkspaceStatus(otherWorkspaceId, status);
      expect(promotions.reserve(workspaceId, attemptId, "outsider")).toBe("hub-admin-required");
      expect(promotions.reserve(otherWorkspaceId, attemptId, "outsider")).toBe("hub-admin-required");
      expect(promotions.reserve(otherWorkspaceId, attemptId, "owner")).toBe("hub-admin-required");
      expect(promotions.reserve(workspaceId, randomUUID(), "outsider")).toBe("hub-admin-required");
      expect(database.connection.prepare("SELECT * FROM hub_workspace_promotions").all()).toEqual(before);
      expect(database.connection.prepare("SELECT * FROM hub_memberships").all()).toEqual(membersBefore);
    }
  } finally { database.close(); }
});
