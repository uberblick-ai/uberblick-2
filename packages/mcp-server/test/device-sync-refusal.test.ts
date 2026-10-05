/** Remote clients keep local tools usable across device admission failures. */
import { chmodSync } from "node:fs";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readHubLogins, writeHubLogin } from "@uberblick/hub/auth-store";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { getMeta, roomForDoc } from "@uberblick/schema";
import { resolveMcpConfig } from "../src/config.js";
import { caughtUp, client, closeClient, closeDeviceSync, config, environment, hub } from "./device-sync-fixture.js";
import { sleep, testConfig, waitUntil, WORKSPACE } from "./helpers.js";

afterEach(closeDeviceSync);

describe("stored-login refusal", () => {
  it("reports a stopped loopback deployment as unreachable even without its stored login", async () => {
    const fixture = await hub();
    await fixture.pause();
    const env = environment();
    const configured = resolveMcpConfig({ ...env, WORKSPACE_ID: WORKSPACE, HUB_URL: fixture.url, HUB_ADMISSION: "device" });
    const rig = await client({ ...configured, ...testConfig({ hubUrl: fixture.url }), deviceLogin: { env }, connectTimeoutMs: 250 });
    await waitUntil("stopped deployment reading", () => rig.instance.replicas.sync.state().status === "hub-down");
    expect(rig.instance.replicas.sync.state().reason).toContain(fixture.url);
  });

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
    // Several reconnects at this rig's 250ms cap, all inside the cooldown.
    await sleep(750);
    expect(fixture.renewalCount).toBe(1);
    expect((await rig.ok("get_doc", { uuid: written.uuid })).title).toBe("Still local");
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

  it("does not use a refused store and every local tool remains available", async () => {
    const fixture = await hub();
    const env = environment();
    const login = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, login, env);
    chmodSync(readHubLogins(env).path, 0o644);
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
    { status: 200, raw: "unreadable renewal" },
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
      await closeClient(redirected);
    } finally {
      await new Promise<void>((resolve, reject) => redirector.close((error) => error ? reject(error) : resolve()));
    }
  });

  // A login naming the workspace meets the skew at room admission; one without
  // it meets the skew at renewal. One skew direction per door still reaches
  // both doors and both directions.
  it.each([
    { hubVersion: SYNC_PROTOCOL_VERSION - 1, door: "room admission", workspaces: [WORKSPACE] },
    { hubVersion: SYNC_PROTOCOL_VERSION + 1, door: "renewal", workspaces: [] },
  ])("keeps a protocol mismatch with hub $hubVersion terminal on $door", async ({ hubVersion, workspaces }) => {
    const fixture = await hub(hubVersion);
    const env = environment();
    fixture.grant(WORKSPACE);
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces }), env);
    const rig = await client(config(fixture, env));
    await waitUntil("update-required reading", () => rig.instance.replicas.sync.state().status === "update-required");
    expect(rig.instance.replicas.sync.state()).toMatchObject({ recoveryClass: "manual", hubProtocolVersion: hubVersion });
    expect(rig.instance.replicas.sync.state().reason).not.toMatch(/secret/i);
    const count = fixture.renewalCount;
    // Several reconnect windows at this rig's 250ms cap.
    await sleep(750);
    expect(fixture.renewalCount).toBe(count);
    expect(await rig.ok("create_doc", { title: "Local across skew", description: "Not acknowledged." })).toMatchObject({ applied: true, synced: false });
  });
});
