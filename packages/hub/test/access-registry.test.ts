import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRegistry, type IssuedCredential } from "../src/credentials.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { PrincipalRegistry } from "../src/principals.js";
import {
  type RequestAction,
  importCredentialKey,
  mintRequestProof,
} from "../src/token.js";
import { OTHER_WORKSPACE, WORKSPACE, removeTempDatabases, tempDatabasePath } from "./helpers.js";

const databases: HubDatabase[] = [];

function registry(path = ":memory:") {
  const db = new HubDatabase(path, (error) => { throw error; });
  db.open();
  databases.push(db);
  return {
    db,
    store: new CredentialRegistry(db),
    memberships: new MembershipRegistry(db),
    principals: new PrincipalRegistry(db),
  };
}

function issue(store: CredentialRegistry, deviceId = "laptop", principalId = "person", workspaces = [WORKSPACE]) {
  return store.issue({ principalId, deviceId, workspaces });
}

async function proof(issued: IssuedCredential, action: RequestAction = { operation: "list-devices" }) {
  return mintRequestProof(await importCredentialKey(issued.keyBytes), {
    kid: issued.record.id,
    ...action,
    lifetimeSeconds: 60,
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

/** Hold just the first verification so a racing renewal can still finish. */
function holdVerification() {
  let release!: () => void;
  let entered!: () => void;
  let first = true;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    if (first) {
      first = false;
      entered();
      await held;
    }
    return verify(...args);
  });
  return { reached, release };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  removeTempDatabases();
});

describe("principal-owned device management", () => {
  it("lists only current own devices, preserves sign-in time through renewal, and returns detached limits", async () => {
    const { store, memberships } = registry();
    const signedInAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(signedInAt);
    const laptop = issue(store);
    memberships.grant({ principalId: "person", workspaceId: OTHER_WORKSPACE, role: "member" });
    now.mockReturnValue(signedInAt + 10_000);
    const renewed = replacement(await store.renew(await proof(laptop, { operation: "renew-credential" }), memberships));
    const phone = issue(store, "phone", "person", []);
    const revoked = issue(store, "revoked");
    store.revokeDevice("person", "revoked");
    // A colliding device id on another principal confers no ownership.
    issue(store, "laptop", "another-person");

    const listed = store.listDevices("person");
    expect(listed).toEqual([
      { deviceId: "laptop", signedInAt, workspaces: [OTHER_WORKSPACE] },
      { deviceId: "phone", signedInAt: phone.record.issuedAt, workspaces: [] },
    ]);
    expect(renewed.record.issuedAt).toBeGreaterThan(signedInAt);
    expect(store.get(laptop.record.id)?.replacedAt).toBeTypeOf("number");
    expect(store.get(revoked.record.id)?.revokedAt).toBeTypeOf("number");
    expect(store.listDevices("unknown-principal")).toEqual([]);
    listed[0]?.workspaces.push(WORKSPACE);
    expect(store.listDevices("person")[0]?.workspaces).toEqual([OTHER_WORKSPACE]);
  });

  it("gives foreign and unknown devices the same refusal without mutation or closure", () => {
    const { db, store } = registry();
    const foreign = issue(store, "foreign-device", "another-person");
    const own = issue(store);
    const before = states(db);
    const closed = vi.fn();
    store.onRevoke(closed);

    expect(store.revokeDevice("person", foreign.record.deviceId)).toBe(false);
    expect(store.revokeDevice("person", "unknown-device")).toBe(false);
    expect(store.revokeDevice("unknown-principal", own.record.deviceId)).toBe(false);
    expect(states(db)).toEqual(before);
    expect(closed).not.toHaveBeenCalled();
  });

  it("preserves the original sign-in time when the clock moves backwards before renewal", async () => {
    const { store, memberships } = registry();
    const signedInAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(signedInAt);
    const original = issue(store);
    const renewingProof = await proof(original, { operation: "renew-credential" });
    now.mockReturnValue(signedInAt - 10_000);

    const renewed = replacement(await store.renew(renewingProof, memberships));
    expect(renewed.record.issuedAt).toBeLessThan(original.record.issuedAt);
    expect(store.listDevices("person")).toEqual([
      { deviceId: "laptop", signedInAt, workspaces: [] },
    ]);
  });

  it("revokes the renewal chain while leaving other devices and principals working", async () => {
    const { store, memberships } = registry();
    const original = issue(store);
    const renewed = replacement(await store.renew(await proof(original, { operation: "renew-credential" }), memberships));
    const ownPhone = issue(store, "phone");
    const foreignLaptop = issue(store, "laptop", "another-person");
    const request = await proof(renewed);
    const closed: string[] = [];
    store.onRevoke((id) => {
      expect(store.get(id)?.revokedAt).toBeTypeOf("number");
      closed.push(id);
    });

    expect(store.revokeDevice("person", "laptop")).toBe(true);
    expect(closed.sort()).toEqual([original.record.id, renewed.record.id].sort());
    expect(await store.verifyRequest(request, { operation: "list-devices" })).toBeNull();
    expect(await store.renew(await proof(renewed, { operation: "renew-credential" }), memberships))
      .toEqual({ status: "sign-in-required" });
    expect(await store.verifyRequest(await proof(ownPhone), { operation: "list-devices" })).toHaveProperty("record", ownPhone.record);
    expect(await store.verifyRequest(await proof(foreignLaptop), { operation: "list-devices" })).toHaveProperty("record", foreignLaptop.record);
    expect(store.listDevices("person")).toEqual([
      { deviceId: "phone", signedInAt: ownPhone.record.issuedAt, workspaces: ownPhone.record.workspaces },
    ]);
  });

  it("lets device revocation win while renewal is verifying", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    const request = await proof(original, { operation: "renew-credential" });
    const barrier = holdVerification();
    const renewing = store.renew(request, memberships);
    await barrier.reached;
    try {
      expect(store.revokeDevice("person", "laptop")).toBe(true);
    } finally {
      barrier.release();
    }

    expect(await renewing).toEqual({ status: "sign-in-required" });
    expect(states(db)).toHaveLength(1);
    expect(store.listDevices("person")).toEqual([]);
  });

  it("includes a just-committed replacement when revocation lands during renewal closure", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    let revoked = false;
    store.onRevoke((id) => {
      if (id === original.record.id && !revoked) {
        revoked = true;
        expect(store.revokeDevice("person", "laptop")).toBe(true);
      }
    });

    expect(await store.renew(await proof(original, { operation: "renew-credential" }), memberships))
      .toEqual({ status: "sign-in-required" });
    const rows = states(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => typeof row.revoked_at === "number")).toBe(true);
    expect(store.listDevices("person")).toEqual([]);
  });

  it("runs all closures after commit despite failures, and retries already-revoked rows", async () => {
    const { store, memberships } = registry();
    const original = issue(store);
    const renewed = replacement(await store.renew(await proof(original, { operation: "renew-credential" }), memberships));
    const closed: string[] = [];
    const unsubscribe = store.onRevoke(() => { throw new Error("closure failure fixture"); });
    store.onRevoke((id) => {
      expect(store.get(original.record.id)?.revokedAt).toBeTypeOf("number");
      expect(store.get(renewed.record.id)?.revokedAt).toBeTypeOf("number");
      closed.push(id);
    });
    let failure: unknown;
    try { store.revokeDevice("person", "laptop"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(closed).toHaveLength(2);
    expect(store.listDevices("person")).toEqual([]);
    const revokedAt = store.get(renewed.record.id)?.revokedAt;
    unsubscribe();

    expect(store.revokeDevice("person", "laptop")).toBe(true);
    expect(closed).toHaveLength(4);
    expect(store.get(renewed.record.id)?.revokedAt).toBe(revokedAt);
  });

  it("rolls back every row and closes nothing when a device-wide SQLite update fails partway", async () => {
    const { db, store, memberships } = registry();
    const original = issue(store);
    const renewed = replacement(await store.renew(await proof(original, { operation: "renew-credential" }), memberships));
    const before = states(db);
    const closed = vi.fn();
    store.onRevoke(closed);
    db.connection.exec(`CREATE TRIGGER fail_device_revocation BEFORE UPDATE OF revoked_at ON hub_credentials
      WHEN OLD.id = '${renewed.record.id}' BEGIN SELECT RAISE(FAIL, 'revocation failure fixture'); END`);

    expect(() => store.revokeDevice("person", "laptop")).toThrow("revocation failure fixture");
    expect(states(db)).toEqual(before);
    expect(closed).not.toHaveBeenCalled();
    expect(await store.verifyRequest(await proof(renewed), { operation: "list-devices" })).toHaveProperty("record", renewed.record);
    db.connection.exec("DROP TRIGGER fail_device_revocation");
    expect(store.revokeDevice("person", "laptop")).toBe(true);
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("persists device history and whole-device revocation across restart", async () => {
    const path = tempDatabasePath();
    const first = registry(path);
    const original = issue(first.store);
    const renewed = replacement(await first.store.renew(await proof(original, { operation: "renew-credential" }), first.memberships));
    const phone = issue(first.store, "phone", "person", []);
    first.store.revokeDevice("person", "laptop");
    first.db.close();
    const restarted = registry(path);

    expect(restarted.store.listDevices("person")).toEqual([
      { deviceId: "phone", signedInAt: phone.record.issuedAt, workspaces: [] },
    ]);
    expect(restarted.store.get(original.record.id)?.revokedAt).toBeTypeOf("number");
    expect(restarted.store.get(renewed.record.id)?.revokedAt).toBeTypeOf("number");
    expect(await restarted.store.verifyRequest(await proof(renewed), { operation: "list-devices" })).toBeNull();
    expect(await restarted.store.verifyRequest(await proof(phone), { operation: "list-devices" })).toHaveProperty("record", phone.record);
  });
});

describe("current management credential verification", () => {
  it.each(["revocation", "replacement"] as const)("refuses a proof when %s lands during asynchronous verification", async (change) => {
    const { store, memberships } = registry();
    const original = issue(store, "laptop", "person", []);
    const request = await proof(original);
    const renewingProof = await proof(original, { operation: "renew-credential" });
    const barrier = holdVerification();
    const checking = store.verifyRequest(request, { operation: "list-devices" });
    await barrier.reached;
    try {
      if (change === "revocation") store.revokeDevice("person", "laptop");
      else replacement(await store.renew(renewingProof, memberships));
    } finally {
      barrier.release();
    }

    expect(await checking).toBeNull();
  });

  it("authorizes an empty-limit credential without consulting membership or GitHub", async () => {
    const { store, memberships } = registry();
    const issued = issue(store, "laptop", "person", []);
    const github = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("GitHub unavailable"));

    expect(await store.verifyRequest(await proof(issued), { operation: "list-devices" })).toHaveProperty("record", issued.record);
    expect(github).not.toHaveBeenCalled();
    expect(memberships.workspacesFor("person")).toEqual([]);
  });
});

describe("public principal lookup", () => {
  it("reads stable identities with refreshed GitHub logins and preserves them across restart", () => {
    const path = tempDatabasePath();
    const first = registry(path);
    const original = first.principals.identify("123", "old-login");
    const updated = first.principals.identify("123", "current-login");
    expect(updated.id).toBe(original.id);
    expect(first.principals.get(original.id)).toEqual(updated);
    const detached = first.principals.get(original.id);
    if (detached !== null) detached.githubUsername = "client-value";
    expect(first.principals.get(original.id)?.githubUsername).toBe("current-login");
    expect(first.principals.get("unknown-principal")).toBeNull();
    first.db.close();

    expect(registry(path).principals.get(original.id)).toEqual(updated);
  });
});
