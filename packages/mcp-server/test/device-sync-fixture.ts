/** Shared stored-login rig for the device-sync suites. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import type { McpConfig } from "../src/config.js";
import type { Rig } from "./helpers.js";
import { cleanupTestResources, LIVE_HUB_SETTLE, startServer, tempDir, testConfig } from "./helpers.js";
import type { TestCleanup } from "./helpers.js";

export type DeviceHub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const hubs: DeviceHub[] = [];
const rigs: Rig[] = [];
export const listeners: TestCleanup[] = [];

/** Pass to `afterEach`: closes every client, then every hub. */
export async function closeDeviceSync(): Promise<void> {
  await cleanupTestResources({
    clients: rigs.splice(0).map((rig) => () => rig.close()),
    hubs: [...hubs.splice(0).map((hub) => () => hub.close()), ...listeners.splice(0)],
  });
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
  return { ...testConfig({ ...LIVE_HUB_SETTLE, hubUrl: fixture.url }), deviceLogin: { env } };
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
export function expireRenewalCooldown(env: NodeJS.ProcessEnv): void {
  const directory = join(env.XDG_CONFIG_HOME!, "uberblick");
  for (const name of readdirSync(directory).filter(name => name.startsWith(".credential-renewal-") && name.endsWith(".json"))) {
    const path = join(directory, name);
    const outcome = JSON.parse(readFileSync(path, "utf8"));
    outcome.retryAt = 0;
    writeFileSync(path, JSON.stringify(outcome), { mode: 0o600 });
  }
}
