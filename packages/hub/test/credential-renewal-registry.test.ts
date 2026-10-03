import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRegistry, type IssuedCredential } from "../src/credentials.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { importCredentialKey, mintRequestProof, mintToken } from "../src/token.js";
import { WORKSPACE, OTHER_WORKSPACE } from "./helpers.js";

const databases: HubDatabase[] = [];
function rig(legacy = false) {
  const db = new HubDatabase(":memory:", () => {});
  databases.push(db);
  db.open();
  const legacyIssued: IssuedCredential = { record: { id: crypto.randomUUID(), principalId: "person",
    deviceId: "laptop", workspaces: [], issuedAt: Date.now(), revokedAt: null, replacedAt: null },
    keyBytes: crypto.getRandomValues(new Uint8Array(32)) };
  if (legacy) {
    db.connection.exec(`CREATE TABLE hub_credentials (
    id TEXT PRIMARY KEY, principal_id TEXT, device_id TEXT, workspaces TEXT,
    signing_key BLOB, issued_at INTEGER, revoked_at INTEGER)`);
    db.connection.prepare("INSERT INTO hub_credentials VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(legacyIssued.record.id, "person", "laptop", "[]", legacyIssued.keyBytes, legacyIssued.record.issuedAt, null);
  }
  const credentials = new CredentialRegistry(db);
  const memberships = new MembershipRegistry(db);
  const issued = legacy ? legacyIssued : credentials.issue({ principalId: "person", deviceId: "laptop", workspaces: [] });
  return { db, credentials, memberships, issued };
}
async function proof(issued: IssuedCredential) {
  return mintRequestProof(await importCredentialKey(issued.keyBytes), {
    kid: issued.record.id, operation: "renew-credential", lifetimeSeconds: 60,
  });
}
async function roomToken(issued: IssuedCredential) {
  return mintToken(await importCredentialKey(issued.keyBytes), {
    typ: "room", sub: "untrusted", workspace: WORKSPACE, scope: "read-write",
    kid: issued.record.id, lifetimeSeconds: 60,
  });
}
function barrier() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  return { held, reached, release, reach };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

describe("atomic credential renewal", () => {
  it("upgrades an already-created credential table and snapshots memberships after verification", async () => {
    const { db, credentials, memberships, issued } = rig(true);
    const signed = await proof(issued);
    const gate = barrier();
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      gate.reach(); await gate.held; return verify(...args);
    });
    const renewal = credentials.renew(signed, memberships);
    await gate.reached;
    try {
      memberships.grant({ workspaceId: OTHER_WORKSPACE, principalId: "person", role: "member" });
      memberships.grant({ workspaceId: WORKSPACE, principalId: "person", role: "admin" });
    } finally { gate.release(); }
    const result = await renewal;
    expect(result).toMatchObject({ status: "complete", credential: { record: {
      principalId: "person", deviceId: "laptop", workspaces: [WORKSPACE, OTHER_WORKSPACE].sort(),
      revokedAt: null, replacedAt: null,
    } } });
    expect(credentials.get(issued.record.id)?.replacedAt).toBeTypeOf("number");
    expect(db.connection.prepare("PRAGMA table_info(hub_credentials)").all()
      .filter((column) => column.name === "replaced_at")).toHaveLength(1);
    expect(new CredentialRegistry(db).get(issued.record.id)?.replacedAt).toBeTypeOf("number");
  });

  it.each(["importKey", "verify"] as const)("revocation during %s prevents a replacement", async (method) => {
    const { db, credentials, memberships, issued } = rig();
    const signed = await proof(issued);
    const gate = barrier();
    const original = crypto.subtle[method].bind(crypto.subtle);
    vi.spyOn(crypto.subtle, method).mockImplementation((async (...args: unknown[]) => {
      gate.reach(); await gate.held;
      return (original as (...args: unknown[]) => unknown)(...args);
    }) as typeof crypto.subtle[typeof method]);
    const renewal = credentials.renew(signed, memberships);
    await gate.reached;
    try { credentials.revoke(issued.record.id); } finally { gate.release(); }
    expect(await renewal).toEqual({ status: "sign-in-required" });
    expect(db.connection.prepare("SELECT id FROM hub_credentials").all()).toHaveLength(1);
  });

  it("allows only one of two simultaneous exchanges and refuses every completed replay", async () => {
    const { db, credentials, memberships, issued } = rig();
    const signed = await proof(issued);
    const results = await Promise.all([credentials.renew(signed, memberships), credentials.renew(signed, memberships)]);
    expect(results.filter((result) => result.status === "complete")).toHaveLength(1);
    expect(results.filter((result) => result.status === "replaced-credential")).toHaveLength(1);
    expect(await credentials.renew(signed, memberships)).toEqual({ status: "replaced-credential" });
    expect(db.connection.prepare("SELECT id FROM hub_credentials WHERE revoked_at IS NULL AND replaced_at IS NULL")
      .all()).toHaveLength(1);
  });

  it("refuses an old room token whose signature verification overlaps replacement", async () => {
    const { credentials, memberships, issued } = rig();
    const signed = await roomToken(issued);
    const renewalProof = await proof(issued);
    const gate = barrier();
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "verify").mockImplementationOnce(async (...args) => {
      gate.reach(); await gate.held; return verify(...args);
    });
    const admission = credentials.verify(signed);
    await gate.reached;
    try { expect((await credentials.renew(renewalProof, memberships)).status).toBe("complete"); }
    finally { gate.release(); }
    expect(await admission).toEqual({ failure: "replaced-credential" });
  });

  it("rolls issuance back if retirement cannot persist", async () => {
    const { db, credentials, memberships, issued } = rig();
    db.connection.exec(`CREATE TRIGGER fail_retirement BEFORE UPDATE OF replaced_at ON hub_credentials
      BEGIN SELECT RAISE(ABORT, 'retirement unavailable'); END`);
    await expect(credentials.renew(await proof(issued), memberships)).rejects.toThrow("retirement unavailable");
    expect(credentials.get(issued.record.id)?.replacedAt).toBeNull();
    expect(db.connection.prepare("SELECT id FROM hub_credentials").all()).toHaveLength(1);
    expect(await credentials.verify(await roomToken(issued))).toHaveProperty("record");
  });

  it("runs every retirement listener and leaves no usable key when closure fails", async () => {
    const { db, credentials, memberships, issued } = rig();
    const closed: string[] = [];
    credentials.onRevoke(() => { throw new Error("closure unavailable"); });
    credentials.onRevoke((id) => { closed.push(id); });
    await expect(credentials.renew(await proof(issued), memberships)).rejects.toThrow("closure failed");
    expect(closed).toContain(issued.record.id);
    expect(closed).toHaveLength(2);
    expect(db.connection.prepare("SELECT id FROM hub_credentials WHERE revoked_at IS NULL AND replaced_at IS NULL")
      .all()).toHaveLength(0);
  });

  it("a revocation in a retirement listener leaves no usable replacement", async () => {
    const { db, credentials, memberships, issued } = rig();
    const unsubscribe = credentials.onRevoke((id) => {
      if (id === issued.record.id) { unsubscribe(); credentials.revoke(id); }
    });
    expect(await credentials.renew(await proof(issued), memberships)).toEqual({ status: "sign-in-required" });
    expect(db.connection.prepare("SELECT id FROM hub_credentials WHERE revoked_at IS NULL AND replaced_at IS NULL")
      .all()).toHaveLength(0);
  });
});
