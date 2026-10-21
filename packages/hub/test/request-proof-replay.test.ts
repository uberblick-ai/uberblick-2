import { issueCredential, MANAGEMENT_OPERATION_NAMES, managementAction, mintDeviceRequestProof as mintRequestProof, renewCredential,
  type TestCredential as IssuedCredential } from "./device-credentials.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importCredentialKey, type RequestAction } from "@uberblick/schema/token";
import { MANAGEMENT_OPERATIONS } from "../src/access-management.js";
import { CredentialRegistry } from "../src/credentials.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { WORKSPACE, removeTempDatabases, tempDatabasePath } from "./helpers.js";

const databases: HubDatabase[] = [];
const principalId = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
const targets = { workspaceId: WORKSPACE, principalId, deviceId, attemptId: deviceId,
  githubUsername: "new-account", githubAccountId: "1234" };
const removal = managementAction("remove-member", targets);

function rig(path = ":memory:", now?: () => number) {
  const db = new HubDatabase(path, error => { throw error; });
  db.open();
  databases.push(db);
  return { db, store: new CredentialRegistry(db, undefined, undefined, now), memberships: new MembershipRegistry(db) };
}

function issue(store: CredentialRegistry) {
  return issueCredential(store, { principalId, deviceId, workspaces: [WORKSPACE] });
}

async function proof(issued: IssuedCredential, action: RequestAction, iat = Math.floor(Date.now() / 1000)) {
  return mintRequestProof(await importCredentialKey(issued.keyBytes), {
    kid: issued.record.id, ...action, iat, lifetimeSeconds: 60,
  });
}

function used(db: HubDatabase) {
  return db.connection.prepare("SELECT proof, expires_at FROM hub_used_request_proofs").all();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  removeTempDatabases();
});

describe("durable request proof consumption", () => {
  it.each([managementAction("list-devices", targets), removal])(
    "refuses a fresh $operation proof that expires before consumption without recording it", async action => {
      let now = Date.now();
      let advanceOnRead = false;
      const { db, store } = rig(":memory:", () => {
        const sampled = now;
        if (advanceOnRead) {
          advanceOnRead = false;
          now += 1_000;
        }
        return sampled;
      });
      const issued = issue(store);
      const iat = Math.floor(now / 1000);
      const token = await proof(issued, action, iat);
      now = (iat + 60) * 1000;
      advanceOnRead = true;

      expect(await store.verifyRequest(token, action)).toBeNull();
      expect(used(db)).toEqual([]);
      expect(store.get(issued.record.id)).toEqual(issued.record);
    },
  );

  // The HTTP suite checks that every changesState: false operation leaves
  // access state unchanged, so the table cannot mark a mutation reusable.
  it.each(MANAGEMENT_OPERATION_NAMES)("verifies a concurrent %s proof once across registries if it changes state, else every time", async operation => {
    const { changesState } = MANAGEMENT_OPERATIONS[operation];
    const { db, store } = rig();
    const other = new CredentialRegistry(db);
    const issued = issue(store);
    const action = managementAction(operation, targets);
    const token = await proof(issued, action);
    const results = await Promise.all([store.verifyRequest(token, action), other.verifyRequest(token, action)]);
    expect(results.filter(result => result !== null)).toHaveLength(changesState ? 1 : 2);
    expect(await store.verifyRequest(token, action) === null).toBe(changesState);
    expect(used(db)).toHaveLength(changesState ? 1 : 0);
  });

  it("retains future-issued proofs through their exact expiry across restart and prunes only afterwards", async () => {
    const path = tempDatabasePath();
    const now = Math.floor(Date.now() / 1000);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const first = rig(path);
    const issued = issue(first.store);
    const action = removal;
    const token = await proof(issued, action, now + 60);
    expect(await first.store.verifyRequest(token, action)).not.toBeNull();
    first.db.close();

    clock.mockReturnValue((now + 61) * 1000);
    const restarted = rig(path);
    expect(await restarted.store.verifyRequest(token, action)).toBeNull();
    expect(used(restarted.db)).toEqual([{ proof: token, expires_at: now + 120 }]);
    clock.mockReturnValue((now + 120) * 1000);
    expect(await restarted.store.verifyRequest(token, action)).toBeNull();
    expect(used(restarted.db)).toHaveLength(1);

    clock.mockReturnValue((now + 121) * 1000);
    const fresh = await proof(issued, action);
    expect(await restarted.store.verifyRequest(fresh, action)).not.toBeNull();
    expect(used(restarted.db)).toEqual([{ proof: fresh, expires_at: now + 181 }]);
    expect(await restarted.store.verifyRequest(token, action)).toBeNull();
    restarted.db.close();

    clock.mockReturnValue((now + 182) * 1000);
    expect(used(rig(path).db)).toEqual([]);
  });

  it("records nothing for a forged signature or an overlong signed proof on either verification path", async () => {
    const { db, store, memberships } = rig();
    const issued = issue(store);
    const wrongKey = await importCredentialKey(issue(store).keyBytes);
    for (const action of [removal, { operation: "renew-credential" } as const]) {
      const forged = await mintRequestProof(wrongKey, { kid: issued.record.id, ...action, lifetimeSeconds: 60 });
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({ typ: "request", kid: issued.record.id, ...action,
        iat: now, exp: now + 61 })).toString("base64url");
      const signature = await crypto.subtle.sign("Ed25519", await importCredentialKey(issued.keyBytes), new TextEncoder().encode(payload));
      const overlong = `${payload}.${Buffer.from(signature).toString("base64url")}`;
      for (const token of [forged, overlong]) {
        if (action.operation === "renew-credential") {
          expect(await renewCredential(store, token, memberships)).toEqual({ status: "sign-in-required" });
        } else {
          expect(await store.verifyRequest(token, action)).toBeNull();
        }
        expect(used(db)).toEqual([]);
        expect(store.get(issued.record.id)).toEqual(issued.record);
      }
    }
  });
});
