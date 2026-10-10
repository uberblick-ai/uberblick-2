import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CredentialRegistry, type IssuedCredential } from "../src/credentials.js";
import { HubDatabase } from "../src/persistence.js";
import {
  MAX_TOKEN_LENGTH,
  MAX_TOKEN_LIFETIME_SECONDS,
  importCredentialKey,
  importRootSecret,
  mintToken,
  readTokenKeyId,
} from "../src/token.js";
import { removeTempDatabases, tempDatabasePath } from "./helpers.js";

const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-000000000002";
const databases: HubDatabase[] = [];

function registry(path = ":memory:"): CredentialRegistry {
  const database = new HubDatabase(path, (error) => { throw error; });
  databases.push(database);
  database.open();
  return new CredentialRegistry(database);
}

function issue(store: CredentialRegistry, deviceId = "laptop"): IssuedCredential {
  return store.issue({ principalId: "person", deviceId, workspaces: [WORKSPACE] });
}

async function token(issued: IssuedCredential, keyBytes = issued.keyBytes): Promise<string> {
  return mintToken(await importCredentialKey(keyBytes), {
    typ: "room",
    sub: "untrusted-client-identity",
    workspace: WORKSPACE,
    scope: "read-write",
    kid: issued.record.id,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  removeTempDatabases();
});

describe("hub-owned credential registry", () => {
  it("persists optional nonunique device names without changing identity or exposing them in credentials", async () => {
    const path = tempDatabasePath();
    const first = registry(path);
    const name = "a".repeat(253);
    const laptop = first.issue({ principalId: "person", deviceId: "laptop", deviceName: name, workspaces: [WORKSPACE] });
    const otherLaptop = first.issue({ principalId: "person", deviceId: "other-laptop", deviceName: name, workspaces: [] });
    const unnamed = issue(first, "legacy");
    first.issue({ principalId: "another-person", deviceId: "foreign", deviceName: "private-host", workspaces: [] });
    expect(laptop.record).not.toHaveProperty("deviceName");
    expect(first.get(laptop.record.id)).not.toHaveProperty("deviceName");
    const expected = [
      { deviceId: unnamed.record.deviceId, signedInAt: unnamed.record.issuedAt, workspaces: [WORKSPACE] },
      { deviceId: laptop.record.deviceId, deviceName: name, signedInAt: laptop.record.issuedAt, workspaces: [WORKSPACE] },
      { deviceId: otherLaptop.record.deviceId, deviceName: name, signedInAt: otherLaptop.record.issuedAt, workspaces: [] },
    ].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    expect(first.listDevices("person")).toEqual(expected);
    databases[0]?.close();
    const restarted = registry(path);
    expect(restarted.listDevices("person")).toEqual(expected);
    expect(await restarted.verify(await token(laptop))).toHaveProperty("record", laptop.record);
    expect(restarted.revokeDevice("person", "foreign")).toBe(false);
    expect(restarted.revokeDevice("person", laptop.record.deviceId)).toBe(true);
    expect(restarted.listDevices("person")).toEqual(expected.filter((row) => row.deviceId !== laptop.record.deviceId));
  });

  it.each(["", "  ", "line\nbreak", "format\u200dcharacter", "control\u0000character", "a".repeat(254)])(
    "ignores an invalid device name without interfering with key issuance", (deviceName) => {
      const store = registry();
      const issued = store.issue({ principalId: "person", deviceId: "laptop", deviceName, workspaces: [] });
      expect(issued.keyBytes).toHaveLength(32);
      expect(store.listDevices("person")).toEqual([
        { deviceId: "laptop", signedInAt: issued.record.issuedAt, workspaces: [] },
      ]);
      expect(databases[0]?.connection.prepare("SELECT device_name FROM hub_credentials").get()?.device_name).toBeNull();
    },
  );

  it("issues distinct keys per device and reveals only public records thereafter", async () => {
    const store = registry();
    const laptop = issue(store);
    const phone = issue(store, "phone");
    expect(laptop.record.id).not.toBe(phone.record.id);
    expect(laptop.keyBytes).toHaveLength(32);
    expect(laptop.keyBytes).not.toEqual(phone.keyBytes);

    const signed = await token(laptop);
    expect(await store.verify(signed)).toEqual({
      record: laptop.record,
      claims: expect.objectContaining({ sub: "untrusted-client-identity", kid: laptop.record.id }),
    });
    expect(Object.keys(store.get(laptop.record.id) ?? {}).sort()).toEqual([
      "deviceId", "id", "issuedAt", "principalId", "replacedAt", "revokedAt", "workspaces",
    ]);
    expect(await store.verify(await token(laptop, phone.keyBytes))).toEqual({ failure: "bad-signature" });

    const rootSigned = await mintToken(await importRootSecret("legacy-root"), {
      typ: "room", sub: "person", workspace: WORKSPACE, scope: "read-write",
      kid: laptop.record.id, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    });
    expect(await store.verify(rootSigned)).toEqual({ failure: "bad-signature" });
  });

  it("fixes a workspace set at issuance and accepts no widening through returned objects", () => {
    const store = registry();
    const requested = [OTHER_WORKSPACE, WORKSPACE, WORKSPACE];
    const issued = store.issue({ principalId: "person", deviceId: "laptop", workspaces: requested });
    const expected = [...new Set(requested)].sort();
    requested.length = 0;
    issued.record.workspaces.push("client-added");
    issued.keyBytes.fill(0);
    const publicRecord = store.get(issued.record.id);
    expect(publicRecord?.workspaces).toEqual(expected);
    if (publicRecord !== null) {
      publicRecord.workspaces.length = 0;
      publicRecord.revokedAt = 123;
    }
    expect(store.get(issued.record.id)?.workspaces).toEqual(expected);
    expect(store.get(issued.record.id)?.revokedAt).toBeNull();
    expect(() => store.issue({ principalId: "person", deviceId: "laptop", workspaces: [`slug-${WORKSPACE}`] }))
      .toThrow("workspaces must be bare UUIDs");
  });

  it("persists revocation before synchronous subscribers run and leaves other devices working", async () => {
    const store = registry();
    const laptop = issue(store);
    const phone = issue(store, "phone");
    const signed = await token(laptop);
    const phoneSigned = await token(phone);
    const events: string[] = [];
    const unsubscribe = store.onRevoke((id) => {
      expect(store.get(id)?.revokedAt).toBeTypeOf("number");
      events.push(id);
    });
    expect(store.revoke(laptop.record.id)).toBe(true);
    expect(events).toEqual([laptop.record.id]);
    expect(store.revoke(laptop.record.id)).toBe(false);
    expect(events).toEqual([laptop.record.id, laptop.record.id]);
    expect(await store.verify(signed)).toEqual({ failure: "revoked-credential" });
    expect(await store.verify(phoneSigned)).toHaveProperty("record", phone.record);
    unsubscribe();
    store.revoke(phone.record.id);
    expect(events).toEqual([laptop.record.id, laptop.record.id]);
  });

  it("runs every closure listener and fails visibly if one cannot close", () => {
    const store = registry();
    const issued = issue(store);
    const closed: string[] = [];
    const unsubscribeFailing = store.onRevoke(() => { throw new Error("closure failed"); });
    store.onRevoke((id) => { closed.push(id); });
    expect(() => store.revoke(issued.record.id)).toThrow("closure failed");
    expect(store.get(issued.record.id)?.revokedAt).toBeTypeOf("number");
    expect(closed).toEqual([issued.record.id]);
    unsubscribeFailing();
    expect(store.revoke(issued.record.id)).toBe(false);
    expect(closed).toEqual([issued.record.id, issued.record.id]);
  });

  it("refuses a token when its credential is revoked during signature verification", async () => {
    const store = registry();
    const issued = issue(store);
    const signed = await token(issued);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const checking = new Promise<void>((resolve) => { reached = resolve; });
    const originalVerify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      reached();
      await held;
      return originalVerify(...args);
    });
    const verifying = store.verify(signed);
    await checking;
    try {
      store.revoke(issued.record.id);
    } finally {
      release();
    }
    expect(await verifying).toEqual({ failure: "revoked-credential" });
  });

  it("keeps issued and revoked credentials across a hub database restart", async () => {
    const path = tempDatabasePath();
    const first = registry(path);
    const laptop = issue(first);
    const phone = issue(first, "phone");
    const laptopSigned = await token(laptop);
    const phoneSigned = await token(phone);
    first.revoke(laptop.record.id);
    databases[0]?.close();
    const restarted = registry(path);
    expect(await restarted.verify(laptopSigned)).toEqual({ failure: "revoked-credential" });
    expect(await restarted.verify(phoneSigned)).toHaveProperty("record", phone.record);
    expect(restarted.get(laptop.record.id)?.revokedAt).toBeTypeOf("number");
  });

  it("opens an existing document database without changing its persisted documents", () => {
    const path = tempDatabasePath();
    copyFileSync(fileURLToPath(new URL("./fixtures/extension-sqlite.sqlite", import.meta.url)), path);
    const store = registry(path);
    const database = databases[0];
    if (database === undefined) throw new Error("fixture database did not open");
    const before = database.connection.prepare("SELECT name, data FROM documents ORDER BY name").all();
    expect(before.length).toBeGreaterThan(0);
    issue(store);
    store.revoke(issue(store, "phone").record.id);
    const after = database.connection.prepare("SELECT name, data FROM documents ORDER BY name").all();
    expect(after).toEqual(before);
    for (const row of after) {
      if (!(row.data instanceof Uint8Array)) throw new Error("invalid fixture data");
      const document = new Y.Doc();
      Y.applyUpdate(document, row.data);
      expect(Y.encodeStateAsUpdate(document)).toEqual(row.data);
      document.destroy();
    }
  });

  it("bounds unverified key hints before looking up credentials", async () => {
    const store = registry();
    const lookup = vi.spyOn(store, "get");
    expect(await store.verify("A".repeat(MAX_TOKEN_LENGTH + 1))).toEqual({ failure: "unparseable" });
    expect(await store.verify("not.a.token")).toEqual({ failure: "unparseable" });
    expect(lookup).not.toHaveBeenCalled();
    const issued = issue(store);
    const signed = await token(issued);
    expect(readTokenKeyId(signed)).toEqual({ kid: issued.record.id });
    const [payload, signature] = signed.split(".");
    expect(readTokenKeyId(`${payload}.${signature}=`)).toHaveProperty("failure", "unparseable");
  });

  it("clamps issued-token lifetime against the hub clock", async () => {
    const store = registry();
    const issued = issue(store);
    const expired = await mintToken(await importCredentialKey(issued.keyBytes), {
      typ: "room", sub: "person", workspace: WORKSPACE, scope: "read-write",
      kid: issued.record.id, iat: 0, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    });
    expect(await store.verify(expired)).toEqual({ failure: "expired" });
  });
});
