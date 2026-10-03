/**
 * Hub-owned device credentials. These rows share the document database handle
 * and its backups, but are never synchronized document content. Independent
 * random signing keys keep the legacy shared root and other devices powerless
 * over a credential. Issuance and renewal return each new key once.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { parseWorkspaceId } from "@uberblick/schema";
import type { HubDatabase } from "./persistence.js";
import type { MembershipRegistry } from "./memberships.js";
import {
  type ClampFailure,
  type TokenClaims,
  type TokenFailure,
  clampToken,
  importCredentialKey,
  inspectToken,
  inspectRequestProof,
  readTokenKeyId,
} from "./token.js";

export interface CredentialRecord {
  id: string;
  principalId: string;
  deviceId: string;
  workspaces: string[];
  issuedAt: number;
  revokedAt: number | null;
  replacedAt: number | null;
}

export interface IssueCredentialRequest {
  principalId: string;
  deviceId: string;
  workspaces: readonly string[];
}

export interface IssuedCredential {
  record: CredentialRecord;
  /** Returned only on issuance, never by get() or verify(). */
  keyBytes: Uint8Array;
}

export type CredentialRenewal =
  | { status: "renewed"; credential: { record: CredentialRecord; key: string } }
  | { status: "already-replaced" }
  | { status: "sign-in-required" };

/** Specific internal causes; admission sends a single safe refusal. */
export type CredentialFailure =
  | TokenFailure
  | ClampFailure
  | "root-key"
  | "unknown-credential"
  | "revoked-credential"
  | "replaced-credential";

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
  replaced_at: number | null;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS hub_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  workspaces TEXT NOT NULL,
  signing_key BLOB NOT NULL CHECK(length(signing_key) = 32),
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER,
  replaced_at INTEGER
)`;

const PUBLIC_COLUMNS =
  "id, principal_id, device_id, workspaces, issued_at, revoked_at, replaced_at";

function recordFromRow(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    deviceId: row.device_id,
    workspaces: JSON.parse(row.workspaces) as string[],
    issuedAt: row.issued_at,
    revokedAt: row.revoked_at,
    replacedAt: row.replaced_at,
  };
}

/**
 * This internal API fixes authorization at issuance. There is no mutation that
 * widens or restores a credential. Renewal issues a replacement and retires
 * the old key. Configured sign-in and renewal share this registry; live room
 * admission still uses the root secret until the coordinated client cutover.
 */
export class CredentialRegistry {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly select: StatementSync;
  private readonly selectKey: StatementSync;
  private readonly markRevoked: StatementSync;
  private readonly markReplaced: StatementSync;
  private readonly revokeListeners = new Set<(credentialId: string) => void>();

  constructor(database: HubDatabase) {
    const db = database.connection;
    this.db = db;
    db.exec(SCHEMA);
    // Configured sign-in hubs already have this table. CREATE IF NOT EXISTS
    // cannot upgrade it; old rows retain their issued/revoked meaning.
    if (!db.prepare("PRAGMA table_info(hub_credentials)").all()
      .some((column) => column.name === "replaced_at")) {
      db.exec("ALTER TABLE hub_credentials ADD COLUMN replaced_at INTEGER");
    }
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
    this.markReplaced = db.prepare(`
      UPDATE hub_credentials SET replaced_at = $replacedAt
      WHERE id = $id AND revoked_at IS NULL AND replaced_at IS NULL
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
      replacedAt: null,
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
    if (record.replacedAt !== null) return { failure: "replaced-credential" };
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
    if (current.replacedAt !== null) return { failure: "replaced-credential" };
    return { record: current, claims: inspected };
  }

  /** A request proof grants this exchange only, never room admission. */
  async renew(token: string, memberships: MembershipRegistry): Promise<CredentialRenewal> {
    const refusal = { status: "sign-in-required" } as const;
    const lookup = readTokenKeyId(token);
    if ("failure" in lookup || lookup.kid === null) return refusal;
    const row = this.selectKey.get({ id: lookup.kid });
    if (!(row?.signing_key instanceof Uint8Array)) return refusal;
    const proof = await inspectRequestProof(
      await importCredentialKey(row.signing_key), token, "renew-credential",
    );
    if ("failure" in proof || clampToken(proof, Math.floor(Date.now() / 1000)) !== null) {
      return refusal;
    }

    // No await follows the last verification. Check, membership snapshot,
    // issuance and retirement are one transaction on the hub's one handle:
    // a revoke or second exchange that got here first wins, and a failed write
    // cannot leave a second usable credential behind.
    let issued: IssuedCredential;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(proof.kid);
      if (current === null || current.revokedAt !== null) {
        this.db.exec("ROLLBACK");
        return refusal;
      }
      if (current.replacedAt !== null) {
        this.db.exec("ROLLBACK");
        return { status: "already-replaced" };
      }
      issued = this.issue({ principalId: current.principalId, deviceId: current.deviceId,
        workspaces: memberships.workspacesFor(current.principalId) });
      this.markReplaced.run({ id: current.id, replacedAt: Date.now() });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    try {
      this.closeCredential(proof.kid);
    } catch (error) {
      // The old key stays retired; a key we could not deliver must not leave
      // an inaccessible usable replacement after a closure failure.
      this.revoke(issued.record.id);
      throw error;
    }
    // Closure callbacks are synchronous but can themselves revoke access.
    // Such a revocation still landed during the exchange and must win.
    if (this.get(proof.kid)?.revokedAt !== null ||
      this.get(issued.record.id)?.revokedAt !== null) {
      this.revoke(issued.record.id);
      return refusal;
    }
    return { status: "renewed", credential: { record: issued.record,
      key: Buffer.from(issued.keyBytes).toString("base64url") } };
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
    this.closeCredential(id);
    return changed;
  }

  private closeCredential(id: string): void {
    const failures: unknown[] = [];
    for (const listener of this.revokeListeners) {
      try {
        listener(id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "CredentialRegistry: closure failed");
    }
  }

  /** Access-ending listeners run for revocation and replacement alike. */
  onRevoke(listener: (credentialId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }
}
