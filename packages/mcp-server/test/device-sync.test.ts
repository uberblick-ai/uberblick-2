/** Remote clients keep local tools usable across device admission failures. */
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readHubLogins, writeHubLogin } from "@uberblick/hub/auth-store";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { MAX_TOKEN_LIFETIME_SECONDS } from "@uberblick/hub/token";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { getMeta, roomForDoc } from "@uberblick/schema";
import { resolveMcpConfig } from "../src/config.js";
import { createMcpEngine } from "../src/engine.js";
import { inspectRemote, syncWorkspace } from "../src/remote.js";
import type { McpConfig } from "../src/config.js";
import type { Rig } from "./helpers.js";
import { removeTempDirs, sleep, startServer, tempDir, testConfig, waitUntil, WORKSPACE } from "./helpers.js";

type DeviceHub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const hubs: DeviceHub[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  for (const hub of hubs.splice(0)) await hub.close();
  removeTempDirs();
});

async function hub(protocolVersion?: number): Promise<DeviceHub> {
  const fixture = await startDeviceSyncHub({ directory: tempDir(), ...(protocolVersion === undefined ? {} : { protocolVersion }) });
  hubs.push(fixture);
  return fixture;
}
function environment(): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: tempDir() };
}
function config(fixture: DeviceHub, env: NodeJS.ProcessEnv): McpConfig {
  return { ...testConfig({ hubUrl: fixture.url }), deviceLogin: { env } };
}
async function client(config: McpConfig): Promise<Rig> {
  const rig = await startServer(config);
  rigs.push(rig);
  return rig;
}
async function caughtUp(rig: Rig): Promise<void> {
  await waitUntil("every room to be acknowledged", async () => {
    const status = await rig.ok("sync_status");
    return status.hub.status === "connected" && status.pendingRooms.length === 0 &&
      status.rooms.every((room: { synced: boolean }) => room.synced);
  }, 70_000);
}

function expireRenewalCooldown(env: NodeJS.ProcessEnv): void {
  const directory = join(env.XDG_CONFIG_HOME!, "uberblick");
  for (const name of readdirSync(directory).filter(name => name.startsWith(".credential-renewal-") && name.endsWith(".json"))) {
    const path = join(directory, name);
    const outcome = JSON.parse(readFileSync(path, "utf8"));
    outcome.retryAt = 0;
    writeFileSync(path, JSON.stringify(outcome), { mode: 0o600 });
  }
}

describe("stored-login sync", () => {
  it("selects stored login for remote endpoints and never falls back to a supplied signing secret", async () => {
    const fixture = await hub();
    const env = environment();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, login, env);
    expect(resolveMcpConfig({ WORKSPACE_ID: WORKSPACE, DEVICE_LOGIN: "true" }).deviceLogin).toBeUndefined();
    const remote = resolveMcpConfig({ ...env, WORKSPACE_ID: WORKSPACE, HUB_URL: "wss://hub.example/ws", HUB_AUTH_TOKEN: "a-root-secret" });
    expect(remote.deviceLogin).toEqual({ env: expect.any(Object) });
    expect(remote.authSecret).toBeNull();
    const rig = await client({ ...config(fixture, environment()), authSecret: "a-root-secret" });
    await waitUntil("missing login reading", () => rig.instance.replicas.sync.state().authRecovery === "sign-in-required");
    expect(fixture.authentications).toHaveLength(0);
    expect(rig.instance.replicas.sync.mintCount).toBe(0);
  });

  it.each(["missing", "revoked", "store-refused"] as const)("resumes a running refused process after later login (%s)", async kind => {
    const fixture = await hub();
    fixture.grant(WORKSPACE);
    const env = environment();
    if (kind !== "missing") {
      const old = fixture.issue({ workspaces: [WORKSPACE] });
      await writeHubLogin(fixture.origin, old, env);
      if (kind === "revoked") fixture.revoke(old.credential.record.id);
      else chmodSync(readHubLogins(env).path, 0o644);
    }
    const rig = await client(config(fixture, env));
    await waitUntil("refused login reading", () => rig.instance.replicas.sync.state().authRecovery === (kind === "store-refused" ? "credential-store" : "sign-in-required"));
    if (kind === "missing") {
      // onOpen and the first inbound message both announce connected. The
      // second announcement must preserve the poll that can discover login.
      const sync = rig.instance.replicas.sync as unknown as {
        socketStatus: string; deviceRetryTimer: unknown;
        socket: { emit(name: string, event: { status: string }): void };
      };
      await waitUntil("missing login recovery scheduled", () => sync.socketStatus === "connected" && sync.deviceRetryTimer !== null);
      sync.socket.emit("status", { status: "connected" });
    }
    const written = await rig.ok("create_doc", { title: `Pending ${kind}`, description: "Local edits survive sign-in." });
    expect(written.synced).toBe(false);
    if (kind === "store-refused") chmodSync(readHubLogins(env).path, 0o600);
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces: [WORKSPACE] }), env);
    await caughtUp(rig);
    expect(getMeta(fixture.readRoom(roomForDoc(WORKSPACE, written.uuid))!).title).toBe(`Pending ${kind}`);
  });

  it("discovers a grant after a confirmed denial without login or restart", async () => {
    const fixture = await hub();
    const env = environment();
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces: [] }), env);
    const rig = await client(config(fixture, env));
    await waitUntil("initial no access", () => rig.instance.replicas.sync.state().authRecovery === "no-workspace-access");
    const written = await rig.ok("create_doc", { title: "Granted later", description: "Same login, same log." });
    await rig.instance.replicas.sync.waitForDeviceWork();
    fixture.grant(WORKSPACE);
    expireRenewalCooldown(env);
    await caughtUp(rig);
    expect(getMeta(fixture.readRoom(roomForDoc(WORKSPACE, written.uuid))!).title).toBe("Granted later");
  });

  it.each(["revoke", "membership"] as const)("ends live sync and retains downloaded documents (%s)", async kind => {
    const fixture = await hub();
    fixture.grant(WORKSPACE);
    const env = environment();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, login, env);
    const rig = await client(config(fixture, env));
    const written = await rig.ok("create_doc", { title: "Downloaded stays", description: "Access cannot erase local data." });
    await caughtUp(rig);
    if (kind === "revoke") fixture.revoke(login.credential.record.id);
    else fixture.removeMembership(WORKSPACE);
    await waitUntil("live access ended", () => rig.instance.replicas.sync.state().authRecovery === (kind === "revoke" ? "sign-in-required" : "no-workspace-access"));
    expect((await rig.ok("get_doc", { uuid: written.uuid })).title).toBe("Downloaded stays");
    const next = await rig.ok("create_doc", { title: "After removal", description: "Still editable locally." });
    expect(next).toMatchObject({ applied: true, synced: false });
    expect(fixture.readRoom(roomForDoc(WORKSPACE, next.uuid))).toBeUndefined();
  });

  it("syncs every workspace room, reads fresh logins on reconnect and resumes after restart", async () => {
    const fixture = await hub();
    fixture.grant(WORKSPACE);
    const env = environment();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, login, env);
    const cfg = config(fixture, env);
    const rig = await client(cfg);
    const created = await rig.ok("create_doc", { title: "Device document", description: "Private local replica." });
    await caughtUp(rig);
    expect(getMeta(fixture.readRoom(roomForDoc(WORKSPACE, created.uuid))!).title).toBe("Device document");
    const rooms = rig.instance.replicas.attachedReplicas().map(({ room }) => room);
    expect(new Set(fixture.authentications.map(({ room }) => room))).toEqual(new Set(rooms));
    for (const { claims, protocolVersion } of fixture.authentications) {
      expect(claims).toMatchObject({ kid: login.credential.record.id, typ: "room", workspace: WORKSPACE });
      expect(claims!.exp - claims!.iat).toBeLessThanOrEqual(MAX_TOKEN_LIFETIME_SECONDS);
      expect(protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
    }
    const count = rig.instance.replicas.sync.mintCount;
    const firstIssuedAt = fixture.authentications[0]!.claims!.iat;
    const replacement = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, replacement, env);
    await sleep(1_100);
    fixture.closeConnections();
    await waitUntil("new login to reach the running server", () => fixture.authentications.some(({ claims }) => claims?.kid === replacement.credential.record.id));
    await caughtUp(rig);
    expect(rig.instance.replicas.sync.mintCount).toBeGreaterThan(count);
    expect(fixture.authentications.find(({ claims }) => claims?.kid === replacement.credential.record.id)!.claims!.iat).toBeGreaterThan(firstIssuedAt);
    expect(fixture.renewalCount).toBe(0);
    const output = JSON.stringify(await rig.ok("sync_status"));
    expect(output).not.toContain(login.credential.key);
    expect(output).not.toContain(replacement.credential.key);
    await rig.close();
    rigs.splice(rigs.indexOf(rig), 1);
    const restarted = await client(cfg);
    expect((await restarted.ok("get_doc", { uuid: created.uuid })).title).toBe("Device document");
    await caughtUp(restarted);
    expect(fixture.renewalCount).toBe(0);
  });

  it("uses the same stored-login path for the background serving engine and CLI probes", async () => {
    const fixture = await hub();
    fixture.grant(WORKSPACE);
    const env = environment();
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces: [WORKSPACE] }), env);
    const cfg = config(fixture, env);
    const engine = await createMcpEngine(cfg);
    try {
      await waitUntil("serving engine rooms to sync", () => engine.replicas.attachedReplicas().every(({ room }) => engine.replicas.isRoomQuiet(room)));
    } finally { await engine.close(); }
    const probe = await inspectRemote(cfg);
    expect(probe.hub.status).toBe("connected");
    const corpus = await syncWorkspace(cfg);
    expect(corpus.hub.status).toBe("connected");
    expect(corpus.unsettled).toEqual([]);
  });

  it("renews a missing workspace once and every concurrent client continues with the stored result", async () => {
    const fixture = await hub();
    fixture.grant(WORKSPACE);
    fixture.setRenewalDelay(100);
    const env = environment();
    const login = fixture.issue({ workspaces: [] });
    await writeHubLogin(fixture.origin, login, env);
    const [first, second] = await Promise.all([client(config(fixture, env)), client(config(fixture, env))]);
    await Promise.all([caughtUp(first), caughtUp(second)]);
    expect(fixture.renewalCount).toBe(1);
    const stored = readHubLogins(env).logins[fixture.origin]!;
    expect(stored.identity).toEqual(login.identity);
    expect(stored.credential.record.id).not.toBe(login.credential.record.id);
    expect(stored.credential.record.workspaces).toEqual([WORKSPACE]);
    expect(stored.credential.record).not.toHaveProperty("replacedAt");
  });

  it("renews generic room refusal and distinguishes missing membership from sign-in", async () => {
    const fixture = await hub();
    const env = environment();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, login, env);
    const rig = await client(config(fixture, env));
    await waitUntil("renewal to confirm no workspace access", () => rig.instance.replicas.sync.state().authRecovery === "no-workspace-access");
    const status = await rig.ok("sync_status");
    expect(status.hub).toMatchObject({ status: "auth-failed", recoveryClass: "manual", authRecovery: "no-workspace-access" });
    expect(status.hub.reason).toContain("GitHub account");
    expect(status.hub.reason).toContain(WORKSPACE);
    const written = await rig.ok("create_doc", { title: "Still local", description: "An unacknowledged write." });
    expect(written).toMatchObject({ applied: true, synced: false });
    await sleep(1_500);
    expect(fixture.renewalCount).toBe(1);
    expect((await rig.ok("get_doc", { uuid: written.uuid })).title).toBe("Still local");
  });

  it("reports revoked login as sign-in required, preserving pending work until a new login", async () => {
    const fixture = await hub();
    fixture.grant(WORKSPACE);
    const env = environment();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, login, env);
    fixture.revoke(login.credential.record.id);
    const cfg = config(fixture, env);
    const rig = await client(cfg);
    await waitUntil("revoked login sign-in reading", () => rig.instance.replicas.sync.state().authRecovery === "sign-in-required");
    expect(rig.instance.replicas.sync.state().reason).toContain(`ub auth login ${fixture.origin}`);
    const written = await rig.ok("create_doc", { title: "Survives refusal", description: "Pending until a hub ack." });
    expect(written).toMatchObject({ applied: true, synced: false });
    expect((await rig.ok("sync_status")).pendingRooms.length).toBeGreaterThan(0);
    await rig.close();
    rigs.splice(rigs.indexOf(rig), 1);
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces: [WORKSPACE] }), env);
    const restarted = await client(cfg);
    expect((await restarted.ok("get_doc", { uuid: written.uuid })).title).toBe("Survives refusal");
    await caughtUp(restarted);
    expect(getMeta(fixture.readRoom(roomForDoc(WORKSPACE, written.uuid))!).title).toBe("Survives refusal");
  });

  it("never presents another hub's login even when that login names this workspace", async () => {
    const first = await hub();
    const second = await hub();
    const env = environment();
    const login = first.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(first.origin, login, env);
    const rig = await client(config(second, env));
    await waitUntil("other origin to require its own sign-in", () => rig.instance.replicas.sync.state().authRecovery === "sign-in-required");
    expect(second.authentications).toEqual([]);
    expect(second.renewalCount).toBe(0);
    expect(JSON.stringify(await rig.ok("sync_status"))).not.toContain(login.credential.key);
  });

  it("keeps both signed-in hubs independent when one revokes this machine", async () => {
    const first = await hub();
    const second = await hub();
    first.grant(WORKSPACE); second.grant(WORKSPACE);
    const env = environment();
    const one = first.issue({ workspaces: [WORKSPACE] });
    const two = second.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(first.origin, one, env);
    await writeHubLogin(second.origin, two, env);
    const a = await client(config(first, env));
    const b = await client(config(second, env));
    await Promise.all([caughtUp(a), caughtUp(b)]);
    first.revoke(one.credential.record.id);
    await waitUntil("only first hub to require sign-in", () => a.instance.replicas.sync.state().authRecovery === "sign-in-required");
    await caughtUp(b);
    expect(readHubLogins(env).logins[second.origin]).toEqual(two);
    expect(second.renewalCount).toBe(0);
    expect(second.authentications.every(auth => auth.claims?.kid === two.credential.record.id)).toBe(true);
    expect(first.authentications.every(auth => auth.claims?.kid === one.credential.record.id)).toBe(true);
  });

  it("reports a missing stored login locally even when the hub cannot be reached", async () => {
    const fixture = await hub();
    const cfg = config(fixture, environment());
    await fixture.pause();
    const rig = await client(cfg);
    expect(rig.instance.replicas.sync.state()).toMatchObject({ status: "auth-failed", authRecovery: "sign-in-required", recoveryClass: "manual" });
    expect(rig.instance.replicas.sync.state().reason).toContain(`ub auth login ${fixture.origin}`);
    const written = await rig.ok("create_doc", { title: "No login or hub", description: "Still local." });
    expect(written).toMatchObject({ applied: true, synced: false });
  });

  it.each(["refused", "unreadable"] as const)("does not use a %s store and every local tool remains available", async (kind) => {
    const fixture = await hub();
    const env = environment();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, login, env);
    const path = readHubLogins(env).path;
    if (kind === "refused") chmodSync(path, 0o644);
    else writeFileSync(path, "not-json", { mode: 0o600 });
    const rig = await client(config(fixture, env));
    await waitUntil("credential store reading", () => rig.instance.replicas.sync.state().authRecovery === "credential-store");
    const status = await rig.ok("sync_status");
    expect(status.hub).toMatchObject({ status: "auth-failed", recoveryClass: "manual" });
    expect(status.hub.reason).toContain("credential store");
    expect(fixture.authentications).toEqual([]);
    expect(fixture.renewalCount).toBe(0);
    const write = await rig.ok("create_doc", { title: "Local despite store", description: "Safe local operation." });
    expect(write).toMatchObject({ applied: true, synced: false });
    expect((await rig.ok("get_doc", { uuid: write.uuid })).title).toBe("Local despite store");
    expect((await rig.ok("search", { query: "Local" })).hits.map((hit: { uuid: string }) => hit.uuid)).toContain(write.uuid);
    expect(await rig.ok("get_sidebar")).toBeDefined();
  });

  it.each([
    { status: 500, body: { status: "failed" } },
    { status: 503, raw: "proxy unavailable" },
    { status: 200, raw: "unreadable renewal" },
    { status: 400, body: { status: "invalid-request" } },
  ])("keeps failed or unreadable renewal ($status) retryable and local", async (reply) => {
    const fixture = await hub();
    const env = environment();
    const login = fixture.issue({ workspaces: [] });
    await writeHubLogin(fixture.origin, login, env);
    fixture.setRenewalReply(reply);
    const rig = await client(config(fixture, env));
    await waitUntil("retryable renewal reading", () => rig.instance.replicas.sync.state().status === "hub-down");
    const status = await rig.ok("sync_status");
    expect(status.hub).toMatchObject({ status: "hub-down", recoveryClass: "retry" });
    expect(status.hub).not.toHaveProperty("authRecovery");
    expect(status.hub.reason).not.toMatch(/sign.in|no access/i);
    expect(readHubLogins(env).logins[fixture.origin]).toEqual(login);
    const written = await rig.ok("create_doc", { title: "Offline renewal", description: "No content is discarded." });
    expect(written).toMatchObject({ applied: true, synced: false });
    expect((await rig.ok("sync_status")).pendingRooms.length).toBeGreaterThan(0);
  });

  it("keeps an unreachable hub retryable and never labels it a sign-in refusal", async () => {
    const fixture = await hub();
    const env = environment();
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces: [WORKSPACE] }), env);
    const cfg = config(fixture, env);
    await fixture.pause();
    const rig = await client(cfg);
    await waitUntil("unreachable hub reading", () => rig.instance.replicas.sync.state().status === "hub-down");
    expect(rig.instance.replicas.sync.state()).toMatchObject({ status: "hub-down", recoveryClass: "retry" });
    expect(rig.instance.replicas.sync.state()).not.toHaveProperty("authRecovery");
    const written = await rig.ok("create_doc", { title: "Unreachable", description: "Waiting for acknowledgement." });
    expect(written).toMatchObject({ applied: true, synced: false });
    fixture.grant(WORKSPACE);
    await fixture.resume();
    await caughtUp(rig);
    expect(getMeta(fixture.readRoom(roomForDoc(WORKSPACE, written.uuid))!).title).toBe("Unreachable");
  });

  it("distinguishes an unconfigured renewal route from a proxy outage", async () => {
    const fixture = await hub();
    const env = environment();
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces: [] }), env);
    fixture.setRenewalReply({ status: 503, body: { status: "not-configured" } });
    const rig = await client(config(fixture, env));
    await waitUntil("unconfigured renewal route reading", () => rig.instance.replicas.sync.state().authRecovery === "renewal-unavailable");
    expect(rig.instance.replicas.sync.state()).toMatchObject({ status: "auth-failed", recoveryClass: "manual" });
    expect(rig.instance.replicas.sync.state().reason).not.toMatch(/sign.in|no access/i);
  });

  it("never follows renewal or websocket redirects to another authentication origin", async () => {
    const issuer = await hub();
    const other = await hub();
    const env = environment();
    await writeHubLogin(issuer.origin, issuer.issue({ workspaces: [] }), env);
    issuer.setRenewalReply({ status: 307, location: `${other.origin}/auth/credential/renew` });
    const rig = await client(config(issuer, env));
    await waitUntil("redirect refusal to stay offline", () => issuer.renewalCount > 0 && rig.instance.replicas.sync.state().status === "hub-down");
    expect(other.renewalCount).toBe(0);
    expect(other.authentications).toEqual([]);

    const redirector = createServer((_request, response) => {
      response.writeHead(302, { Location: other.url });
      response.end();
    });
    redirector.on("upgrade", (_request, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${other.url}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    try {
      const address = redirector.address();
      if (address === null || typeof address === "string") throw new Error("no redirect server port");
      const origin = `http://127.0.0.1:${address.port}`;
      await writeHubLogin(origin, issuer.issue({ workspaces: [WORKSPACE] }), env);
      const redirected = await client({ ...config(issuer, env), hubUrl: `ws://127.0.0.1:${address.port}` });
      await waitUntil("websocket redirect refusal", () => redirected.instance.replicas.sync.state().status === "hub-down");
      expect(redirected.instance.replicas.sync.mintCount).toBe(0);
      expect(other.authentications).toEqual([]);
      await redirected.close();
      rigs.splice(rigs.indexOf(redirected), 1);
    } finally {
      await new Promise<void>((resolve, reject) => redirector.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([SYNC_PROTOCOL_VERSION - 1, SYNC_PROTOCOL_VERSION + 1])("keeps a protocol mismatch with hub %s terminal on room admission and renewal", async hubVersion => {
    for (const workspaces of [[WORKSPACE], []]) {
      const fixture = await hub(hubVersion);
      const env = environment();
      fixture.grant(WORKSPACE);
      await writeHubLogin(fixture.origin, fixture.issue({ workspaces }), env);
      const rig = await client(config(fixture, env));
      await waitUntil("update-required reading", () => rig.instance.replicas.sync.state().status === "update-required");
      expect(rig.instance.replicas.sync.state()).toMatchObject({ recoveryClass: "manual", hubProtocolVersion: hubVersion });
      expect(rig.instance.replicas.sync.state().reason).not.toMatch(/secret/i);
      const count = fixture.renewalCount;
      await sleep(1_500);
      expect(fixture.renewalCount).toBe(count);
      expect(await rig.ok("create_doc", { title: "Local across skew", description: "Not acknowledged." })).toMatchObject({ applied: true, synced: false });
    }
  });
});
