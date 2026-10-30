import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { getMeta } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialProvider } from "../src/credential-provider.js";
import { createMcpHost } from "../src/http-host.js";
import type { McpHostGrant } from "../src/host-token-check.js";
import * as server from "../src/server.js";
import { cleanupTestResources, tempDir, waitUntil, WORKSPACE } from "./helpers.js";

type Host = ReturnType<typeof createMcpHost>;
type Hub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const hosts: Host[] = [];
const hubs: Hub[] = [];
const clients: Client[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  try {
    await cleanupTestResources({
      clients: clients.splice(0).map(client => () => client.close()),
      peers: hosts.splice(0).map(host => () => host.close()),
      hubs: hubs.splice(0).map(hub => () => hub.close()),
      after: [async () => { await Promise.allSettled(pending.splice(0)); }],
    });
  } finally {
    vi.restoreAllMocks();
  }
});

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { entered, release, async wait() { enter(); await held; } };
}

async function fixture() {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  function grant() {
    const principal = randomUUID();
    hub.grant(WORKSPACE, principal);
    const login = hub.issue({ workspaces: [WORKSPACE], principalId: principal });
    const credentialProvider: CredentialProvider = {
      read: () => ({ status: "ready", origin: hub.origin, login }),
      ensure: async () => ({ status: "ready", origin: hub.origin, login }),
    };
    return {
      answer: { grantId: randomUUID(), principal, workspace: WORKSPACE, scope: "docs:read docs:write", expiresAt: Date.now() + 3_600_000 },
      credentials: { credentialProvider, agentName: `Grant ${principal}` },
      login,
    };
  }
  const first = grant();
  const second = grant();
  const checkToken = vi.fn(async (token: string) => {
    if (token === "first" || token === "first-renewed") return { status: "positive" as const, ...first.answer };
    if (token === "second") return { status: "positive" as const, ...second.answer };
    return { status: "negative" as const };
  });
  const credentialsForGrant = vi.fn(async (answer: McpHostGrant) => {
    if (answer.grantId === first.answer.grantId) return first.credentials;
    if (answer.grantId === second.answer.grantId) return second.credentials;
    throw new Error("Unexpected grant");
  });
  const runtimes: server.UberblickMcpRuntime[] = [];
  const sessions: server.UberblickMcpSession[] = [];
  const createRuntime = server.createMcpRuntime;
  const opening = vi.spyOn(server, "createMcpRuntime").mockImplementation((config, options) => {
    const instance = createRuntime(config, options);
    runtimes.push(instance);
    const openSession = instance.openSession;
    vi.spyOn(instance, "openSession").mockImplementation(() => {
      const session = openSession();
      sessions.push(session);
      return session;
    });
    return instance;
  });
  const host = createMcpHost({
    issuer: "https://hub.example", allowedOrigins: [], hubUrl: hub.url, databaseDirectory: tempDir(),
  }, { checkToken, credentialsForGrant });
  hosts.push(host);
  await new Promise<void>(resolve => host.server.listen(0, "127.0.0.1", resolve));
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("Host has no TCP listener");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp/${WORKSPACE}`);
  return { hub, host, url, first, second, checkToken, credentialsForGrant, opening, runtimes, sessions };
}

async function connect(url: URL, token: string, name: string) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: "1" });
  clients.push(client);
  await client.connect(transport as Transport);
  return {
    client, transport,
    async ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result.structuredContent;
    },
  };
}

async function request(url: URL, method: string, token: string, sessionId: string) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId,
      "MCP-Protocol-Version": "2025-11-25", "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 123, method: "tools/list" }) } : {}),
  });
  return { status: response.status, body: await response.text() };
}

function renameCallback(session: server.UberblickMcpSession) {
  const registered = session.server as unknown as {
    _registeredTools: Record<string, {
      handler(args: { uuid: string; title: string }): Promise<CallToolResult>;
    }>;
  };
  return registered._registeredTools.set_metadata!.handler;
}

function expectShuttingDown(result: CallToolResult) {
  expect(result.isError).toBe(true);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("A refusal must contain its JSON failure payload");
  expect(JSON.parse(content.text)).toMatchObject({ error: "server_shutting_down", applied: false });
}

it("coalesces concurrent sessions of a grant, isolates its credentials, and hides sessions from other grants", async () => {
  const rig = await fixture();
  const held = gate();
  rig.credentialsForGrant.mockImplementationOnce(async () => { await held.wait(); return rig.first.credentials; });
  const firstOpening = connect(rig.url, "first", "first-client");
  pending.push(firstOpening);
  await held.entered;
  const sameGrantOpening = connect(rig.url, "first-renewed", "same-grant-client");
  pending.push(sameGrantOpening);
  await waitUntil("both first-session tokens to reach the host", () =>
    rig.checkToken.mock.calls.some(([token]) => token === "first-renewed"));
  expect(rig.credentialsForGrant).toHaveBeenCalledTimes(1);
  expect(rig.opening).not.toHaveBeenCalled();
  held.release();
  const [first, sameGrant] = await Promise.all([firstOpening, sameGrantOpening]);
  expect(rig.opening).toHaveBeenCalledTimes(1);
  expect(first.transport.sessionId).not.toBe(sameGrant.transport.sessionId);
  expect(rig.sessions[0]!.replicas).toBe(rig.sessions[1]!.replicas);

  const second = await connect(rig.url, "second", "second-client");
  expect(rig.opening).toHaveBeenCalledTimes(2);
  expect(rig.opening.mock.calls[0]![1]).toEqual(rig.first.credentials);
  expect(rig.opening.mock.calls[1]![1]).toEqual(rig.second.credentials);
  expect(rig.opening.mock.calls[0]![0].databasePath).not.toBe(rig.opening.mock.calls[1]![0].databasePath);
  expect(rig.runtimes[0]!.store).not.toBe(rig.runtimes[1]!.store);
  await first.ok("list_docs");
  await second.ok("list_docs");
  for (const [instance, grant] of [[rig.runtimes[0]!, rig.first], [rig.runtimes[1]!, rig.second]] as const) {
    const authentications = rig.hub.authentications.filter(item => item.claims?.sub === instance.replicas.config.sessionId);
    expect(authentications.length).toBeGreaterThan(0);
    expect(authentications.every(item => item.claims?.kid === grant.login.credential.record.id)).toBe(true);
  }

  const id = first.transport.sessionId!;
  const renewed = await request(rig.url, "POST", "first-renewed", id);
  expect(renewed.status).toBe(200);
  expect(renewed.body).toContain("create_doc");
  rig.checkToken.mockResolvedValueOnce({ status: "negative" });
  expect((await request(rig.url, "POST", "first", id)).status).toBe(401);
  for (const method of ["POST", "GET", "DELETE"]) {
    const wrongGrant = await request(rig.url, method, "second", id);
    expect(wrongGrant).toEqual(await request(rig.url, method, "first", randomUUID()));
    expect(wrongGrant.status).toBe(404);
  }
  expect((await first.client.listTools()).tools.length).toBeGreaterThan(0);
  expect((await sameGrant.client.listTools()).tools.length).toBeGreaterThan(0);
  expect(rig.opening).toHaveBeenCalledTimes(2);
});

it("DELETE stops admission and waits for an admitted write while the grant's other session keeps serving", async () => {
  const rig = await fixture();
  const first = await connect(rig.url, "first", "closing-client");
  const survivor = await connect(rig.url, "first-renewed", "surviving-client");
  const instance = rig.runtimes[0]!;
  const created = await first.ok("create_doc", { title: "Before close", description: "Session close drains admitted writes." });
  const held = gate();
  const settle = instance.replicas.settle.bind(instance.replicas);
  vi.spyOn(instance.replicas, "settle").mockImplementationOnce(async () => { await held.wait(); await settle(); });
  const admitted = first.client.callTool({
    name: "set_metadata", arguments: { uuid: created.uuid, title: "Admitted write" },
  }).catch((error: unknown) => error);
  pending.push(admitted);
  await held.entered;
  const session = rig.sessions[0]!;
  const closingSession = vi.spyOn(session, "close");
  const destroy = vi.spyOn(instance.replicas, "destroy");
  let deleted = false;
  const deletion = request(rig.url, "DELETE", "first", first.transport.sessionId!).then(result => {
    deleted = true;
    return result;
  });
  pending.push(deletion);
  await waitUntil("DELETE to close the session", () => closingSession.mock.calls.length > 0);
  expect(await request(rig.url, "POST", "first", first.transport.sessionId!)).toMatchObject({ status: 404 });
  expectShuttingDown(await renameCallback(session)({ uuid: created.uuid, title: "Refused write" }));
  expect((await survivor.ok("get_doc", { uuid: created.uuid })).title).toBe("Before close");
  expect(deleted).toBe(false);
  expect(destroy).not.toHaveBeenCalled();
  held.release();
  expect(await deletion).toMatchObject({ status: 200 });
  await first.client.close();
  await admitted;
  expect((await survivor.ok("get_doc", { uuid: created.uuid })).title).toBe("Admitted write");
  await survivor.ok("set_metadata", { uuid: created.uuid, title: "Survivor still writes" });
  expect(destroy).not.toHaveBeenCalled();
  expect(rig.opening).toHaveBeenCalledTimes(1);
});

it("host stop refuses every session and drains the in-flight write before releasing the runtime", async () => {
  const rig = await fixture();
  const first = await connect(rig.url, "first", "first-client");
  await connect(rig.url, "first-renewed", "second-client");
  await connect(rig.url, "second", "other-grant-client");
  const instance = rig.runtimes[0]!;
  const otherStoreClose = vi.spyOn(rig.runtimes[1]!.store, "close");
  const created = await first.ok("create_doc", { title: "Before stop", description: "Host stop owns runtime release." });
  const held = gate();
  const settle = instance.replicas.settle.bind(instance.replicas);
  vi.spyOn(instance.replicas, "settle").mockImplementationOnce(async () => { await held.wait(); await settle(); });
  const admitted = first.client.callTool({
    name: "set_metadata", arguments: { uuid: created.uuid, title: "Finished before release" },
  }).catch((error: unknown) => error);
  pending.push(admitted);
  await held.entered;
  const titleAtRelease: string[] = [];
  const destroy = instance.replicas.destroy.bind(instance.replicas);
  vi.spyOn(instance.replicas, "destroy").mockImplementation(() => {
    titleAtRelease.push(getMeta(instance.replicas.replica(created.uuid).doc).title);
    destroy();
  });
  const storeClose = vi.spyOn(instance.store, "close");
  let closed = false;
  const closing = rig.host.close();
  pending.push(closing);
  void closing.then(() => { closed = true; });
  expect(rig.host.close()).toBe(closing);
  for (const session of rig.sessions) {
    expectShuttingDown(await renameCallback(session)({ uuid: created.uuid, title: "Too late" }));
  }
  expect(closed).toBe(false);
  expect(titleAtRelease).toEqual([]);
  expect(storeClose).not.toHaveBeenCalled();
  held.release();
  await closing;
  await first.client.close();
  await admitted;
  expect(titleAtRelease).toEqual(["Finished before release"]);
  expect(storeClose).toHaveBeenCalledTimes(1);
  expect(otherStoreClose).toHaveBeenCalledTimes(1);
});
