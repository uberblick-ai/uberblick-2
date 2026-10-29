import { afterEach, describe, expect, it } from "vitest";
import { AgentGrantRegistry } from "../src/agent-grants.js";
import { HubDatabase } from "../src/persistence.js";
import { MembershipRegistry } from "../src/memberships.js";
import type { TokenScope } from "@uberblick/schema/token";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const request = { clientId: "hosted-agent", clientName: "Hosted Agent", principalId: "person", workspaceId: WORKSPACE, scope: "read-only" as const };
const databases: HubDatabase[] = [];

function open(path = ":memory:"): HubDatabase {
  const database = new HubDatabase(path, (error) => { throw error; });
  database.open();
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  removeTempDatabases();
});

describe("hub-private agent grants", () => {
  it("persists consent authority and a stable isolated device identity across reopen", () => {
    const path = tempDatabasePath();
    const database = open(path);
    const grants = new AgentGrantRegistry(database);
    const first = grants.create(request);
    const second = grants.create({ ...request, scope: "read-write" });
    expect(first).toEqual({ ...request, id: expect.any(String), deviceId: expect.any(String), createdAt: expect.any(Number), revokedAt: null });
    expect(second.id).not.toBe(first.id);
    expect(second.deviceId).not.toBe(first.deviceId);
    expect(database.connection.prepare("SELECT name FROM documents").all()).toEqual([]);
    database.close();
    const reopened = new AgentGrantRegistry(open(path));
    expect(reopened.get(first.id)).toEqual(first);
    expect(reopened.get(second.id)).toEqual(second);
    expect(reopened.get(crypto.randomUUID())).toBeNull();
  });

  it("shares consent caller transactions without committing them", () => {
    const database = open();
    const grants = new AgentGrantRegistry(database);
    database.connection.exec("BEGIN IMMEDIATE");
    const rolledBack = grants.create(request);
    database.connection.exec("ROLLBACK");
    expect(grants.get(rolledBack.id)).toBeNull();
    database.connection.exec("BEGIN IMMEDIATE");
    const committed = grants.create(request);
    database.connection.exec("COMMIT");
    expect(grants.get(committed.id)).toEqual(committed);
  });

  it("keeps the first revocation and its device identity across reopen", () => {
    let now = 1000;
    const path = tempDatabasePath();
    const database = open(path);
    const grants = new AgentGrantRegistry(database, () => now);
    const grant = grants.create(request);
    expect(grants.revoke(grant.id)).toBe(true);
    now = 2000;
    expect(grants.revoke(grant.id)).toBe(false);
    expect(grants.revoke(crypto.randomUUID())).toBe(false);
    database.close();
    expect(new AgentGrantRegistry(open(path)).get(grant.id)).toEqual({ ...grant, revokedAt: 1000 });
  });

  it("lists unused owned grants independently of membership while liveness follows current authority", () => {
    const database = open();
    const grants = new AgentGrantRegistry(database, () => 1000);
    const memberships = new MembershipRegistry(database);
    const grant = grants.create(request);
    const foreign = grants.create({ ...request, principalId: "someone-else" });
    expect(grant.createdAt).toBe(1000);
    expect(grants.listForPrincipal("person")).toEqual([grant]);
    expect(grants.getForDevice("person", grant.deviceId)).toEqual(grant);
    expect(grants.getForDevice("someone-else", grant.deviceId)).toBeNull();
    expect(grants.getForDevice("person", foreign.deviceId)).toBeNull();
    expect(grants.isLive(grant.id)).toBe(false);
    expect(grants.isLive(crypto.randomUUID())).toBe(false);
    memberships.grant({ principalId: "person", workspaceId: WORKSPACE, role: "member" });
    expect(grants.isLive(grant.id)).toBe(true);
    memberships.remove({ principalId: "person", workspaceId: WORKSPACE });
    expect(grants.isLive(grant.id)).toBe(false);
    expect(grants.get(grant.id)).toEqual(grant);
    expect(grants.listForPrincipal("person")).toEqual([grant]);
    memberships.grant({ principalId: "person", workspaceId: WORKSPACE, role: "member" });
    expect(grants.isLive(grant.id)).toBe(true);
    grants.revoke(grant.id);
    expect(grants.isLive(grant.id)).toBe(false);
    expect(grants.listForPrincipal("person")).toEqual([]);
    expect(grants.getForDevice("person", grant.deviceId)?.revokedAt).toBe(1000);
  });

  it("additively upgrades the released grant table and retains recorded times across reopen", () => {
    const path = tempDatabasePath();
    const database = open(path);
    database.connection.exec(`CREATE TABLE hub_agent_grants (
      id TEXT PRIMARY KEY NOT NULL, client_id TEXT NOT NULL, client_name TEXT NOT NULL,
      principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
      device_id TEXT UNIQUE NOT NULL, revoked_at INTEGER
    )`);
    database.connection.prepare(`INSERT INTO hub_agent_grants
      (id, client_id, client_name, principal_id, workspace_id, scope, device_id, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("old-grant", request.clientId, request.clientName,
      request.principalId, WORKSPACE, request.scope, "old-device", 500);
    const grants = new AgentGrantRegistry(database, () => 2000);
    const historical = { ...request, id: "old-grant", deviceId: "old-device", createdAt: 0, revokedAt: 500 };
    expect(grants.get("old-grant")).toEqual(historical);
    const current = grants.create(request);
    expect(current.createdAt).toBe(2000);
    database.close();
    const reopened = new AgentGrantRegistry(open(path), () => 3000);
    expect(reopened.get("old-grant")).toEqual(historical);
    expect(reopened.get(current.id)).toEqual(current);
    expect(reopened.listForPrincipal("person")).toEqual([current]);
  });

  it("refuses incomplete consent authority and noncanonical workspaces", () => {
    const grants = new AgentGrantRegistry(open());
    expect(() => grants.create({ ...request, principalId: "" })).toThrow("must not be empty");
    expect(() => grants.create({ ...request, clientId: "" })).toThrow("must not be empty");
    expect(() => grants.create({ ...request, clientName: "" })).toThrow("must not be empty");
    expect(() => grants.create({ ...request, workspaceId: `slug-${WORKSPACE}` })).toThrow("bare UUID");
    expect(() => grants.create({ ...request, scope: "docs:read" as TokenScope })).toThrow("scope");
  });
});
