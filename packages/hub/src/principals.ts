/** Durable GitHub identity, private to the hub and its backup. */
import type { StatementSync } from "node:sqlite";
import type { HubDatabase } from "./persistence.js";

export interface PrincipalRecord {
  id: string;
  githubAccountId: string;
  githubUsername: string;
}

function fromRow(row: Record<string, unknown>): PrincipalRecord {
  return {
    id: row.id as string,
    githubAccountId: row.github_account_id as string,
    githubUsername: row.github_username as string,
  };
}

export class PrincipalRegistry {
  private readonly upsert: StatementSync;
  private readonly select: StatementSync;
  private readonly selectAccount: StatementSync;
  private readonly selectUsername: StatementSync;
  private readonly selectSignIn: StatementSync;
  private readonly markSignIn: StatementSync;

  constructor(database: HubDatabase, now: () => number = Date.now) {
    const db = database.connection;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_principals (
      id TEXT PRIMARY KEY NOT NULL,
      github_account_id TEXT UNIQUE NOT NULL,
      github_username TEXT NOT NULL,
      has_signed_in INTEGER NOT NULL DEFAULT 0
    )`);
    if (!db.prepare("PRAGMA table_info(hub_principals)").all().some(column => column.name === "has_signed_in")) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("ALTER TABLE hub_principals ADD COLUMN has_signed_in INTEGER NOT NULL DEFAULT 0");
        const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
        if (tables.some(table => table.name === "hub_credentials")) {
          // Revoked credentials still prove that their account completed sign-in.
          db.exec(`UPDATE hub_principals SET has_signed_in = 1 WHERE id IN
            (SELECT principal_id FROM hub_credentials)`);
        }
        if (tables.some(table => table.name === "hub_browser_sessions")) {
          db.prepare(`UPDATE hub_principals SET has_signed_in = 1 WHERE id IN
            (SELECT principal_id FROM hub_browser_sessions WHERE expires_at > $now)`).run({ now: now() });
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    this.upsert = db.prepare(`
      INSERT INTO hub_principals (id, github_account_id, github_username)
      VALUES ($id, $accountId, $username)
      ON CONFLICT(github_account_id) DO UPDATE SET github_username = excluded.github_username
      RETURNING id, github_account_id, github_username
    `);
    this.select = db.prepare(`
      SELECT id, github_account_id, github_username FROM hub_principals WHERE id = $id
    `);
    this.selectAccount = db.prepare(`
      SELECT id, github_account_id, github_username FROM hub_principals WHERE github_account_id = $accountId
    `);
    this.selectUsername = db.prepare(`
      SELECT id, github_account_id, github_username FROM hub_principals WHERE github_username = $username COLLATE NOCASE
    `);
    this.selectSignIn = db.prepare("SELECT has_signed_in FROM hub_principals WHERE id = $id");
    this.markSignIn = db.prepare("UPDATE hub_principals SET has_signed_in = 1 WHERE id = $id");
  }

  get(id: string): PrincipalRecord | null {
    const row = this.select.get({ id });
    return row === undefined ? null : fromRow(row);
  }

  getByGithubAccountId(accountId: string): PrincipalRecord | null {
    const row = this.selectAccount.get({ accountId });
    return row === undefined ? null : fromRow(row);
  }

  findByGithubUsername(username: string): PrincipalRecord[] {
    return this.selectUsername.all({ username }).map(fromRow);
  }

  hasSignedIn(id: string): boolean {
    return this.selectSignIn.get({ id })?.has_signed_in === 1;
  }

  /** The caller commits this with the credential or browser session, never identity lookup alone. */
  recordSignIn(id: string): void {
    this.markSignIn.run({ id });
  }

  /** Internal only: identity comes from the hub's GitHub authorization or public lookup. */
  identify(accountId: string, username: string): PrincipalRecord {
    if (!/^[1-9][0-9]*$/.test(accountId) || username.length < 1) {
      throw new Error("PrincipalRegistry: invalid GitHub public identity");
    }
    const row = this.upsert.get({ id: crypto.randomUUID(), accountId, username });
    if (row === undefined) throw new Error("PrincipalRegistry: identity was not persisted");
    return fromRow(row);
  }
}
