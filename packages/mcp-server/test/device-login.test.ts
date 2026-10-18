import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { DEVICE_CREDENTIAL_LIFETIME_MS } from "@uberblick/schema/token";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialsPath, readHubLogins, removeHubLogin, usesDeviceCredentials, writeHubLogin } from "../src/auth-store.js";
import { DEVICE_CREDENTIAL_RENEWAL_AGE_MS, ensureDeviceLogin, readDeviceLogin } from "../src/device-login.js";
import { acquireInitLock } from "../src/init-lock.js";
import { cleanupTestResources } from "./helpers.js";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const directories: string[] = [];
const hubs: Awaited<ReturnType<typeof startDeviceSyncHub>>[] = [];
function box(): { directory: string; env: NodeJS.ProcessEnv } {
  const directory = mkdtempSync(join(tmpdir(), `device-login-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  directories.push(directory);
  return { directory, env: { ...process.env, XDG_CONFIG_HOME: directory } };
}
async function setup() {
  const test = box();
  const hub = await startDeviceSyncHub({ directory: test.directory });
  hubs.push(hub);
  return { ...test, hub };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({

    hubs: hubs.splice(0).map((hub) => () => hub.close()),
    after: directories.splice(0).map((directory) => () => rmSync(directory, { recursive: true, force: true })),
  });
});

async function waitForRequest(hub: Awaited<ReturnType<typeof startDeviceSyncHub>>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (hub.renewalCount === 0) {
    if (Date.now() >= deadline) throw new Error("renewal request did not arrive");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

describe("stored device login renewal", () => {
  it.each([false, true])("renews by age unconditionally even when workspace access is unchanged (missing: %s)", async missing => {
    const test = await setup();
    if (!missing) test.hub.grant(WORKSPACE);
    const before = test.hub.issue({ workspaces: missing ? [] : [WORKSPACE] });
    before.credential.record.issuedAt = Date.now() - DEVICE_CREDENTIAL_LIFETIME_MS / 2;
    await writeHubLogin(test.hub.origin, before, test.env);
    const results = await Promise.all([
      ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env }),
      ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env }),
    ]);
    expect(results.map(result => result.status)).toEqual(missing ? ["no-access", "no-access"] : ["ready", "ready"]);
    expect(test.hub.renewalCount).toBe(1);
    const after = readHubLogins(test.env).logins[test.hub.origin]!;
    expect(after.credential.record.id).not.toBe(before.credential.record.id);
    expect(after.credential.record.deviceId).toBe(before.credential.record.deviceId);
    expect(after.credential.record.issuedAt).toBeGreaterThan(before.credential.record.issuedAt);
  });

  it.each([false, true])("renews at half-life despite a cached unchanged-access result (missing: %s)", async missing => {
    const test = await setup();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    test.hub.grant(WORKSPACE);
    const before = test.hub.issue({ workspaces: [WORKSPACE] });
    before.credential.record.issuedAt = now - DEVICE_CREDENTIAL_RENEWAL_AGE_MS + 1_000;
    await writeHubLogin(test.hub.origin, before, test.env);

    expect((await ensureDeviceLogin(test.hub.url, OTHER_WORKSPACE, { env: test.env })).status).toBe("no-access");
    expect((await ensureDeviceLogin(test.hub.url, OTHER_WORKSPACE, { env: test.env })).status).toBe("no-access");
    expect(test.hub.renewalCount).toBe(1);
    expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(before);

    now += 1_000;
    const workspace = missing ? OTHER_WORKSPACE : WORKSPACE;
    const results = await Promise.all([
      ensureDeviceLogin(test.hub.url, workspace, { env: test.env }),
      ensureDeviceLogin(test.hub.url, workspace, { env: test.env }),
    ]);
    expect(results.map(result => result.status)).toEqual(missing ? ["no-access", "no-access"] : ["ready", "ready"]);
    expect(test.hub.renewalCount).toBe(2);
    const after = readHubLogins(test.env).logins[test.hub.origin]!;
    expect(after.credential.record.id).not.toBe(before.credential.record.id);
    expect(after.credential.record.issuedAt).toBe(now);
  });

  it("reads a login at its full lifetime as signed out without attempting renewal", async () => {
    const test = await setup();
    const before = test.hub.issue({ workspaces: [WORKSPACE] });
    before.credential.record.issuedAt = Date.now() - DEVICE_CREDENTIAL_LIFETIME_MS;
    await writeHubLogin(test.hub.origin, before, test.env);
    expect(readDeviceLogin(test.hub.url, WORKSPACE, test.env)).toMatchObject({
      status: "sign-in-required", message: expect.stringContaining("ub auth login"),
    });
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe("sign-in-required");
    expect(test.hub.renewalCount).toBe(0);
    expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(before);
  });

  it("requires sign-in for an old HMAC login without treating its store as damaged or falling back on loopback", async () => {
    const test = await setup();
    const old = test.hub.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(test.hub.origin, old, test.env);
    old.credential.key = Buffer.alloc(32, 7).toString("base64url");
    writeFileSync(credentialsPath(test.env), JSON.stringify({ hubLogins: { [test.hub.origin]: old } }));
    expect(usesDeviceCredentials(test.hub.url, test.env)).toBe(true);
    expect(readDeviceLogin(test.hub.url, WORKSPACE, test.env)).toMatchObject({
      status: "sign-in-required", message: expect.stringContaining(`ub auth login ${test.hub.origin}`),
    });
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe("sign-in-required");
    expect(test.hub.renewalCount).toBe(0);
  });

  it("renews once after suspension and polls for restore without replacing the credential again", async () => {
    const test = await setup();
    test.hub.grant(WORKSPACE);
    test.hub.grant(OTHER_WORKSPACE);
    const before = test.hub.issue({ workspaces: [WORKSPACE, OTHER_WORKSPACE] });
    await writeHubLogin(test.hub.origin, before, test.env);
    test.hub.setWorkspaceStatus(WORKSPACE, "suspended");
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, {
      env: test.env, rejected: before, renewalCooldownMs: 0,
    })).status).toBe("no-access");
    const after = readHubLogins(test.env).logins[test.hub.origin]!;
    expect(after.credential.record.id).not.toBe(before.credential.record.id);
    expect(after.credential.record.workspaces).toEqual([OTHER_WORKSPACE]);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, renewalCooldownMs: 0 })).status).toBe("no-access");
      expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(after);
      expect((await ensureDeviceLogin(test.hub.url, OTHER_WORKSPACE, { env: test.env })).status).toBe("ready");
    }
    expect(test.hub.renewalCount).toBe(4);
    test.hub.setWorkspaceStatus(WORKSPACE, "active");
    const restored = await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, renewalCooldownMs: 0 });
    expect(restored.status).toBe("ready");
    if (restored.status !== "ready") throw new Error("restore did not rediscover workspace access");
    expect(restored.login.identity).toEqual(before.identity);
    expect(restored.login.credential.record.deviceId).toBe(before.credential.record.deviceId);
    expect(restored.login.credential.record.workspaces).toEqual([WORKSPACE, OTHER_WORKSPACE].sort());
  });

  it("replaces names with each stored credential, including an older hub's unnamed reply", async () => {
    const test = await setup();
    const before = test.hub.issue({ workspaces: [WORKSPACE] });
    before.credential.workspaceNames = { [WORKSPACE]: "Before rename" };
    await writeHubLogin(test.hub.origin, before, test.env);
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe("ready");
    expect(test.hub.renewalCount).toBe(0);

    const next = test.hub.issue({ workspaces: [WORKSPACE, OTHER_WORKSPACE], deviceId: before.credential.record.deviceId });
    next.credential.workspaceNames = { [WORKSPACE]: "After rename", [OTHER_WORKSPACE]: "New grant" };
    const { key: _key, ...publicCredential } = next.credential;
    test.hub.setRenewalReply({ status: 200, body: { status: "renewed", credential: publicCredential } });
    const renewed = await ensureDeviceLogin(test.hub.url, OTHER_WORKSPACE, { env: test.env, renewalCooldownMs: 0 });
    expect(renewed.status).toBe("ready");
    const stored = readHubLogins(test.env).logins[test.hub.origin]!;
    expect(stored.credential).toMatchObject(publicCredential);
    expect(stored.credential.key).not.toBe(before.credential.key);
    expect(stored.credential.key).not.toBe(next.credential.key);
    expect(test.hub.renewalCount).toBe(1);

    const unnamed = test.hub.issue({ workspaces: [WORKSPACE, OTHER_WORKSPACE], deviceId: before.credential.record.deviceId });
    const { key: _unnamedKey, ...unnamedPublicCredential } = unnamed.credential;
    test.hub.setRenewalReply({ status: 200, body: { status: "renewed", credential: unnamedPublicCredential } });
    const refreshed = await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, rejected: stored });
    expect(refreshed.status).toBe("ready");
    expect(readHubLogins(test.env).logins[test.hub.origin]!.credential).toMatchObject(unnamedPublicCredential);
    expect(readHubLogins(test.env).logins[test.hub.origin]!.credential.workspaceNames).toBeUndefined();
    expect(test.hub.renewalCount).toBe(2);
  });

  it.each(["login", "logout"])("does not overwrite concurrent %s during its network request", async (action) => {
    const test = await setup();
    test.hub.grant(WORKSPACE);
    await writeHubLogin(test.hub.origin, test.hub.issue({ workspaces: [] }), test.env);
    test.hub.setRenewalDelay(150);
    const renewal = ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env });
    await waitForRequest(test.hub);
    const next = test.hub.issue({ workspaces: [WORKSPACE] });
    if (action === "login") await writeHubLogin(test.hub.origin, next, test.env);
    else await removeHubLogin(test.hub.origin, test.env);
    const result = await renewal;
    expect(result.status).toBe(action === "login" ? "ready" : "sign-in-required");
    expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(action === "login" ? next : undefined);
  });

  it("keeps configuration writers available and cancels without late publication", async () => {
    const test = await setup();
    test.hub.grant(WORKSPACE);
    const before = test.hub.issue({ workspaces: [] });
    await writeHubLogin(test.hub.origin, before, test.env);
    test.hub.setRenewalDelay(150);
    const abort = new AbortController();
    const renewal = ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, signal: abort.signal });
    await waitForRequest(test.hub);
    const configWriter = await acquireInitLock(test.env, { waitMs: 0 });
    configWriter.release();
    abort.abort();
    await expect(renewal).rejects.toMatchObject({ name: "AbortError" });
    expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(before);
  });

  it.each([
    { status: 401, body: { status: "sign-in-required" }, reading: "sign-in-required" },
    { status: 409, body: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION + 1}` }, reading: "update-required" },
    { status: 503, body: { status: "not-configured" }, reading: "renewal-unavailable" },
    { status: 200, body: { status: "renewed", credential: { key: "private-invalid-key" } }, reading: "hub-down" },
  ])("classifies renewal reply $status/$reading without inventing access", async ({ reading, ...reply }) => {
    const test = await setup();
    const before = test.hub.issue({ workspaces: [] });
    before.credential.record.issuedAt = Date.now() - DEVICE_CREDENTIAL_RENEWAL_AGE_MS;
    await writeHubLogin(test.hub.origin, before, test.env);
    test.hub.setRenewalReply(reply);
    const result = await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env });
    expect(result.status).toBe(reading);
    expect(JSON.stringify(result)).not.toContain(before.credential.key);
    expect(JSON.stringify(result)).not.toContain("private-invalid-key");
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe(reading);
    expect(test.hub.renewalCount).toBe(1);
    expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(before);
  });

  it("uses origin identity and refuses exposed or malformed stores without network", async () => {
    const test = await setup();
    const before = test.hub.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(test.hub.origin, before, test.env);
    expect(readDeviceLogin(`${test.hub.origin}/path`, WORKSPACE, test.env).status).toBe("ready");
    expect((await ensureDeviceLogin("wss://another-hub.example/ws", WORKSPACE, { env: test.env })).status).toBe("sign-in-required");
    const path = credentialsPath(test.env);
    chmodSync(path, 0o644);
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe("credential-store-refused");
    chmodSync(path, 0o600);
    writeFileSync(path, "invalid-private-contents");
    const result = await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env });
    expect(result.status).toBe("credential-store-unreadable");
    expect(JSON.stringify(result)).not.toContain("invalid-private-contents");
    expect(test.hub.renewalCount).toBe(0);
  });

  it("never follows a renewal redirect to another authentication origin", async () => {
    const test = await setup();
    const other = await setup();
    await writeHubLogin(test.hub.origin, test.hub.issue({ workspaces: [] }), test.env);
    test.hub.setRenewalReply({ status: 307, location: `${other.hub.origin}/auth/credential/renew` });
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe("hub-down");
    expect(other.hub.renewalCount).toBe(0);
  });

  it("cancels a renewal lock wait without taking another holder's lock", async () => {
    const test = await setup();
    await writeHubLogin(test.hub.origin, test.hub.issue({ workspaces: [] }), test.env);
    test.hub.setRenewalDelay(150);
    const first = ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env });
    await waitForRequest(test.hub);
    const abort = new AbortController();
    const next = ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, signal: abort.signal });
    const reason = new Error("renewal cancelled");
    abort.abort(reason);
    await expect(next).rejects.toBe(reason);
    const locks = readdirSync(dirname(credentialsPath(test.env))).filter(name => name.endsWith(".lock"));
    expect(locks).toHaveLength(1);
    expect(existsSync(join(dirname(credentialsPath(test.env)), locks[0]!))).toBe(true);
    await first;
    expect(test.hub.renewalCount).toBe(1);
  });
});
