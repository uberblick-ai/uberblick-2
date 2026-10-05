/** One denied workspace must not keep retiring another workspace's login. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readHubLogins, writeHubLogin } from "@uberblick/hub/auth-store";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { getMeta, roomForDoc } from "@uberblick/schema";
import type { Rig } from "./helpers.js";
import { sleep, startServer, testConfig, waitUntil } from "./helpers.js";

const COOLDOWN_MS = 1_000;

async function caughtUp(rig: Rig, timeoutMs = 20_000): Promise<void> {
  await waitUntil("all local writes to be acknowledged", async () => {
    const status = await rig.ok("sync_status");
    return status.hub.status === "connected" && status.pendingRooms.length === 0 &&
      status.rooms.every((room: { synced: boolean }) => room.synced);
  }, timeoutMs);
}

it("keeps a shared credential stable while polling denied access and resumes after a later grant", async () => {
  const directory = mkdtempSync(join(tmpdir(), `device-no-access-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  const fixture = await startDeviceSyncHub({ directory });
  const clients: Rig[] = [];
  const firstWorkspace = randomUUID();
  const secondWorkspace = randomUUID();
  const env = { XDG_CONFIG_HOME: directory };
  const config = (workspaceId: string, databaseName: string) => ({
    ...testConfig({ workspaceId, hubUrl: fixture.url, databasePath: join(directory, databaseName) }),
    deviceLogin: { env },
    reconnectMaxDelayMs: 2_000,
    // The production cooldown and polling ceiling are thirty seconds each; a
    // shorter pair crosses the same two cooldown boundaries in real time.
    deviceRenewalCooldownMs: COOLDOWN_MS,
    deviceRetryMaxDelayMs: 2_000,
  });

  try {
    fixture.grant(firstWorkspace);
    await writeHubLogin(fixture.origin, fixture.issue({ workspaces: [firstWorkspace] }), env);
    const first = await startServer(config(firstWorkspace, "first.sqlite"));
    clients.push(first);
    await caughtUp(first);
    const second = await startServer(config(secondWorkspace, "second.sqlite"));
    clients.push(second);
    await waitUntil("renewal to confirm the second workspace needs access", () =>
      second.instance.replicas.sync.state().authRecovery === "no-workspace-access");
    await caughtUp(first);

    const shared = readHubLogins(env).logins[fixture.origin]!;
    expect(fixture.renewalCount).toBe(1);
    expect(shared.credential.record.workspaces).toEqual([firstWorkspace]);
    const admissionStart = fixture.authentications.length;
    const local = await second.ok("create_doc", {
      title: "Waiting for workspace access", description: "Durable until this hub acknowledges it.",
    });
    expect(local).toMatchObject({ applied: true, synced: false });
    expect((await second.ok("sync_status")).pendingRooms.length).toBeGreaterThan(0);

    // Cross two cooldowns with real clocks, crypto, stores and hubs.
    // Conditional checks discover later grants without retiring the first
    // engine's working credential while its authority is unchanged.
    await sleep(COOLDOWN_MS * 2 + 2_500);
    expect(fixture.renewalCount).toBeGreaterThan(1);
    expect(readHubLogins(env).logins[fixture.origin]).toEqual(shared);
    for (const { claims } of fixture.authentications.slice(admissionStart)) {
      if (claims?.workspace === firstWorkspace) expect(claims.kid).toBe(shared.credential.record.id);
    }
    await caughtUp(first);
    expect((await second.ok("sync_status")).hub).toMatchObject({
      status: "auth-failed", authRecovery: "no-workspace-access", recoveryClass: "manual",
    });
    expect((await second.ok("get_doc", { uuid: local.uuid })).title).toBe("Waiting for workspace access");
    expect((await second.ok("sync_status")).pendingRooms.length).toBeGreaterThan(0);
    expect(fixture.readRoom(roomForDoc(secondWorkspace, local.uuid))).toBeUndefined();

    await second.instance.replicas.sync.waitForDeviceWork();
    const checksBeforeGrant = fixture.renewalCount;
    fixture.grant(secondWorkspace);
    await caughtUp(second);
    await caughtUp(first);
    const replacement = readHubLogins(env).logins[fixture.origin]!;
    expect(replacement.identity).toEqual(shared.identity);
    expect(replacement.credential.record.id).not.toBe(shared.credential.record.id);
    expect(replacement.credential.record.workspaces).toEqual([firstWorkspace, secondWorkspace].sort());
    expect(getMeta(fixture.readRoom(roomForDoc(secondWorkspace, local.uuid))!).title).toBe("Waiting for workspace access");
    expect(fixture.renewalCount).toBeGreaterThan(checksBeforeGrant);
    expect(fixture.authentications.some(({ claims }) =>
      claims?.workspace === secondWorkspace && claims.kid === replacement.credential.record.id)).toBe(true);
  } finally {
    for (const client of clients.reverse()) await client.close();
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
