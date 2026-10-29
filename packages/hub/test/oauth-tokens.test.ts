import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentGrantRegistry } from "../src/agent-grants.js";
import { MembershipRegistry } from "../src/memberships.js";
import { OAuthAuthorizations, type OAuthCodeExchange, type PendingAuthorization } from "../src/oauth-authorizations.js";
import { HubDatabase } from "../src/persistence.js";
import { WorkspaceNameReader } from "../src/workspace-names.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const PRINCIPAL = "consenting-person";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const request: PendingAuthorization = {
  clientId: "registered-agent", clientName: "Consented Agent", redirectUri: "https://client.example:8443/callback?existing=value",
  state: null, codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
  resource: `https://hub.example/mcp/${WORKSPACE}`, workspaceId: WORKSPACE, writeRequested: true,
};
const databases: HubDatabase[] = [];

function openDatabase(path: string) {
  const database = new HubDatabase(path, error => { throw error; });
  database.open();
  databases.push(database);
  return database;
}

function rig(path = ":memory:", clock = { now: 1000 }) {
  const database = openDatabase(path);
  const memberships = new MembershipRegistry(database);
  memberships.grant({ workspaceId: WORKSPACE, principalId: PRINCIPAL, role: "member" });
  const authorizations = new OAuthAuthorizations(database, memberships, new WorkspaceNameReader(database), () => clock.now);
  return { database, memberships, authorizations, clock };
}

function authorize(r: ReturnType<typeof rig>, accessLevel: "read-only" | "read-write" = "read-write"): OAuthCodeExchange {
  const id = r.authorizations.create(request)!;
  const result = r.authorizations.submit({ requestId: id, decision: "approve", accessLevel }, PRINCIPAL);
  if (result.status !== "approved") throw new Error("approval failed");
  return { code: new URL(result.redirectUrl).searchParams.get("code")!, codeVerifier: VERIFIER,
    clientId: request.clientId, redirectUri: request.redirectUri };
}

function issue(r: ReturnType<typeof rig>, exchange: OAuthCodeExchange) {
  const result = r.authorizations.exchange(exchange);
  if (result.status !== "issued") throw new Error(`exchange failed: ${result.status}`);
  return result;
}

function snapshot(database: HubDatabase) {
  return {
    codes: database.connection.prepare("SELECT * FROM hub_oauth_authorization_codes").all(),
    tokens: database.connection.prepare("SELECT * FROM hub_oauth_access_tokens").all(),
    grants: database.connection.prepare("SELECT * FROM hub_agent_grants").all(),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  removeTempDatabases();
});

describe("OAuth access token persistence", () => {
  it.each([
    { accessLevel: "read-only" as const, scope: "docs:read", explicitResource: false },
    { accessLevel: "read-write" as const, scope: "docs:read docs:write", explicitResource: true },
  ])("stores only a token hash and preserves $scope with the approved resource", ({ accessLevel, scope, explicitResource }) => {
    const r = rig();
    const exchange = authorize(r, accessLevel);
    const before = snapshot(r.database);
    r.clock.now += 9000;
    const issuedAt = r.clock.now;
    const result = issue(r, explicitResource ? { ...exchange, resource: request.resource } : exchange);
    expect(result.scope).toBe(scope);
    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = snapshot(r.database);
    expect(stored.codes).toEqual(before.codes);
    expect(stored.grants).toEqual(before.grants);
    expect(stored.tokens).toEqual([{
      token_hash: createHash("sha256").update(result.accessToken).digest("hex"),
      code_hash: createHash("sha256").update(exchange.code).digest("hex"),
      grant_id: before.codes[0]!.grant_id, resource: request.resource, scope,
      expires_at: issuedAt + 3_600_000, revoked_at: null,
    }]);
    expect(JSON.stringify(stored)).not.toContain(result.accessToken);
    const expected = { grantId: before.codes[0]!.grant_id, resource: request.resource, scope, expiresAt: issuedAt + 3_600_000 };
    expect(r.authorizations.getAccessToken(result.accessToken)).toEqual(expected);
    expect(r.authorizations.getAccessToken("unknown-token")).toBeNull();
    r.clock.now = expected.expiresAt - 1;
    expect(r.authorizations.getAccessToken(result.accessToken)).toEqual(expected);
    r.clock.now = expected.expiresAt;
    expect(r.authorizations.getAccessToken(result.accessToken)).toBeNull();
    expect(snapshot(r.database)).toEqual(stored);
  });

  const refusals: Array<{ name: string; override: Partial<OAuthCodeExchange>; status: "invalid_grant" | "invalid_target" }> = [
    { name: "unknown code", override: { code: "unknown-code" }, status: "invalid_grant" },
    { name: "wrong verifier", override: { codeVerifier: "x".repeat(43) }, status: "invalid_grant" },
    { name: "different redirect URI", override: { redirectUri: `${request.redirectUri}&extra=value` }, status: "invalid_grant" },
    { name: "different client", override: { clientId: "another-client" }, status: "invalid_grant" },
    { name: "different resource", override: { resource: `${request.resource}/other` }, status: "invalid_target" },
  ];

  it.each(refusals)("refuses $name without consuming the valid code or issuing a token", ({ override, status }) => {
    const r = rig();
    const exchange = authorize(r);
    const before = snapshot(r.database);
    expect(r.authorizations.exchange({ ...exchange, ...override })).toEqual({ status });
    expect(snapshot(r.database)).toEqual(before);
    expect(r.authorizations.exchange(exchange)).toHaveProperty("status", "issued");
  });

  it("allows the last millisecond of a code's life and refuses the exact expiry without mutation", () => {
    const r = rig();
    const exchange = authorize(r);
    r.clock.now += 59_999;
    expect(r.authorizations.exchange(exchange)).toHaveProperty("status", "issued");
    const before = snapshot(r.database);
    r.clock.now++;
    expect(r.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database)).toEqual(before);
    const expired = authorize(r);
    const expiredBefore = snapshot(r.database);
    r.clock.now += 60_000;
    expect(r.authorizations.exchange(expired)).toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database)).toEqual(expiredBefore);
  });

  it.each(refusals.filter(refusal => refusal.name !== "unknown code"))(
    "refuses replay with $name without revoking the token", ({ override, status }) => {
      const r = rig();
      const exchange = authorize(r);
      const token = issue(r, exchange).accessToken;
      const before = snapshot(r.database);
      expect(r.authorizations.exchange({ ...exchange, ...override })).toEqual({ status });
      expect(snapshot(r.database)).toEqual(before);
      expect(r.authorizations.getAccessToken(token)).not.toBeNull();
    },
  );

  it("issues once, then revokes only that code's token on a fully validated replay while retaining its grant", () => {
    const r = rig();
    const exchange = authorize(r);
    const token = issue(r, exchange).accessToken;
    const unrelatedToken = issue(r, authorize(r)).accessToken;
    expect(unrelatedToken).not.toBe(token);
    const before = snapshot(r.database);
    expect(r.authorizations.getAccessToken(token)).not.toBeNull();
    r.clock.now++;
    expect(r.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.getAccessToken(token)).toBeNull();
    expect(r.authorizations.getAccessToken(unrelatedToken)).not.toBeNull();
    const after = snapshot(r.database);
    expect(after.tokens).toHaveLength(2);
    expect(after.tokens.find(row => row.token_hash === createHash("sha256").update(token).digest("hex")))
      .toHaveProperty("revoked_at", r.clock.now);
    expect(after.codes).toEqual(before.codes);
    expect(after.grants).toEqual(before.grants);
    expect(r.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database).tokens).toHaveLength(2);
  });

  it("rolls back failed token issuance so a storage failure does not consume the code", () => {
    const r = rig();
    const exchange = authorize(r);
    const before = snapshot(r.database);
    r.database.connection.exec(`CREATE TRIGGER reject_token BEFORE INSERT ON hub_oauth_access_tokens
      BEGIN SELECT RAISE(ABORT, 'token storage failed'); END`);
    expect(() => r.authorizations.exchange(exchange)).toThrow("token storage failed");
    expect(snapshot(r.database)).toEqual(before);
    r.database.connection.exec("DROP TRIGGER reject_token");
    const token = issue(r, exchange).accessToken;
    expect(r.authorizations.getAccessToken(token)).not.toBeNull();
    expect(snapshot(r.database).tokens).toHaveLength(1);
  });

  it("opens the released code schema unchanged and preserves token lookup and single-use state across restart", () => {
    const path = tempDatabasePath();
    const database = openDatabase(path);
    database.connection.exec(`CREATE TABLE hub_oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('docs:read', 'docs:read docs:write')), expires_at INTEGER NOT NULL
    )`);
    const columns = database.connection.prepare("PRAGMA table_info(hub_oauth_authorization_codes)").all();
    const grant = new AgentGrantRegistry(database).create({ clientId: request.clientId, clientName: request.clientName,
      principalId: PRINCIPAL, workspaceId: WORKSPACE, scope: "read-only" });
    database.connection.prepare(`INSERT INTO hub_oauth_authorization_codes
      (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(createHash("sha256").update("existing-code").digest("hex"),
      grant.id, request.clientId, request.redirectUri, request.codeChallenge, request.resource, "docs:read", 61_000);
    database.close();
    const r = rig(path);
    expect(r.database.connection.prepare("PRAGMA table_info(hub_oauth_authorization_codes)").all()).toEqual(columns);
    const exchange = { code: "existing-code", codeVerifier: VERIFIER, clientId: request.clientId, redirectUri: request.redirectUri };
    const token = issue(r, exchange).accessToken;
    const lookup = r.authorizations.getAccessToken(token);
    r.database.close();
    const reopened = rig(path, r.clock);
    expect(reopened.authorizations.getAccessToken(token)).toEqual(lookup);
    expect(reopened.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(reopened.authorizations.getAccessToken(token)).toBeNull();
    expect(snapshot(reopened.database).tokens).toHaveLength(1);
    reopened.database.close();
    const reopenedAgain = rig(path, r.clock);
    expect(reopenedAgain.authorizations.getAccessToken(token)).toBeNull();
    expect(reopenedAgain.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(snapshot(reopenedAgain.database).tokens).toHaveLength(1);
  });

  it("leaves membership and grant revocation enforcement to token use", () => {
    const r = rig();
    const exchange = authorize(r);
    const grantId = snapshot(r.database).codes[0]!.grant_id as string;
    r.memberships.remove({ workspaceId: WORKSPACE, principalId: PRINCIPAL });
    new AgentGrantRegistry(r.database, () => r.clock.now).revoke(grantId);
    const token = issue(r, exchange).accessToken;
    expect(r.authorizations.getAccessToken(token)).toHaveProperty("grantId", grantId);
  });

  it("fences late exchanges and lookups before shutdown closes storage", () => {
    const r = rig();
    const exchange = authorize(r);
    const token = issue(r, exchange).accessToken;
    const unredeemed = authorize(r);
    const before = snapshot(r.database);
    r.authorizations.stop();
    expect(r.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.exchange(unredeemed)).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.getAccessToken(token)).toBeNull();
    expect(snapshot(r.database)).toEqual(before);
    r.database.close();
    expect(r.authorizations.exchange(unredeemed)).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.getAccessToken(token)).toBeNull();
  });
});
