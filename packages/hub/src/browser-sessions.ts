import { createHash, randomBytes } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import type { HubDatabase } from "./persistence.js";

export const BROWSER_SESSION_LIFETIME_MS = 24 * 60 * 60_000;

export interface BrowserSession {
  username: string;
  expiresAt: number;
}

/** Browser identity only: these rows and tokens grant no device or room authority. */
export class BrowserSessions {
  private readonly insert: StatementSync;
  private readonly select: StatementSync;
  private readonly remove: StatementSync;
  private readonly expire: StatementSync;

  constructor(database: HubDatabase, private readonly now: () => number = Date.now) {
    const db = database.connection;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_browser_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      principal_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    this.insert = db.prepare(`INSERT INTO hub_browser_sessions
      (token_hash, principal_id, origin, expires_at)
      VALUES ($hash, $principalId, $origin, $expiresAt)`);
    this.select = db.prepare(`SELECT principals.github_username, sessions.expires_at
      FROM hub_browser_sessions AS sessions JOIN hub_principals AS principals
        ON principals.id = sessions.principal_id
      WHERE sessions.token_hash = $hash AND sessions.origin = $origin AND sessions.expires_at > $now`);
    this.remove = db.prepare("DELETE FROM hub_browser_sessions WHERE token_hash = $hash AND origin = $origin");
    this.expire = db.prepare("DELETE FROM hub_browser_sessions WHERE expires_at <= $now");
  }

  /** The caller commits issuance together with identity and an optional hub claim. */
  issue(principalId: string, username: string, origin: string): BrowserSession & { token: string } {
    const now = this.now();
    this.expire.run({ now });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + BROWSER_SESSION_LIFETIME_MS;
    this.insert.run({ hash: this.hash(token), principalId, origin, expiresAt });
    return { token, username, expiresAt };
  }

  get(token: string, origin: string): BrowserSession | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.select.get({ hash: this.hash(token), origin, now: this.now() });
    return row === undefined ? null : { username: row.github_username as string, expiresAt: row.expires_at as number };
  }

  /** A successful synchronous DELETE has committed before HTTP confirms sign-out. */
  revoke(token: string, origin: string): void {
    this.remove.run({ hash: this.hash(token), origin });
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
