import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRegistry, type CredentialRecord, type IssuedCredential } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import type { Hub } from "../src/server.js";
import { importCredentialKey, importRootSecret, mintRequestProof, mintToken } from "../src/token.js";
import { OTHER_WORKSPACE, removeTempDatabases, startHub, tempDatabasePath, TEST_SECRET, WORKSPACE } from "./helpers.js";

const CLIENT_ID = "Iv23AbCdEF0123456789";
const PRINCIPAL = "renewing-principal";
const DEVICE = "renewing-device";
const hubs: Hub[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

function seed(databasePath: string, issuedWorkspaces: string[], currentWorkspaces: string[]) {
  const database = new HubDatabase(databasePath, () => {});
  database.open();
  try {
    const credentials = new CredentialRegistry(database);
    const memberships = new MembershipRegistry(database);
    const issued = credentials.issue({ principalId: PRINCIPAL, deviceId: DEVICE, workspaces: issuedWorkspaces });
    const other = credentials.issue({ principalId: "another-principal", deviceId: "another-device", workspaces: [WORKSPACE] });
    memberships.grant({ workspaceId: WORKSPACE, principalId: "another-principal", role: "admin" });
    for (const workspaceId of currentWorkspaces) {
      memberships.grant({ workspaceId, principalId: PRINCIPAL, role: "member" });
    }
    return { issued, other };
  } finally { database.close(); }
}

async function start(databasePath: string, configured = true) {
  const logs: HubLogRecord[] = [];
  const githubFetch = vi.fn<typeof fetch>(async () => { throw new Error("GitHub is unreachable"); });
  const hub = await startHub({ databasePath, log: (record) => logs.push(record),
    ...(configured ? { github: { clientId: CLIENT_ID, fetch: githubFetch } } : {}),
  });
  hubs.push(hub);
  return { hub, logs, githubFetch, databasePath };
}

async function rig(issuedWorkspaces: string[] = [], currentWorkspaces: string[] = []) {
  const databasePath = tempDatabasePath();
  const seeded = seed(databasePath, issuedWorkspaces, currentWorkspaces);
  return { ...await start(databasePath), ...seeded };
}

async function proof(issued: IssuedCredential, keyBytes = issued.keyBytes, iat?: number) {
  return mintRequestProof(await importCredentialKey(keyBytes), {
    kid: issued.record.id, operation: "renew-credential", lifetimeSeconds: 60, ...(iat === undefined ? {} : { iat }),
  });
}

function envelope(token: string) {
  return { protocolVersion: SYNC_PROTOCOL_VERSION, token };
}

async function request(hub: Hub, body: string, options: { method?: string; headers?: Record<string, string>; path?: string } = {}) {
  const method = options.method ?? "POST";
  const response = await fetch(`http://127.0.0.1:${hub.port}${options.path ?? "/auth/credential/renew"}`, {
    method, headers: { "Content-Type": "application/json", ...options.headers }, ...(method === "GET" ? {} : { body }),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { code: response.status, result: await response.json() as Record<string, unknown> };
}

function post(hub: Hub, body: unknown, options: Parameters<typeof request>[2] = {}) {
  return request(hub, JSON.stringify(body), options);
}

function privateRows(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      credentials: database.prepare("SELECT id, principal_id, device_id, workspaces, issued_at, revoked_at, replaced_at FROM hub_credentials ORDER BY id").all(),
      memberships: database.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all(),
    };
  } finally { database.close(); }
}

interface Complete {
  status: "complete";
  credential: { record: CredentialRecord; key: string };
}

function completed(response: Awaited<ReturnType<typeof post>>): Complete {
  expect(response.code).toBe(200);
  expect(response.result.status).toBe("complete");
  expect(Object.keys(response.result).sort()).toEqual(["credential", "status"]);
  const result = response.result as unknown as Complete;
  expect(Object.keys(result.credential).sort()).toEqual(["key", "record"]);
  expect(result.credential.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return result;
}

describe("device credential renewal over HTTP", () => {
  it.each([
    { issuedWorkspaces: [], currentWorkspaces: [] },
    { issuedWorkspaces: [], currentWorkspaces: [OTHER_WORKSPACE, WORKSPACE] },
    { issuedWorkspaces: [WORKSPACE], currentWorkspaces: [] },
  ])("renews $issuedWorkspaces to exactly current memberships $currentWorkspaces without GitHub", async ({ issuedWorkspaces, currentWorkspaces }) => {
    const testRig = await rig(issuedWorkspaces, currentWorkspaces);
    const before = privateRows(testRig.databasePath);
    const presented = await proof(testRig.issued);
    const result = completed(await post(testRig.hub, envelope(presented)));
    expect(result.credential.record).toMatchObject({ principalId: PRINCIPAL, deviceId: DEVICE,
      workspaces: [...currentWorkspaces].sort(), revokedAt: null, replacedAt: null });
    expect(result.credential.record.id).not.toBe(testRig.issued.record.id);
    expect(result.credential.key).not.toBe(Buffer.from(testRig.issued.keyBytes).toString("base64url"));
    const after = privateRows(testRig.databasePath);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.credentials).toHaveLength(before.credentials.length + 1);
    expect(after.credentials.find((row) => row.id === testRig.other.record.id)).toEqual(before.credentials.find((row) => row.id === testRig.other.record.id));
    expect(after.credentials.filter((row) => row.principal_id === PRINCIPAL && row.revoked_at === null && row.replaced_at === null)).toHaveLength(1);
    expect(await post(testRig.hub, envelope(presented))).toEqual({ code: 409, result: { status: "replaced-credential" } });
    expect(testRig.githubFetch).not.toHaveBeenCalled();
    const logs = JSON.stringify(testRig.logs);
    for (const secret of [presented, result.credential.key, Buffer.from(testRig.issued.keyBytes).toString("base64url"), TEST_SECRET]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("refuses unrelated signing keys, room tokens, other operations, GitHub tokens and expired proofs without mutation", async () => {
    const testRig = await rig([], [WORKSPACE]);
    const key = await importCredentialKey(testRig.issued.keyBytes);
    const rootProof = await mintRequestProof(await importRootSecret(TEST_SECRET), {
      kid: testRig.issued.record.id, operation: "renew-credential", lifetimeSeconds: 60,
    });
    const roomToken = await mintToken(key, {
      typ: "room", sub: PRINCIPAL, workspace: WORKSPACE, scope: "read-write", kid: testRig.issued.record.id, lifetimeSeconds: 60,
    });
    const valid = await proof(testRig.issued);
    const claims = JSON.parse(Buffer.from(valid.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    claims.operation = "list-devices";
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const wrongOperation = `${payload}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("base64url")}`;
    const invalid = [await proof(testRig.issued, testRig.other.keyBytes), rootProof, roomToken, wrongOperation,
      "ghu_github-token-is-not-a-credential", await proof(testRig.issued, testRig.issued.keyBytes, 0)];
    const before = privateRows(testRig.databasePath);
    for (const token of invalid) {
      expect(await post(testRig.hub, envelope(token))).toEqual({ code: 401, result: { status: "sign-in-required" } });
      expect(privateRows(testRig.databasePath)).toEqual(before);
    }
    expect(testRig.githubFetch).not.toHaveBeenCalled();
    for (const secret of [...invalid, valid]) expect(JSON.stringify(testRig.logs)).not.toContain(secret);
  });

  it("gives revoked, unknown and unverifiable credentials the same sign-in result", async () => {
    const testRig = await rig();
    const revokedProof = await proof(testRig.issued);
    const unknownProof = await proof({ ...testRig.issued, record: { ...testRig.issued.record, id: crypto.randomUUID() } });
    const wrongKeyProof = await proof(testRig.issued, testRig.other.keyBytes);
    const database = new HubDatabase(testRig.databasePath, () => {});
    database.open();
    try { new CredentialRegistry(database).revoke(testRig.issued.record.id); }
    finally { database.close(); }
    const before = privateRows(testRig.databasePath);
    for (const token of [revokedProof, unknownProof, wrongKeyProof]) {
      expect(await post(testRig.hub, envelope(token))).toEqual({ code: 401, result: { status: "sign-in-required" } });
      expect(privateRows(testRig.databasePath)).toEqual(before);
    }
    expect(testRig.githubFetch).not.toHaveBeenCalled();
  });

  it("discloses replacement only to a verified old holder and never redelivers its key", async () => {
    const testRig = await rig();
    const presented = await proof(testRig.issued);
    const result = completed(await post(testRig.hub, envelope(presented)));
    const before = privateRows(testRig.databasePath);
    const bad = await proof(testRig.issued, testRig.other.keyBytes);
    expect(await post(testRig.hub, envelope(bad))).toEqual({ code: 401, result: { status: "sign-in-required" } });
    expect(await post(testRig.hub, envelope(presented))).toEqual({ code: 409, result: { status: "replaced-credential" } });
    expect(privateRows(testRig.databasePath)).toEqual(before);
    expect(JSON.stringify(testRig.logs)).not.toContain(result.credential.key);
  });

  it("concurrent exchanges yield one replacement and leave exactly one usable credential for the device", async () => {
    const testRig = await rig([], [WORKSPACE]);
    const presented = envelope(await proof(testRig.issued));
    const responses = await Promise.all([post(testRig.hub, presented), post(testRig.hub, presented)]);
    expect(responses.filter(({ result }) => result.status === "complete")).toHaveLength(1);
    expect(responses.find(({ result }) => result.status !== "complete")).toEqual({ code: 409, result: { status: "replaced-credential" } });
    const replacement = completed(responses.find(({ result }) => result.status === "complete")!);
    const rows = privateRows(testRig.databasePath).credentials;
    expect(rows.filter((row) => row.principal_id === PRINCIPAL && row.device_id === DEVICE && row.revoked_at === null && row.replaced_at === null).map((row) => row.id)).toEqual([replacement.credential.record.id]);
    expect(testRig.githubFetch).not.toHaveBeenCalled();
  });

  it("persists replacement and revocation across restart while the returned key renews again", async () => {
    const testRig = await rig([], [WORKSPACE]);
    const oldProof = await proof(testRig.issued);
    const result = completed(await post(testRig.hub, envelope(oldProof)));
    await testRig.hub.stop();
    const restarted = await start(testRig.databasePath);
    expect(await post(restarted.hub, envelope(oldProof))).toEqual({ code: 409, result: { status: "replaced-credential" } });
    const replacement = { record: result.credential.record, keyBytes: Buffer.from(result.credential.key, "base64url") };
    const replacementProof = await proof(replacement);
    const renewed = completed(await post(restarted.hub, envelope(replacementProof)));
    await restarted.hub.stop();
    const database = new HubDatabase(testRig.databasePath, () => {});
    database.open();
    try { new CredentialRegistry(database).revoke(renewed.credential.record.id); }
    finally { database.close(); }
    const again = await start(testRig.databasePath);
    const revokedProof = await proof({ record: renewed.credential.record, keyBytes: Buffer.from(renewed.credential.key, "base64url") });
    expect(await post(again.hub, envelope(revokedProof))).toEqual({ code: 401, result: { status: "sign-in-required" } });
    expect(await post(again.hub, envelope(replacementProof))).toEqual({ code: 409, result: { status: "replaced-credential" } });
    expect(again.githubFetch).not.toHaveBeenCalled();
  });

  it("separates malformed requests and protocol skew from proof failure, before changing any credential", async () => {
    const testRig = await rig();
    const presented = await proof(testRig.issued);
    const body = envelope(presented);
    const before = privateRows(testRig.databasePath);
    for (const invalid of [null, [], {}, { token: presented }, { protocolVersion: SYNC_PROTOCOL_VERSION },
      { ...body, token: 123 }, { ...body, protocolVersion: 1.5 }, { ...body, principalId: PRINCIPAL }]) {
      expect(await post(testRig.hub, invalid)).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    expect(await request(testRig.hub, "not-json")).toEqual({ code: 400, result: { status: "invalid-request" } });
    expect(await post(testRig.hub, body, { method: "GET" })).toEqual({ code: 400, result: { status: "invalid-request" } });
    expect(await post(testRig.hub, body, { headers: { Authorization: "Bearer ignored-github-token" } })).toEqual({ code: 400, result: { status: "invalid-request" } });
    expect(await post(testRig.hub, body, { headers: { "Content-Type": "text/plain" } })).toEqual({ code: 400, result: { status: "invalid-request" } });
    expect(await post(testRig.hub, envelope("é".repeat(2100)))).toEqual({ code: 400, result: { status: "invalid-request" } });
    expect(await post(testRig.hub, { protocolVersion: SYNC_PROTOCOL_VERSION + 1, token: "unverifiable" })).toEqual({
      code: 409, result: { status: "protocol-mismatch", protocolVersion: SYNC_PROTOCOL_VERSION },
    });
    expect(privateRows(testRig.databasePath)).toEqual(before);
    expect(testRig.githubFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(testRig.logs)).not.toContain(presented);
  });

  it("refuses renewal on a hub without sign-in using sign-in's not-configured result", async () => {
    const testRig = await start(tempDatabasePath(), false);
    const renewal = await post(testRig.hub, envelope("proof"));
    expect(renewal).toEqual({ code: 503, result: { status: "not-configured" } });
    expect(await post(testRig.hub, {}, { path: "/auth/github/start" })).toEqual(renewal);
    expect(testRig.githubFetch).not.toHaveBeenCalled();
  });

  it("a persistence failure returns no key and leaves the presented credential usable", async () => {
    const testRig = await rig([], [WORKSPACE]);
    const database = new DatabaseSync(testRig.databasePath);
    try {
      database.exec(`CREATE TRIGGER fail_retirement BEFORE UPDATE OF replaced_at ON hub_credentials
        BEGIN SELECT RAISE(ABORT, 'private persistence detail'); END`);
    } finally { database.close(); }
    const before = privateRows(testRig.databasePath);
    const presented = await proof(testRig.issued);
    expect(await post(testRig.hub, envelope(presented))).toEqual({ code: 500, result: { status: "failed" } });
    expect(privateRows(testRig.databasePath)).toEqual(before);
    expect(JSON.stringify(testRig.logs)).not.toContain("private persistence detail");
    expect(JSON.stringify(testRig.logs)).not.toContain(presented);
  });

  it("revocation between registry completion and HTTP delivery suppresses and revokes the replacement", async () => {
    const testRig = await rig([], [WORKSPACE]);
    const renew = CredentialRegistry.prototype.renew;
    vi.spyOn(CredentialRegistry.prototype, "renew").mockImplementation(async function(this: CredentialRegistry, token, memberships) {
      const result = await renew.call(this, token, memberships);
      this.revoke(testRig.issued.record.id);
      return result;
    });
    expect(await post(testRig.hub, envelope(await proof(testRig.issued))))
      .toEqual({ code: 401, result: { status: "sign-in-required" } });
    const rows = privateRows(testRig.databasePath).credentials;
    expect(rows.filter((row) => row.principal_id === PRINCIPAL && row.revoked_at === null && row.replaced_at === null))
      .toHaveLength(0);
  });
});
