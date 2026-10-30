import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialProvider } from "../src/credential-provider.js";
import { createMcpHost } from "../src/http-host.js";
import type { McpHostTokenResult } from "../src/host-token-check.js";
import * as serverModule from "../src/server.js";
import { cleanupTestResources, tempDir, WORKSPACE } from "./helpers.js";

const hosts: ReturnType<typeof createMcpHost>[] = [];
const releases: (() => void)[] = [];
const grant: McpHostTokenResult = {
  status: "positive", grantId: "pending-grant", principal: "person", workspace: WORKSPACE,
  scope: "docs:read docs:write", expiresAt: Date.now() + 60_000,
};
const credentialProvider: CredentialProvider = {
  read: () => ({ status: "hub-down", origin: "http://127.0.0.1:1", message: "Test hub is unavailable" }),
  async ensure() { return this.read(); },
};

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await cleanupTestResources({ after: [...hosts.splice(0).map(host => () => host.close()), () => vi.restoreAllMocks()] });
});

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { entered, release, async wait() { enter(); await held; } };
}

async function listen(dependencies: Parameters<typeof createMcpHost>[1]) {
  const host = createMcpHost({ issuer: undefined, allowedOrigins: [], hubUrl: "ws://127.0.0.1:1", databaseDirectory: tempDir() }, dependencies);
  hosts.push(host);
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("Missing host port");
  return { host, url: `http://127.0.0.1:${address.port}/mcp/${WORKSPACE}` };
}

function initialize(url: string) {
  return fetch(url, {
    method: "POST", headers: { Authorization: "Bearer test", Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "shutdown-test", version: "1" } } }),
  });
}

it.each(["token", "credentials"])("does not open a runtime after shutdown starts during pending %s", async stage => {
  const held = gate();
  const opening = vi.spyOn(serverModule, "createMcpRuntime");
  const credentialsForGrant = vi.fn(async () => {
    if (stage === "credentials") await held.wait();
    return { credentialProvider, agentName: "Pending grant" };
  });
  const { host, url } = await listen({
    async checkToken() { if (stage === "token") await held.wait(); return grant; },
    credentialsForGrant,
  });
  const request = initialize(url);
  await held.entered;
  const closing = host.close();
  expect(host.close()).toBe(closing);
  held.release();
  const response = await request;
  expect(response.status).toBe(503);
  await response.text();
  await closing;
  expect(opening).not.toHaveBeenCalled();
  expect(credentialsForGrant).toHaveBeenCalledTimes(stage === "token" ? 0 : 1);
});

it("tracks a session during startup and drains its admitted connect before releasing the runtime", async () => {
  const held = gate();
  const createRuntime = serverModule.createMcpRuntime;
  let runtime!: serverModule.UberblickMcpRuntime;
  vi.spyOn(serverModule, "createMcpRuntime").mockImplementation((config, options) => {
    runtime = createRuntime({ ...config, localWorkspace: true }, options);
    const settle = runtime.replicas.settle.bind(runtime.replicas);
    vi.spyOn(runtime.replicas, "settle").mockImplementationOnce(async (...args) => {
      await held.wait();
      return settle(...args);
    });
    return runtime;
  });
  const { host, url } = await listen({
    checkToken: async () => grant,
    credentialsForGrant: async () => ({ credentialProvider, agentName: "Starting grant" }),
  });
  const request = initialize(url);
  await held.entered;
  const releaseStore = vi.spyOn(runtime.store, "close");
  const closing = host.close();
  expect(releaseStore).not.toHaveBeenCalled();
  held.release();
  const response = await request;
  expect(response.status).toBe(503);
  await response.text();
  await closing;
  expect(releaseStore).toHaveBeenCalledTimes(1);
});
