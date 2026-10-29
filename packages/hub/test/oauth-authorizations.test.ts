import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentGrantRegistry } from "../src/agent-grants.js";
import { MembershipRegistry } from "../src/memberships.js";
import { MAX_PENDING_AUTHORIZATIONS, OAuthAuthorizations, type PendingAuthorization } from "../src/oauth-authorizations.js";
import { HubDatabase } from "../src/persistence.js";
import { WorkspaceNameReader } from "../src/workspace-names.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const PRINCIPAL = "consenting-person";
const request: PendingAuthorization = {
  clientId: "registered-agent", clientName: "Consented Agent", redirectUri: "https://client.example:8443/callback?existing=value",
  state: "private state", codeChallenge: "requested-pkce-challenge", resource: `https://hub.example/mcp/${WORKSPACE}`,
  workspaceId: WORKSPACE, writeRequested: true,
};
const databases: HubDatabase[] = [];

function rig(path = ":memory:", clock = { now: 1000 }) {
  const database = new HubDatabase(path, error => { throw error; });
  database.open();
  databases.push(database);
  const memberships = new MembershipRegistry(database);
  memberships.grant({ workspaceId: WORKSPACE, principalId: PRINCIPAL, role: "member" });
  const authorizations = new OAuthAuthorizations(database, memberships, new WorkspaceNameReader(database), () => clock.now);
  return { database, memberships, authorizations, clock };
}

function snapshot(database: HubDatabase) {
  return {
    pending: database.connection.prepare("SELECT * FROM hub_oauth_pending_authorizations").all(),
    grants: database.connection.prepare("SELECT * FROM hub_agent_grants").all(),
    codes: database.connection.prepare("SELECT * FROM hub_oauth_authorization_codes").all(),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  removeTempDatabases();
});

describe("OAuth consent persistence", () => {
  it("fences late requests before shutdown closes storage", () => {
    const r = rig();
    const id = r.authorizations.create(request)!;
    const before = snapshot(r.database);
    r.authorizations.stop();
    expect(r.authorizations.submit({ requestId: id, decision: "approve", accessLevel: "read-write" }, PRINCIPAL))
      .toEqual({ status: "unknown-request" });
    expect(snapshot(r.database)).toEqual(before);
    r.database.close();
    expect(r.authorizations.create(request)).toBeNull();
    expect(r.authorizations.read(id, PRINCIPAL)).toEqual({ status: "unknown-request" });
    expect(r.authorizations.submit({ requestId: id, decision: "deny" }, PRINCIPAL)).toEqual({ status: "unknown-request" });
  });

  it("refuses capacity without evicting live requests and reuses only expired slots", () => {
    const r = rig();
    const first = r.authorizations.create(request)!;
    const firstExpiry = r.clock.now + 300_000;
    r.clock.now++;
    const live: string[] = [];
    for (let index = 1; index < MAX_PENDING_AUTHORIZATIONS; index++) {
      live.push(r.authorizations.create(request)!);
    }
    const before = snapshot(r.database);
    expect(before.pending).toHaveLength(MAX_PENDING_AUTHORIZATIONS);
    expect(r.authorizations.create(request)).toBeNull();
    expect(snapshot(r.database)).toEqual(before);
    expect(r.authorizations.read(first, PRINCIPAL)).toHaveProperty("status", "pending");
    r.clock.now = firstExpiry;
    const replacement = r.authorizations.create(request);
    expect(replacement).toEqual(expect.any(String));
    expect(snapshot(r.database).pending).toHaveLength(MAX_PENDING_AUTHORIZATIONS);
    expect(r.authorizations.read(first, PRINCIPAL)).toEqual({ status: "unknown-request" });
    expect(r.authorizations.read(live[0]!, PRINCIPAL)).toHaveProperty("status", "pending");
    expect(r.authorizations.read(replacement!, PRINCIPAL)).toHaveProperty("status", "pending");
  });

  it("makes reads non-consuming and treats the expiry boundary and unknown ids as nonmutating refusals", () => {
    const r = rig();
    const id = r.authorizations.create(request)!;
    const expiresAt = r.clock.now + 300_000;
    const before = snapshot(r.database);
    r.clock.now = expiresAt - 1;
    expect(r.authorizations.read(id, PRINCIPAL)).toHaveProperty("status", "pending");
    expect(r.authorizations.read(id, PRINCIPAL)).toHaveProperty("status", "pending");
    expect(snapshot(r.database)).toEqual(before);
    r.clock.now = expiresAt;
    for (const requestId of [id, "unknown-request"]) {
      expect(r.authorizations.read(requestId, PRINCIPAL)).toEqual({ status: "unknown-request" });
      expect(r.authorizations.submit({ requestId, decision: "approve", accessLevel: "read-only" }, PRINCIPAL))
        .toEqual({ status: "unknown-request" });
    }
    expect(snapshot(r.database)).toEqual(before);
  });

  it("stores only the code hash with all redemption bindings and persists the grant and code across reopen", () => {
    const path = tempDatabasePath();
    const r = rig(path);
    const id = r.authorizations.create(request)!;
    r.clock.now += 1234;
    const approvedAt = r.clock.now;
    const result = r.authorizations.submit({ requestId: id, decision: "approve", accessLevel: "read-write" }, PRINCIPAL);
    expect(result.status).toBe("approved");
    if (result.status !== "approved") throw new Error("approval failed");
    const redirect = new URL(result.redirectUrl);
    const code = redirect.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirect.origin + redirect.pathname).toBe("https://client.example:8443/callback");
    expect(redirect.searchParams.get("existing")).toBe("value");
    expect(redirect.searchParams.get("state")).toBe(request.state);
    const stored = snapshot(r.database);
    expect(stored.pending).toEqual([]);
    expect(stored.grants).toHaveLength(1);
    expect(stored.codes).toEqual([{
      code_hash: createHash("sha256").update(code).digest("hex"), grant_id: stored.grants[0]!.id,
      client_id: request.clientId, redirect_uri: request.redirectUri, code_challenge: request.codeChallenge,
      resource: request.resource, scope: "docs:read docs:write", expires_at: approvedAt + 60_000,
    }]);
    expect(JSON.stringify(stored)).not.toContain(code);
    const grant = new AgentGrantRegistry(r.database).get(stored.codes[0]!.grant_id as string);
    expect(grant).toEqual({ id: stored.grants[0]!.id, clientId: request.clientId, clientName: request.clientName,
      principalId: PRINCIPAL, workspaceId: WORKSPACE, scope: "read-write", deviceId: expect.any(String), createdAt: approvedAt, revokedAt: null });
    r.database.close();
    const reopened = rig(path, r.clock);
    expect(snapshot(reopened.database)).toEqual(stored);
    expect(new AgentGrantRegistry(reopened.database).get(grant!.id)).toEqual(grant);
    expect(reopened.authorizations.submit({ requestId: id, decision: "approve", accessLevel: "read-write" }, PRINCIPAL))
      .toEqual({ status: "unknown-request" });
    expect(snapshot(reopened.database)).toEqual(stored);
  });

  it("refuses access elevation without consuming the request so a valid read-only approval can follow", () => {
    const r = rig();
    const id = r.authorizations.create({ ...request, writeRequested: false })!;
    const before = snapshot(r.database);
    expect(r.authorizations.submit({ requestId: id, decision: "approve", accessLevel: "read-write" }, PRINCIPAL))
      .toEqual({ status: "invalid-request" });
    expect(snapshot(r.database)).toEqual(before);
    expect(r.authorizations.submit({ requestId: id, decision: "approve", accessLevel: "read-only" }, PRINCIPAL))
      .toHaveProperty("status", "approved");
    expect(snapshot(r.database).codes[0]).toHaveProperty("scope", "docs:read");
  });

  it.each(["hub_agent_grants", "hub_oauth_authorization_codes"])("rolls back consumption and all issuance when inserting into %s fails", table => {
    const r = rig();
    const id = r.authorizations.create(request)!;
    const before = snapshot(r.database);
    r.database.connection.exec(`CREATE TRIGGER reject_issuance BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'consent storage failed'); END`);
    expect(() => r.authorizations.submit({ requestId: id, decision: "approve", accessLevel: "read-write" }, PRINCIPAL))
      .toThrow("consent storage failed");
    expect(snapshot(r.database)).toEqual(before);
    r.database.connection.exec("DROP TRIGGER reject_issuance");
    expect(r.authorizations.submit({ requestId: id, decision: "approve", accessLevel: "read-write" }, PRINCIPAL))
      .toHaveProperty("status", "approved");
    const after = snapshot(r.database);
    expect(after.pending).toEqual([]);
    expect(after.grants).toHaveLength(1);
    expect(after.codes).toHaveLength(1);
  });

  it("rechecks removed membership on submit and consumes the request without issuing authority", () => {
    const r = rig();
    const id = r.authorizations.create(request)!;
    expect(r.authorizations.read(id, PRINCIPAL)).toHaveProperty("status", "pending");
    r.memberships.remove({ workspaceId: WORKSPACE, principalId: PRINCIPAL });
    expect(r.authorizations.submit({ requestId: id, decision: "approve", accessLevel: "read-write" }, PRINCIPAL))
      .toEqual({ status: "not-a-member" });
    expect(snapshot(r.database)).toEqual({ pending: [], grants: [], codes: [] });
    r.memberships.grant({ workspaceId: WORKSPACE, principalId: PRINCIPAL, role: "member" });
    expect(r.authorizations.read(id, PRINCIPAL)).toEqual({ status: "unknown-request" });
  });

  it("consumes denial once and returns access_denied without issuing authority", () => {
    const r = rig();
    const id = r.authorizations.create(request)!;
    const result = r.authorizations.submit({ requestId: id, decision: "deny" }, PRINCIPAL);
    expect(result.status).toBe("denied");
    if (result.status !== "denied") throw new Error("denial failed");
    const redirect = new URL(result.redirectUrl);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(request.state);
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(snapshot(r.database)).toEqual({ pending: [], grants: [], codes: [] });
    expect(r.authorizations.submit({ requestId: id, decision: "deny" }, PRINCIPAL)).toEqual({ status: "unknown-request" });
  });
});
