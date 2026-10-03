/** Failure boundaries of the inactive client path, against a credential hub. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialsPath, readHubLogins, writeHubLogin } from "../src/auth-store.js";
import { DEVICE_RENEWAL_COOLDOWN_MS, ensureDeviceLogin } from "../src/device-login.js";
import { acquireInitLock } from "../src/init-lock.js";
import { startDeviceSyncHub } from "./device-sync-hub.js";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const directories: string[] = [];
const hubs: Awaited<ReturnType<typeof startDeviceSyncHub>>[] = [];

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), `device-login-contract-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  directories.push(directory);
  const env = { ...process.env, XDG_CONFIG_HOME: directory };
  const hub = await startDeviceSyncHub({ directory });
  hubs.push(hub);
  const login = hub.issue({ workspaces: [] });
  await writeHubLogin(hub.origin, login, env);
  return { hub, env, login };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function expireCooldown(): void {
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => now() + DEVICE_RENEWAL_COOLDOWN_MS + 1);
}

describe("device renewal response and recovery contracts", () => {
  it.each(["principal", "device", "credential id", "key", "revocation"])(
    "refuses a renewed response with mismatched %s without losing the recorded login",
    async (changed) => {
      const { hub, env, login } = await setup();
      const replacement = hub.issue({ workspaces: [WORKSPACE], deviceId: login.credential.record.deviceId });
      if (changed === "principal") replacement.credential.record.principalId = randomUUID();
      if (changed === "device") replacement.credential.record.deviceId = randomUUID();
      if (changed === "credential id") replacement.credential.record.id = login.credential.record.id;
      if (changed === "key") replacement.credential.key = "unreadable-private-key";
      if (changed === "revocation") replacement.credential.record.revokedAt = Date.now();
      hub.setRenewalReply({ status: 200, body: { status: "renewed", credential: replacement.credential } });
      const result = await ensureDeviceLogin(hub.url, WORKSPACE, { env });
      expect(result.status).toBe("hub-down");
      expect(JSON.stringify(result)).not.toContain(login.credential.key);
      expect(JSON.stringify(result)).not.toContain(replacement.credential.key);
      expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
      expect(hub.renewalCount).toBe(1);
    },
  );

  it("bounds an oversized renewal body and keeps it retryable without exposing its contents", async () => {
    const { hub, env, login } = await setup();
    const privateBody = `${login.credential.key}${"x".repeat(65_537)}`;
    hub.setRenewalReply({ status: 200, raw: privateBody });
    const result = await ensureDeviceLogin(hub.url, WORKSPACE, { env });
    expect(result.status).toBe("hub-down");
    expect(JSON.stringify(result)).not.toContain(login.credential.key);
    expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("hub-down");
    expect(hub.renewalCount).toBe(1);
  });

  it("keeps confirmed missing access manual until the stored credential changes", async () => {
    const { hub, env } = await setup();
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("no-access");
    const withoutAccess = readHubLogins(env).logins[hub.origin]!;
    hub.grant(WORKSPACE);
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("no-access");
    expect(hub.renewalCount).toBe(1);
    expireCooldown();
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("no-access");
    expect(hub.renewalCount).toBe(1);
    expect(readHubLogins(env).logins[hub.origin]).toEqual(withoutAccess);
    const replacement = hub.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(hub.origin, replacement, env);
    const recovered = await ensureDeviceLogin(hub.url, WORKSPACE, { env });
    expect(recovered.status).toBe("ready");
    if (recovered.status !== "ready") throw new Error("membership recovery failed");
    expect(recovered.login.credential.record.id).not.toBe(withoutAccess.credential.record.id);
    expect(recovered.login.credential.record.workspaces).toContain(WORKSPACE);
    expect(hub.renewalCount).toBe(1);
  });

  it("stores an issued replacement despite cancellation while configuration publication waits", async () => {
    const { hub, env, login } = await setup();
    hub.grant(WORKSPACE);
    const configLock = await acquireInitLock(env);
    const abort = new AbortController();
    const fetchResponse = globalThis.fetch;
    let delivered!: () => void;
    const responseDelivered = new Promise<void>(resolve => { delivered = resolve; });
    // Real exchange and complete response, with cancellation at the boundary
    // between receiving the replacement and publishing it locally.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await fetchResponse(...args);
      const body = await response.text();
      abort.abort();
      delivered();
      return new Response(body, { status: response.status, headers: response.headers });
    });
    const renewal = ensureDeviceLogin(hub.url, WORKSPACE, { env, signal: abort.signal });
    const cancelled = expect(renewal).rejects.toMatchObject({ name: "AbortError" });
    try {
      await responseDelivered;
      expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
    } finally {
      configLock.release();
    }
    await cancelled;
    const stored = readHubLogins(env).logins[hub.origin]!;
    expect(stored.credential.record.id).not.toBe(login.credential.record.id);
    expect(stored.credential.record.workspaces).toEqual([WORKSPACE]);
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("ready");
    expect(hub.renewalCount).toBe(1);
  });

  it("retries a transient offline renewal after cooldown and preserves the login until issuance", async () => {
    const { hub, env, login } = await setup();
    hub.grant(WORKSPACE);
    await hub.pause();
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("hub-down");
    expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
    await hub.resume();
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("hub-down");
    expect(hub.renewalCount).toBe(0);
    expireCooldown();
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("ready");
    expect(hub.renewalCount).toBe(1);
  });

  it("shares one issued replacement between simultaneous needs for different workspaces", async () => {
    const { hub, env } = await setup();
    hub.grant(WORKSPACE);
    hub.grant(OTHER_WORKSPACE);
    hub.setRenewalDelay(75);
    const results = await Promise.all([WORKSPACE, OTHER_WORKSPACE].map((workspace) => ensureDeviceLogin(hub.url, workspace, { env })));
    expect(results.map((result) => result.status)).toEqual(["ready", "ready"]);
    const ids = results.map((result) => result.status === "ready" ? result.login.credential.record.id : null);
    expect(ids[0]).toBe(ids[1]);
    expect(hub.renewalCount).toBe(1);
  });

  it("reports a revoked credential as sign-in required from the real renewal route", async () => {
    const { hub, env, login } = await setup();
    hub.grant(WORKSPACE);
    hub.revoke(login.credential.record.id);
    const result = await ensureDeviceLogin(hub.url, WORKSPACE, { env });
    expect(result.status).toBe("sign-in-required");
    expect(result).toHaveProperty("message", expect.stringContaining(`ub auth login ${hub.origin}`));
    expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
  });

  it("renews only the selected credential while preserving unknown login and identity fields", async () => {
    const { hub, env, login } = await setup();
    hub.grant(WORKSPACE);
    const path = credentialsPath(env);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.hubLogins[hub.origin].future = { opaque: "preserved" };
    stored.hubLogins[hub.origin].identity.future = "identity-extension";
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    expect((await ensureDeviceLogin(hub.url, WORKSPACE, { env })).status).toBe("ready");
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hubLogins[hub.origin].future).toEqual(stored.hubLogins[hub.origin].future);
    expect(after.hubLogins[hub.origin].identity).toEqual(stored.hubLogins[hub.origin].identity);
    expect(after.hubLogins[hub.origin].credential.record.id).not.toBe(login.credential.record.id);
  });
});
