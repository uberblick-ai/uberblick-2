import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { roomForDoc } from "@uberblick/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredHubLogin } from "../src/auth-store.js";
import type { McpConfig } from "../src/config.js";
import type { CredentialProvider } from "../src/credential-provider.js";
import * as deviceLogin from "../src/device-login.js";
import type { DeviceLoginOptions, DeviceLoginResult } from "../src/device-login.js";
import { createMcpRuntime } from "../src/server.js";
import { cleanupTestResources, directoryStub, LIVE_HUB_SETTLE, tempDir, TEST_SECRET, testConfig, waitUntil, WORKSPACE } from "./helpers.js";

type DeviceHub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
type Runtime = ReturnType<typeof createMcpRuntime>;
const clients: Array<() => Promise<void>> = [];
const runtimes: Runtime[] = [];
const hubs: DeviceHub[] = [];

afterEach(async () => {
  try {
    await cleanupTestResources({
      clients: clients.splice(0),
      peers: runtimes.splice(0).map(runtime => () => runtime.close()),
      hubs: hubs.splice(0).map(hub => () => hub.close()),
    });
  } finally {
    vi.restoreAllMocks();
  }
});

/** The replacement and its outcome belong to this grant, held only in memory. */
class GrantCredentialProvider implements CredentialProvider {
  readonly refused: string[] = [];
  renewals = 0;

  constructor(private readonly hub: DeviceHub, public login: StoredHubLogin) {}

  read(): DeviceLoginResult {
    return { status: "ready", origin: this.hub.origin, login: this.login };
  }

  async ensure(options: Omit<DeviceLoginOptions, "env"> = {}): Promise<DeviceLoginResult> {
    options.signal?.throwIfAborted();
    if (options.rejected !== undefined) {
      this.refused.push(options.rejected.credential.record.id);
      if (deviceLogin.sameCredential(this.login, options.rejected)) {
        this.login = this.hub.issue({
          workspaces: [WORKSPACE],
          principalId: this.login.identity.id,
          deviceId: this.login.credential.record.deviceId,
        });
        this.renewals += 1;
      }
    }
    return this.read();
  }
}

async function fixture(): Promise<DeviceHub> {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  return hub;
}

function provider(hub: DeviceHub): GrantCredentialProvider {
  const principalId = randomUUID();
  hub.grant(WORKSPACE, principalId);
  return new GrantCredentialProvider(hub, hub.issue({ workspaces: [WORKSPACE], principalId }));
}

function runtime(hub: DeviceHub, credentialProvider: CredentialProvider, agentName: string, env: NodeJS.ProcessEnv): Runtime {
  const config: McpConfig = {
    ...testConfig({ ...LIVE_HUB_SETTLE, hubUrl: hub.url, authSecret: TEST_SECRET }),
    authEnv: env,
  };
  const instance = createMcpRuntime(config, { credentialProvider, agentName });
  runtimes.push(instance);
  return instance;
}

async function session(runtime: Runtime, clientName: string) {
  const instance = runtime.openSession();
  const client = new Client({ name: clientName, title: `${clientName} title`, version: "1" });
  clients.push(async () => {
    await client.close();
    await instance.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      const payload = JSON.parse(content[0]?.text ?? "null");
      if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(payload)}`);
      return payload;
    },
  };
}

function remoteCursor(runtime: Runtime, uuid: string, agentName: string): boolean {
  const replica = runtime.replicas.replica(uuid);
  return [...replica.awareness.getStates()].some(([clientId, state]) =>
    clientId !== replica.doc.clientID && state.user?.name === agentName && state.cursor != null);
}

describe("runtime credential and identity isolation", () => {
  it("authenticates, attributes writes and publishes cursors using only each runtime's provider and fixed name", async () => {
    const hub = await fixture();
    const firstProvider = provider(hub);
    const secondProvider = provider(hub);
    const env = { XDG_CONFIG_HOME: tempDir() };
    const readLocal = vi.spyOn(deviceLogin, "readDeviceLogin");
    const ensureLocal = vi.spyOn(deviceLogin, "ensureDeviceLogin");
    const first = runtime(hub, firstProvider, "Grant one", env);
    const second = runtime(hub, secondProvider, "Grant two", env);
    const firstSession = await session(first, "client-one");
    await session(first, "last-client-must-not-rename-the-grant");
    const secondSession = await session(second, "client-two");

    const doc = await firstSession.ok("create_doc", {
      title: "Grant identities",
      description: "Runtime providers keep grants separate.",
      blocks: [{ type: "paragraph", text: "initial" }],
    });
    await firstSession.ok("edit_block", {
      uuid: doc.uuid, block_id: doc.blocks[0].id,
      old_text: "initial", new_text: "first",
    });
    expect(await first.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    await waitUntil("the second grant to receive the document", () => directoryStub(second, doc.uuid) !== null);
    const room = roomForDoc(WORKSPACE, doc.uuid);
    expect(await second.replicas.waitForSettled({ rooms: [room] })).toMatchObject({ caughtUp: true });
    const read = await secondSession.ok("get_doc", { uuid: doc.uuid });
    expect(read.title).toBe("Grant identities");
    await waitUntil("the second grant to see the first grant's cursor", () => remoteCursor(second, doc.uuid, "Grant one"));
    await secondSession.ok("edit_block", {
      uuid: doc.uuid,
      block_id: read.blocks[0].id,
      old_text: "first",
      new_text: "first and second",
      rev: read.blocks[0].rev,
    });
    expect(await second.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    await waitUntil("the first grant to see the second grant's cursor", () => remoteCursor(first, doc.uuid, "Grant two"));

    for (const [instance, grant, name] of [[first, firstProvider, "Grant one"], [second, secondProvider, "Grant two"]] as const) {
      const offered = hub.authentications.filter(authentication => authentication.claims?.sub === instance.replicas.config.sessionId);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.every(authentication => authentication.claims?.kid === grant.login.credential.record.id)).toBe(true);
      expect(hub.changes.filter(change => change.room === room)).toContainEqual(expect.objectContaining({
        attribution: expect.objectContaining({
          author: { principalId: grant.login.identity.id, surface: { kind: "mcp", name } },
          deliveredBy: {
            principalId: grant.login.identity.id,
            credentialId: grant.login.credential.record.id,
            deviceId: grant.login.credential.record.deviceId,
          },
        }),
      }));
    }
    await first.close();
    await second.close();
    expect(readLocal).not.toHaveBeenCalled();
    expect(ensureLocal).not.toHaveBeenCalled();
    expect(readdirSync(env.XDG_CONFIG_HOME)).toEqual([]);
  });

  it("renews only the refused provider while another runtime keeps its credential and connection", async () => {
    const hub = await fixture();
    const healthyProvider = provider(hub);
    const refusedProvider = provider(hub);
    const env = { XDG_CONFIG_HOME: tempDir() };
    const readLocal = vi.spyOn(deviceLogin, "readDeviceLogin");
    const ensureLocal = vi.spyOn(deviceLogin, "ensureDeviceLogin");
    const healthy = runtime(hub, healthyProvider, "Healthy grant", env);
    const healthySession = await session(healthy, "healthy-client");
    const healthyDoc = await healthySession.ok("create_doc", {
      title: "Unaffected grant", description: "A different grant may recover independently.",
      blocks: [{ type: "paragraph", text: "before" }],
    });
    expect(await healthy.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const healthyCredential = healthyProvider.login;
    const healthyMints = healthy.replicas.sync.mintCount;
    const refusedCredential = refusedProvider.login.credential.record.id;
    hub.revoke(refusedCredential);

    const recovering = runtime(hub, refusedProvider, "Recovering grant", env);
    const recoveringSession = await session(recovering, "recovering-client");
    await waitUntil("only the refused grant's provider to renew", () => refusedProvider.renewals === 1);
    expect(await recovering.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect(refusedProvider.refused).toContain(refusedCredential);
    expect(healthyProvider.refused).toEqual([]);
    expect(healthyProvider.renewals).toBe(0);
    expect(healthyProvider.login).toBe(healthyCredential);
    expect(healthy.replicas.sync.mintCount).toBe(healthyMints);
    expect(healthy.replicas.sync.state().status).toBe("connected");

    await healthySession.ok("edit_block", {
      uuid: healthyDoc.uuid, block_id: healthyDoc.blocks[0].id,
      old_text: "before", new_text: "after another grant recovered",
    });
    expect(await healthy.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const recoveredDoc = await recoveringSession.ok("create_doc", {
      title: "Recovered grant", description: "The provider supplies its replacement credential.",
    });
    expect(await recovering.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect(hub.changes.filter(change => change.room === roomForDoc(WORKSPACE, recoveredDoc.uuid))).toContainEqual(expect.objectContaining({
      attribution: expect.objectContaining({
        author: { principalId: refusedProvider.login.identity.id, surface: { kind: "mcp", name: "Recovering grant" } },
        deliveredBy: expect.objectContaining({ credentialId: refusedProvider.login.credential.record.id }),
      }),
    }));
    expect(healthyProvider.login).toBe(healthyCredential);
    expect(healthyProvider.refused).toEqual([]);
    expect(hub.renewalCount).toBe(0);
    await healthy.close();
    await recovering.close();
    expect(readLocal).not.toHaveBeenCalled();
    expect(ensureLocal).not.toHaveBeenCalled();
    expect(readdirSync(env.XDG_CONFIG_HOME)).toEqual([]);
  });
});
