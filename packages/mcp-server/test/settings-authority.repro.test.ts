/**
 * Audit reproduction (not for merge): a member's offline `_settings` updates
 * wait in the replica's pending log and reach the hub through the stored-login
 * sync engine on reconnect. The hub fixture uses production credential
 * admission; nothing on the client or hub checks the workspace-admin role.
 */
import { afterEach, expect, it } from "vitest";
import { writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { getWorkspaceMainRepository, getWorkspaceName, setWorkspaceName, settingsRoom } from "@uberblick/schema";
import { syncWorkspace } from "../src/remote.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import { fillWorkspaceMainRepository } from "../src/workspace-settings.js";
import { cleanupTestResources, tempDir, testConfig, WORKSPACE } from "./helpers.js";

type DeviceHub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const hubs: DeviceHub[] = [];
afterEach(async () => {
  await cleanupTestResources({ hubs: hubs.splice(0).map((fixture) => () => fixture.close()) });
});

it("pushes a member's offline settings writes from the pending log on reconnect", async () => {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  // The fixture's principal is a plain member; the fixture's admin is someone else.
  hub.grant(WORKSPACE);
  const env = { XDG_CONFIG_HOME: tempDir() };
  await writeHubLogin(hub.origin, hub.issue({ workspaces: [WORKSPACE] }), env);
  const config = { ...testConfig({ hubUrl: hub.url, connectTimeoutMs: 1_500, syncTimeoutMs: 3_000 }),
    reconnectMaxDelayMs: 2_000, deviceLogin: { env } };

  await syncWorkspace(config);
  await hub.pause();

  // Offline: the supported CLI fill (`ub workspace use` in a checkout) and a
  // local-server write of the kind the web General form makes, both into the log.
  fillWorkspaceMainRepository(WORKSPACE, "member/checkout", config.databasePath);
  const offline = openWorkspaceReplicas(config, { hubFree: true });
  try {
    setWorkspaceName(offline.replicas.settings().doc, "Renamed offline by a member");
    offline.replicas.assertHealthy();
  } finally { offline.close(); }

  await hub.resume();
  await syncWorkspace(config);

  expect(hub.readRoom(settingsRoom(WORKSPACE), getWorkspaceName)).toBe("Renamed offline by a member");
  expect(hub.readRoom(settingsRoom(WORKSPACE), getWorkspaceMainRepository)).toBe("member/checkout");
  expect(hub.logs.filter((record) => record.event === "hub.auth.rejected")).toEqual([]);
});
