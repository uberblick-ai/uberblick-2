import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRegistry, type IssuedCredential } from "../src/credentials.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  importCredentialKey,
  importRootSecret,
  mintRequestProof,
  mintToken,
} from "../src/token.js";
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
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
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
  it("renews an initially empty credential to exactly current memberships without GitHub or grants", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store, []);
    const originalRoom = await roomToken(original);
    const request = await proof(original);
    memberships.grant({ principalId: PRINCIPAL, workspaceId: WORKSPACE, role: "member" });
    memberships.grant({ principalId: PRINCIPAL, workspaceId: OTHER_WORKSPACE, role: "admin" });
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
      iat: now, exp: now + MAX_TOKEN_LIFETIME_SECONDS,
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

  it("distinguishes a verified replaced credential and completed replay without disclosing its replacement", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    const other = issue(store);
    const request = await proof(original);
    replacement(await store.renew(request, memberships));
    const before = states(db);

    expect(await store.renew(request, memberships)).toEqual({ status: "already-replaced" });
    expect(await store.renew(await proof(original), memberships)).toEqual({ status: "already-replaced" });
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
    expect(results.filter((result) => result.status === "already-replaced")).toHaveLength(1);
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

    expect(await restarted.store.renew(originalProof, restarted.memberships)).toEqual({ status: "already-replaced" });
    expect(await restarted.store.verify(await roomToken(original))).toEqual({ failure: "replaced-credential" });
    expect(await restarted.store.renew(await proof(revoked), restarted.memberships)).toEqual({ status: "sign-in-required" });
    expect(await restarted.store.verify(await roomToken(renewed))).toHaveProperty("record", renewed.record);
    expect(await restarted.store.verify(await roomToken(active))).toHaveProperty("record", active.record);
    const olderBackup = registry();
    expect(await olderBackup.store.renew(await proof(active), olderBackup.memberships)).toEqual({ status: "sign-in-required" });
    expect(states(olderBackup.db)).toEqual([]);
  });

  it("adds replacement state to the existing credential table while preserving active and revoked rows", async () => {
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
    expect(await store.verify(await roomToken(original))).toHaveProperty("record", original.record);
    expect(await store.renew(await proof(revoked), memberships)).toEqual({ status: "sign-in-required" });
    expect((await store.renew(await proof(original), memberships)).status).toBe("renewed");
    expect(usableCount(db)).toBe(1);
  });
});
