
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { parseWorkspaceId } from "@uberblick/schema";
import type { HubDatabase } from "./persistence.js";
import type { MembershipRegistry } from "./memberships.js";
import { AgentGrantRegistry } from "./agent-grants.js";
import { HubAdminRegistry } from "./hub-admins.js";
import { sanitizeDeviceName } from "@uberblick/schema/device-name";
import { sanitizeWorkspaceNames } from "@uberblick/schema/workspace-names";
import { WorkspaceNameReader } from "./workspace-names.js";
import {
  type ClampFailure,
  type RequestAction,
  type RequestProofClaims,
  type TokenClaims,
  type TokenFailure,
  type TokenScope,
  DEVICE_CREDENTIAL_LIFETIME_MS,
  clampToken,
  importCredentialPublicKey,
  inspectToken,
  inspectRequestProof,
  readTokenKeyId,
} from "@uberblick/schema/token";
import { type HubLogger, stderrLogger } from "./log.js";
import { CREDENTIAL_SCHEMA } from "./credentials-schema.js";
import { MANAGEMENT_OPERATIONS } from "./access-management.js";

export interface CredentialRecord {
  id: string;
  principalId: string;
  deviceId: string;
  workspaces: string[];
  issuedAt: number;
  revokedAt: number | null;
  replacedAt: number | null;
  ceiling?: CredentialCeiling;
}

export interface CredentialCeiling {
  grantId: string;
  workspaceId: string;
  scope: TokenScope;
}

export interface IssueCredentialRequest {
  principalId: string;
  deviceId: string;
  deviceName?: string;
  workspaces: readonly string[];
  publicKey: Uint8Array;
}

export interface IssuedCredential {
  record: CredentialRecord;
}

export interface DeviceRecord {
  deviceId: string;
  deviceName?: string;
  signedInAt: number;
  workspaces: string[];
  hosted?: true;
  workspaceId?: string;
  workspaceName?: string;
  scope?: TokenScope;
}

export type CredentialRenewal =
  | { status: "renewed"; credential: { record: CredentialRecord; workspaceNames?: Record<string, string> } }
  | { status: "unchanged" }
  | { status: "already-replaced" }
  | { status: "sign-in-required" };

export type UnusableCredential =
  | "unknown-credential"
  | "revoked-credential"
  | "replaced-credential"
  | "expired-credential";

/** Specific internal causes; admission sends a single safe refusal. */
export type CredentialFailure = TokenFailure | ClampFailure | "root-key" | UnusableCredential;

export type CredentialVerification =
  | { record: CredentialRecord; claims: TokenClaims }
  | { failure: CredentialFailure };

export interface CredentialRequestVerification {
  record: CredentialRecord;
  claims: RequestProofClaims;
}

interface CredentialRow {
  id: string;
  principal_id: string;
  device_id: string;
  workspaces: string;
  issued_at: number;
  revoked_at: number | null;
  replaced_at: number | null;
  ceiling: string | null;
}

const PUBLIC_COLUMNS =
  "id, principal_id, device_id, workspaces, issued_at, revoked_at, replaced_at, ceiling";

function recordFromRow(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    deviceId: row.device_id,
    workspaces: JSON.parse(row.workspaces) as string[],
    issuedAt: row.issued_at,
    revokedAt: row.revoked_at,
    replacedAt: row.replaced_at,
    ...(row.ceiling === null ? {} : { ceiling: JSON.parse(row.ceiling) as CredentialCeiling }),
  };
}

/**
 * Existing credentials cannot gain authority or be restored; renewal replaces
 * and retires the key.
 * Admission, sign-in and renewal must share this registry and database handle.
 * Rows belong to hub backups, never synchronized document content.
 */
export class CredentialRegistry {
  private readonly db: DatabaseSync;
  private readonly grants: AgentGrantRegistry;
  private readonly insert: StatementSync;
  private readonly select: StatementSync;
  private readonly selectKey: StatementSync;
  private readonly selectDeviceName: StatementSync;
  private readonly markRevoked: StatementSync;
  private readonly markReplaced: StatementSync;
  private readonly selectDevices: StatementSync;
  private readonly selectDeviceCredentials: StatementSync;
  private readonly markDeviceRevoked: StatementSync;
  private readonly insertUsedProof: StatementSync;
  private readonly deleteExpiredProofs: StatementSync;
  private readonly revokeListeners = new Set<(credentialId: string) => void>();

  constructor(database: HubDatabase, private readonly hubAdmins = new HubAdminRegistry(database),
    private readonly log: HubLogger = stderrLogger, private readonly now: () => number = () => Date.now(),
    private readonly workspaceNames = new WorkspaceNameReader(database)) {
    // Database opening upgrades existing rows before any registry prepares queries.
    const db = database.connection;
    this.db = db;
    db.exec(CREDENTIAL_SCHEMA);
    this.grants = new AgentGrantRegistry(database, this.now);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_used_request_proofs (
      proof TEXT PRIMARY KEY NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS hub_used_request_proofs_expiry ON hub_used_request_proofs(expires_at)");
    this.insertUsedProof = db.prepare(`
      INSERT INTO hub_used_request_proofs (proof, expires_at) VALUES ($proof, $expiresAt)
      ON CONFLICT(proof) DO NOTHING
    `);
    this.deleteExpiredProofs = db.prepare("DELETE FROM hub_used_request_proofs WHERE expires_at < $now");
    this.deleteExpiredProofs.run({ now: Math.floor(this.now() / 1000) });
    this.insert = db.prepare(`
      INSERT INTO hub_credentials
        (id, principal_id, device_id, device_name, workspaces, public_key, issued_at, ceiling)
      VALUES ($id, $principalId, $deviceId, $deviceName, $workspaces, $key, $issuedAt, $ceiling)
    `);
    this.select = db.prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM hub_credentials WHERE id = $id`,
    );
    this.selectKey = db.prepare(
      "SELECT public_key FROM hub_credentials WHERE id = $id",
    );
    this.selectDeviceName = db.prepare(
      "SELECT device_name FROM hub_credentials WHERE id = $id",
    );
    this.markRevoked = db.prepare(`
      UPDATE hub_credentials SET revoked_at = $revokedAt
      WHERE id = $id AND revoked_at IS NULL
    `);
    this.markReplaced = db.prepare(`
      UPDATE hub_credentials SET replaced_at = $replacedAt
      WHERE id = $id AND revoked_at IS NULL AND replaced_at IS NULL
    `);
    // Renewal appends rows; timestamp order can change when the clock moves.
    // Retained insertion order identifies the device's original sign-in.
    this.selectDevices = db.prepare(`
      SELECT current.device_id, current.device_name, current.workspaces,
        (SELECT history.issued_at FROM hub_credentials AS history
          WHERE history.principal_id = current.principal_id
            AND history.device_id = current.device_id
          ORDER BY history.rowid LIMIT 1) AS signed_in_at
      FROM hub_credentials AS current
      WHERE current.principal_id = $principalId
        AND current.ceiling IS NULL
        AND current.revoked_at IS NULL AND current.replaced_at IS NULL
        AND current.issued_at > $oldestIssuedAt
      ORDER BY current.device_id
    `);
    this.selectDeviceCredentials = db.prepare(`
      SELECT id FROM hub_credentials
      WHERE principal_id = $principalId AND device_id = $deviceId ORDER BY id
    `);
    this.markDeviceRevoked = db.prepare(`
      UPDATE hub_credentials SET revoked_at = $revokedAt
      WHERE principal_id = $principalId AND device_id = $deviceId AND revoked_at IS NULL
    `);
  }

  issue(request: IssueCredentialRequest): IssuedCredential {
    return this.issueWithCeiling(request, null);
  }

  /** Internal hosted issuance derives all authority from the live grant. */
  issueForGrant(grantId: string, publicKey: Uint8Array): IssuedCredential | null {
    let issued: IssuedCredential;
    let previousIds: string[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const grant = this.grants.get(grantId);
      if (grant === null || !this.grants.isLive(grantId)) {
        this.db.exec("ROLLBACK");
        return null;
      }
      previousIds = this.selectDeviceCredentials.all({ principalId: grant.principalId, deviceId: grant.deviceId })
        .map(row => row.id as string);
      issued = this.issueWithCeiling({ principalId: grant.principalId, deviceId: grant.deviceId,
        workspaces: [grant.workspaceId], publicKey },
      { grantId: grant.id, workspaceId: grant.workspaceId, scope: grant.scope });
      for (const id of previousIds) this.markReplaced.run({ id, replacedAt: this.now() });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    try {
      this.closeCredentials(previousIds);
    } catch (error) {
      this.revoke(issued.record.id);
      throw error;
    }
    if (!this.grants.isLive(grantId)) {
      this.revoke(issued.record.id);
      return null;
    }
    return "failure" in this.usable(this.get(issued.record.id)) ? null : issued;
  }

  private issueWithCeiling(request: IssueCredentialRequest, ceiling: CredentialCeiling | null): IssuedCredential {
    if (typeof request.principalId !== "string" || request.principalId === "") {
      throw new Error("CredentialRegistry.issue: principalId must not be empty");
    }
    if (typeof request.deviceId !== "string" || request.deviceId === "") {
      throw new Error("CredentialRegistry.issue: deviceId must not be empty");
    }
    if (!(request.publicKey instanceof Uint8Array) || request.publicKey.length !== 32) {
      throw new Error("CredentialRegistry.issue: publicKey must be a 32-byte Ed25519 public key");
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
      workspaces: this.hubAdmins.availableWorkspaces([...new Set(request.workspaces)]).sort(),
      issuedAt: this.now(),
      revokedAt: null,
      replacedAt: null,
      ...(ceiling === null ? {} : { ceiling }),
    };
    this.insert.run({
      id: record.id,
      principalId: record.principalId,
      deviceId: record.deviceId,
      deviceName: sanitizeDeviceName(request.deviceName) ?? null,
      workspaces: JSON.stringify(record.workspaces),
      key: request.publicKey,
      issuedAt: record.issuedAt,
      ceiling: ceiling === null ? null : JSON.stringify(ceiling),
    });
    return { record };
  }

  /** Fresh public values: mutating a returned record cannot change the registry. */
  get(id: string): CredentialRecord | null {
    const row = this.select.get({ id }) as unknown as CredentialRow | undefined;
    return row === undefined ? null : recordFromRow(row);
  }

  remainingLifetime(record: CredentialRecord): number {
    return record.issuedAt + DEVICE_CREDENTIAL_LIFETIME_MS - this.now();
  }

  isExpired(record: CredentialRecord): boolean {
    return this.remainingLifetime(record) <= 0;
  }

  /** Callers pass a fresh read after every await: a revoke, replacement or expiry meanwhile wins. */
  usable(record: CredentialRecord | null): { record: CredentialRecord } | { failure: UnusableCredential } {
    if (record === null) return { failure: "unknown-credential" };
    if (record.revokedAt !== null) return { failure: "revoked-credential" };
    if (record.replacedAt !== null) return { failure: "replaced-credential" };
    if (record.ceiling !== undefined) {
      const grant = this.grants.get(record.ceiling.grantId);
      if (grant === null || grant.revokedAt !== null) return { failure: "revoked-credential" };
    }
    return this.isExpired(record) ? { failure: "expired-credential" } : { record };
  }

  /** Consent grants stay visible independently of their credentials and membership. */
  listDevices(principalId: string): DeviceRecord[] {
    const laptops = this.selectDevices.all({ principalId, oldestIssuedAt: this.now() - DEVICE_CREDENTIAL_LIFETIME_MS }).map((row) => {
      const deviceName = sanitizeDeviceName(row.device_name);
      return {
        deviceId: row.device_id as string,
        ...(deviceName === undefined ? {} : { deviceName }),
        signedInAt: row.signed_in_at as number,
        workspaces: JSON.parse(row.workspaces as string) as string[],
      };
    });
    const grants = this.grants.listForPrincipal(principalId).map(grant => {
      const deviceName = sanitizeDeviceName(grant.clientName);
      const workspaceName = sanitizeWorkspaceNames({ [grant.workspaceId]: this.workspaceNames.read(grant.workspaceId) },
        [grant.workspaceId])?.[grant.workspaceId];
      return {
        deviceId: grant.deviceId, signedInAt: grant.createdAt, workspaces: [grant.workspaceId],
        hosted: true as const, workspaceId: grant.workspaceId, scope: grant.scope,
        ...(deviceName === undefined ? {} : { deviceName }),
        ...(workspaceName === undefined ? {} : { workspaceName }),
      };
    });
    return [...laptops, ...grants].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  /**
   * Valid mutation proofs are spent before returning. After awaiting, callers must
   * synchronously re-read authority and clamp the proof at the operation's time.
   */
  async verifyRequest(token: string, request: RequestAction): Promise<CredentialRequestVerification | null> {
    const proof = await this.signedProof(token, request);
    if (proof === null) return null;
    const current = this.usable(this.get(proof.kid));
    if ("failure" in current || !this.consumeProof(token, proof)) return null;
    return { record: current.record, claims: proof };
  }

  /** Signature only; callers then check current authority and consume the proof. */
  private async signedProof(token: string, request: RequestAction): Promise<RequestProofClaims | null> {
    const lookup = readTokenKeyId(token);
    if ("failure" in lookup || lookup.kid === null) return null;
    const key = await this.publicKey(lookup.kid);
    if (key === null) return null;
    const proof = await inspectRequestProof(key, token, request);
    return "failure" in proof ? null : proof;
  }

  private async publicKey(id: string): Promise<CryptoKey | null> {
    const row = this.selectKey.get({ id });
    return row?.public_key instanceof Uint8Array ? importCredentialPublicKey(row.public_key) : null;
  }

  private consumeProof(token: string, proof: RequestProofClaims): boolean {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (clampToken(proof, nowSeconds) !== null) return false;
    // Expiry itself is still admissible. Cleanup and the unique insert never
    // yield, so another request cannot consume the same proof between them.
    this.deleteExpiredProofs.run({ now: nowSeconds });
    // Read-only management proofs may repeat within their lifetime; a proof
    // for anything that changes state is spent once.
    if (proof.operation !== "renew-credential" && !MANAGEMENT_OPERATIONS[proof.operation].changesState) return true;
    return this.insertUsedProof.run({ proof: token, expiresAt: proof.exp }).changes === 1;
  }

  async verify(token: string): Promise<CredentialVerification> {
    const lookup = readTokenKeyId(token);
    if ("failure" in lookup) return { failure: lookup.failure };
    if (lookup.kid === null) return { failure: "root-key" };
    const found = this.usable(this.get(lookup.kid));
    if ("failure" in found) return found;
    const key = await this.publicKey(lookup.kid);
    if (key === null) throw new Error("CredentialRegistry.verify: public key is missing");
    const inspected = await inspectToken(key, token);
    if ("failure" in inspected) return { failure: inspected.failure };
    const clampFailure = clampToken(inspected, Math.floor(this.now() / 1000));
    if (clampFailure !== null) return { failure: clampFailure };
    // Both key import and signature verification yield. A revoke in either
    // interval must win over a signature that was already being checked.
    const current = this.usable(this.get(lookup.kid));
    return "failure" in current ? current : { record: current.record, claims: inspected };
  }

  /** A request proof grants this exchange only, never room admission. */
  async renew(token: string, memberships: MembershipRegistry, options: {
    publicKey: string;
    ifWorkspacesChanged?: boolean;
  }): Promise<CredentialRenewal> {
    const refusal = { status: "sign-in-required" } as const;
    const proof = await this.signedProof(token, { operation: "renew-credential", publicKey: options.publicKey });
    if (proof === null) return refusal;

    // No await follows verification. Current-row checks, proof consumption,
    // membership snapshot, issuance and retirement share one transaction:
    // a revoke or second exchange that got here first wins, and a failed write
    // cannot leave a second usable credential behind.
    let exchanged: { issued: IssuedCredential } | { reused: CredentialRecord; ids: string[] };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(proof.kid);
      const usable = this.usable(current);
      // A replaced key that signs a fresh proof is reuse, whatever its age.
      const reused = "failure" in usable && usable.failure === "replaced-credential";
      if (current === null || ("failure" in usable && !reused) || !this.consumeProof(token, proof)) {
        this.db.exec("ROLLBACK");
        return refusal;
      }
      if (reused) {
        const ids = this.selectDeviceCredentials.all({ principalId: current.principalId, deviceId: current.deviceId })
          .map((credential) => credential.id as string);
        this.endDevice(current.principalId, current.deviceId);
        this.db.exec("COMMIT");
        exchanged = { reused: current, ids };
      } else {
        if (current.ceiling !== undefined && !this.grants.isLive(current.ceiling.grantId)) {
          this.db.exec("ROLLBACK");
          return refusal;
        }
        const eligible = memberships.workspacesFor(current.principalId)
          .filter(workspace => current.ceiling === undefined || workspace === current.ceiling.workspaceId);
        const workspaces = this.hubAdmins.availableWorkspaces(eligible).sort();
        if (options.ifWorkspacesChanged === true &&
          workspaces.length === current.workspaces.length &&
          workspaces.every((workspace, index) => workspace === current.workspaces[index])) {
          // A denied workspace can be polled without retiring this machine's
          // credential and closing its healthy rooms on every check.
          this.db.exec("COMMIT");
          return { status: "unchanged" };
        }
        const deviceName = sanitizeDeviceName(this.selectDeviceName.get({ id: current.id })?.device_name);
        const issued = this.issueWithCeiling({ principalId: current.principalId, deviceId: current.deviceId,
          ...(deviceName === undefined ? {} : { deviceName }),
          publicKey: Buffer.from(options.publicKey, "base64url"),
          workspaces }, current.ceiling ?? null);
        this.markReplaced.run({ id: current.id, replacedAt: this.now() });
        this.db.exec("COMMIT");
        exchanged = { issued };
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if ("reused" in exchanged) {
      try {
        this.log({ event: "hub.credential.reuse", credentialId: exchanged.reused.id,
          principalId: exchanged.reused.principalId, deviceId: exchanged.reused.deviceId });
      } finally {
        this.closeCredentials(exchanged.ids);
      }
      return { status: "already-replaced" };
    }
    const issued = exchanged.issued;
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
      "failure" in this.usable(this.get(issued.record.id)) ||
      (issued.record.ceiling !== undefined && !this.grants.isLive(issued.record.ceiling.grantId))) {
      this.revoke(issued.record.id);
      return refusal;
    }
    return { status: "renewed", credential: { record: issued.record } };
  }

  /**
   * Persist first, then synchronously fence and close admitted connections.
   * Every listener runs even if another fails; a failure is visible and leaves
   * the credential durably revoked rather than pretending to roll it back.
   */
  revoke(id: string): boolean {
    const result = this.markRevoked.run({ id, revokedAt: this.now() });
    const changed = result.changes !== 0;
    // A previous listener failure left the row revoked. Retrying must still
    // fence every connection before it can report success to its caller.
    if (!changed && this.get(id) === null) return false;
    this.closeCredential(id);
    return changed;
  }

  /**
   * Snapshot and revoke every device row in one transaction without yielding.
   * Include committed replacements; verifying exchanges fail their current-row check.
   * Retain sign-in history for closure retries; owned revoked devices still return true.
   */
  revokeDevice(principalId: string, deviceId: string): boolean {
    let ids: string[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      ids = this.selectDeviceCredentials.all({ principalId, deviceId })
        .map((row) => row.id as string);
      const grant = this.grants.getForDevice(principalId, deviceId);
      if (ids.length === 0 && grant === null) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.endDevice(principalId, deviceId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.closeCredentials(ids);
    return true;
  }

  /** Called inside the revocation transaction, never by credential replacement or expiry. */
  private endDevice(principalId: string, deviceId: string): void {
    this.markDeviceRevoked.run({ principalId, deviceId, revokedAt: this.now() });
    const grant = this.grants.getForDevice(principalId, deviceId);
    if (grant !== null) this.grants.revoke(grant.id);
  }

  private closeCredential(id: string): void {
    this.closeCredentials([id]);
  }

  private closeCredentials(ids: readonly string[]): void {
    const failures: unknown[] = [];
    for (const id of ids) {
      for (const listener of this.revokeListeners) {
        try {
          listener(id);
        } catch (error) {
          failures.push(error);
        }
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
