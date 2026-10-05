import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRegistry, type CredentialRenewal, type IssuedCredential } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import type { MembershipRole } from "../src/memberships.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import { createHub, type Hub } from "../src/server.js";
import { importCredentialKey, importRootSecret, mintRequestProof, mintToken, type RequestAction } from "../src/token.js";
import { createClient, OTHER_WORKSPACE, removeTempDatabases, tempDatabasePath, TEST_SECRET, testRoom,
  type TestClient, token, waitForText, waitUntil, WORKSPACE } from "./helpers.js";

type Action = Exclude<RequestAction, { operation: "renew-credential" }>;
const hubs: Hub[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

async function rig(options: { loopback?: boolean; github?: boolean; githubFetch?: typeof fetch; githubNow?: () => number } = {}) {
  const logs: HubLogRecord[] = [];
  const github = vi.fn<typeof fetch>(options.githubFetch ?? (async () => { throw new Error("GitHub is unreachable"); }));
  const hub = await createHub({ address: options.loopback ? "127.0.0.1" : "0.0.0.0", port: 0,
    databasePath: tempDatabasePath(), authSecret: TEST_SECRET, log: record => logs.push(record),
    ...(options.github === false ? {} : { github: { clientId: "Iv1.0123456789abcdef", fetch: github,
      ...(options.githubNow === undefined ? {} : { now: options.githubNow }) } }),
  });
  hubs.push(hub);
  return { hub, logs, github };
}

function person(hub: Hub, accountId: string, username: string, memberships: [string, MembershipRole][] = []) {
  const principal = hub.principals!.identify(accountId, username);
  for (const [workspaceId, role] of memberships) hub.memberships!.grant({ workspaceId, principalId: principal.id, role });
  const issued = hub.credentials!.issue({ principalId: principal.id, deviceId: randomUUID(),
    workspaces: memberships.map(([workspace]) => workspace) });
  return { principal, issued };
}

async function proof(issued: IssuedCredential, action: Action, iat?: number) {
  return mintRequestProof(await importCredentialKey(issued.keyBytes), {
    kid: issued.record.id, ...action, ...(iat === undefined ? {} : { iat }), lifetimeSeconds: 60,
  });
}

async function post(hub: Hub, body: unknown, options: { raw?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`http://127.0.0.1:${hub.port}/auth/manage`, {
    method: "POST", headers: { "Content-Type": "application/json", ...options.headers },
    body: options.raw ?? JSON.stringify(body),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { code: response.status, result: await response.json() as Record<string, unknown> };
}

function envelope(presented: string, action: Action, protocolVersion = SYNC_PROTOCOL_VERSION) {
  return { protocolVersion, token: presented, ...action };
}

async function manage(hub: Hub, issued: IssuedCredential, action: Action) {
  return post(hub, envelope(await proof(issued, action), action));
}

async function roomToken(issued: IssuedCredential, workspace = WORKSPACE) {
  return mintToken(await importCredentialKey(issued.keyBytes), { typ: "room", sub: issued.record.principalId,
    workspace, scope: "read-write", kid: issued.record.id, lifetimeSeconds: 60 });
}

function connect(hub: Hub, room: string, presented: string) {
  const client = createClient({ port: hub.port, room, token: presented, reconnectDelayMs: 60_000 });
  clients.push(client);
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe("authenticated hub access management", () => {
  it("accepts a device collected through public GitHub sign-in using the same principal and membership registries", async () => {
    let githubTime = Date.now();
    const githubFetch: typeof fetch = async input => {
      const url = String(input);
      if (url === "https://github.com/login/device/code") return Response.json({ device_code: "private-code",
        user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "github-token", token_type: "bearer", scope: "" });
      expect(url).toBe("https://api.github.com/user");
      return Response.json({ id: 1234, login: "current-admin" });
    };
    const { hub, logs } = await rig({ githubFetch, githubNow: () => githubTime });
    const principal = hub.principals!.identify("1234", "old-admin");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "admin" });
    const signInPost = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${hub.port}/auth/github/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const pending = await signInPost("start", {});
    githubTime += 5_000;
    const completed = await signInPost("collect", { requestId: pending.requestId, collectionSecret: pending.collectionSecret });
    expect(completed.status).toBe("complete");
    const credential = completed.credential as { record: IssuedCredential["record"]; key: string };
    const issued: IssuedCredential = { record: credential.record, keyBytes: Buffer.from(credential.key, "base64url") };
    expect(issued.record.principalId).toBe(principal.id);
    const listed = await manage(hub, issued, { operation: "list-members", workspaceId: WORKSPACE });
    expect(listed).toEqual({ code: 200, result: { status: "ok", members: [{ principalId: principal.id,
      githubAccountId: "1234", githubUsername: "current-admin", role: "admin" }] } });
    for (const secret of ["github-token", credential.key]) expect(JSON.stringify({ listed, logs })).not.toContain(secret);
  });

  it("reads GitHub identities and current roles, and applies the existing admin and last-admin rules", async () => {
    const { hub, github } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const member = person(hub, "5678", "old-login", [[WORKSPACE, "member"]]);
    hub.principals!.identify("5678", "current-login");
    const listed = await manage(hub, admin.issued, { operation: "list-members", workspaceId: WORKSPACE });
    expect(listed).toEqual({ code: 200, result: { status: "ok", members: expect.arrayContaining([
      { principalId: admin.principal.id, githubAccountId: "1234", githubUsername: "admin", role: "admin" },
      { principalId: member.principal.id, githubAccountId: "5678", githubUsername: "current-login", role: "member" },
    ]) } });
    expect(listed.result.members).toHaveLength(2);
    expect(await manage(hub, member.issued, { operation: "own-role", workspaceId: WORKSPACE }))
      .toEqual({ code: 200, result: { status: "ok", role: "member" } });
    const promote = { operation: "change-role", workspaceId: WORKSPACE, principalId: member.principal.id, role: "admin" } as const;
    const promoteRequest = envelope(await proof(admin.issued, promote), promote);
    expect(await post(hub, promoteRequest)).toEqual({ code: 200, result: { status: "ok" } });
    expect(await post(hub, promoteRequest)).toEqual({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, member.issued, { operation: "own-role", workspaceId: WORKSPACE }))
      .toEqual({ code: 200, result: { status: "ok", role: "admin" } });
    expect(await manage(hub, admin.issued, { ...promote, principalId: admin.principal.id, role: "member" }))
      .toEqual({ code: 200, result: { status: "ok" } });
    for (const action of [
      { ...promote, principalId: member.principal.id, role: "member" },
      { operation: "remove-member", workspaceId: WORKSPACE, principalId: member.principal.id },
    ] as Action[]) {
      expect(await manage(hub, member.issued, action)).toEqual({ code: 409, result: { status: "last-admin" } });
    }
    expect(hub.memberships!.roleFor(WORKSPACE, member.principal.id)).toBe("admin");
    expect(await manage(hub, member.issued, { ...promote, principalId: randomUUID() }))
      .toEqual({ code: 404, result: { status: "member-not-found" } });
    expect(await manage(hub, member.issued, { operation: "remove-member", workspaceId: WORKSPACE, principalId: admin.principal.id }))
      .toEqual({ code: 200, result: { status: "ok" } });
    expect(hub.memberships!.roleFor(WORKSPACE, admin.principal.id)).toBeNull();
    expect(github).not.toHaveBeenCalled();
  });

  it("requires current workspace authority and an issued workspace limit before disclosing members or changing anything", async () => {
    const { hub } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"], [OTHER_WORKSPACE, "admin"]]);
    const member = person(hub, "5678", "member", [[WORKSPACE, "member"]]);
    const laterAdmin = person(hub, "9012", "later-admin");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: laterAdmin.principal.id, role: "admin" });
    const adminActions: Action[] = [
      { operation: "list-members", workspaceId: WORKSPACE },
      { operation: "change-role", workspaceId: WORKSPACE, principalId: admin.principal.id, role: "member" },
      { operation: "remove-member", workspaceId: WORKSPACE, principalId: admin.principal.id },
    ];
    for (const actor of [member, laterAdmin]) {
      for (const action of adminActions) {
        expect(await manage(hub, actor.issued, action)).toEqual({ code: 403, result: { status: "forbidden" } });
      }
    }
    for (const action of [{ operation: "own-role", workspaceId: WORKSPACE },
      { operation: "own-role", workspaceId: OTHER_WORKSPACE }] as Action[]) {
      expect(await manage(hub, laterAdmin.issued, action)).toEqual({ code: 403, result: { status: "forbidden" } });
    }
    expect(await manage(hub, member.issued, { operation: "list-members", workspaceId: OTHER_WORKSPACE }))
      .toEqual({ code: 403, result: { status: "forbidden" } });
    expect(hub.memberships!.roleFor(WORKSPACE, admin.principal.id)).toBe("admin");
    const stale = envelope(await proof(admin.issued, adminActions[0]!), adminActions[0]!);
    hub.memberships!.changeRole({ workspaceId: WORKSPACE, principalId: admin.principal.id,
      actorPrincipalId: laterAdmin.principal.id, role: "member" });
    expect(await post(hub, stale)).toEqual({ code: 403, result: { status: "forbidden" } });
    hub.memberships!.remove({ workspaceId: WORKSPACE, principalId: member.principal.id, actorPrincipalId: laterAdmin.principal.id });
    expect(await manage(hub, member.issued, { operation: "own-role", workspaceId: WORKSPACE }))
      .toEqual({ code: 403, result: { status: "forbidden" } });
  });

  it("lists only the caller's current devices, preserves sign-in time through renewal, and permits self-service with no workspace", async () => {
    const { hub } = await rig();
    const signedInAt = Date.now() - 10_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(signedInAt);
    const owner = person(hub, "1234", "owner");
    clock.mockRestore();
    const second = hub.credentials!.issue({ principalId: owner.principal.id, deviceId: randomUUID(), workspaces: [] });
    const retired = hub.credentials!.issue({ principalId: owner.principal.id, deviceId: randomUUID(), workspaces: [] });
    hub.credentials!.revoke(retired.record.id);
    const foreign = person(hub, "5678", "foreign", [[WORKSPACE, "admin"]]);
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: owner.principal.id, role: "member" });
    const renewalProof = await mintRequestProof(await importCredentialKey(owner.issued.keyBytes), {
      kid: owner.issued.record.id, operation: "renew-credential", lifetimeSeconds: 60,
    });
    const response = await fetch(`http://127.0.0.1:${hub.port}/auth/credential/renew`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: SYNC_PROTOCOL_VERSION, token: renewalProof }),
    });
    const renewed = await response.json() as CredentialRenewal;
    if (renewed.status !== "renewed") throw new Error("credential did not renew");
    const replacement: IssuedCredential = { record: renewed.credential.record,
      keyBytes: Buffer.from(renewed.credential.key, "base64url") };
    expect(replacement.record.issuedAt).toBeGreaterThan(signedInAt);
    expect(await manage(hub, second, { operation: "list-devices" })).toEqual({ code: 200, result: { status: "ok",
      devices: expect.arrayContaining([
        { deviceId: owner.issued.record.deviceId, signedInAt, workspaces: [WORKSPACE], current: false },
        { deviceId: second.record.deviceId, signedInAt: second.record.issuedAt, workspaces: [], current: true },
      ]),
    } });
    const listed = await manage(hub, replacement, { operation: "list-devices" });
    expect(listed.result.devices).toHaveLength(2);
    expect(listed.result.devices).toContainEqual({ deviceId: owner.issued.record.deviceId, signedInAt,
      workspaces: [WORKSPACE], current: true });
    const unknown = await manage(hub, second, { operation: "revoke-device", deviceId: randomUUID() });
    expect(unknown).toEqual({ code: 404, result: { status: "device-not-found" } });
    expect(await manage(hub, second, { operation: "revoke-device", deviceId: foreign.issued.record.deviceId })).toEqual(unknown);
    expect(await manage(hub, foreign.issued, { operation: "revoke-device", deviceId: second.record.deviceId })).toEqual(unknown);
    expect(await manage(hub, foreign.issued, { operation: "list-devices" })).toEqual({ code: 200,
      result: { status: "ok", devices: [{ deviceId: foreign.issued.record.deviceId,
        signedInAt: foreign.issued.record.issuedAt, workspaces: [WORKSPACE], current: true }] } });
    expect(await post(hub, { ...envelope(await proof(second, { operation: "list-devices" }), { operation: "list-devices" }),
      principalId: foreign.principal.id })).toEqual({ code: 400, result: { status: "invalid-request" } });
    expect(await manage(hub, second, { operation: "revoke-device", deviceId: owner.issued.record.deviceId }))
      .toEqual({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, replacement, { operation: "list-devices" }))
      .toEqual({ code: 401, result: { status: "sign-in-required" } });
    expect(await manage(hub, second, { operation: "list-devices" })).toEqual({ code: 200, result: { status: "ok", devices: [
      { deviceId: second.record.deviceId, signedInAt: second.record.issuedAt, workspaces: [], current: true },
    ] } });
    expect(hub.credentials!.get(foreign.issued.record.id)?.revokedAt).toBeNull();
    expect(await manage(hub, second, { operation: "revoke-device", deviceId: second.record.deviceId }))
      .toEqual({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, second, { operation: "list-devices" }))
      .toEqual({ code: 401, result: { status: "sign-in-required" } });
  });

  it("authenticates only current hub-issued device proofs and binds every authority-bearing request field", async () => {
    const { hub } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"], [OTHER_WORKSPACE, "admin"]]);
    const member = person(hub, "5678", "member", [[WORKSPACE, "member"]]);
    const otherHub = (await rig()).hub;
    const foreign = person(otherHub, "1234", "admin");
    const action = { operation: "list-devices" } as const;
    const key = await importCredentialKey(admin.issued.keyBytes);
    const renewal = await mintRequestProof(key, { kid: admin.issued.record.id, operation: "renew-credential", lifetimeSeconds: 60 });
    const root = await mintRequestProof(await importRootSecret(TEST_SECRET), { kid: admin.issued.record.id, ...action, lifetimeSeconds: 60 });
    const unknown = await mintRequestProof(key, { kid: randomUUID(), ...action, lifetimeSeconds: 60 });
    for (const presented of [await roomToken(admin.issued), renewal, root, unknown, "github-token",
      await proof(admin.issued, action, 0), await proof(foreign.issued, action)]) {
      expect(await post(hub, envelope(presented, action))).toEqual({ code: 401, result: { status: "sign-in-required" } });
    }
    const change = { operation: "change-role", workspaceId: WORKSPACE, principalId: member.principal.id, role: "admin" } as const;
    const bound = await proof(admin.issued, change);
    for (const substituted of [
      { ...change, operation: "remove-member", role: undefined },
      { ...change, workspaceId: OTHER_WORKSPACE },
      { ...change, principalId: admin.principal.id },
      { ...change, role: "member" },
    ] as Action[]) {
      expect(await post(hub, envelope(bound, substituted))).toEqual({ code: 401, result: { status: "sign-in-required" } });
    }
    expect(hub.memberships!.roleFor(WORKSPACE, member.principal.id)).toBe("member");
    const managementProof = await proof(admin.issued, action);
    const renew = await fetch(`http://127.0.0.1:${hub.port}/auth/credential/renew`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: SYNC_PROTOCOL_VERSION, token: managementProof }),
    });
    expect(renew.status).toBe(401);
    expect(await renew.json()).toEqual({ status: "sign-in-required" });
    await expect(connect(hub, testRoom(), managementProof).denied).resolves.toBe("device-credential-refused");
    const replaced = await hub.credentials!.renew(renewal, hub.memberships!);
    expect(replaced.status).toBe("renewed");
    expect(await post(hub, envelope(managementProof, action))).toEqual({ code: 401, result: { status: "sign-in-required" } });
    hub.credentials!.revoke(member.issued.record.id);
    expect(await manage(hub, member.issued, action)).toEqual({ code: 401, result: { status: "sign-in-required" } });
  });

  it("bounds JSON transport, refuses headers and extra fields, and distinguishes protocol skew without mutation", async () => {
    const { hub } = await rig();
    const owner = person(hub, "1234", "owner");
    const action = { operation: "list-devices" } as const;
    const valid = envelope(await proof(owner.issued, action), action);
    for (const body of [null, [], {}, { operation: "list-devices" }, { ...valid, key: "extra" },
      { ...valid, protocolVersion: 0 }, { ...valid, token: 12 },
      { ...valid, operation: "change-role", workspaceId: WORKSPACE, principalId: owner.principal.id, role: "owner" }]) {
      expect(await post(hub, body)).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    for (const raw of ["{", "x".repeat(4097)]) {
      expect(await post(hub, {}, { raw })).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    for (const headers of [{ Authorization: "Bearer github-token" }, { "Content-Type": "text/plain" }]) {
      expect(await post(hub, valid, { headers })).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    const get = await fetch(`http://127.0.0.1:${hub.port}/auth/manage`);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.status).toBe(400);
    expect(await get.json()).toEqual({ status: "invalid-request" });
    expect(await post(hub, { ...valid, protocolVersion: SYNC_PROTOCOL_VERSION + 1 })).toEqual({ code: 409,
      result: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION}` } });
    expect(hub.credentials!.get(owner.issued.record.id)?.revokedAt).toBeNull();
    expect((await post(hub, valid)).code).toBe(200);
  });

  // One change per mechanism: credential state, membership and the clock.
  it.each(["revoke", "demote", "expire"] as const)("rechecks %s after asynchronous proof verification before acting", async change => {
    const { hub } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const backup = person(hub, "5678", "backup-admin", [[WORKSPACE, "admin"]]);
    const action = { operation: "list-members", workspaceId: WORKSPACE } as const;
    const presented = await proof(admin.issued, action);
    const verify = hub.credentials!.verifyRequest.bind(hub.credentials!);
    vi.spyOn(hub.credentials!, "verifyRequest").mockImplementationOnce(async (requestProof, request) => {
      const verified = await verify(requestProof, request);
      expect(verified).not.toBeNull();
      if (change === "revoke") hub.credentials!.revoke(admin.issued.record.id);
      if (change === "demote") hub.memberships!.changeRole({ workspaceId: WORKSPACE,
        principalId: admin.principal.id, actorPrincipalId: backup.principal.id, role: "member" });
      if (change === "expire") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      return verified;
    });
    expect(await post(hub, envelope(presented, action))).toEqual(change === "demote"
      ? { code: 403, result: { status: "forbidden" } }
      : { code: 401, result: { status: "sign-in-required" } });
  });

  it("uses sign-in's not-configured result for every management operation", async () => {
    const { hub } = await rig({ github: false });
    for (const operation of ["list-devices", "revoke-device", "own-role", "list-members", "change-role", "remove-member",
      "promote-workspace", "resolve-account", "grant-member"]) {
      expect(await post(hub, { operation })).toEqual({ code: 503, result: { status: "not-configured" } });
    }
    const signIn = await fetch(`http://127.0.0.1:${hub.port}/auth/github/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(signIn.status).toBe(503);
    expect(await signIn.json()).toEqual({ status: "not-configured" });
  });

  it("reports safe internal failure without disclosing exception, proof, device key or signing secret", async () => {
    const { hub, logs } = await rig();
    const owner = person(hub, "1234", "owner");
    const action = { operation: "list-devices" } as const;
    const presented = await proof(owner.issued, action);
    const key = Buffer.from(owner.issued.keyBytes).toString("base64url");
    vi.spyOn(CredentialRegistry.prototype, "listDevices").mockImplementationOnce(() => {
      throw new Error(`${presented} ${key} github-token ${TEST_SECRET}`);
    });
    const failure = await post(hub, envelope(presented, action));
    expect(failure).toEqual({ code: 500, result: { status: "failed" } });
    const success = await post(hub, envelope(presented, action));
    expect(success.code).toBe(200);
    for (const secret of [presented, key, "github-token", TEST_SECRET]) {
      expect(JSON.stringify({ failure, success, logs })).not.toContain(secret);
    }
  });

  it("reports revoke-device as applied when a closure listener fails after commit", async () => {
    const { hub } = await rig();
    const member = person(hub, "5678", "member", [[WORKSPACE, "member"]]);
    hub.credentials!.onRevoke(() => { throw new Error("post-commit closure failure"); });
    expect(await manage(hub, member.issued, { operation: "revoke-device", deviceId: member.issued.record.deviceId }))
      .toEqual({ code: 500, result: { status: "closure-failed", applied: true } });
    expect(hub.credentials!.get(member.issued.record.id)?.revokedAt).toBeTypeOf("number");
    await expect(connect(hub, testRoom(), await roomToken(member.issued)).denied).resolves.toBe("device-credential-refused");
  });

  it.each(["revoke-device", "remove-member"] as const)("%s closes and fences exactly its remote live authority while local data and unrelated access survive", async operation => {
    const { hub } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const member = person(hub, "5678", "member", [[WORKSPACE, "member"], [OTHER_WORKSPACE, "admin"]]);
    const second = hub.credentials!.issue({ principalId: member.principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE, OTHER_WORKSPACE] });
    const room = testRoom();
    const writer = connect(hub, room, await roomToken(member.issued));
    const otherDevice = connect(hub, room, await roomToken(second));
    const observer = connect(hub, room, await roomToken(admin.issued));
    const outside = connect(hub, testRoom(OTHER_WORKSPACE), await roomToken(second, OTHER_WORKSPACE));
    await Promise.all([writer.synced, otherDevice.synced, observer.synced, outside.synced]);
    writer.text.insert(0, "downloaded data");
    await waitForText("downloaded documents", observer.text, "downloaded data");
    const authority = hub.hocuspocus.documents.get(room)!.getConnections()
      .filter(connection => "credentialId" in connection.context && [member.issued.record.id, second.record.id].includes(connection.context.credentialId))
      .map(connection => connection.context);
    const action: Action = operation === "revoke-device"
      ? { operation, deviceId: member.issued.record.deviceId }
      : { operation, workspaceId: WORKSPACE, principalId: member.principal.id };
    expect(await manage(hub, operation === "revoke-device" ? member.issued : admin.issued, action))
      .toEqual({ code: 200, result: { status: "ok" } });
    for (const context of authority) {
      if (!("authorization" in context)) throw new Error("missing remote authority");
      expect(context.authorization.active).toBe(operation === "revoke-device" && context.credentialId === second.record.id);
    }
    await waitUntil("managed remote connections close", () => hub.hocuspocus.documents.get(room)!.getConnections().length === (operation === "revoke-device" ? 2 : 1));
    writer.text.insert(writer.text.length, " local edit");
    expect(writer.text.toString()).toBe("downloaded data local edit");
    expect(observer.text.toString()).toBe("downloaded data");
    await expect(connect(hub, testRoom(), await roomToken(member.issued)).denied).resolves.toBe("device-credential-refused");
    if (operation === "revoke-device") {
      otherDevice.text.insert(otherDevice.text.length, " other device edit");
      await waitForText("another device remains admitted", observer.text, "downloaded data other device edit");
    } else {
      await expect(connect(hub, testRoom(), await roomToken(second)).denied).resolves.toBe("device-credential-refused");
      expect(hub.credentials!.get(member.issued.record.id)?.revokedAt).toBeNull();
      expect(hub.credentials!.get(second.record.id)?.revokedAt).toBeNull();
    }
    outside.text.insert(0, "other workspace remains usable");
    const outsideObserver = connect(hub, outside.provider.configuration.name, await roomToken(second, OTHER_WORKSPACE));
    await outsideObserver.synced;
    await waitForText("unrelated workspace", outsideObserver.text, "other workspace remains usable");
  });

  it("leaves loopback admission unchanged when management revokes or removes private access", async () => {
    const { hub } = await rig({ loopback: true });
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const member = person(hub, "5678", "member", [[WORKSPACE, "member"]]);
    const room = testRoom();
    const local = connect(hub, room, await token());
    const observer = connect(hub, room, await token());
    await Promise.all([local.synced, observer.synced]);
    expect(await manage(hub, member.issued, { operation: "revoke-device", deviceId: member.issued.record.deviceId }))
      .toEqual({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, admin.issued, { operation: "remove-member", workspaceId: WORKSPACE, principalId: member.principal.id }))
      .toEqual({ code: 200, result: { status: "ok" } });
    expect(hub.hocuspocus.documents.get(room)!.getConnections()).toHaveLength(2);
    local.text.insert(0, "local admission still works");
    await waitForText("loopback remains admitted", observer.text, "local admission still works");
    const managementProof = await proof(admin.issued, { operation: "list-devices" });
    await expect(connect(hub, testRoom(), managementProof).denied).resolves.toBe("invalid-token");
  });
});

describe("direct GitHub account grants", () => {
  it("resolves without writing, then grants the confirmed ID with the provider's current login", async () => {
    const { hub, github } = await rig({ githubFetch: async (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      const url = String(input);
      if (url === "https://api.github.com/users/old-handle") return Response.json({ id: 5678, login: "old-handle", type: "User" });
      expect(url).toBe("https://api.github.com/user/5678");
      return Response.json({ id: 5678, login: "renamed-handle", type: "User" });
    } });
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const identify = vi.spyOn(hub.principals!, "identify");
    const resolve = { operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: "old-handle" } as const;
    expect(await manage(hub, admin.issued, resolve)).toEqual({ code: 200, result: { status: "ok",
      githubAccountId: "5678", githubUsername: "old-handle" } });
    expect(identify).not.toHaveBeenCalled();
    expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(1);
    const granted = await manage(hub, admin.issued, { operation: "grant-member", workspaceId: WORKSPACE,
      githubAccountId: "5678" });
    expect(granted).toEqual({ code: 200, result: { status: "ok", member: {
      principalId: expect.any(String), githubAccountId: "5678", githubUsername: "renamed-handle", role: "member",
    } } });
    const member = granted.result.member as { principalId: string };
    expect(hub.credentials!.listDevices(member.principalId)).toEqual([]);
    expect(await manage(hub, admin.issued, { operation: "list-members", workspaceId: WORKSPACE }))
      .toEqual({ code: 200, result: { status: "ok", members: expect.arrayContaining([
        { principalId: member.principalId, githubAccountId: "5678", githubUsername: "renamed-handle", role: "member" },
      ]) } });
    expect(github).toHaveBeenCalledTimes(2);
  });

  it("permits explicit admin grants and reports existing roles without refreshing stored logins", async () => {
    const { hub, github } = await rig({ githubFetch: async input => {
      const url = String(input);
      expect(["https://api.github.com/user/5678", "https://api.github.com/user/9012"]).toContain(url);
      return Response.json({ id: url.endsWith("5678") ? 5678 : 9012, login: "provider-login", type: "User" });
    } });
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const existing = person(hub, "5678", "stored-login", [[WORKSPACE, "member"]]);
    expect(await manage(hub, admin.issued, { operation: "grant-member", workspaceId: WORKSPACE,
      githubAccountId: "5678", role: "admin" })).toEqual({ code: 200, result: { status: "already-member", member: {
      principalId: existing.principal.id, githubAccountId: "5678", githubUsername: "stored-login", role: "member",
    } } });
    expect(hub.principals!.get(existing.principal.id)?.githubUsername).toBe("stored-login");
    const action = { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "9012", role: "admin" } as const;
    const granted = await manage(hub, admin.issued, action);
    expect(granted).toMatchObject({ code: 200, result: { status: "ok", member: {
      githubAccountId: "9012", githubUsername: "provider-login", role: "admin",
    } } });
    expect(await manage(hub, admin.issued, { ...action, role: "member" })).toEqual({ code: 200,
      result: { ...granted.result, status: "already-member" } });
    expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(3);
    expect(github).toHaveBeenCalledTimes(3);
  });

  it("serializes concurrent grants to one membership and preserves the first role", async () => {
    const release = deferred<Response>();
    const { hub, github } = await rig({ githubFetch: async () => (await release.promise).clone() });
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const action = { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "5678", role: "admin" } as const;
    const requests = [manage(hub, admin.issued, action), manage(hub, admin.issued, { ...action, role: "member" })];
    try {
      await waitUntil("both account lookups started", () => github.mock.calls.length === 2);
    } finally {
      release.resolve(Response.json({ id: 5678, login: "new-account", type: "User" }));
      await Promise.allSettled(requests);
    }
    const results = await Promise.all(requests);
    expect(results.map(result => result.code)).toEqual([200, 200]);
    expect(results.map(result => result.result.status).sort()).toEqual(["already-member", "ok"]);
    expect(results[0]!.result.member).toEqual(results[1]!.result.member);
    const member = results[0]!.result.member as { principalId: string; role: MembershipRole };
    expect(hub.memberships!.roleFor(WORKSPACE, member.principalId)).toBe(member.role);
    expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(2);
  });

  it("never resolves a handle from stale stored logins or grants a different account that reused it", async () => {
    const { hub } = await rig({ githubFetch: async input => {
      if (String(input) === "https://api.github.com/users/old-handle") {
        return Response.json({ id: 9012, login: "old-handle", type: "User" });
      }
      expect(String(input)).toBe("https://api.github.com/user/5678");
      return Response.json({ id: 5678, login: "renamed-handle", type: "User" });
    } });
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const old = person(hub, "5678", "old-handle");
    expect(await manage(hub, admin.issued, { operation: "resolve-account", workspaceId: WORKSPACE,
      githubUsername: "old-handle" })).toEqual({ code: 200, result: { status: "ok",
      githubAccountId: "9012", githubUsername: "old-handle" } });
    expect(hub.memberships!.workspacesFor(old.principal.id)).toEqual([]);
    const granted = await manage(hub, admin.issued, { operation: "grant-member", workspaceId: WORKSPACE,
      githubAccountId: "5678" });
    expect(granted).toEqual({ code: 200, result: { status: "ok", member: {
      principalId: old.principal.id, githubAccountId: "5678", githubUsername: "old-handle", role: "member",
    } } });
    expect(hub.principals!.identify("5678", "renamed-handle").id).toBe(old.principal.id);
    const reused = hub.principals!.identify("9012", "old-handle");
    expect(hub.memberships!.workspacesFor(reused.id)).toEqual([]);
    expect(hub.memberships!.workspacesFor(old.principal.id)).toEqual([WORKSPACE]);
  });

  it("refuses members, outsiders, unnamed workspaces and stale credentials before contacting GitHub", async () => {
    const { hub, github } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const member = person(hub, "5678", "member", [[WORKSPACE, "member"]]);
    const outsider = person(hub, "9012", "outsider");
    const unnamed = person(hub, "3456", "later-admin");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: unnamed.principal.id, role: "admin" });
    const revoked = person(hub, "7890", "revoked", [[WORKSPACE, "admin"]]);
    hub.credentials!.revoke(revoked.issued.record.id);
    const replaced = person(hub, "2345", "replaced", [[WORKSPACE, "admin"]]);
    const renewal = await mintRequestProof(await importCredentialKey(replaced.issued.keyBytes), {
      kid: replaced.issued.record.id, operation: "renew-credential", lifetimeSeconds: 60,
    });
    expect((await hub.credentials!.renew(renewal, hub.memberships!)).status).toBe("renewed");
    for (const action of [
      { operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: "new-account" },
      { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "4567" },
    ] as Action[]) {
      for (const actor of [member, outsider, unnamed]) expect(await manage(hub, actor.issued, action))
        .toEqual({ code: 403, result: { status: "forbidden" } });
      for (const actor of [revoked, replaced]) expect(await manage(hub, actor.issued, action))
        .toEqual({ code: 401, result: { status: "sign-in-required" } });
      expect(await manage(hub, admin.issued, { ...action, workspaceId: OTHER_WORKSPACE } as Action))
        .toEqual({ code: 403, result: { status: "forbidden" } });
      expect(await post(hub, envelope(await proof(admin.issued, action, 0), action)))
        .toEqual({ code: 401, result: { status: "sign-in-required" } });
    }
    expect(github).not.toHaveBeenCalled();
    expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(5);
  });

  it.each(["resolve-account", "grant-member"] as const)("binds %s proofs to all targets and rejects client-supplied identity text", async operation => {
    const { hub, github } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"], [OTHER_WORKSPACE, "admin"]]);
    const action: Action = operation === "resolve-account"
      ? { operation, workspaceId: WORKSPACE, githubUsername: "new-account" }
      : { operation, workspaceId: WORKSPACE, githubAccountId: "5678", role: "member" };
    const signed = await proof(admin.issued, action);
    const changes: Action[] = [{ ...action, workspaceId: OTHER_WORKSPACE }];
    if (action.operation === "resolve-account") {
      changes.push({ ...action, githubUsername: "another-account" },
        { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "5678" });
    } else {
      changes.push({ ...action, githubAccountId: "9012" }, { ...action, role: "admin" },
        { operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: "new-account" });
    }
    for (const changed of changes) expect(await post(hub, envelope(signed, changed)))
      .toEqual({ code: 401, result: { status: "sign-in-required" } });
    if (action.operation === "grant-member") expect(await post(hub, {
      ...envelope(signed, action), githubUsername: "client-supplied-login",
    })).toEqual({ code: 400, result: { status: "invalid-request" } });
    expect(github).not.toHaveBeenCalled();
    expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(1);
  });

  it("rejects malformed handles, account IDs and roles without outbound requests or writes", async () => {
    const { hub, github } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const signed = await proof(admin.issued, { operation: "list-members", workspaceId: WORKSPACE });
    const resolve = { protocolVersion: SYNC_PROTOCOL_VERSION, token: signed, operation: "resolve-account", workspaceId: WORKSPACE };
    for (const githubUsername of ["", "-login", "login-", "two--hyphens", "@login", "with space", "../user", "login%2Fuser", "a".repeat(40), 5678]) {
      expect(await post(hub, { ...resolve, githubUsername })).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    const grant = { protocolVersion: SYNC_PROTOCOL_VERSION, token: signed, operation: "grant-member", workspaceId: WORKSPACE };
    for (const githubAccountId of ["", "0", "-1", "01", "1.5", "1/user", "1%2Fuser", 5678]) {
      expect(await post(hub, { ...grant, githubAccountId })).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    for (const role of ["owner", "", null]) expect(await post(hub, { ...grant, githubAccountId: "5678", role }))
      .toEqual({ code: 400, result: { status: "invalid-request" } });
    expect(github).not.toHaveBeenCalled();
    expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(1);
  });

  it.each(["resolve-account", "grant-member"] as const)("distinguishes missing accounts from unavailable %s lookups and writes nothing", async operation => {
    const { hub, github, logs } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const identify = vi.spyOn(hub.principals!, "identify");
    const action: Action = operation === "resolve-account"
      ? { operation, workspaceId: WORKSPACE, githubUsername: "new-account" }
      : { operation, workspaceId: WORKSPACE, githubAccountId: "5678" };
    const cases: [() => Promise<Response>, number, string][] = [
      [async () => Response.json({ message: "provider-private" }, { status: 404 }), 404, "account-not-found"],
      [async () => Response.json({ id: 5678, login: "new-account", type: "Organization" }), 404, "account-not-found"],
      [async () => Response.json({ id: 5678, login: "new-account", type: "Bot" }), 404, "account-not-found"],
      [async () => Response.json({ message: "provider-private" }, { status: 500 }), 503, "lookup-unavailable"],
      [async () => Response.json({ message: "provider-private" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }), 503, "lookup-unavailable"],
      [async () => Response.json({ message: "provider-private" }, { status: 429 }), 503, "lookup-unavailable"],
      [async () => new Response(null, { status: 302, headers: { location: "https://other.example/account" } }), 503, "lookup-unavailable"],
      [async () => { throw new DOMException("provider-private", "TimeoutError"); }, 503, "lookup-unavailable"],
      [async () => { throw new TypeError("provider-private"); }, 503, "lookup-unavailable"],
      [async () => new Response("provider-private"), 503, "lookup-unavailable"],
      [async () => new Response("x".repeat(65_537)), 503, "lookup-unavailable"],
      [async () => Response.json({ id: 5678, login: "new-account" }), 503, "lookup-unavailable"],
      [async () => Response.json({ id: 1.5, login: "new-account", type: "User" }), 503, "lookup-unavailable"],
      [async () => Response.json({ id: 5678, login: "../user", type: "User" }), 503, "lookup-unavailable"],
    ];
    if (operation === "grant-member") cases.push([
      async () => Response.json({ id: 9012, login: "another-account", type: "User" }), 503, "lookup-unavailable",
    ]);
    else cases.push([
      async () => Response.json({ id: 5678, login: "another-account", type: "User" }), 503, "lookup-unavailable",
    ]);
    for (const [answer, code, status] of cases) {
      github.mockImplementationOnce(answer);
      expect(await manage(hub, admin.issued, action)).toEqual({ code, result: { status } });
      expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(1);
    }
    expect(identify).not.toHaveBeenCalled();
    expect(github).toHaveBeenCalledTimes(cases.length);
    expect(JSON.stringify(logs)).not.toContain("provider-private");
  });

  it("bounds a stalled provider lookup with its abort signal and reports retry without writing", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(() => timeout.signal);
    const { hub, github } = await rig({ githubFetch: async (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) });
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const identify = vi.spyOn(hub.principals!, "identify");
    const request = manage(hub, admin.issued, { operation: "grant-member", workspaceId: WORKSPACE,
      githubAccountId: "5678" });
    try {
      await waitUntil("stalled account lookup started", () => github.mock.calls.length === 1);
    } finally {
      timeout.abort(new DOMException("provider-private", "TimeoutError"));
      await request;
    }
    expect(await request).toEqual({ code: 503, result: { status: "lookup-unavailable" } });
    expect(identify).not.toHaveBeenCalled();
    expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(1);
  });

  describe.each(["resolve-account", "grant-member"] as const)("%s lookup authority", operation => {
    it.each(["demote", "remove", "revoke", "replace", "expire"] as const)("rechecks %s after the provider await before any write", async change => {
      const release = deferred<Response>();
      const { hub, github } = await rig({ githubFetch: () => release.promise });
      const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
      const backup = person(hub, "5678", "backup-admin", [[WORKSPACE, "admin"]]);
      const identify = vi.spyOn(hub.principals!, "identify");
      const action: Action = operation === "resolve-account"
        ? { operation, workspaceId: WORKSPACE, githubUsername: "new-account" }
        : { operation, workspaceId: WORKSPACE, githubAccountId: "9012" };
      const request = manage(hub, admin.issued, action);
      try {
        await waitUntil("account lookup started", () => github.mock.calls.length === 1);
        if (change === "demote") hub.memberships!.changeRole({ workspaceId: WORKSPACE,
          principalId: admin.principal.id, actorPrincipalId: backup.principal.id, role: "member" });
        if (change === "remove") hub.memberships!.remove({ workspaceId: WORKSPACE,
          principalId: admin.principal.id, actorPrincipalId: backup.principal.id });
        if (change === "revoke") hub.credentials!.revoke(admin.issued.record.id);
        if (change === "replace") {
          const renewal = await mintRequestProof(await importCredentialKey(admin.issued.keyBytes), {
            kid: admin.issued.record.id, operation: "renew-credential", lifetimeSeconds: 60,
          });
          expect((await hub.credentials!.renew(renewal, hub.memberships!)).status).toBe("renewed");
        }
        if (change === "expire") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      } finally {
        release.resolve(Response.json({ id: 9012, login: "new-account", type: "User" }));
        await request;
      }
      expect(await request).toEqual(change === "demote" || change === "remove"
        ? { code: 403, result: { status: "forbidden" } }
        : { code: 401, result: { status: "sign-in-required" } });
      expect(identify).not.toHaveBeenCalled();
      expect(hub.memberships!.listMembers(WORKSPACE, backup.principal.id)).toHaveLength(change === "remove" ? 1 : 2);
    });
  });

  it("keeps every other management operation local and preserves its existing answer", async () => {
    const { hub, github } = await rig();
    const admin = person(hub, "1234", "admin", [[WORKSPACE, "admin"]]);
    const member = person(hub, "5678", "member", [[WORKSPACE, "member"]]);
    const spare = hub.credentials!.issue({ principalId: admin.principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
    expect(await manage(hub, admin.issued, { operation: "list-devices" })).toMatchObject({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, admin.issued, { operation: "revoke-device", deviceId: spare.record.deviceId }))
      .toEqual({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, member.issued, { operation: "own-role", workspaceId: WORKSPACE }))
      .toEqual({ code: 200, result: { status: "ok", role: "member" } });
    expect(await manage(hub, admin.issued, { operation: "list-members", workspaceId: WORKSPACE }))
      .toMatchObject({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, admin.issued, { operation: "change-role", workspaceId: WORKSPACE,
      principalId: member.principal.id, role: "admin" })).toEqual({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, admin.issued, { operation: "remove-member", workspaceId: WORKSPACE,
      principalId: member.principal.id })).toEqual({ code: 200, result: { status: "ok" } });
    expect(await manage(hub, admin.issued, { operation: "promote-workspace", workspaceId: randomUUID(), attemptId: randomUUID() }))
      .toMatchObject({ code: 200, result: { status: "created" } });
    expect(github).not.toHaveBeenCalled();
  });
});

describe("workspace promotion authority", () => {
  it("creates for a current member, and resumes only the same principal and attempt", async () => {
    const { hub } = await rig();
    const actor = person(hub, "1201", "promoter", [[WORKSPACE, "member"]]);
    const admin = person(hub, "1202", "administrator", [[WORKSPACE, "admin"]]);
    const stranger = person(hub, "1203", "signed-in");
    const other = person(hub, "1204", "other-admin", [[OTHER_WORKSPACE, "admin"]]);
    const action = { operation: "promote-workspace", workspaceId: randomUUID(), attemptId: randomUUID() } as const;
    expect(await manage(hub, stranger.issued, action)).toMatchObject({ code: 403, result: { status: "member-required" } });
    expect(hub.memberships!.hasMembership(action.workspaceId)).toBe(false);
    // The credential does not include the new UUID; current hub authority does.
    expect(await manage(hub, actor.issued, action)).toMatchObject({ code: 200, result: { status: "created" } });
    expect(hub.memberships!.listMembers(action.workspaceId, actor.principal.id)).toEqual([
      { workspaceId: action.workspaceId, principalId: actor.principal.id, role: "admin" },
    ]);
    expect(await manage(hub, actor.issued, action)).toMatchObject({ code: 200, result: { status: "resumed" } });
    for (const [requestActor, request] of [
      [other, action], [actor, { ...action, attemptId: randomUUID() }],
      [actor, { ...action, workspaceId: randomUUID() }],
    ] as const) {
      expect(await manage(hub, requestActor.issued, request)).toMatchObject({ code: 409, result: { status: "workspace-conflict" } });
    }
    expect(hub.memberships!.listMembers(WORKSPACE, admin.principal.id)).toHaveLength(2);
    expect(hub.memberships!.workspacesFor(stranger.principal.id)).toEqual([]);
  });

  it("binds the proof to both targets and refuses revoked devices or withdrawn membership", async () => {
    const { hub } = await rig();
    const admin = person(hub, "1201", "promoter", [[WORKSPACE, "admin"]]);
    const second = person(hub, "1202", "other-admin", [[WORKSPACE, "admin"]]);
    const action = { operation: "promote-workspace", workspaceId: randomUUID(), attemptId: randomUUID() } as const;
    const signed = await proof(admin.issued, action);
    for (const changed of [{ ...action, workspaceId: randomUUID() }, { ...action, attemptId: randomUUID() }]) {
      expect(await post(hub, envelope(signed, changed))).toMatchObject({ code: 401 });
      expect(hub.memberships!.hasMembership(changed.workspaceId)).toBe(false);
    }
    const original = hub.credentials!.verifyRequest.bind(hub.credentials!);
    vi.spyOn(hub.credentials!, "verifyRequest").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      hub.memberships!.remove({ workspaceId: WORKSPACE, actorPrincipalId: second.principal.id,
        principalId: admin.principal.id });
      return result;
    });
    expect(await post(hub, envelope(signed, action))).toMatchObject({ code: 403, result: { status: "member-required" } });
    expect(hub.credentials!.get(admin.issued.record.id)!.workspaces).toContain(WORKSPACE);
    expect(hub.memberships!.workspacesFor(admin.principal.id)).toEqual([]);
    hub.credentials!.revokeDevice(second.principal.id, second.issued.record.deviceId);
    expect(await manage(hub, second.issued, action)).toMatchObject({ code: 401 });
    expect(hub.memberships!.hasMembership(action.workspaceId)).toBe(false);
  });

  it("serializes competing attempts and rejects a UUID with an existing membership", async () => {
    const { hub } = await rig();
    const admin = person(hub, "1201", "promoter", [[WORKSPACE, "admin"]]);
    const workspaceId = randomUUID();
    const requests = [randomUUID(), randomUUID()].map(attemptId =>
      manage(hub, admin.issued, { operation: "promote-workspace", workspaceId, attemptId }));
    const results = await Promise.all(requests);
    expect(results.map(result => result.code).sort()).toEqual([200, 409]);
    expect(await manage(hub, admin.issued, { operation: "promote-workspace", workspaceId: WORKSPACE, attemptId: randomUUID() }))
      .toMatchObject({ code: 409, result: { status: "workspace-conflict" } });
  });
});
