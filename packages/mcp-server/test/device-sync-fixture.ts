/** Shared stored-login rig for the device-sync suites. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import type { McpConfig } from "../src/config.js";
import type { Rig } from "./helpers.js";
import { removeTempDirs, startServer, tempDir, testConfig, waitUntil } from "./helpers.js";

export type DeviceHub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const hubs: DeviceHub[] = [];
const rigs: Rig[] = [];

/** Pass to `afterEach`: closes every client, then every hub. */
export async function closeDeviceSync(): Promise<void> {
  for (const rig of rigs.splice(0)) await rig.close();
  for (const hub of hubs.splice(0)) await hub.close();
  removeTempDirs();
}

export async function hub(protocolVersion?: number): Promise<DeviceHub> {
  const fixture = await startDeviceSyncHub({ directory: tempDir(), ...(protocolVersion === undefined ? {} : { protocolVersion }) });
  hubs.push(fixture);
  return fixture;
}
export function environment(): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: tempDir() };
}
export function config(fixture: DeviceHub, env: NodeJS.ProcessEnv): McpConfig {
  return { ...testConfig({ hubUrl: fixture.url }), deviceLogin: { env } };
}
export async function client(config: McpConfig): Promise<Rig> {
  const rig = await startServer(config);
  rigs.push(rig);
  return rig;
}
/** Close a client before the test ends, so teardown does not close it twice. */
export async function closeClient(rig: Rig): Promise<void> {
  await rig.close();
  rigs.splice(rigs.indexOf(rig), 1);
}
export async function caughtUp(rig: Rig): Promise<void> {
  await waitUntil("every room to be acknowledged", async () => {
    const status = await rig.ok("sync_status");
    return status.hub.status === "connected" && status.pendingRooms.length === 0 &&
      status.rooms.every((room: { synced: boolean }) => room.synced);
  }, 70_000);
}

export function expireRenewalCooldown(env: NodeJS.ProcessEnv): void {
  const directory = join(env.XDG_CONFIG_HOME!, "uberblick");
  for (const name of readdirSync(directory).filter(name => name.startsWith(".credential-renewal-") && name.endsWith(".json"))) {
    const path = join(directory, name);
    const outcome = JSON.parse(readFileSync(path, "utf8"));
    outcome.retryAt = 0;
    writeFileSync(path, JSON.stringify(outcome), { mode: 0o600 });
  }
}
