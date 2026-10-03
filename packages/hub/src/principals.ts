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

  constructor(database: HubDatabase) {
    const db = database.connection;
    db.exec(`CREATE TABLE IF NOT EXISTS hub_principals (
      id TEXT PRIMARY KEY NOT NULL,
      github_account_id TEXT UNIQUE NOT NULL,
      github_username TEXT NOT NULL
    )`);
    this.upsert = db.prepare(`
      INSERT INTO hub_principals (id, github_account_id, github_username)
      VALUES ($id, $accountId, $username)
      ON CONFLICT(github_account_id) DO UPDATE SET github_username = excluded.github_username
      RETURNING id, github_account_id, github_username
    `);
  }

  /** Internal only: identity comes from the hub's completed GitHub authorization. */
  identify(accountId: string, username: string): PrincipalRecord {
    if (!/^[1-9][0-9]*$/.test(accountId) || username.length < 1) {
      throw new Error("PrincipalRegistry: invalid GitHub public identity");
    }
    const row = this.upsert.get({ id: crypto.randomUUID(), accountId, username });
    if (row === undefined) throw new Error("PrincipalRegistry: identity was not persisted");
    return fromRow(row);
  }
}
