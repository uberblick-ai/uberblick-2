import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type ClientRequest } from "node:http";
import { getMeta } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialProvider } from "../src/credential-provider.js";
import { createMcpHost } from "../src/http-host.js";
import type { McpHostTokenResult } from "../src/host-token-check.js";
import * as serverModule from "../src/server.js";
import { tools } from "../src/tool-table.js";
import { cleanupTestResources, startServer, tempDir, waitUntil, WORKSPACE } from "./helpers.js";

const hosts: ReturnType<typeof createMcpHost>[] = [];
const requests: ClientRequest[] = [];
const peers: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
const readonlyNames = tools.filter(tool => tool.writes === null).map(tool => tool.name);
const allNames = tools.map(tool => tool.name);

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const outgoing of requests.splice(0)) outgoing.destroy();
  vi.useRealTimers();
  try {
    await cleanupTestResources({
      peers: [...peers.splice(0), ...hosts.splice(0).map(host => () => host.close())],
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

async function fixture({ issuer }: { issuer: string | undefined } = { issuer: "https://hub.example" }) {
  const credentialProvider: CredentialProvider = {
    read: () => ({ status: "hub-down", origin: "http://127.0.0.1:1", message: "Test hub unavailable" }),
    async ensure() { return this.read(); },
  };
  const grant = { grantId: randomUUID(), principal: randomUUID(), workspace: WORKSPACE,
    scope: "docs:read docs:write", expiresAt: Date.now() + 3_600_000 };
  const checkToken = vi.fn(async (token: string): Promise<McpHostTokenResult> => ({
    status: "positive", ...grant, scope: token === "read" ? "docs:read" : grant.scope,
  }));
  const runtimes: serverModule.UberblickMcpRuntime[] = [];
  const sessions: serverModule.UberblickMcpSession[] = [];
  const createRuntime = serverModule.createMcpRuntime;
  vi.spyOn(serverModule, "createMcpRuntime").mockImplementation((config, options) => {
    const runtime = createRuntime({ ...config, localWorkspace: true }, options);
    runtimes.push(runtime);
    const openSession = runtime.openSession.bind(runtime);
    vi.spyOn(runtime, "openSession").mockImplementation((...args) => {
      const session = openSession(...args);
      sessions.push(session);
      return session;
    });
    return runtime;
  });
  const host = createMcpHost({
    issuer, allowedOrigins: [], hubUrl: "ws://127.0.0.1:1", databaseDirectory: tempDir(), limits: { minFreeBytes: 0 },
  }, { checkToken, credentialsForGrant: async () => ({ credentialProvider, agentName: "Scope grant" }) });
  hosts.push(host);
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("Missing host listener");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp/${WORKSPACE}`);
  let nextId = 0;

  function headers(token: string, sessionId?: string) {
    return {
      Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" }),
    };
  }
  function send(token: string, sessionId: string | undefined, body: unknown) {
    return fetch(url, { method: "POST", headers: headers(token, sessionId), body: JSON.stringify(body) });
  }
  async function initialize(token = "write") {
    const response = await send(token, undefined, { jsonrpc: "2.0", id: ++nextId, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "scope-test", version: "1" },
    } });
    expect(response.status).toBe(200);
    await response.text();
    return response.headers.get("mcp-session-id")!;
  }
  async function result(response: Response): Promise<any> {
    expect(response.status).toBe(200);
    const body = await response.text();
    const event = body.split("\n").find(line => line.startsWith("data: "));
    if (event === undefined) throw new Error(`Missing MCP result: ${body}`);
    const answer = JSON.parse(event.slice(6));
    expect(answer.error).toBeUndefined();
    return answer.result;
  }
  async function list(token: string, sessionId: string): Promise<any[]> {
    const answer = await result(await send(token, sessionId, { jsonrpc: "2.0", id: ++nextId, method: "tools/list" }));
    return answer.tools;
  }
  function delayedList(token: string, sessionId: string) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/list" });
    let outgoing!: ClientRequest;
    const response = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      outgoing = request(url, { method: "POST", headers: {
        ...headers(token, sessionId), "Content-Length": Buffer.byteLength(body),
      } }, resolve);
      requests.push(outgoing);
      outgoing.on("error", reject);
      outgoing.flushHeaders();
    });
    const listed = response.then(async incoming => {
      let text = "";
      incoming.setEncoding("utf8");
      incoming.on("data", chunk => { text += chunk; });
      await once(incoming, "end");
      expect(incoming.statusCode).toBe(200);
      const event = text.split("\n").find(line => line.startsWith("data: "));
      if (event === undefined) throw new Error(`Missing MCP result: ${text}`);
      return JSON.parse(event.slice(6)).result.tools as { name: string }[];
    });
    pending.push(listed);
    return { finish: () => outgoing.end(body), listed };
  }
  function call(token: string, sessionId: string, name: string, args: Record<string, unknown> = {}) {
    return send(token, sessionId, { jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } });
  }
  async function ok(token: string, sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
    const answer = await result(await call(token, sessionId, name, args));
    expect(answer.isError).not.toBe(true);
    return answer.structuredContent;
  }
  async function stream(token: string, sessionId: string) {
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const outgoing = request(url, { method: "GET", headers: headers(token, sessionId) }, resolve);
      requests.push(outgoing);
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(response.statusCode).toBe(200);
    let buffered = "";
    const notifications: string[] = [];
    response.setEncoding("utf8");
    response.on("data", chunk => {
      buffered += chunk;
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary === -1) break;
        const event = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = event.split("\n").find(line => line.startsWith("data: "));
        if (data !== undefined) notifications.push(JSON.parse(data.slice(6)).method);
      }
    });
    return { response, notifications };
  }
  return { host, checkToken, grant, runtimes, sessions, send, initialize, result, list, delayedList, call, ok, stream };
}

function expectScopeFailure(result: any) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(JSON.parse(result.content[0].text)).toMatchObject({
    error: "insufficient_scope", applied: false, partial: false, synced: false,
    recoveryClass: "manual", message: expect.any(String), recovery: expect.any(String),
  });
}

it("lists exactly non-writing tools for read-only requests and the complete stdio catalog for write requests", async () => {
  const rig = await fixture();
  const id = await rig.initialize("read");
  const readonly = await rig.list("read", id);
  expect(readonly.map(tool => tool.name)).toEqual(readonlyNames);
  const writable = await rig.list("write", id);
  expect(writable.map(tool => tool.name)).toEqual(allNames);
  const stdio = await startServer();
  peers.push(() => stdio.close());
  expect(writable).toEqual((await stdio.client.listTools()).tools);
  await stdio.ok("create_doc", { title: "Stdio still writes", description: "Scope checks apply to hosted sessions." });
  expect((await rig.list("read", id)).map(tool => tool.name)).toEqual(readonlyNames);
});

it.each(["read", "write"])("keeps an overlapping %s tools/list tied to its own request token", async token => {
  const rig = await fixture();
  const id = await rig.initialize();
  const before = rig.checkToken.mock.calls.length;
  const delayed = rig.delayedList(token, id);
  await waitUntil("the delayed list's token check", () => rig.checkToken.mock.calls.length > before);
  const other = token === "read" ? "write" : "read";
  expect((await rig.list(other, id)).map(tool => tool.name)).toEqual(other === "read" ? readonlyNames : allNames);
  delayed.finish();
  expect((await delayed.listed).map(tool => tool.name)).toEqual(token === "read" ? readonlyNames : allNames);
});

it.each(["https://hub.example", undefined])("refuses every writing tool before dispatch with issuer %s", async issuer => {
  const rig = await fixture({ issuer });
  const id = await rig.initialize();
  expect((await rig.list("write", id)).map(tool => tool.name)).toEqual(allNames);
  const instance = rig.runtimes[0]!;
  const settled = vi.spyOn(instance.replicas, "settle");
  const append = vi.spyOn(instance.store, "appendUpdate");
  for (const tool of tools.filter(tool => tool.writes !== null)) {
    const refused = await rig.call("read", id, tool.name, tool.example);
    expect(refused.status, tool.name).toBe(403);
    expect(refused.headers.get("www-authenticate"), tool.name).toBe(issuer === undefined ? null :
      `Bearer error="insufficient_scope", scope="docs:read docs:write", resource_metadata="https://hub.example/.well-known/oauth-protected-resource/mcp/${WORKSPACE}"`);
    await refused.text();
  }
  const batch = await rig.send("read", id, [
    { jsonrpc: "2.0", id: 10_001, method: "tools/call", params: { name: "list_docs", arguments: {} } },
    { jsonrpc: "2.0", id: 10_002, method: "tools/call", params: { name: "create_doc", arguments: {
      title: "Refused batch", description: "No message in this batch may be dispatched.",
    } } },
  ]);
  expect(batch.status).toBe(403);
  await batch.text();
  expect(settled).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it("announces narrowing and re-widening on an open stream and lists each accepted request's scope", async () => {
  const rig = await fixture();
  const id = await rig.initialize();
  const stream = await rig.stream("write", id);
  expect((await rig.list("read", id)).map(tool => tool.name)).toEqual(readonlyNames);
  await waitUntil("scope narrowing notification", () => stream.notifications.length === 1);
  expect(stream.notifications).toEqual(["notifications/tools/list_changed"]);
  expect((await rig.list("read", id)).map(tool => tool.name)).toEqual(readonlyNames);
  expect((await rig.list("write", id)).map(tool => tool.name)).toEqual(allNames);
  await waitUntil("scope re-widening notification", () => stream.notifications.length === 2);
  expect(stream.notifications).toEqual(["notifications/tools/list_changed", "notifications/tools/list_changed"]);
  await rig.ok("write", id, "create_doc", { title: "Re-widened", description: "A later broad token restores write scope." });
});

it("refuses an admitted local write after narrowing while another session of the same grant can still write", async () => {
  const rig = await fixture();
  const id = await rig.initialize();
  const other = await rig.initialize();
  expect(rig.runtimes).toHaveLength(1);
  const created = await rig.ok("write", id, "create_doc", { title: "Before narrowing", description: "Scope belongs to a session." });
  const runtime = rig.runtimes[0]!;
  const held = gate();
  const settle = runtime.replicas.settle.bind(runtime.replicas);
  vi.spyOn(runtime.replicas, "settle").mockImplementationOnce(async (...args) => { await held.wait(); return settle(...args); });
  const admitted = rig.call("write", id, "set_metadata", { uuid: created.uuid, title: "Too late" }).then(rig.result);
  pending.push(admitted);
  await held.entered;
  expect((await rig.list("read", id)).map(tool => tool.name)).toEqual(readonlyNames);
  await rig.ok("write", other, "set_metadata", { uuid: created.uuid, title: "Other session writes" });
  const append = vi.spyOn(runtime.store, "appendUpdate");
  held.release();
  expectScopeFailure(await admitted);
  expect(append).not.toHaveBeenCalled();
  expect(getMeta(runtime.replicas.replica(created.uuid).doc).title).toBe("Other session writes");
});

it("uses the latest accepted scope when an admitted write is narrowed and then re-widened", async () => {
  const rig = await fixture();
  const id = await rig.initialize();
  const created = await rig.ok("write", id, "create_doc", { title: "Before", description: "Latest accepted token wins." });
  const runtime = rig.runtimes[0]!;
  const held = gate();
  const settle = runtime.replicas.settle.bind(runtime.replicas);
  vi.spyOn(runtime.replicas, "settle").mockImplementationOnce(async (...args) => { await held.wait(); return settle(...args); });
  const admitted = rig.call("write", id, "set_metadata", { uuid: created.uuid, title: "Allowed again" }).then(rig.result);
  pending.push(admitted);
  await held.entered;
  await rig.list("read", id);
  await rig.list("write", id);
  held.release();
  expect((await admitted).isError).not.toBe(true);
  expect(getMeta(runtime.replicas.replica(created.uuid).doc).title).toBe("Allowed again");
});

it("does not replace session scope with an open stream's periodic token recheck", async () => {
  const rig = await fixture();
  const id = await rig.initialize();
  const created = await rig.ok("write", id, "create_doc", { title: "Before recheck", description: "Stream rechecks do not change session scope." });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  const stream = await rig.stream("opening-stream", id);
  const runtime = rig.runtimes[0]!;
  const held = gate();
  const settle = runtime.replicas.settle.bind(runtime.replicas);
  vi.spyOn(runtime.replicas, "settle").mockImplementationOnce(async (...args) => { await held.wait(); return settle(...args); });
  const admitted = rig.call("write", id, "set_metadata", { uuid: created.uuid, title: "Recheck preserved scope" }).then(rig.result);
  pending.push(admitted);
  await held.entered;
  rig.checkToken.mockImplementation(async token => ({ status: "positive", ...rig.grant,
    scope: token === "opening-stream" ? "docs:read" : "docs:read docs:write" }));
  await vi.advanceTimersByTimeAsync(25_000);
  expect(rig.checkToken.mock.calls.at(-1)).toEqual(["opening-stream"]);
  held.release();
  expect((await admitted).isError).not.toBe(true);
  expect(getMeta(runtime.replicas.replica(created.uuid).doc).title).toBe("Recheck preserved scope");
  expect(stream.notifications).toEqual([]);
});
