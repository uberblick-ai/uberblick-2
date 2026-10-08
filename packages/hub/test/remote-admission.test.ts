import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHubConfig } from "../src/config.js";
import type { IssuedCredential } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "../src/protocol.js";
import { isLoopbackEndpoint, isLoopbackHost } from "../src/remote-url.js";
import { createHub, type Hub } from "../src/server.js";
import { importCredentialKey, mintRequestProof, mintToken } from "../src/token.js";
import { createClient, removeTempDatabases, tempDatabasePath, TEST_SECRET, testRoom, token,
  type TestClient, waitForText, waitUntil, WORKSPACE } from "./helpers.js";

const hubs: Hub[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

async function remote(options: { address?: string; github?: boolean; secret?: string } = {}) {
  const logs: HubLogRecord[] = [];
  const hub = await createHub({ address: options.address ?? "0.0.0.0", port: 0,
    databasePath: tempDatabasePath(), ...(options.secret === undefined ? {} : { authSecret: options.secret }),
    log: record => logs.push(record),
    ...(options.github === false ? {} : { github: { clientId: "Iv1.0123456789abcdef" } }),
  });
  hubs.push(hub);
  return { hub, logs };
}

function connect(hub: Hub, room: string, presented: string, version = SYNC_PROTOCOL_VERSION) {
  const client = createClient({ port: hub.port, room, token: presented,
    protocolVersion: version, reconnectDelayMs: 60_000 });
  clients.push(client);
  return client;
}

async function credentialToken(issued: IssuedCredential, workspace = WORKSPACE) {
  return mintToken(await importCredentialKey(issued.keyBytes), {
    typ: "room", sub: issued.record.principalId, workspace,
    scope: "read-write", kid: issued.record.id, lifetimeSeconds: 60,
  });
}

describe("one local boundary", () => {
  it("recognizes loopback hosts and requires remote admission for everything else", () => {
    for (const host of ["localhost", "127.0.0.1", "127.255.12.3", "::1", "[::1]", "0:0:0:0:0:0:0:1"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "[::]", "127.example.com", "127.1", "127.300.0.1", "127.0.0.1.example", "10.0.0.1"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
  it("uses endpoint host only and never treats wildcards as local", () => {
    expect(isLoopbackEndpoint("ws://127.4.3.2:1234/ws")).toBe(true);
    expect(isLoopbackEndpoint("ws://[::1]:1234/ws")).toBe(true);
    expect(isLoopbackEndpoint("wss://example.com/127.0.0.1")).toBe(false);
    expect(isLoopbackEndpoint("ws://0.0.0.0:1234")).toBe(false);
    expect(resolveHubConfig({ HUB_HOST: "0.0.0.0", HUB_AUTH_TOKEN: "obsolete" })).not.toHaveProperty("authSecret");
    expect(resolveHubConfig({ HUB_HOST: "::" })).not.toHaveProperty("authSecret");
    expect(() => resolveHubConfig({ HUB_HOST: "127.0.0.1" })).toThrow(/HUB_AUTH_TOKEN/);
  });
});

describe("remote createHub admission", () => {
  it("a loopback test seam only tightens admission", async () => {
    const hub = await createHub({ address: "127.0.0.1", port: 0,
      databasePath: tempDatabasePath(), authSecret: TEST_SECRET,
      github: { clientId: "Iv1.0123456789abcdef" }, log: () => {} }, { deviceCredentials: true });
    hubs.push(hub);
    await expect(connect(hub, testRoom(), await token()).denied).resolves.toBe("device-credential-refused");
  });

  it("ignores a leftover shared secret and checks protocol before device authority", async () => {
    const { hub } = await remote({ secret: TEST_SECRET });
    const root = await token();
    await expect(connect(hub, testRoom(), root).denied).resolves.toBe("device-credential-refused");
    await expect(connect(hub, testRoom(), root, SYNC_PROTOCOL_VERSION - 1).denied)
      .resolves.toBe(`protocol-mismatch:${SYNC_PROTOCOL_VERSION}`);
    const member = hub.principals!.identify("1234", "member");
    const issued = hub.credentials!.issue({ principalId: member.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
    await expect(connect(hub, testRoom(), await credentialToken(issued)).denied).resolves.toBe("device-credential-refused");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: member.id, role: "admin" });
    const admitted = connect(hub, testRoom(), await credentialToken(issued));
    await admitted.synced;
    const outsideLimit = hub.credentials!.issue({ principalId: member.id, deviceId: randomUUID(), workspaces: [] });
    await expect(connect(hub, testRoom(), await credentialToken(outsideLimit)).denied).resolves.toBe("device-credential-refused");
  });

  it("admits nobody without sign-in and states why at startup", async () => {
    const { hub, logs } = await remote({ github: false, secret: TEST_SECRET });
    await expect(connect(hub, testRoom(), await token()).denied).resolves.toBe("device-sign-in-unavailable");
    expect(logs).toContainEqual({ event: "hub.auth.unavailable",
      reason: "GitHub sign-in is not configured; this remote hub admits no clients" });
  });

  it.each(["revoke", "remove"])("%s closes live sessions on the same factory authorities", async operation => {
    const { hub } = await remote();
    const member = hub.principals!.identify("1234", "member");
    const admin = hub.principals!.identify("5678", "admin");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: admin.id, role: "admin" });
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: member.id, role: "member" });
    const issued = hub.credentials!.issue({ principalId: member.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
    const observerCredential = hub.credentials!.issue({ principalId: admin.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
    const room = testRoom();
    const writer = connect(hub, room, await credentialToken(issued));
    const observer = connect(hub, room, await credentialToken(observerCredential));
    await Promise.all([writer.synced, observer.synced]);
    writer.text.insert(0, "downloaded data");
    await waitForText("initial remote edit", observer.text, "downloaded data");
    const context = hub.hocuspocus.documents.get(room)!.getConnections()
      .find(connection => "credentialId" in connection.context && connection.context.credentialId === issued.record.id)!.context;
    if (!("authorization" in context)) throw new Error("remote context missing credential authority");
    if (operation === "revoke") hub.credentials!.revoke(issued.record.id);
    else hub.memberships!.remove({ workspaceId: WORKSPACE, principalId: member.id, actorPrincipalId: admin.id });
    expect(context.authorization.active).toBe(false);
    await waitUntil("remote member room closes", () => hub.hocuspocus.documents.get(room)!.getConnections().length === 1);
    writer.text.insert(writer.text.length, " local pending edit");
    expect(writer.text.toString()).toBe("downloaded data local pending edit");
    expect(observer.text.toString()).toBe("downloaded data");
    await expect(connect(hub, testRoom(), await credentialToken(issued)).denied).resolves.toBe("device-credential-refused");
  });

  it("keeps same-app hubs' live admission, renewal and revocation isolated", async () => {
    const { hub: first } = await remote();
    const { hub: second } = await remote();
    const firstMember = first.principals!.identify("1234", "same-person");
    const secondMember = second.principals!.identify("1234", "same-person");
    expect(firstMember.id).not.toBe(secondMember.id);
    const issued = [first, second].map((hub, index) => {
      const principalId = [firstMember.id, secondMember.id][index]!;
      hub.memberships!.grant({ workspaceId: WORKSPACE, principalId, role: "admin" });
      return hub.credentials!.issue({ principalId, deviceId: randomUUID(), workspaces: [WORKSPACE] });
    });
    const firstToken = await credentialToken(issued[0]!);
    const secondClient = connect(second, testRoom(), await credentialToken(issued[1]!));
    await secondClient.synced;
    await expect(connect(second, testRoom(), firstToken).denied).resolves.toBe("device-credential-refused");
    const proof = await mintRequestProof(await importCredentialKey(issued[0]!.keyBytes), {
      kid: issued[0]!.record.id, operation: "renew-credential", lifetimeSeconds: 60,
    });
    const response = await fetch(`http://127.0.0.1:${second.port}/auth/credential/renew`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: wrapToken(proof),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: "sign-in-required" });
    first.credentials!.revoke(issued[0]!.record.id);
    expect(second.credentials!.get(issued[1]!.record.id)?.revokedAt).toBeNull();
    expect(second.hocuspocus.documents.get(secondClient.provider.configuration.name)?.getConnections()).toHaveLength(1);
    expect(second.memberships!.roleFor(WORKSPACE, secondMember.id)).toBe("admin");
  });
});
