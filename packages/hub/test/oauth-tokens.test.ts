import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGrantRegistry } from "../src/agent-grants.js";
import { CredentialRegistry } from "../src/credentials.js";
import { HubAdminRegistry } from "../src/hub-admins.js";
import { MembershipRegistry } from "../src/memberships.js";
import { OAuthAuthorizations, type OAuthCodeExchange, type PendingAuthorization } from "../src/oauth-authorizations.js";
import { HubDatabase } from "../src/persistence.js";
import { WorkspaceNameReader } from "../src/workspace-names.js";
import { generateTestCredentialKeyPair } from "./device-credentials.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const PRINCIPAL = "consenting-person";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60_000;
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
  const admins = new HubAdminRegistry(database);
  const credentials = new CredentialRegistry(database, admins, undefined, () => clock.now);
  const grants = new AgentGrantRegistry(database, () => clock.now);
  const authorizations = new OAuthAuthorizations(database, memberships, new WorkspaceNameReader(database), credentials, () => clock.now);
  return { database, memberships, admins, credentials, grants, authorizations, clock };
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

function refresh(r: ReturnType<typeof rig>, refreshToken: string, options: { scope?: string; resource?: string } = {}) {
  const result = r.authorizations.refresh({ refreshToken, clientId: request.clientId, ...options });
  if (result.status !== "issued") throw new Error(`refresh failed: ${result.status}`);
  return result;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(database: HubDatabase) {
  return {
    codes: database.connection.prepare("SELECT * FROM hub_oauth_authorization_codes").all(),
    tokens: database.connection.prepare("SELECT * FROM hub_oauth_access_tokens").all(),
    refreshTokens: database.connection.prepare("SELECT * FROM hub_oauth_refresh_tokens").all(),
    refreshAccessTokens: database.connection.prepare("SELECT * FROM hub_oauth_refresh_access_tokens").all(),
    grants: database.connection.prepare("SELECT * FROM hub_agent_grants").all(),
    credentials: database.connection.prepare("SELECT * FROM hub_credentials").all(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.refreshToken).not.toBe(result.accessToken);
    expect(stored.refreshTokens).toEqual([{
      token_hash: hash(result.refreshToken), grant_id: before.codes[0]!.grant_id,
      client_id: request.clientId, resource: request.resource, scope,
      expires_at: issuedAt + REFRESH_LIFETIME_MS, spent_at: null, revoked_at: null,
    }]);
    expect(JSON.stringify(stored)).not.toContain(result.accessToken);
    expect(JSON.stringify(stored)).not.toContain(result.refreshToken);
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

  it("revokes both access stores and the refresh family on validated code replay while retaining its grant", () => {
    const r = rig();
    const exchange = authorize(r);
    const original = issue(r, exchange);
    const rotated = refresh(r, original.refreshToken);
    const current = refresh(r, rotated.refreshToken);
    const unrelated = issue(r, authorize(r));
    const grantId = r.authorizations.getAccessToken(original.accessToken)!.grantId;
    const before = snapshot(r.database);
    r.clock.now++;
    expect(r.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.getAccessToken(original.accessToken)).toBeNull();
    expect(r.authorizations.getAccessToken(rotated.accessToken)).toBeNull();
    expect(r.authorizations.getAccessToken(current.accessToken)).toBeNull();
    expect(r.authorizations.getAccessToken(unrelated.accessToken)).not.toBeNull();
    expect(r.grants.isLive(grantId)).toBe(true);
    const after = snapshot(r.database);
    expect(after.tokens).toHaveLength(2);
    expect(after.tokens.find(row => row.token_hash === hash(original.accessToken)))
      .toHaveProperty("revoked_at", r.clock.now);
    expect(after.refreshAccessTokens).toHaveLength(2);
    expect(after.refreshAccessTokens.every(row => row.revoked_at === r.clock.now)).toBe(true);
    expect(after.codes).toEqual(before.codes);
    expect(after.grants).toEqual(before.grants);
    for (const token of [original.refreshToken, rotated.refreshToken, current.refreshToken]) {
      expect(r.authorizations.refresh({ refreshToken: token, clientId: request.clientId })).toEqual({ status: "invalid_grant" });
    }
    expect(snapshot(r.database)).toEqual(after);
    expect(r.grants.isLive(grantId)).toBe(true);
    expect(refresh(r, unrelated.refreshToken)).toHaveProperty("status", "issued");
    expect(r.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database).tokens).toHaveLength(2);
  });

  it.each(["hub_oauth_access_tokens", "hub_oauth_refresh_tokens"])(
    "rolls back failed issuance into %s without consuming the code", table => {
      const r = rig();
      const exchange = authorize(r);
      const before = snapshot(r.database);
      r.database.connection.exec(`CREATE TRIGGER reject_token BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'token storage failed'); END`);
      expect(() => r.authorizations.exchange(exchange)).toThrow("token storage failed");
      expect(snapshot(r.database)).toEqual(before);
      r.database.connection.exec("DROP TRIGGER reject_token");
      const token = issue(r, exchange).accessToken;
      expect(r.authorizations.getAccessToken(token)).not.toBeNull();
      expect(snapshot(r.database).tokens).toHaveLength(1);
    },
  );

  it("opens the released code schema unchanged and preserves token lookup and single-use state across restart", () => {
    const path = tempDatabasePath();
    const database = openDatabase(path);
    database.connection.exec(`CREATE TABLE hub_oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('docs:read', 'docs:read docs:write')), expires_at INTEGER NOT NULL
    )`);
    database.connection.exec(`CREATE TABLE hub_oauth_access_tokens (
      token_hash TEXT PRIMARY KEY NOT NULL, code_hash TEXT UNIQUE NOT NULL, grant_id TEXT NOT NULL,
      resource TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('docs:read', 'docs:read docs:write')),
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    )`);
    const columns = database.connection.prepare("PRAGMA table_info(hub_oauth_authorization_codes)").all();
    const accessColumns = database.connection.prepare("PRAGMA table_info(hub_oauth_access_tokens)").all();
    const grant = new AgentGrantRegistry(database).create({ clientId: request.clientId, clientName: request.clientName,
      principalId: PRINCIPAL, workspaceId: WORKSPACE, scope: "read-only" });
    database.connection.prepare(`INSERT INTO hub_oauth_authorization_codes
      (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(createHash("sha256").update("existing-code").digest("hex"),
      grant.id, request.clientId, request.redirectUri, request.codeChallenge, request.resource, "docs:read", 61_000);
    database.connection.prepare(`INSERT INTO hub_oauth_access_tokens
      (token_hash, code_hash, grant_id, resource, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(hash("existing-access"), hash("previously-redeemed-code"), grant.id, request.resource, "docs:read", 3_601_000);
    database.close();
    const r = rig(path);
    expect(r.database.connection.prepare("PRAGMA table_info(hub_oauth_authorization_codes)").all()).toEqual(columns);
    expect(r.database.connection.prepare("PRAGMA table_info(hub_oauth_access_tokens)").all()).toEqual(accessColumns);
    const existingLookup = { grantId: grant.id, resource: request.resource, scope: "docs:read", expiresAt: 3_601_000 };
    expect(r.authorizations.getAccessToken("existing-access")).toEqual(existingLookup);
    const exchange = { code: "existing-code", codeVerifier: VERIFIER, clientId: request.clientId, redirectUri: request.redirectUri };
    const original = issue(r, exchange);
    const token = original.accessToken;
    const rotated = refresh(r, original.refreshToken);
    const lookup = r.authorizations.getAccessToken(token);
    const refreshLookup = r.authorizations.getAccessToken(rotated.accessToken);
    r.database.close();
    const reopened = rig(path, r.clock);
    expect(reopened.authorizations.getAccessToken("existing-access")).toEqual(existingLookup);
    expect(reopened.authorizations.getAccessToken(token)).toEqual(lookup);
    expect(reopened.authorizations.getAccessToken(rotated.accessToken)).toEqual(refreshLookup);
    const current = refresh(reopened, rotated.refreshToken);
    expect(reopened.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(reopened.authorizations.getAccessToken(token)).toBeNull();
    expect(reopened.authorizations.getAccessToken(rotated.accessToken)).toBeNull();
    expect(reopened.authorizations.getAccessToken(current.accessToken)).toBeNull();
    expect(reopened.authorizations.getAccessToken("existing-access")).toBeNull();
    expect(snapshot(reopened.database).tokens).toHaveLength(2);
    reopened.database.close();
    const reopenedAgain = rig(path, r.clock);
    expect(reopenedAgain.authorizations.getAccessToken(token)).toBeNull();
    expect(reopenedAgain.authorizations.refresh({ refreshToken: current.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(reopenedAgain.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(snapshot(reopenedAgain.database).tokens).toHaveLength(2);
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
    const issued = issue(r, exchange);
    const token = issued.accessToken;
    const rotated = refresh(r, issued.refreshToken);
    const unredeemed = authorize(r);
    const before = snapshot(r.database);
    r.authorizations.stop();
    expect(r.authorizations.exchange(exchange)).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.exchange(unredeemed)).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.getAccessToken(token)).toBeNull();
    expect(r.authorizations.refresh({ refreshToken: rotated.refreshToken, clientId: request.clientId })).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.getAccessToken(rotated.accessToken)).toBeNull();
    expect(snapshot(r.database)).toEqual(before);
    r.database.close();
    expect(r.authorizations.exchange(unredeemed)).toEqual({ status: "invalid_grant" });
    expect(r.authorizations.getAccessToken(token)).toBeNull();
    expect(r.authorizations.refresh({ refreshToken: rotated.refreshToken, clientId: request.clientId })).toEqual({ status: "invalid_grant" });
  });
});

describe("OAuth refresh rotation", () => {
  it("rotates opaque hashes atomically and preserves the grant scope after a narrowed refresh", () => {
    const r = rig();
    const original = issue(r, authorize(r));
    const grantId = r.authorizations.getAccessToken(original.accessToken)!.grantId;
    r.clock.now += 12_000;
    const narrowedAt = r.clock.now;
    const narrowed = refresh(r, original.refreshToken, { scope: "docs:read", resource: request.resource });
    expect(narrowed.scope).toBe("docs:read");
    expect(narrowed.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(narrowed.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([original.accessToken, original.refreshToken, narrowed.accessToken, narrowed.refreshToken]).size).toBe(4);
    const stored = snapshot(r.database);
    expect(stored.refreshTokens).toEqual([
      { token_hash: hash(original.refreshToken), grant_id: grantId, client_id: request.clientId,
        resource: request.resource, scope: "docs:read docs:write", expires_at: 1000 + REFRESH_LIFETIME_MS,
        spent_at: narrowedAt, revoked_at: null },
      { token_hash: hash(narrowed.refreshToken), grant_id: grantId, client_id: request.clientId,
        resource: request.resource, scope: "docs:read docs:write", expires_at: narrowedAt + REFRESH_LIFETIME_MS,
        spent_at: null, revoked_at: null },
    ]);
    expect(stored.refreshAccessTokens).toEqual([
      { token_hash: hash(narrowed.accessToken), grant_id: grantId, resource: request.resource,
        scope: "docs:read", expires_at: narrowedAt + 3_600_000, revoked_at: null },
    ]);
    expect(JSON.stringify(stored)).not.toContain(narrowed.accessToken);
    expect(JSON.stringify(stored)).not.toContain(narrowed.refreshToken);
    const lookup = { grantId, resource: request.resource, scope: "docs:read", expiresAt: narrowedAt + 3_600_000 };
    expect(r.authorizations.getAccessToken(narrowed.accessToken)).toEqual(lookup);
    const restored = refresh(r, narrowed.refreshToken);
    expect(restored.scope).toBe("docs:read docs:write");
    expect(r.authorizations.getAccessToken(restored.accessToken)).toHaveProperty("scope", "docs:read docs:write");
    const explicit = refresh(r, restored.refreshToken, { scope: "docs:read docs:write" });
    expect(explicit.scope).toBe("docs:read docs:write");
    r.clock.now = lookup.expiresAt - 1;
    expect(r.authorizations.getAccessToken(narrowed.accessToken)).toEqual(lookup);
    r.clock.now = lookup.expiresAt;
    const beforeExpiry = snapshot(r.database);
    expect(r.authorizations.getAccessToken(narrowed.accessToken)).toBeNull();
    expect(snapshot(r.database)).toEqual(beforeExpiry);
  });

  it.each([
    { accessLevel: "read-only" as const, scope: "docs:read docs:write" },
    { accessLevel: "read-only" as const, scope: "docs:write" },
    { accessLevel: "read-write" as const, scope: "docs:write" },
    { accessLevel: "read-write" as const, scope: "docs:read unknown" },
    { accessLevel: "read-write" as const, scope: "openid" },
    { accessLevel: "read-write" as const, scope: "" },
  ])("refuses scope '$scope' on $accessLevel without spending the refresh token", ({ accessLevel, scope }) => {
    const r = rig();
    const original = issue(r, authorize(r, accessLevel));
    const before = snapshot(r.database);
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId, scope }))
      .toEqual({ status: "invalid_scope" });
    expect(snapshot(r.database)).toEqual(before);
    expect(refresh(r, original.refreshToken).scope).toBe(accessLevel === "read-write" ? "docs:read docs:write" : "docs:read");
  });

  it.each([
    { name: "unknown token", override: { refreshToken: "unknown-token" }, status: "invalid_grant" },
    { name: "another client", override: { clientId: "another-client" }, status: "invalid_grant" },
    { name: "another resource", override: { resource: `${request.resource}/other` }, status: "invalid_target" },
  ])("refuses $name without mutating any authority", ({ override, status }) => {
    const r = rig();
    const original = issue(r, authorize(r));
    const before = snapshot(r.database);
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId, ...override }))
      .toEqual({ status });
    expect(snapshot(r.database)).toEqual(before);
    expect(refresh(r, original.refreshToken)).toHaveProperty("status", "issued");
  });

  it("preserves a former member's token for restoration and does not treat suspension as refresh liveness", () => {
    const r = rig();
    const original = issue(r, authorize(r));
    const grantId = r.authorizations.getAccessToken(original.accessToken)!.grantId;
    r.memberships.remove({ workspaceId: WORKSPACE, principalId: PRINCIPAL });
    const before = snapshot(r.database);
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database)).toEqual(before);
    expect(r.grants.get(grantId)?.revokedAt).toBeNull();
    r.memberships.grant({ workspaceId: WORKSPACE, principalId: PRINCIPAL, role: "member" });
    r.admins.setWorkspaceStatus(WORKSPACE, "suspended");
    expect(refresh(r, original.refreshToken)).toHaveProperty("status", "issued");
    expect(r.grants.isLive(grantId)).toBe(true);
  });

  it.each(["grant", "token"] as const)("refuses a revoked %s without issuing or spending anything", revoked => {
    const r = rig();
    const original = issue(r, authorize(r));
    const grantId = r.authorizations.getAccessToken(original.accessToken)!.grantId;
    if (revoked === "grant") r.grants.revoke(grantId);
    else r.database.connection.prepare("UPDATE hub_oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?")
      .run(r.clock.now, hash(original.refreshToken));
    const before = snapshot(r.database);
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database)).toEqual(before);
  });

  it("expires an unused token at exactly 30 days without mutation", () => {
    const r = rig();
    const original = issue(r, authorize(r));
    const before = snapshot(r.database);
    r.clock.now += REFRESH_LIFETIME_MS;
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database)).toEqual(before);
  });

  it("accepts the last millisecond and forgets spent ancestors at their own expiry while descendants stay live", () => {
    const r = rig();
    const original = issue(r, authorize(r));
    const grantId = r.authorizations.getAccessToken(original.accessToken)!.grantId;
    r.clock.now += REFRESH_LIFETIME_MS - 1;
    const descendant = refresh(r, original.refreshToken);
    r.clock.now++;
    const before = snapshot(r.database);
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database)).toEqual(before);
    expect(r.grants.isLive(grantId)).toBe(true);
    const current = refresh(r, descendant.refreshToken);
    const after = snapshot(r.database);
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database)).toEqual(after);
    expect(refresh(r, current.refreshToken)).toHaveProperty("status", "issued");
    expect(r.grants.isLive(grantId)).toBe(true);
  });

  it("ends only the spent token's grant through device revocation and closes its credentials", () => {
    const r = rig();
    const original = issue(r, authorize(r));
    const grantId = r.authorizations.getAccessToken(original.accessToken)!.grantId;
    const credential = r.credentials.issueForGrant(grantId, generateTestCredentialKeyPair().publicKey)!;
    const unrelated = issue(r, authorize(r));
    const unrelatedGrantId = r.authorizations.getAccessToken(unrelated.accessToken)!.grantId;
    const unrelatedCredential = r.credentials.issueForGrant(unrelatedGrantId, generateTestCredentialKeyPair().publicKey)!;
    const closed = vi.fn();
    r.credentials.onRevoke(closed);
    const current = refresh(r, original.refreshToken);
    const before = snapshot(r.database);
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: "another-client" }))
      .toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database)).toEqual(before);
    expect(closed).not.toHaveBeenCalled();
    r.clock.now += REFRESH_LIFETIME_MS - 1;
    r.memberships.remove({ workspaceId: WORKSPACE, principalId: PRINCIPAL });
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId,
      scope: "unknown", resource: "https://other.example/mcp" })).toEqual({ status: "invalid_grant" });
    expect(r.grants.get(grantId)?.revokedAt).toBe(r.clock.now);
    expect(r.credentials.get(credential.record.id)?.revokedAt).toBe(r.clock.now);
    expect(closed).toHaveBeenCalledExactlyOnceWith(credential.record.id);
    expect(r.authorizations.refresh({ refreshToken: current.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(snapshot(r.database).refreshTokens).toHaveLength(before.refreshTokens.length);
    expect(snapshot(r.database).refreshAccessTokens).toHaveLength(before.refreshAccessTokens.length);
    expect(r.grants.get(unrelatedGrantId)?.revokedAt).toBeNull();
    expect(r.credentials.get(unrelatedCredential.record.id)?.revokedAt).toBeNull();
    r.memberships.grant({ workspaceId: WORKSPACE, principalId: PRINCIPAL, role: "member" });
    expect(refresh(r, unrelated.refreshToken)).toHaveProperty("status", "issued");
    expect(r.authorizations.refresh({ refreshToken: current.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
  });

  it.each([
    { name: "spend", operation: "UPDATE OF spent_at ON hub_oauth_refresh_tokens" },
    { name: "access insertion", operation: "INSERT ON hub_oauth_refresh_access_tokens" },
    { name: "refresh insertion", operation: "INSERT ON hub_oauth_refresh_tokens" },
  ])("rolls back failed $name without losing the presented token", ({ operation }) => {
    const r = rig();
    const original = issue(r, authorize(r));
    const before = snapshot(r.database);
    r.database.connection.exec(`CREATE TRIGGER reject_rotation BEFORE ${operation}
      BEGIN SELECT RAISE(ABORT, 'rotation storage failed'); END`);
    expect(() => r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toThrow("rotation storage failed");
    expect(snapshot(r.database)).toEqual(before);
    r.database.connection.exec("DROP TRIGGER reject_rotation");
    expect(refresh(r, original.refreshToken)).toHaveProperty("status", "issued");
  });

  it("retries grant revocation after a storage rollback on reuse", () => {
    const r = rig();
    const original = issue(r, authorize(r));
    const grantId = r.authorizations.getAccessToken(original.accessToken)!.grantId;
    const credential = r.credentials.issueForGrant(grantId, generateTestCredentialKeyPair().publicKey)!;
    const current = refresh(r, original.refreshToken);
    const closed = vi.fn();
    r.credentials.onRevoke(closed);
    const before = snapshot(r.database);
    r.database.connection.exec(`CREATE TRIGGER reject_grant_revoke BEFORE UPDATE OF revoked_at ON hub_agent_grants
      BEGIN SELECT RAISE(ABORT, 'grant storage failed'); END`);
    expect(() => r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toThrow("grant storage failed");
    expect(snapshot(r.database)).toEqual(before);
    expect(closed).not.toHaveBeenCalled();
    r.database.connection.exec("DROP TRIGGER reject_grant_revoke");
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(r.grants.isLive(grantId)).toBe(false);
    expect(closed).toHaveBeenCalledExactlyOnceWith(credential.record.id);
    expect(r.authorizations.refresh({ refreshToken: current.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
  });

  it("keeps a failed room closure revoked and retries it when the spent token is presented again", () => {
    const r = rig();
    const original = issue(r, authorize(r));
    const grantId = r.authorizations.getAccessToken(original.accessToken)!.grantId;
    const credential = r.credentials.issueForGrant(grantId, generateTestCredentialKeyPair().publicKey)!;
    const current = refresh(r, original.refreshToken);
    const closed = vi.fn().mockImplementationOnce(() => { throw new Error("room closure failed"); });
    const alsoClosed = vi.fn();
    r.credentials.onRevoke(closed);
    r.credentials.onRevoke(alsoClosed);
    expect(() => r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toThrow("closure failed");
    expect(r.grants.isLive(grantId)).toBe(false);
    expect(r.credentials.get(credential.record.id)?.revokedAt).toBe(r.clock.now);
    expect(closed).toHaveBeenCalledExactlyOnceWith(credential.record.id);
    expect(alsoClosed).toHaveBeenCalledExactlyOnceWith(credential.record.id);
    const before = snapshot(r.database);
    expect(r.authorizations.refresh({ refreshToken: current.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(r.authorizations.refresh({ refreshToken: original.refreshToken, clientId: request.clientId }))
      .toEqual({ status: "invalid_grant" });
    expect(closed).toHaveBeenCalledTimes(2);
    expect(alsoClosed).toHaveBeenCalledTimes(2);
    expect(snapshot(r.database)).toEqual(before);
  });
});
