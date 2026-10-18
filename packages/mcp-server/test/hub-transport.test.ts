import { createServer } from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { credentialsPath, writeHubLogin } from "../src/auth-store.js";
import { ensureDeviceLogin } from "../src/device-login.js";
import { manageRequest } from "../src/management-client.js";
import { cleanupTestResources, startServer, tempDir, testConfig, trackListener, WORKSPACE } from "./helpers.js";
import { client, closeDeviceSync, config, environment, hub } from "./device-sync-fixture.js";

const clients: (() => Promise<void>)[] = [];
const listeners: (() => Promise<void>)[] = [];
afterEach(async () => {
  await cleanupTestResources({ clients: [...clients.splice(0), closeDeviceSync], hubs: listeners.splice(0) });
});

it("keeps MCP local edits durable while refusing sync, renewal and management before any connection", async () => {
  const server = createServer();
  const tracked = trackListener(server);
  listeners.push(() => tracked.close());
  let connections = 0;
  server.on("connection", () => { connections += 1; });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const endpoint = `ws://0.0.0.0:${port}/ws`;
  const origin = `http://0.0.0.0:${port}`;
  const env = { XDG_CONFIG_HOME: tempDir() };
  const principalId = randomUUID();
  const login = {
    identity: { id: principalId, githubAccountId: "1234", githubUsername: "octocat" },
    credential: { key: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"), record: {
      id: randomUUID(), principalId, deviceId: randomUUID(), workspaces: [], issuedAt: Date.now(), revokedAt: null,
    } },
  };
  await writeHubLogin(origin, login, env);
  const credentialPath = credentialsPath(env);
  const credentialBefore = readFileSync(credentialPath, "utf8");
  const filesBefore = readdirSync(dirname(credentialPath));
  const cfg = { ...testConfig({ hubUrl: endpoint }), deviceLogin: { env }, authEnv: env };
  const rig = await startServer(cfg);
  clients.push(() => rig.close());
  const written = await rig.ok("create_doc", { title: "Stays on this computer", description: "Blocked transport keeps local work." });
  expect(written).toMatchObject({ applied: true, synced: false });
  const reading = await rig.ok("sync_status");
  expect(reading.hub).toMatchObject({ status: "hub-down", recoveryClass: "manual", url: endpoint,
    reason: expect.stringContaining(`wss://0.0.0.0:${port}/ws`) });
  expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + 5_000 }))
    .toMatchObject({ caughtUp: false, reason: "unavailable" });
  expect(await ensureDeviceLogin(endpoint, WORKSPACE, { env }))
    .toMatchObject({ status: "hub-down", fix: `use wss://0.0.0.0:${port}/ws` });
  for (const stored of [login, null]) {
    await expect(manageRequest(origin, { operation: "list-devices" }, stored, { env }))
      .rejects.toThrow(`https://0.0.0.0:${port}`);
  }
  expect(readFileSync(credentialPath, "utf8")).toBe(credentialBefore);
  expect(readdirSync(dirname(credentialPath))).toEqual(filesBefore);
  await rig.close();
  clients.pop();
  const reopened = await startServer(cfg);
  clients.push(() => reopened.close());
  expect((await reopened.ok("get_doc", { uuid: written.uuid })).title).toBe("Stays on this computer");
  await setImmediate();
  expect(connections).toBe(0);
});

it("syncs and renews only the explicitly allowed non-loopback fixture", async () => {
  const fixture = await hub();
  fixture.grant(WORKSPACE);
  const endpoint = fixture.url.replace("127.0.0.1", "0.0.0.0");
  const origin = fixture.origin.replace("127.0.0.1", "0.0.0.0");
  const env = { ...environment(), UB_INSECURE_HUBS: new URL(endpoint).host };
  await writeHubLogin(origin, fixture.issue({ workspaces: [] }), env);
  const rig = await client({ ...config(fixture, env), hubUrl: endpoint });
  expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + 70_000 })).toMatchObject({ caughtUp: true });
  expect(fixture.renewalCount).toBe(1);
  expect((await rig.ok("sync_status")).hub.status).toBe("connected");
});
