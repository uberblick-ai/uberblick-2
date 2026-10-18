import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRegistry, type IssuedCredential } from "../src/credentials.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubAdminRegistry } from "../src/hub-admins.js";
import { HubDatabase } from "../src/persistence.js";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  REQUEST_PROOF_LIFETIME_SECONDS,
  importCredentialKey,
  importRootSecret,
  mintRequestProof,
  mintToken,
} from "@uberblick/schema/token";
import { OTHER_WORKSPACE, WORKSPACE, removeTempDatabases, tempDatabasePath } from "./helpers.js";

const PRINCIPAL = "person";
const DEVICE = "laptop";
const databases: HubDatabase[] = [];

function database(path = ":memory:"): HubDatabase {
  const opened = new HubDatabase(path, (error) => { throw error; });
  opened.open();
  databases.push(opened);
  return opened;
}

function registry(path = ":memory:") {
  const db = database(path);
  return { db, store: new CredentialRegistry(db), memberships: new MembershipRegistry(db) };
}

function issue(store: CredentialRegistry, workspaces: string[] = [WORKSPACE]): IssuedCredential {
  return store.issue({ principalId: PRINCIPAL, deviceId: DEVICE, workspaces });
}

async function proof(issued: IssuedCredential, options: { key?: CryptoKey; kid?: string; iat?: number } = {}) {
  return mintRequestProof(options.key ?? await importCredentialKey(issued.keyBytes), {
    kid: options.kid ?? issued.record.id,
    operation: "renew-credential",
    lifetimeSeconds: REQUEST_PROOF_LIFETIME_SECONDS,
    ...(options.iat === undefined ? {} : { iat: options.iat }),
  });
}

async function roomToken(issued: IssuedCredential) {
  return mintToken(await importCredentialKey(issued.keyBytes), {
    typ: "room", sub: "untrusted-client-identity", workspace: WORKSPACE,
    scope: "read-write", kid: issued.record.id, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });
}

function replacement(result: Awaited<ReturnType<CredentialRegistry["renew"]>>): IssuedCredential {
  if (result.status !== "renewed") throw new Error("expected a successful renewal");
  return { record: result.credential.record, keyBytes: Buffer.from(result.credential.key, "base64url") };
}

function states(db: HubDatabase) {
  return db.connection.prepare(
    "SELECT id, revoked_at, replaced_at FROM hub_credentials ORDER BY id",
  ).all();
}

function usableCount(db: HubDatabase): number {
  return db.connection.prepare(
    "SELECT COUNT(*) AS count FROM hub_credentials WHERE revoked_at IS NULL AND replaced_at IS NULL",
  ).get()?.count as number;
}

function holdVerification() {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const originalVerify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    entered();
    await held;
    return originalVerify(...args);
  });
  return { reached, release };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  removeTempDatabases();
});

describe("device credential renewal", () => {
  it("omits suspended workspaces once, polls without retiring healthy rooms, and rediscovers restored access", async () => {
    const { db, store, memberships } = registry();
    const admins = new HubAdminRegistry(db);
    admins.grant("hub-admin");
    memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "admin" });
    memberships.grant({ principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "member" });
    const original = issue(store, [WORKSPACE, OTHER_WORKSPACE]);
    const device = store.listDevices(PRINCIPAL)[0]!;
    const closed = vi.fn();
    store.onRevoke(closed);
    admins.setWorkspaceStatus("hub-admin", WORKSPACE, "suspended");
    expect(store.get(original.record.id)).toEqual(original.record);
    expect(store.issue({ principalId: "new-device", deviceId: "new", workspaces: [WORKSPACE, OTHER_WORKSPACE] })
      .record.workspaces).toEqual([OTHER_WORKSPACE]);

    const renewed = replacement(await store.renew(await proof(original), memberships));
    expect(renewed.record.workspaces).toEqual([OTHER_WORKSPACE]);
    expect(closed).toHaveBeenCalledExactlyOnceWith(original.record.id);
    const now = Math.floor(Date.now() / 1000);
    const before = states(db);
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = await proof(renewed, { iat: now + attempt });
      expect(await store.renew(request, memberships, { ifWorkspacesChanged: true })).toEqual({ status: "unchanged" });
    }
    expect(states(db)).toEqual(before);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(memberships.workspacesFor(PRINCIPAL)).toEqual([WORKSPACE, OTHER_WORKSPACE].sort());
    expect(memberships.roleFor(WORKSPACE, PRINCIPAL)).toBe("admin");

    admins.setWorkspaceStatus("hub-admin", WORKSPACE, "active");
    const restored = replacement(await store.renew(await proof(renewed, { iat: now + 3 }), memberships, { ifWorkspacesChanged: true }));
    expect(restored.record.workspaces).toEqual([WORKSPACE, OTHER_WORKSPACE].sort());
    expect(store.listDevices(PRINCIPAL)).toEqual([{ ...device, workspaces: restored.record.workspaces }]);
  });

  it("reads suspension after the last awaited renewal proof verification", async () => {
    const { db, store, memberships } = registry();
    const admins = new HubAdminRegistry(db);
    admins.grant("hub-admin");
    memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "admin" });
    const original = issue(store);
    const request = await proof(original);
    const barrier = holdVerification();
    const renewing = store.renew(request, memberships);
    await barrier.reached;
    try { admins.setWorkspaceStatus("hub-admin", WORKSPACE, "suspended"); }
    finally { barrier.release(); }
    expect(replacement(await renewing).record.workspaces).toEqual([]);
    expect(memberships.roleFor(WORKSPACE, PRINCIPAL)).toBe("admin");
  });

  it("preserves the device name, UUID and original sign-in time across renewal and restart", async () => {
    const path = tempDatabasePath();
    const first = registry(path);
    const original = first.store.issue({ principalId: PRINCIPAL, deviceId: DEVICE, deviceName: "agent-server", workspaces: [] });
    const originalDevice = first.store.listDevices(PRINCIPAL)[0];
    expect(originalDevice).toEqual({ deviceId: DEVICE, deviceName: "agent-server", signedInAt: original.record.issuedAt, workspaces: [] });
    const renewed = replacement(await first.store.renew(await proof(original), first.memberships));
    expect(renewed.record).not.toHaveProperty("deviceName");
    expect(renewed.record.deviceId).toBe(original.record.deviceId);
    expect(first.store.listDevices(PRINCIPAL)).toEqual([originalDevice]);
    first.db.close();
    const restarted = registry(path);
    expect(restarted.store.listDevices(PRINCIPAL)).toEqual([originalDevice]);
    const next = replacement(await restarted.store.renew(await proof(renewed), restarted.memberships));
    expect(restarted.store.listDevices(PRINCIPAL)).toEqual([originalDevice]);
    expect(restarted.store.revokeDevice(PRINCIPAL, DEVICE)).toBe(true);
    expect(restarted.store.listDevices(PRINCIPAL)).toEqual([]);
    expect(await restarted.store.verify(await roomToken(next))).toEqual({ failure: "revoked-credential" });
  });

  it("ignores invalid stored display metadata when listing and renewing a device", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store, []);
    db.connection.prepare("UPDATE hub_credentials SET device_name = ? WHERE id = ?")
      .run("bad\nname", original.record.id);
    expect(store.listDevices(PRINCIPAL)[0]).not.toHaveProperty("deviceName");
    const renewed = replacement(await store.renew(await proof(original), memberships));
    expect(store.listDevices(PRINCIPAL)[0]).not.toHaveProperty("deviceName");
    expect(db.connection.prepare("SELECT device_name FROM hub_credentials WHERE id = ?")
      .get(renewed.record.id)?.device_name).toBeNull();
    expect(await store.verify(await roomToken(renewed))).toHaveProperty("record", renewed.record);
  });

  it("spends an unchanged proof so replay after a grant cannot retire the device's key", async () => {
    const { db, store, memberships } = registry();
    memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "admin" });
    const original = issue(store);
    const now = Math.floor(Date.now() / 1000);
    const request = await proof(original, { iat: now });
    const closed = vi.fn();
    store.onRevoke(closed);
    const before = states(db);
    expect(await store.renew(request, memberships, { ifWorkspacesChanged: true })).toEqual({ status: "unchanged" });
    expect(states(db)).toEqual(before);
    expect(closed).not.toHaveBeenCalled();
    memberships.grant({ principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "member" });
    expect(await store.renew(request, memberships, { ifWorkspacesChanged: true })).toEqual({ status: "sign-in-required" });
    expect(states(db)).toEqual(before);
    expect(closed).not.toHaveBeenCalled();
    expect(await store.verify(await roomToken(original))).toHaveProperty("record", original.record);
    const freshRequest = await proof(original, { iat: now + 1 });
    const next = replacement(await store.renew(freshRequest, memberships, { ifWorkspacesChanged: true }));
    expect(next.record.workspaces).toEqual([WORKSPACE, OTHER_WORKSPACE].sort());
    expect(closed).toHaveBeenCalledExactlyOnceWith(original.record.id);
    expect(await store.renew(freshRequest, memberships, { ifWorkspacesChanged: true })).toEqual({ status: "sign-in-required" });
    store.revoke(next.record.id);
    expect(await store.renew(await proof(next), memberships, { ifWorkspacesChanged: true })).toEqual({ status: "sign-in-required" });
  });

  it("accepts an unchanged proof only once when exchanges arrive concurrently", async () => {
    const { db, store, memberships } = registry();
    memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "admin" });
    const original = issue(store);
    const request = await proof(original);
    const before = states(db);
    const results = await Promise.all([
      store.renew(request, memberships, { ifWorkspacesChanged: true }),
      store.renew(request, memberships, { ifWorkspacesChanged: true }),
    ]);
    expect(results.filter((result) => result.status === "unchanged")).toHaveLength(1);
    expect(results.filter((result) => result.status === "sign-in-required")).toHaveLength(1);
    expect(states(db)).toEqual(before);
    expect(await store.verify(await roomToken(original))).toHaveProperty("record", original.record);
  });

  it("remembers an unchanged proof across restart after the device's workspaces change", async () => {
    const path = tempDatabasePath();
    const first = registry(path);
    first.memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "admin" });
    const original = issue(first.store);
    const now = Math.floor(Date.now() / 1000);
    const request = await proof(original, { iat: now });
    expect(await first.store.renew(request, first.memberships, { ifWorkspacesChanged: true })).toEqual({ status: "unchanged" });
    first.db.close();
    const restarted = registry(path);
    restarted.memberships.grant({ principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "member" });
    const before = states(restarted.db);

    expect(await restarted.store.renew(request, restarted.memberships, { ifWorkspacesChanged: true })).toEqual({ status: "sign-in-required" });
    expect(states(restarted.db)).toEqual(before);
    expect(await restarted.store.verify(await roomToken(original))).toHaveProperty("record", original.record);
    expect(replacement(await restarted.store.renew(await proof(original, { iat: now + 1 }), restarted.memberships,
      { ifWorkspacesChanged: true })).record.workspaces).toEqual([WORKSPACE, OTHER_WORKSPACE].sort());
  });

  it("renews an initially empty credential after direct admin grants without GitHub or further grants", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store, []);
    const originalRoom = await roomToken(original);
    const request = await proof(original);
    memberships.grant({ principalId: "admin", workspaceId: WORKSPACE, role: "admin" });
    memberships.grant({ principalId: "admin", workspaceId: OTHER_WORKSPACE, role: "admin" });
    memberships.grantMember({ actorPrincipalId: "admin", principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "member" });
    memberships.grantMember({ actorPrincipalId: "admin", principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "admin" });
    memberships.grant({ principalId: "another-person", workspaceId: crypto.randomUUID(), role: "admin" });
    const membersBefore = db.connection.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all();
    const github = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("GitHub is unreachable"));
    const closing = vi.fn((id: string) => {
      expect(store.get(id)?.replacedAt).toBeTypeOf("number");
    });
    store.onRevoke(closing);

    const result = await store.renew(request, memberships);
    const renewed = replacement(result);
    expect(renewed.record).toEqual(expect.objectContaining({
      principalId: PRINCIPAL, deviceId: DEVICE, workspaces: [WORKSPACE, OTHER_WORKSPACE].sort(),
      revokedAt: null, replacedAt: null,
    }));
    expect(renewed.record.id).not.toBe(original.record.id);
    expect(renewed.keyBytes).toHaveLength(32);
    expect(renewed.keyBytes).not.toEqual(original.keyBytes);
    expect(github).not.toHaveBeenCalled();
    expect(db.connection.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all()).toEqual(membersBefore);
    expect(closing).toHaveBeenCalledExactlyOnceWith(original.record.id);
    expect(await store.verify(originalRoom)).toEqual({ failure: "replaced-credential" });
    const verified = await store.verify(await roomToken(renewed));
    expect(verified).toHaveProperty("record", renewed.record);
    expect(verified).not.toHaveProperty("key");
    expect(store.get(renewed.record.id)).toEqual(renewed.record);
    expect(store.get(renewed.record.id)).not.toHaveProperty("keyBytes");
    expect(usableCount(db)).toBe(1);
  });

  it("can replace all former workspace limits with none after membership removal", async () => {
    const { store, memberships } = registry();
    memberships.grant({ principalId: "admin", workspaceId: WORKSPACE, role: "admin" });
    memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "member" });
    const original = issue(store);
    memberships.remove({ actorPrincipalId: "admin", principalId: PRINCIPAL, workspaceId: WORKSPACE });

    const renewed = replacement(await store.renew(await proof(original), memberships));
    expect(renewed.record).toEqual(expect.objectContaining({ principalId: PRINCIPAL, deviceId: DEVICE, workspaces: [] }));
    expect(memberships.workspacesFor(PRINCIPAL)).toEqual([]);
    expect(memberships.roleFor(WORKSPACE, "admin")).toBe("admin");
    expect((await store.renew(await proof(renewed), memberships)).status).toBe("renewed");
  });

  it("snapshots membership after the final asynchronous proof check", async () => {
    const { store, memberships } = registry();
    const original = issue(store, []);
    const request = await proof(original);
    const barrier = holdVerification();
    const renewing = store.renew(request, memberships);
    await barrier.reached;
    try {
      memberships.grant({ principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "admin" });
    } finally {
      barrier.release();
    }
    expect(replacement(await renewing).record.workspaces).toEqual([OTHER_WORKSPACE]);
  });

  it("returns only sign-in-required for unknown, revoked and unverified credentials", async () => {
    const { db, store, memberships } = registry();
    const active = issue(store);
    const revoked = issue(store);
    store.revoke(revoked.record.id);
    const stranger = issue(store);
    const before = states(db);
    const requests = [
      await proof(active, { kid: crypto.randomUUID() }),
      await proof(revoked),
      await proof(active, { key: await importCredentialKey(stranger.keyBytes) }),
      await proof(active, { key: await importRootSecret("shared-root-test-secret") }),
      await roomToken(active),
      await proof(active, { iat: 0 }),
      "github-access-token-fixture",
    ];
    // A validly signed proof for another operation must not authorize renewal.
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      typ: "request", kid: active.record.id, operation: "list-devices",
      iat: now, exp: now + REQUEST_PROOF_LIFETIME_SECONDS,
    })).toString("base64url");
    const signature = await crypto.subtle.sign(
      "HMAC", await importCredentialKey(active.keyBytes), new TextEncoder().encode(payload),
    );
    requests.push(`${payload}.${Buffer.from(signature).toString("base64url")}`);

    for (const request of requests) {
      expect(await store.renew(request, memberships)).toEqual({ status: "sign-in-required" });
      expect(states(db)).toEqual(before);
    }
    expect(await store.verify(await roomToken(active))).toHaveProperty("record", active.record);
  });

  it.each([REQUEST_PROOF_LIFETIME_SECONDS + 1, MAX_TOKEN_LIFETIME_SECONDS])(
    "refuses a validly signed renewal proof with a %i-second lifetime without retiring the key", async (lifetime) => {
      const { db, store, memberships } = registry();
      const original = issue(store);
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({
        typ: "request", kid: original.record.id, operation: "renew-credential",
        iat: now, exp: now + lifetime,
      })).toString("base64url");
      const signature = await crypto.subtle.sign(
        "HMAC", await importCredentialKey(original.keyBytes), new TextEncoder().encode(payload),
      );
      const before = states(db);

      expect(await store.renew(`${payload}.${Buffer.from(signature).toString("base64url")}`, memberships))
        .toEqual({ status: "sign-in-required" });
      expect(states(db)).toEqual(before);
      expect(await store.verify(await roomToken(original))).toHaveProperty("record", original.record);
    },
  );

  it("distinguishes a fresh proof for a replaced credential from a spent proof without disclosing its replacement", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    const other = issue(store);
    const now = Math.floor(Date.now() / 1000);
    const request = await proof(original, { iat: now });
    replacement(await store.renew(request, memberships));
    const before = states(db);

    expect(await store.renew(request, memberships)).toEqual({ status: "sign-in-required" });
    expect(await store.renew(await proof(original, { iat: now + 1 }), memberships)).toEqual({ status: "already-replaced" });
    expect(await store.renew(await proof(original, { key: await importCredentialKey(other.keyBytes) }), memberships))
      .toEqual({ status: "sign-in-required" });
    expect(states(db)).toEqual(before);
  });

  it("allows at most one usable result from concurrent exchanges of one credential", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    const request = await proof(original);
    const results = await Promise.all([store.renew(request, memberships), store.renew(request, memberships)]);
    expect(results.filter((result) => result.status === "renewed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "sign-in-required")).toHaveLength(1);
    const winner = results.find((result) => result.status === "renewed");
    if (winner === undefined) throw new Error("renewal had no successful result");
    expect(await store.verify(await roomToken(replacement(winner)))).toHaveProperty("record");
    expect(usableCount(db)).toBe(1);
    expect(states(db)).toHaveLength(2);
  });

  it.each(["before verification", "during verification"])("lets revocation win %s", async (when) => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    const request = await proof(original);
    if (when === "before verification") {
      store.revoke(original.record.id);
      expect(await store.renew(request, memberships)).toEqual({ status: "sign-in-required" });
    } else {
      const barrier = holdVerification();
      const renewing = store.renew(request, memberships);
      await barrier.reached;
      try {
        store.revoke(original.record.id);
      } finally {
        barrier.release();
      }
      expect(await renewing).toEqual({ status: "sign-in-required" });
    }
    expect(usableCount(db)).toBe(0);
    expect(states(db)).toHaveLength(1);
  });

  it("delivers no key when revocation lands while retirement closes connections", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    let revoked = false;
    store.onRevoke((id) => {
      if (id === original.record.id && !revoked) {
        revoked = true;
        store.revoke(id);
      }
    });

    expect(await store.renew(await proof(original), memberships)).toEqual({ status: "sign-in-required" });
    expect(store.get(original.record.id)?.revokedAt).toBeTypeOf("number");
    expect(usableCount(db)).toBe(0);
  });

  it("runs every closure listener and revokes an undelivered replacement on closure failure", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    const closed: string[] = [];
    store.onRevoke(() => { throw new Error("closure failure fixture"); });
    store.onRevoke((id) => { closed.push(id); });

    await expect(store.renew(await proof(original), memberships)).rejects.toThrow();
    const rows = states(db);
    expect(rows).toHaveLength(2);
    const replacementRow = rows.find((row) => row.id !== original.record.id);
    expect(store.get(original.record.id)?.replacedAt).toBeTypeOf("number");
    expect(replacementRow?.revoked_at).toBeTypeOf("number");
    expect(closed).toEqual([original.record.id, replacementRow?.id]);
    expect(usableCount(db)).toBe(0);
  });

  it.each(["insert", "retire"])("rolls back both records when the %s write fails", async (write) => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    const request = await proof(original);
    const before = states(db);
    db.connection.exec(write === "insert"
      ? "CREATE TRIGGER fail_renewal BEFORE INSERT ON hub_credentials BEGIN SELECT RAISE(FAIL, 'insertion failure fixture'); END"
      : "CREATE TRIGGER fail_renewal BEFORE UPDATE OF replaced_at ON hub_credentials BEGIN SELECT RAISE(FAIL, 'retirement failure fixture'); END");

    await expect(store.renew(request, memberships)).rejects.toThrow();
    expect(states(db)).toEqual(before);
    expect(await store.verify(await roomToken(original))).toHaveProperty("record", original.record);
    db.connection.exec("DROP TRIGGER fail_renewal");
    expect((await store.renew(request, memberships)).status).toBe("renewed");
    expect(usableCount(db)).toBe(1);
  });

  it("persists issued, replaced and revoked states across restart and rejects a backup-unknown credential", async () => {
    const path = tempDatabasePath();
    const first = registry(path);
    const original = issue(first.store);
    const originalProof = await proof(original);
    const renewed = replacement(await first.store.renew(originalProof, first.memberships));
    const revoked = issue(first.store);
    first.store.revoke(revoked.record.id);
    const active = issue(first.store);
    first.db.close();
    const restarted = registry(path);

    expect(await restarted.store.renew(originalProof, restarted.memberships)).toEqual({ status: "sign-in-required" });
    expect(await restarted.store.verify(await roomToken(original))).toEqual({ failure: "replaced-credential" });
    expect(await restarted.store.renew(await proof(revoked), restarted.memberships)).toEqual({ status: "sign-in-required" });
    expect(await restarted.store.verify(await roomToken(renewed))).toHaveProperty("record", renewed.record);
    expect(await restarted.store.verify(await roomToken(active))).toHaveProperty("record", active.record);
    const olderBackup = registry();
    expect(await olderBackup.store.renew(await proof(active), olderBackup.memberships)).toEqual({ status: "sign-in-required" });
    expect(states(olderBackup.db)).toEqual([]);
  });

  it("adds replacement state and optional names to legacy credentials while preserving active and revoked rows", async () => {
    const db = database();
    db.connection.exec(`CREATE TABLE hub_credentials (
      id TEXT PRIMARY KEY NOT NULL, principal_id TEXT NOT NULL, device_id TEXT NOT NULL,
      workspaces TEXT NOT NULL, signing_key BLOB NOT NULL CHECK(length(signing_key) = 32),
      issued_at INTEGER NOT NULL, revoked_at INTEGER
    )`);
    const original: IssuedCredential = {
      record: { id: crypto.randomUUID(), principalId: PRINCIPAL, deviceId: DEVICE,
        workspaces: [WORKSPACE], issuedAt: Date.now(), revokedAt: null, replacedAt: null },
      keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    };
    const revoked = { ...original, record: { ...original.record, id: crypto.randomUUID(), revokedAt: Date.now() } };
    const insert = db.connection.prepare(`INSERT INTO hub_credentials
      (id, principal_id, device_id, workspaces, signing_key, issued_at, revoked_at)
      VALUES ($id, $principalId, $deviceId, $workspaces, $key, $issuedAt, $revokedAt)`);
    for (const issued of [original, revoked]) {
      insert.run({ id: issued.record.id, principalId: issued.record.principalId,
        deviceId: issued.record.deviceId, workspaces: JSON.stringify(issued.record.workspaces),
        key: issued.keyBytes, issuedAt: issued.record.issuedAt, revokedAt: issued.record.revokedAt });
    }
    const store = new CredentialRegistry(db);
    const memberships = new MembershipRegistry(db);

    expect(store.get(original.record.id)).toEqual(original.record);
    expect(store.get(revoked.record.id)).toEqual(revoked.record);
    expect(store.listDevices(PRINCIPAL)).toEqual([
      { deviceId: DEVICE, signedInAt: original.record.issuedAt, workspaces: [WORKSPACE] },
    ]);
    expect(await store.verify(await roomToken(original))).toHaveProperty("record", original.record);
    expect(await store.renew(await proof(revoked), memberships)).toEqual({ status: "sign-in-required" });
    expect((await store.renew(await proof(original), memberships)).status).toBe("renewed");
    expect(usableCount(db)).toBe(1);
  });
});
