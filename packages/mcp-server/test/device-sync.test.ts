/** Remote clients resume device sync after a later login or grant, keeping local work. */
import { afterEach, describe, expect, it } from "vitest";
import { readHubLogins, writeHubLogin } from "@uberblick/hub/auth-store";
import { MAX_TOKEN_LIFETIME_SECONDS } from "@uberblick/hub/token";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { getMeta, roomForDoc } from "@uberblick/schema";
import { resolveMcpConfig } from "../src/config.js";
import { createMcpEngine } from "../src/engine.js";
import { inspectRemote, syncWorkspace } from "../src/remote.js";
import { caughtUp, client, closeClient, closeDeviceSync, config, environment, expireRenewalCooldown, hub } from "./device-sync-fixture.js";
import { testConfig, waitUntil, WORKSPACE } from "./helpers.js";

afterEach(closeDeviceSync);

describe("stored-login sync", () => {
  it("discovers device admission through a loopback proxy and resumes pending edits after login", async () => {
    const fixture = await hub();
    fixture.grant(WORKSPACE);
    const env = environment();
    const initial = resolveMcpConfig({ ...env, WORKSPACE_ID: WORKSPACE, HUB_URL: fixture.url, HUB_AUTH_TOKEN: "old-local-secret" });
    const rig = await client({ ...initial, ...testConfig({ hubUrl: fixture.url, authSecret: "old-local-secret" }), authEnv: env });
    await waitUntil("loopback device sign-in recovery", () => rig.instance.replicas.sync.state().authRecovery === "sign-in-required");
    expect(rig.instance.replicas.sync.state().reason).toContain("ub auth login");
    expect(rig.instance.replicas.sync.state().reason).not.toContain("secret");
    const written = await rig.ok("create_doc", { title: "Login after local proxy admission", description: "Retains pending local edits." });
    expect(written.synced).toBe(false);
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces: [WORKSPACE] }), env);
    await caughtUp(rig);
    expect(getMeta(fixture.readRoom(roomForDoc(WORKSPACE, written.uuid))!).title).toBe("Login after local proxy admission");
  });

  it.each(["missing", "revoked"] as const)("resumes a running refused process after later login (%s)", async kind => {
    const fixture = await hub();
    fixture.grant(WORKSPACE);
    const env = environment();
    if (kind === "revoked") {
      const old = fixture.issue({ workspaces: [WORKSPACE] });
      await writeHubLogin(fixture.origin, old, env);
      fixture.revoke(old.credential.record.id);
    }
    const rig = await client(config(fixture, env));
    await waitUntil("refused login reading", () => rig.instance.replicas.sync.state().authRecovery === "sign-in-required");
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
    const replacement = fixture.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(fixture.origin, replacement, env);
    fixture.closeConnections();
    await waitUntil("new login to reach the running server", () => fixture.authentications.some(({ claims }) => claims?.kid === replacement.credential.record.id));
    await caughtUp(rig);
    expect(rig.instance.replicas.sync.mintCount).toBeGreaterThan(count);
    expect(fixture.renewalCount).toBe(0);
    const output = JSON.stringify(await rig.ok("sync_status"));
    expect(output).not.toContain(login.credential.key);
    expect(output).not.toContain(replacement.credential.key);
    await closeClient(rig);
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
});
