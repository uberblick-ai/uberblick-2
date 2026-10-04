/** Bounded CLI probes use the same credential recovery as serving engines. */
import { afterEach, describe, expect, it } from "vitest";
import { readHubLogins, writeHubLogin } from "@uberblick/hub/auth-store";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import type { McpConfig } from "../src/config.js";
import { inspectRemote, syncWorkspace } from "../src/remote.js";
import { deviceRetryDelayMs } from "../src/sync.js";
import { removeTempDirs, sleep, tempDir, testConfig, WORKSPACE } from "./helpers.js";

type DeviceHub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const hubs: DeviceHub[] = [];
afterEach(async () => {
  for (const fixture of hubs.splice(0)) await fixture.close();
  removeTempDirs();
});

async function fixture(): Promise<{ hub: DeviceHub; env: NodeJS.ProcessEnv; config: McpConfig }> {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  const env = { XDG_CONFIG_HOME: tempDir() };
  return { hub, env, config: {
    ...testConfig({ hubUrl: hub.url, connectTimeoutMs: 1_500, syncTimeoutMs: 3_000 }),
    reconnectMaxDelayMs: 2_000,
    deviceLogin: { env },
  } };
}

const probes = [
  { name: "inspectRemote", run: inspectRemote },
  { name: "syncWorkspace", run: syncWorkspace },
];

it("spreads device retries through a growing band and caps long manual waits", () => {
  for (const [attempt, floor, ceiling] of [[0, 1_000, 2_000], [1, 2_000, 4_000], [5, 15_000, 30_000], [20, 15_000, 30_000]] as const) {
    expect(deviceRetryDelayMs(attempt, 2_000, false, () => 0)).toBe(floor);
    expect(deviceRetryDelayMs(attempt, 2_000, false, () => 1)).toBe(ceiling);
  }
  expect(deviceRetryDelayMs(0, 2_000, true, () => 0)).toBe(125);
  expect(deviceRetryDelayMs(0, 2_000, true, () => 1)).toBe(250);
  expect(deviceRetryDelayMs(1, 2_000, true, () => 0)).toBe(2_000);
  expect(deviceRetryDelayMs(1, 2_000, true, () => 1)).toBe(4_000);
});

describe.each(probes)("stored-login $name probe recovery", ({ run }) => {
  it("checks a revoked connection before returning sign-in required", async () => {
    const { hub, env, config } = await fixture();
    hub.grant(WORKSPACE);
    const login = hub.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(hub.origin, login, env);
    hub.revoke(login.credential.record.id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await run(config);
      expect(result.hub).toMatchObject({
        status: "auth-failed", recoveryClass: "manual", authRecovery: "sign-in-required",
      });
    }
    expect(hub.renewalCount).toBe(1);
    expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
  });

  it("checks removed membership before returning no workspace access", async () => {
    const { hub, env, config } = await fixture();
    hub.grant(WORKSPACE);
    const login = hub.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(hub.origin, login, env);
    hub.removeMembership(WORKSPACE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await run(config);
      expect(result.hub).toMatchObject({
        status: "auth-failed", recoveryClass: "manual", authRecovery: "no-workspace-access",
      });
    }
    expect(hub.renewalCount).toBe(1);
    expect(readHubLogins(env).logins[hub.origin]!.credential.record.workspaces).toEqual([]);
  });

  it("keeps a renewal outage retryable after a refused connection", async () => {
    const { hub, env, config } = await fixture();
    const login = hub.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(hub.origin, login, env);
    hub.setRenewalReply({ status: 503, raw: "temporarily unavailable" });
    const result = await run(config);
    expect(result.hub).toMatchObject({ status: "hub-down", recoveryClass: "retry" });
    expect(result.hub).not.toHaveProperty("authRecovery");
    expect(hub.renewalCount).toBe(1);
    expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
  });
});

it("keeps a slow refusal check inside inspectRemote's existing settle budget", async () => {
  const { hub, env, config } = await fixture();
  const login = hub.issue({ workspaces: [WORKSPACE] });
  await writeHubLogin(hub.origin, login, env);
  const responseDelayMs = 5_000;
  hub.setRenewalReply({ status: 503, raw: "temporarily unavailable" });
  hub.setRenewalDelay(responseDelayMs);
  const started = Date.now();
  try {
    const result = await inspectRemote(config);
    expect(Date.now() - started).toBeLessThan(config.connectTimeoutMs + config.syncTimeoutMs);
    expect(result.hub).toMatchObject({ status: "hub-down", recoveryClass: "retry" });
    expect(result.hub).not.toHaveProperty("authRecovery");
    expect(hub.renewalCount).toBe(1);
    expect(readHubLogins(env).logins[hub.origin]).toEqual(login);
  } finally {
    // The fixture owns a delayed response even after the probe aborts it.
    await sleep(responseDelayMs);
  }
});
