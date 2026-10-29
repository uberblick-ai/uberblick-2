import { createHash, randomBytes } from "node:crypto";
import type { TokenScope } from "@uberblick/schema/token";
import { AgentGrantRegistry } from "./agent-grants.js";
import type { MembershipRegistry } from "./memberships.js";
import type { HubDatabase } from "./persistence.js";
import type { WorkspaceNameReader } from "./workspace-names.js";

export const OAUTH_PENDING_LIFETIME_MS = 5 * 60_000;
export const OAUTH_CODE_LIFETIME_MS = 60_000;
export const OAUTH_ACCESS_TOKEN_LIFETIME_MS = 60 * 60_000;
export const MAX_PENDING_AUTHORIZATIONS = 1000;

export interface OAuthCodeExchange {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  resource?: string;
}

export interface OAuthAccessToken {
  grantId: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

type CodeExchangeResult = { status: "issued"; accessToken: string; scope: string }
  | { status: "invalid_grant" | "invalid_target" };

export interface PendingAuthorization {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  workspaceId: string;
  writeRequested: boolean;
}

export type ConsentSubmission = { requestId: string; decision: "deny" }
  | { requestId: string; decision: "approve"; accessLevel: TokenScope };

type ConsentRefusal = { status: "unknown-request" | "not-a-member" | "invalid-request" };

export function oauthRedirect(redirectUri: string, state: string | null, parameter: "code" | "error", value: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set(parameter, value);
  if (state !== null) url.searchParams.set("state", state);
  return url.href;
}

function pendingFromRow(row: Record<string, unknown>): PendingAuthorization {
  return {
    clientId: row.client_id as string, clientName: row.client_name as string,
    redirectUri: row.redirect_uri as string, state: row.state as string | null,
    codeChallenge: row.code_challenge as string, resource: row.resource as string,
    workspaceId: row.workspace_id as string, writeRequested: row.write_requested === 1,
  };
}

/** The shared SQLite handle serializes consent and redemption with their persisted authority. */
export class OAuthAuthorizations {
  private readonly grants: AgentGrantRegistry;
  private stopped = false;

  constructor(private readonly database: HubDatabase, private readonly memberships: MembershipRegistry,
    private readonly workspaceNames: WorkspaceNameReader, private readonly now: () => number = Date.now) {
    this.grants = new AgentGrantRegistry(database, now);
    database.connection.exec(`CREATE TABLE IF NOT EXISTS hub_oauth_pending_authorizations (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      state TEXT,
      code_challenge TEXT NOT NULL,
      resource TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      write_requested INTEGER NOT NULL CHECK(write_requested IN (0, 1)),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY NOT NULL,
      grant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('docs:read', 'docs:read docs:write')),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_oauth_access_tokens (
      token_hash TEXT PRIMARY KEY NOT NULL,
      code_hash TEXT UNIQUE NOT NULL,
      grant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('docs:read', 'docs:read docs:write')),
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
  }

  stop(): void { this.stopped = true; }

  create(request: PendingAuthorization): string | null {
    if (this.stopped) return null;
    const db = this.database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      db.prepare("DELETE FROM hub_oauth_pending_authorizations WHERE expires_at <= ?").run(now);
      const count = db.prepare("SELECT COUNT(*) AS count FROM hub_oauth_pending_authorizations").get()?.count as number;
      if (count >= MAX_PENDING_AUTHORIZATIONS) {
        db.exec("COMMIT");
        return null;
      }
      const id = randomBytes(32).toString("base64url");
      db.prepare(`INSERT INTO hub_oauth_pending_authorizations
        (id, client_id, client_name, redirect_uri, state, code_challenge, resource, workspace_id, write_requested, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, request.clientId, request.clientName,
        request.redirectUri, request.state, request.codeChallenge, request.resource, request.workspaceId,
        request.writeRequested ? 1 : 0, now + OAUTH_PENDING_LIFETIME_MS);
      db.exec("COMMIT");
      return id;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  read(requestId: string, principalId: string): ConsentRefusal | {
    status: "pending"; clientName: string; redirectHost: string; workspaceId: string;
    workspaceName: string | null; accessLevels: TokenScope[];
  } {
    if (this.stopped) return { status: "unknown-request" };
    const pending = this.get(requestId);
    if (pending === null) return { status: "unknown-request" };
    if (this.memberships.roleFor(pending.workspaceId, principalId) === null) return { status: "not-a-member" };
    return { status: "pending", clientName: pending.clientName, redirectHost: new URL(pending.redirectUri).host,
      workspaceId: pending.workspaceId, workspaceName: this.workspaceNames.read(pending.workspaceId),
      accessLevels: pending.writeRequested ? ["read-only", "read-write"] : ["read-only"] };
  }

  submit(request: ConsentSubmission, principalId: string): ConsentRefusal | { status: "approved" | "denied"; redirectUrl: string } {
    if (this.stopped) return { status: "unknown-request" };
    const db = this.database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.get(request.requestId);
      let result: ReturnType<OAuthAuthorizations["submit"]>;
      if (pending === null) result = { status: "unknown-request" };
      else if (request.decision === "approve" && request.accessLevel === "read-write" && !pending.writeRequested) {
        result = { status: "invalid-request" };
      } else {
        db.prepare("DELETE FROM hub_oauth_pending_authorizations WHERE id = ?").run(request.requestId);
        if (this.memberships.roleFor(pending.workspaceId, principalId) === null) result = { status: "not-a-member" };
        else if (request.decision === "deny") {
          result = { status: "denied", redirectUrl: oauthRedirect(pending.redirectUri, pending.state, "error", "access_denied") };
        } else {
          const grant = this.grants.create({ clientId: pending.clientId, clientName: pending.clientName,
            principalId, workspaceId: pending.workspaceId, scope: request.accessLevel });
          const code = randomBytes(32).toString("base64url");
          const now = this.now();
          db.prepare("DELETE FROM hub_oauth_authorization_codes WHERE expires_at <= ?").run(now);
          db.prepare(`INSERT INTO hub_oauth_authorization_codes
            (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(createHash("sha256").update(code).digest("hex"), grant.id,
            pending.clientId, pending.redirectUri, pending.codeChallenge, pending.resource,
            request.accessLevel === "read-write" ? "docs:read docs:write" : "docs:read", now + OAUTH_CODE_LIFETIME_MS);
          result = { status: "approved", redirectUrl: oauthRedirect(pending.redirectUri, pending.state, "code", code) };
        }
      }
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  exchange(request: OAuthCodeExchange): CodeExchangeResult {
    if (this.stopped) return { status: "invalid_grant" };
    const db = this.database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      const codeHash = createHash("sha256").update(request.code).digest("hex");
      const code = db.prepare(`SELECT * FROM hub_oauth_authorization_codes
        WHERE code_hash = ? AND expires_at > ?`).get(codeHash, now);
      let result: CodeExchangeResult;
      if (code === undefined || request.clientId !== code.client_id || request.redirectUri !== code.redirect_uri ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(request.codeVerifier) ||
        createHash("sha256").update(request.codeVerifier).digest("base64url") !== code.code_challenge) {
        result = { status: "invalid_grant" };
      } else if (request.resource !== undefined && request.resource !== code.resource) {
        result = { status: "invalid_target" };
      } else if (db.prepare("SELECT 1 FROM hub_oauth_access_tokens WHERE code_hash = ?").get(codeHash) !== undefined) {
        // Only a fully bound, unexpired replay can revoke the first redemption's token.
        db.prepare(`UPDATE hub_oauth_access_tokens SET revoked_at = ?
          WHERE code_hash = ? AND revoked_at IS NULL`).run(now, codeHash);
        result = { status: "invalid_grant" };
      } else {
        const accessToken = randomBytes(32).toString("base64url");
        const scope = code.scope as string;
        // A token row also records consumption; its lifetime exceeds the code's replay window.
        db.prepare("DELETE FROM hub_oauth_access_tokens WHERE expires_at <= ?").run(now);
        db.prepare(`INSERT INTO hub_oauth_access_tokens
          (token_hash, code_hash, grant_id, resource, scope, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(createHash("sha256").update(accessToken).digest("hex"), codeHash,
          code.grant_id as string, code.resource as string, scope, now + OAUTH_ACCESS_TOKEN_LIFETIME_MS);
        result = { status: "issued", accessToken, scope };
      }
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Callers must also enforce grant validity and current membership before granting access. */
  getAccessToken(token: string): OAuthAccessToken | null {
    if (this.stopped) return null;
    const row = this.database.connection.prepare(`SELECT grant_id, resource, scope, expires_at FROM hub_oauth_access_tokens
      WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL`)
      .get(createHash("sha256").update(token).digest("hex"), this.now());
    return row === undefined ? null : { grantId: row.grant_id as string, resource: row.resource as string,
      scope: row.scope as string, expiresAt: row.expires_at as number };
  }

  private get(requestId: string): PendingAuthorization | null {
    const row = this.database.connection.prepare(`SELECT * FROM hub_oauth_pending_authorizations
      WHERE id = ? AND expires_at > ?`).get(requestId, this.now());
    return row === undefined ? null : pendingFromRow(row);
  }
}
