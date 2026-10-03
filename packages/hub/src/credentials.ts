/**
 * Hub-owned device credentials. These rows share the document database handle
 * and its backups, but are never synchronized document content. Independent
 * random signing keys keep the legacy shared root and other devices powerless
 * over a credential. Only issue() returns the key to its sign-in caller.
 */

import type { StatementSync } from "node:sqlite";
import { parseWorkspaceId } from "@uberblick/schema";
import type { HubDatabase } from "./persistence.js";
import {
  type ClampFailure,
  type TokenClaims,
  type TokenFailure,
  clampToken,
  importCredentialKey,
  inspectToken,
  readTokenKeyId,
} from "./token.js";

export interface CredentialRecord {
  id: string;
  principalId: string;
  deviceId: string;
  workspaces: string[];
  issuedAt: number;
  revokedAt: number | null;
}

export interface IssueCredentialRequest {
  principalId: string;
  deviceId: string;
  workspaces: readonly string[];
}

export interface IssuedCredential {
  record: CredentialRecord;
  /** Returned only here, never by get() or verify(). */
  keyBytes: Uint8Array;
}

/** Specific internal causes; admission sends a single safe refusal. */
export type CredentialFailure =
  | TokenFailure
  | ClampFailure
  | "root-key"
  | "unknown-credential"
  | "revoked-credential";

export type CredentialVerification =
  | { record: CredentialRecord; claims: TokenClaims }
  | { failure: CredentialFailure };

interface CredentialRow {
  id: string;
  principal_id: string;
  device_id: string;
  workspaces: string;
  issued_at: number;
  revoked_at: number | null;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS hub_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  workspaces TEXT NOT NULL,
  signing_key BLOB NOT NULL CHECK(length(signing_key) = 32),
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER
)`;

const PUBLIC_COLUMNS =
  "id, principal_id, device_id, workspaces, issued_at, revoked_at";

function recordFromRow(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    deviceId: row.device_id,
    workspaces: JSON.parse(row.workspaces) as string[],
    issuedAt: row.issued_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * This internal API fixes authorization at issuance. There is no mutation that
 * widens or restores a credential, and no route from client messages to it.
 * Configured live sign-in constructs this registry for issuance; live room
 * admission still uses the root secret until the coordinated client cutover.
 */
export class CredentialRegistry {
  private readonly insert: StatementSync;
  private readonly select: StatementSync;
  private readonly selectKey: StatementSync;
  private readonly markRevoked: StatementSync;
  private readonly revokeListeners = new Set<(credentialId: string) => void>();

  constructor(database: HubDatabase) {
    const db = database.connection;
    db.exec(SCHEMA);
    this.insert = db.prepare(`
      INSERT INTO hub_credentials
        (id, principal_id, device_id, workspaces, signing_key, issued_at)
      VALUES ($id, $principalId, $deviceId, $workspaces, $key, $issuedAt)
    `);
    this.select = db.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM hub_credentials WHERE id = $id`,
    );
    this.selectKey = db.prepare(
      "SELECT signing_key FROM hub_credentials WHERE id = $id",
    );
    this.markRevoked = db.prepare(`
      UPDATE hub_credentials SET revoked_at = $revokedAt
      WHERE id = $id AND revoked_at IS NULL
    `);
  }

  issue(request: IssueCredentialRequest): IssuedCredential {
    if (typeof request.principalId !== "string" || request.principalId === "") {
      throw new Error("CredentialRegistry.issue: principalId must not be empty");
    }
    if (typeof request.deviceId !== "string" || request.deviceId === "") {
      throw new Error("CredentialRegistry.issue: deviceId must not be empty");
    }
    for (const workspace of request.workspaces) {
      try {
        if (parseWorkspaceId(workspace).uuid !== workspace) throw new Error();
      } catch {
        throw new Error("CredentialRegistry.issue: workspaces must be bare UUIDs");
      }
    }
    const record: CredentialRecord = {
      id: globalThis.crypto.randomUUID(),
      principalId: request.principalId,
      deviceId: request.deviceId,
      workspaces: [...new Set(request.workspaces)].sort(),
      issuedAt: Date.now(),
      revokedAt: null,
    };
    const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    this.insert.run({
      id: record.id,
      principalId: record.principalId,
      deviceId: record.deviceId,
      workspaces: JSON.stringify(record.workspaces),
      key: keyBytes,
      issuedAt: record.issuedAt,
    });
    return { record, keyBytes };
  }

  /** Fresh public values: mutating a returned record cannot change the registry. */
  get(id: string): CredentialRecord | null {
    const row = this.select.get({ id }) as unknown as CredentialRow | undefined;
    return row === undefined ? null : recordFromRow(row);
  }

  async verify(token: string): Promise<CredentialVerification> {
    const lookup = readTokenKeyId(token);
    if ("failure" in lookup) return { failure: lookup.failure };
    if (lookup.kid === null) return { failure: "root-key" };
    const record = this.get(lookup.kid);
    if (record === null) return { failure: "unknown-credential" };
    if (record.revokedAt !== null) return { failure: "revoked-credential" };
    const row = this.selectKey.get({ id: record.id });
    const keyBytes = row?.signing_key;
    if (!(keyBytes instanceof Uint8Array)) {
      throw new Error("CredentialRegistry.verify: signing key is missing");
    }
    const inspected = await inspectToken(await importCredentialKey(keyBytes), token);
    if ("failure" in inspected) return { failure: inspected.failure };
    const clampFailure = clampToken(inspected, Math.floor(Date.now() / 1000));
    if (clampFailure !== null) return { failure: clampFailure };
    // Both key import and signature verification yield. A revoke in either
    // interval must win over a signature that was already being checked.
    const current = this.get(record.id);
    if (current === null) return { failure: "unknown-credential" };
    if (current.revokedAt !== null) return { failure: "revoked-credential" };
    return { record: current, claims: inspected };
  }

  /**
   * Persist first, then synchronously fence and close admitted connections.
   * Every listener runs even if another fails; a failure is visible and leaves
   * the credential durably revoked rather than pretending to roll it back.
   */
  revoke(id: string): boolean {
    const result = this.markRevoked.run({ id, revokedAt: Date.now() });
    const changed = result.changes !== 0;
    // A previous listener failure left the row revoked. Retrying must still
    // fence every connection before it can report success to its caller.
    if (!changed && this.get(id) === null) return false;
    const failures: unknown[] = [];
    for (const listener of this.revokeListeners) {
      try {
        listener(id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "CredentialRegistry.revoke: closure failed");
    }
    return changed;
  }

  onRevoke(listener: (credentialId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }
}
