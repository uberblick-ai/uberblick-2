import { copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importCredentialKey, MAX_TOKEN_LIFETIME_SECONDS, mintToken, type TokenScope } from "@uberblick/schema/token";
import { AgentGrantRegistry } from "../src/agent-grants.js";
import { CredentialRegistry } from "../src/credentials.js";
import { HubAdminRegistry } from "../src/hub-admins.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import {
  generateTestCredentialKeyPair,
  issueCredential,
  mintDeviceRequestProof,
  renewCredential,
  replacementCredential,
  type TestCredential,
} from "./device-credentials.js";
import { OTHER_WORKSPACE, removeTempDatabases, tempDatabasePath, WORKSPACE } from "./helpers.js";

const PRINCIPAL = "grant-person";
const databases: HubDatabase[] = [];

function registry(path = ":memory:") {
  const db = new HubDatabase(path, (error) => { throw error; });
  db.open();
  databases.push(db);
  return {
    db,
    store: new CredentialRegistry(db),
    grants: new AgentGrantRegistry(db),
    memberships: new MembershipRegistry(db),
    admins: new HubAdminRegistry(db),
  };
}

function issueForGrant(store: CredentialRegistry, grantId: string): TestCredential {
  const pair = generateTestCredentialKeyPair();
  const issued = store.issueForGrant(grantId, pair.publicKey);
  if (issued === null) throw new Error("expected grant issuance to succeed");
  return { ...issued, keyBytes: pair.keyBytes };
}

async function roomToken(issued: TestCredential) {
  return mintToken(await importCredentialKey(issued.keyBytes), {
    typ: "room", sub: PRINCIPAL, workspace: WORKSPACE, scope: "read-only",
    kid: issued.record.id, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });
}

async function renewalProof(issued: TestCredential) {
  return mintDeviceRequestProof(await importCredentialKey(issued.keyBytes), {
    kid: issued.record.id, operation: "renew-credential", lifetimeSeconds: 60,
  });
}

function createGrant(context: ReturnType<typeof registry>, scope: TokenScope = "read-only") {
  context.memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "member" });
  return context.grants.create({ clientId: "hosted-client", principalId: PRINCIPAL, workspaceId: WORKSPACE, scope });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  removeTempDatabases();
});

describe("hosted grant credential ceilings", () => {
  it.each(["read-only", "read-write"] as const)("derives the principal, workspace and %s ceiling from the live grant", (scope) => {
    const context = registry();
    const grant = createGrant(context, scope);
    context.memberships.grant({ principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "admin" });
    const pair = generateTestCredentialKeyPair();
    const issued = context.store.issueForGrant(grant.id, pair.publicKey)!;
    expect(issued.record).toEqual(expect.objectContaining({
      principalId: PRINCIPAL, deviceId: grant.deviceId, workspaces: [WORKSPACE],
      ceiling: { grantId: grant.id, workspaceId: WORKSPACE, scope },
    }));
    expect(context.db.connection.prepare("SELECT public_key FROM hub_credentials WHERE id = ?")
      .get(issued.record.id)?.public_key).toEqual(pair.publicKey);
    issued.record.ceiling!.workspaceId = OTHER_WORKSPACE;
    issued.record.ceiling!.scope = scope === "read-only" ? "read-write" : "read-only";
    expect(context.store.get(issued.record.id)?.ceiling).toEqual({ grantId: grant.id, workspaceId: WORKSPACE, scope });
  });

  it("refuses unknown, revoked and no-longer-member grants without issuing a credential", () => {
    const context = registry();
    const revoked = createGrant(context);
    context.memberships.grant({ principalId: "removed-person", workspaceId: WORKSPACE, role: "member" });
    const removed = context.grants.create({ clientId: "hosted-client", principalId: "removed-person",
      workspaceId: WORKSPACE, scope: "read-only" });
    context.grants.revoke(revoked.id);
    context.memberships.remove({ principalId: "removed-person", workspaceId: WORKSPACE });
    const publicKey = generateTestCredentialKeyPair().publicKey;
    expect(context.store.issueForGrant(crypto.randomUUID(), publicKey)).toBeNull();
    expect(context.store.issueForGrant(revoked.id, publicKey)).toBeNull();
    expect(context.store.issueForGrant(removed.id, publicKey)).toBeNull();
    expect(context.db.connection.prepare("SELECT COUNT(*) AS count FROM hub_credentials").get()?.count).toBe(0);
  });

  it("replaces one grant's credentials across restart and isolates key reuse and device revocation", async () => {
    const path = tempDatabasePath();
    const first = registry(path);
    const grant = createGrant(first);
    const otherGrant = createGrant(first);
    const original = issueForGrant(first.store, grant.id);
    const other = issueForGrant(first.store, otherGrant.id);
    const laptop = issueCredential(first.store, { principalId: PRINCIPAL, deviceId: "laptop", workspaces: [WORKSPACE] });
    expect(new Set([original.record.deviceId, other.record.deviceId, laptop.record.deviceId]).size).toBe(3);
    first.db.close();

    const restarted = registry(path);
    const replacement = issueForGrant(restarted.store, grant.id);
    expect(replacement.record.deviceId).toBe(original.record.deviceId);
    expect(replacement.record.ceiling).toEqual(original.record.ceiling);
    expect(restarted.store.get(original.record.id)).toEqual(expect.objectContaining({ revokedAt: null, replacedAt: expect.any(Number) }));
    expect(restarted.grants.get(grant.id)?.revokedAt).toBeNull();
    expect(await restarted.store.verify(await roomToken(original))).toEqual({ failure: "replaced-credential" });
    expect(await restarted.store.verify(await roomToken(replacement))).toHaveProperty("record", replacement.record);
    expect(await renewCredential(restarted.store, await renewalProof(original), restarted.memberships))
      .toEqual({ status: "already-replaced" });
    expect(await restarted.store.verify(await roomToken(replacement))).toEqual({ failure: "revoked-credential" });
    expect(restarted.store.get(original.record.id)?.revokedAt).toBeTypeOf("number");
    expect(restarted.grants.get(grant.id)?.revokedAt).toBeNull();
    expect(await restarted.store.verify(await roomToken(other))).toHaveProperty("record", other.record);
    expect(await restarted.store.verify(await roomToken(laptop))).toHaveProperty("record", laptop.record);

    const recovered = issueForGrant(restarted.store, grant.id);
    expect(recovered.record.deviceId).toBe(grant.deviceId);
    expect(restarted.store.revokeDevice(PRINCIPAL, recovered.record.deviceId)).toBe(true);
    expect(await restarted.store.verify(await roomToken(recovered))).toEqual({ failure: "revoked-credential" });
    expect(await restarted.store.verify(await roomToken(other))).toHaveProperty("record", other.record);
    expect(await restarted.store.verify(await roomToken(laptop))).toHaveProperty("record", laptop.record);
  });

  it("rolls back a failed replacement without retiring the previous usable key", async () => {
    const context = registry();
    const grant = createGrant(context);
    const original = issueForGrant(context.store, grant.id);
    const before = context.db.connection.prepare("SELECT * FROM hub_credentials").all();
    context.db.connection.exec(`CREATE TRIGGER reject_replacement BEFORE UPDATE OF replaced_at ON hub_credentials
      BEGIN SELECT RAISE(ABORT, 'replacement storage failed'); END`);
    expect(() => issueForGrant(context.store, grant.id)).toThrow("replacement storage failed");
    expect(context.db.connection.prepare("SELECT * FROM hub_credentials").all()).toEqual(before);
    expect(await context.store.verify(await roomToken(original))).toHaveProperty("record", original.record);
    expect(context.grants.get(grant.id)?.revokedAt).toBeNull();
  });

  it("leaves no usable replacement when an admitted connection cannot be closed", () => {
    const context = registry();
    const grant = createGrant(context);
    const original = issueForGrant(context.store, grant.id);
    const closed: string[] = [];
    context.store.onRevoke(() => { throw new Error("cannot close old connection"); });
    context.store.onRevoke(id => { closed.push(id); });
    expect(() => issueForGrant(context.store, grant.id)).toThrow("closure failed");
    const rows = context.db.connection.prepare("SELECT id, revoked_at, replaced_at FROM hub_credentials").all();
    expect(rows).toHaveLength(2);
    expect(context.store.get(original.record.id)).toEqual(expect.objectContaining({ revokedAt: null, replacedAt: expect.any(Number) }));
    const replacement = rows.find(row => row.id !== original.record.id)!;
    expect(replacement.revoked_at).toBeTypeOf("number");
    expect(closed).toEqual([original.record.id, replacement.id]);
    expect(context.grants.get(grant.id)?.revokedAt).toBeNull();
  });

  it.each(["read-only", "read-write"] as const)("keeps a %s ceiling through renewal, suspension and restore", async (scope) => {
    const context = registry();
    const grant = createGrant(context, scope);
    context.admins.setWorkspaceStatus(WORKSPACE, "suspended");
    const original = issueForGrant(context.store, grant.id);
    expect(original.record.workspaces).toEqual([]);
    const ceiling = { grantId: grant.id, workspaceId: WORKSPACE, scope };
    expect(original.record.ceiling).toEqual(ceiling);
    context.memberships.grant({ principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "member" });
    const suspended = replacementCredential(await renewCredential(context.store, await renewalProof(original), context.memberships));
    expect(suspended.record.workspaces).toEqual([]);
    expect(suspended.record.ceiling).toEqual(ceiling);
    context.admins.setWorkspaceStatus(WORKSPACE, "active");
    const restored = replacementCredential(await renewCredential(context.store, await renewalProof(suspended), context.memberships,
      { ifWorkspacesChanged: true }));
    expect(restored.record.workspaces).toEqual([WORKSPACE]);
    expect(restored.record.ceiling).toEqual(ceiling);
    expect(restored.record.deviceId).toBe(grant.deviceId);
    expect(context.store.get(restored.record.id)?.ceiling).toEqual(ceiling);
    expect(context.grants.get(grant.id)?.revokedAt).toBeNull();
  });

  it("upgrades existing laptop rows with no ceiling, preserving document bytes and membership renewal", async () => {
    const path = tempDatabasePath();
    copyFileSync(fileURLToPath(new URL("./fixtures/extension-sqlite.sqlite", import.meta.url)), path);
    const legacy = new DatabaseSync(path);
    const pair = generateTestCredentialKeyPair();
    const credentialId = crypto.randomUUID();
    const issuedAt = Date.now();
    const before = legacy.prepare("SELECT name, data FROM documents ORDER BY name").all();
    expect(before.length).toBeGreaterThan(0);
    legacy.exec(`CREATE TABLE hub_credentials (
      id TEXT PRIMARY KEY NOT NULL, principal_id TEXT NOT NULL, device_id TEXT NOT NULL,
      device_name TEXT, workspaces TEXT NOT NULL, public_key BLOB, issued_at INTEGER NOT NULL,
      revoked_at INTEGER, replaced_at INTEGER
    )`);
    legacy.prepare(`INSERT INTO hub_credentials
      (id, principal_id, device_id, workspaces, public_key, issued_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(credentialId, PRINCIPAL, "old-laptop", JSON.stringify([WORKSPACE]), pair.publicKey, issuedAt);
    legacy.close();

    const upgraded = new HubDatabase(path, error => { throw error; });
    upgraded.open();
    try {
      expect(upgraded.connection.prepare("SELECT ceiling FROM hub_credentials WHERE id = ?")
        .get(credentialId)?.ceiling).toBeNull();
    } finally {
      upgraded.close();
    }
    const context = registry(path);
    const record = context.store.get(credentialId)!;
    expect(record).not.toHaveProperty("ceiling");
    const laptop = { record, keyBytes: pair.keyBytes };
    expect(await context.store.verify(await roomToken(laptop))).toHaveProperty("record", record);
    context.memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "member" });
    context.memberships.grant({ principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "member" });
    const renewed = replacementCredential(await renewCredential(context.store, await renewalProof(laptop), context.memberships));
    expect(renewed.record.workspaces).toEqual([WORKSPACE, OTHER_WORKSPACE].sort());
    expect(renewed.record).not.toHaveProperty("ceiling");
    context.db.close();
    const reopened = registry(path);
    expect(reopened.store.get(renewed.record.id)).not.toHaveProperty("ceiling");
    expect(await reopened.store.verify(await roomToken(renewed))).toHaveProperty("record", renewed.record);
    expect(reopened.db.connection.prepare("SELECT name, data FROM documents ORDER BY name").all()).toEqual(before);
  });
});
