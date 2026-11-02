import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { statSync } from "node:fs";
import { request, type ClientRequest, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { getMeta, roomForDoc } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialProvider } from "../src/credential-provider.js";
import { createMcpHost, type McpHostConfig, type McpHostDependencies } from "../src/http-host.js";
import type { McpHostGrant } from "../src/host-token-check.js";
import * as serverModule from "../src/server.js";
import { cleanupTestResources, tempDir, waitUntil, WORKSPACE } from "./helpers.js";

type Hub = Awaited<ReturnType<typeof startDeviceSyncHub>>;
const hosts: ReturnType<typeof createMcpHost>[] = [];
const hubs: Hub[] = [];
const requests: ClientRequest[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
const IDLE_MS = 15 * 60_000;

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const outgoing of requests.splice(0)) outgoing.destroy();
  try {
    await cleanupTestResources({
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

async function fixture(limits: McpHostConfig["limits"] = {}, hub?: Hub, freeSpace?: McpHostDependencies["freeSpace"]) {
  let now = 0;
  const credentials = new Map<string, { credentialProvider: CredentialProvider; agentName: string }>();
  const grants = new Map<string, McpHostGrant>();
  for (const token of ["first", "second", "third"]) {
    const principal = randomUUID();
    const grant = { grantId: randomUUID(), principal, workspace: WORKSPACE,
      scope: "docs:read docs:write", expiresAt: Date.now() + 3_600_000 };
    grants.set(token, grant);
    if (hub === undefined) {
      const credentialProvider: CredentialProvider = {
        read: () => ({ status: "hub-down", origin: "http://127.0.0.1:1", message: "Test hub unavailable" }),
        async ensure() { return this.read(); },
      };
      credentials.set(grant.grantId, { credentialProvider, agentName: token });
    } else {
      hub.grant(WORKSPACE, principal);
      const login = hub.issue({ workspaces: [WORKSPACE], principalId: principal });
      const credentialProvider: CredentialProvider = {
        read: () => ({ status: "ready", origin: hub.origin, login }),
        ensure: async () => ({ status: "ready", origin: hub.origin, login }),
      };
      credentials.set(grant.grantId, { credentialProvider, agentName: token });
    }
  }
  const checkToken = vi.fn(async (token: string) => ({ status: "positive" as const, ...grants.get(token)! }));
  const credentialsForGrant = vi.fn(async (grant: McpHostGrant) => credentials.get(grant.grantId)!);
  const runtimes: serverModule.UberblickMcpRuntime[] = [];
  const createRuntime = serverModule.createMcpRuntime;
  const opening = vi.spyOn(serverModule, "createMcpRuntime").mockImplementation((config, options) => {
    const runtime = createRuntime({ ...config, ...(hub === undefined ? { localWorkspace: true } : {
      connectTimeoutMs: 1_000, syncTimeoutMs: 1_000,
    }) }, options);
    runtimes.push(runtime);
    return runtime;
  });
  const host = createMcpHost({
    issuer: undefined, allowedOrigins: [], hubUrl: hub?.url ?? "ws://127.0.0.1:1", databaseDirectory: tempDir(),
    limits: { minFreeBytes: 0, ...limits },
  }, { checkToken, credentialsForGrant, now: () => now, ...(freeSpace === undefined ? {} : { freeSpace }) });
  hosts.push(host);
  const responses: ServerResponse[] = [];
  host.server.on("request", (_incoming, response) => { responses.push(response); });
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("Missing host listener");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp/${WORKSPACE}`);
  let nextId = 0;

  async function send(token: string, sessionId: string | undefined, body?: unknown, method = "POST", signal?: AbortSignal) {
    return fetch(url, { method, headers: {
      Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal === undefined ? {} : { signal }) });
  }
  async function initialize(token = "first") {
    const response = await send(token, undefined, { jsonrpc: "2.0", id: ++nextId, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "capacity-test", version: "1" },
    } });
    const body = await response.text();
    return { response, body, id: response.headers.get("mcp-session-id")! };
  }
  function call(token: string, id: string, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
    return send(token, id, { jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } }, "POST", signal);
  }
  async function ok(token: string, id: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
    const response = await call(token, id, name, args);
    expect(response.status).toBe(200);
    const body = await response.text();
    const event = body.split("\n").find(line => line.startsWith("data: "));
    if (event === undefined) throw new Error(`Missing MCP result: ${body}`);
    const answer = JSON.parse(event.slice(6));
    expect(answer.error).toBeUndefined();
    expect(answer.result.isError).not.toBe(true);
    return answer.result.structuredContent;
  }
  async function listed(token: string, id: string) {
    const response = await send(token, id, { jsonrpc: "2.0", id: ++nextId, method: "tools/list" });
    await response.text();
    return response;
  }
  return { host, url, opening, runtimes, checkToken, credentialsForGrant, credentials, grants, responses,
    send, initialize, call, ok, listed, advance: (value: number) => { now = value; } };
}

function expectFull(response: Response) {
  expect(response.status).toBe(503);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
}

async function liveFixture(limits: McpHostConfig["limits"] = {}) {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  return fixture(limits, hub);
}

it("reserves opening runtimes, coalesces one grant, and keeps existing sessions working at capacity", async () => {
  const rig = await fixture({ maxRuntimes: 1 });
  const held = gate();
  rig.credentialsForGrant.mockImplementationOnce(async grant => {
    await held.wait();
    return rig.credentials.get(grant.grantId)!;
  });
  const first = rig.initialize();
  pending.push(first);
  await held.entered;
  const sameGrant = rig.initialize();
  pending.push(sameGrant);
  await waitUntil("both same-grant openings to reach admission", () => rig.checkToken.mock.calls.length === 2);
  const refused = await rig.initialize("second");
  expectFull(refused.response);
  expect(rig.credentialsForGrant).toHaveBeenCalledTimes(1);
  expect(rig.opening).not.toHaveBeenCalled();
  held.release();
  const [one, two] = await Promise.all([first, sameGrant]);
  expect(one.response.status).toBe(200);
  expect(two.response.status).toBe(200);
  expect(one.id).not.toBe(two.id);
  expect(rig.opening).toHaveBeenCalledTimes(1);
  expect((await rig.listed("first", one.id)).status).toBe(200);
  expect((await rig.listed("first", two.id)).status).toBe(200);
  expectFull((await rig.initialize("second")).response);
});

it("reserves sessions before opening a runtime and releases the slot after DELETE drains", async () => {
  const rig = await fixture({ maxSessions: 1 });
  const held = gate();
  rig.credentialsForGrant.mockImplementationOnce(async grant => {
    await held.wait();
    return rig.credentials.get(grant.grantId)!;
  });
  const first = rig.initialize();
  pending.push(first);
  await held.entered;
  expectFull((await rig.initialize()).response);
  expectFull((await rig.initialize("second")).response);
  expect(rig.credentialsForGrant).toHaveBeenCalledTimes(1);
  expect(rig.opening).not.toHaveBeenCalled();
  held.release();
  const one = await first;
  expect((await rig.listed("first", one.id)).status).toBe(200);
  const deletion = await rig.send("first", one.id, undefined, "DELETE");
  expect(deletion.status).toBe(200);
  await deletion.text();
  expect((await rig.listed("first", one.id)).status).toBe(404);
  expect((await rig.initialize("second")).response.status).toBe(200);
  expect(rig.opening).toHaveBeenCalledTimes(2);
});

it("refuses a new runtime below the disk threshold while existing sessions keep writing", async () => {
  const freeSpace = vi.fn(() => 0);
  const rig = await fixture({ minFreeBytes: 1 }, undefined, freeSpace);
  expectFull((await rig.initialize()).response);
  expect(rig.opening).not.toHaveBeenCalled();
  freeSpace.mockReturnValue(1);
  const first = await rig.initialize();
  expect(first.response.status).toBe(200);
  freeSpace.mockReturnValue(0);
  expectFull((await rig.initialize("second")).response);
  expect(rig.opening).toHaveBeenCalledTimes(1);
  expect(await rig.ok("first", first.id, "create_doc", {
    title: "Existing session", description: "The disk threshold gates new runtime openings.",
  })).toMatchObject({ applied: true });
  expect(rig.opening).toHaveBeenCalledTimes(1);
});

it("keeps a call slot until disconnected work finishes and refuses excess writes without applying them", async () => {
  const rig = await fixture({ maxCalls: 1 });
  const one = await rig.initialize();
  const two = await rig.initialize("second");
  const created = await rig.ok("first", one.id, "create_doc", { title: "Before", description: "Capacity protects admission." });
  const runtime = rig.runtimes[0]!;
  const held = gate();
  const settle = runtime.replicas.settle.bind(runtime.replicas);
  vi.spyOn(runtime.replicas, "settle").mockImplementationOnce(async (...args) => { await held.wait(); return settle(...args); });
  const abort = new AbortController();
  const write = rig.call("first", one.id, "set_metadata", { uuid: created.uuid, title: "Admitted" }, abort.signal)
    .then(async response => { await response.text(); }).catch(() => {});
  pending.push(write);
  await held.entered;
  const response = rig.responses.at(-1)!;
  const disconnected = once(response, "close");
  abort.abort();
  await disconnected;
  const refused = await rig.call("first", one.id, "set_metadata", { uuid: created.uuid, title: "Refused" });
  expectFull(refused);
  await refused.text();
  const otherGrant = await rig.call("second", two.id, "create_doc", { title: "Refused other grant", description: "Host-wide call cap." });
  expectFull(otherGrant);
  await otherGrant.text();
  expectFull((await rig.initialize("third")).response);
  expect(rig.opening).toHaveBeenCalledTimes(2);
  expect(getMeta(runtime.replicas.replica(created.uuid).doc).title).toBe("Before");
  rig.advance(IDLE_MS);
  await rig.host.sweepIdle();
  expect(rig.runtimes).toHaveLength(2);
  held.release();
  await write;
  await waitUntil("the disconnected write to finish", () => getMeta(runtime.replicas.replica(created.uuid).doc).title === "Admitted");
  expect((await rig.listed("first", one.id)).status).toBe(200);
});

it("releases a completed call's slot while another call in its session remains busy", async () => {
  const rig = await fixture({ maxCalls: 2 });
  const one = await rig.initialize();
  const two = await rig.initialize("second");
  const runtime = rig.runtimes[0]!;
  const held = gate();
  const settle = runtime.replicas.settle.bind(runtime.replicas);
  vi.spyOn(runtime.replicas, "settle").mockImplementationOnce(async (...args) => { await held.wait(); return settle(...args); });
  const busy = rig.ok("first", one.id, "list_docs");
  pending.push(busy);
  await held.entered;
  expect((await rig.listed("first", one.id)).status).toBe(200);
  expect((await rig.listed("second", two.id)).status).toBe(200);
  held.release();
  await busy;
});

it("reserves every request in a batch before any of its writes starts", async () => {
  const rig = await fixture({ maxCalls: 1 });
  const one = await rig.initialize();
  const created = await rig.ok("first", one.id, "create_doc", { title: "Before batch", description: "A batch has one slot per call." });
  const response = await rig.send("first", one.id, [
    { jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "set_metadata", arguments: { uuid: created.uuid, title: "First batch write" } } },
    { jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "set_metadata", arguments: { uuid: created.uuid, title: "Second batch write" } } },
  ]);
  expectFull(response);
  await response.text();
  expect((await rig.ok("first", one.id, "get_doc", { uuid: created.uuid })).title).toBe("Before batch");
});

it("closes idle sessions despite a GET stream, while POST refreshes the grant's remaining session", async () => {
  const rig = await liveFixture();
  const one = await rig.initialize();
  rig.advance(5 * 60_000);
  const two = await rig.initialize();
  await waitUntil("the idle fixture's seed to be acknowledged", () => rig.runtimes[0]!.store.pendingRooms().length === 0);
  const close = vi.spyOn(rig.runtimes[0]!, "close");
  rig.advance(14 * 60_000);
  const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const outgoing = request(rig.url, { method: "GET", headers: {
      Authorization: "Bearer first", "Mcp-Session-Id": one.id, "MCP-Protocol-Version": "2025-11-25",
      Accept: "application/json, text/event-stream",
    } }, resolve);
    requests.push(outgoing);
    outgoing.on("error", reject);
    outgoing.end();
  });
  expect(stream.statusCode).toBe(200);
  const ended = once(stream, "end");
  stream.resume();
  rig.advance(IDLE_MS);
  await rig.host.sweepIdle();
  await ended;
  expect((await rig.listed("first", one.id)).status).toBe(404);
  expect((await rig.listed("first", two.id)).status).toBe(200);
  expect(close).not.toHaveBeenCalled();
  rig.advance(20 * 60_000);
  await rig.host.sweepIdle();
  expect(close).not.toHaveBeenCalled();
  rig.advance(30 * 60_000);
  await rig.host.sweepIdle();
  expect(close).toHaveBeenCalledTimes(1);
  expect((await rig.listed("first", two.id)).status).toBe(404);
});

it("opens a replacement for an evicted grant while the old runtime is still closing", async () => {
  const rig = await liveFixture({ maxRuntimes: 1 });
  const one = await rig.initialize();
  const old = rig.runtimes[0]!;
  await waitUntil("the evictable runtime's seed to be acknowledged", () => old.store.pendingRooms().length === 0);
  const storeClose = vi.spyOn(old.store, "close");
  const held = gate();
  const close = old.close.bind(old);
  const retiring = vi.spyOn(old, "close").mockImplementationOnce(async deadline => { await held.wait(); await close(deadline); });
  rig.advance(IDLE_MS);
  let swept = false;
  const sweeping = rig.host.sweepIdle().then(() => { swept = true; });
  pending.push(sweeping);
  await waitUntil("the evictable runtime to start closing", () => retiring.mock.calls.length === 1, 2_000);
  await held.entered;
  await waitUntil("idle admission to detach the retiring runtime", () => swept, 1_000);
  expect((await rig.listed("first", one.id)).status).toBe(404);
  const replacement = await rig.initialize();
  expect(replacement.response.status).toBe(200);
  expect(rig.opening).toHaveBeenCalledTimes(2);
  expect(rig.runtimes[1]!.store.databasePath).toBe(old.store.databasePath);
  await rig.ok("first", replacement.id, "create_doc", { title: "Replacement works", description: "The prior runtime has not released its mirror." });
  held.release();
  await waitUntil("the old mirror handle to close", () => storeClose.mock.calls.length === 1);
  expect((await rig.listed("first", replacement.id)).status).toBe(200);
  expect(rig.opening).toHaveBeenCalledTimes(2);
});

it("evicts clean runtimes by their last activity rather than their opening order", async () => {
  const rig = await liveFixture();
  const first = await rig.initialize();
  rig.advance(5 * 60_000);
  await rig.initialize("second");
  rig.advance(10 * 60_000);
  expect((await rig.listed("first", first.id)).status).toBe(200);
  await waitUntil("both idle candidates to have no pending changes", () =>
    rig.runtimes.every(runtime => runtime.store.pendingRooms().length === 0));
  const order: number[] = [];
  for (const [index, runtime] of rig.runtimes.entries()) {
    const close = runtime.close.bind(runtime);
    vi.spyOn(runtime, "close").mockImplementation(deadline => { order.push(index); return close(deadline); });
  }
  rig.advance(25 * 60_000);
  await rig.host.sweepIdle();
  expect(order).toEqual([1, 0]);
});

it("persists mirror last use even when the oldest runtime finishes closing last", async () => {
  const rig = await liveFixture();
  const firstUse = Date.now();
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(firstUse);
  await rig.initialize();
  rig.advance(60_000);
  wallClock.mockReturnValue(firstUse + 1_000);
  const newer = await rig.initialize("second");
  rig.advance(2 * 60_000);
  wallClock.mockReturnValue(firstUse + 2_000);
  expect((await rig.listed("second", newer.id)).status).toBe(200);
  await waitUntil("both mirror candidates to be acknowledged", () =>
    rig.runtimes.every(runtime => runtime.store.pendingRooms().length === 0));
  const [oldestRuntime, newerRuntime] = rig.runtimes;
  const oldestClose = oldestRuntime!.close.bind(oldestRuntime);
  const newerClose = newerRuntime!.close.bind(newerRuntime);
  const held = gate();
  const completed: number[] = [];
  const oldestClosing = vi.spyOn(oldestRuntime!, "close").mockImplementationOnce(async deadline => {
    await held.wait();
    await oldestClose(deadline);
    completed.push(0);
  });
  vi.spyOn(newerRuntime!, "close").mockImplementationOnce(async deadline => {
    await newerClose(deadline);
    completed.push(1);
  });
  rig.advance(17 * 60_000);
  wallClock.mockReturnValue(firstUse + 3_000);
  await rig.host.sweepIdle();
  await waitUntil("the oldest runtime to enter retirement", () => oldestClosing.mock.calls.length === 1, 2_000);
  await held.entered;
  await waitUntil("the newer mirror to close ahead of the held oldest mirror", () => completed.includes(1));
  wallClock.mockReturnValue(firstUse + 4_000);
  held.release();
  await rig.host.close();
  expect(completed).toEqual([1, 0]);
  expect(statSync(dirname(oldestRuntime!.store.databasePath)).mtimeMs).toBe(firstUse);
  expect(statSync(dirname(newerRuntime!.store.databasePath)).mtimeMs).toBe(firstUse + 2_000);
});

it("keeps the replacement's last use after both generations of its mirror retire", async () => {
  const rig = await liveFixture({ maxRuntimes: 1 });
  const firstUse = Date.now();
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(firstUse);
  await rig.initialize();
  const old = rig.runtimes[0]!;
  await waitUntil("the original mirror to have no pending seed", () => old.store.pendingRooms().length === 0);
  const held = gate();
  const close = old.close.bind(old);
  const retiring = vi.spyOn(old, "close").mockImplementationOnce(async deadline => { await held.wait(); await close(deadline); });
  rig.advance(IDLE_MS);
  await rig.host.sweepIdle();
  await waitUntil("the original generation to enter retirement", () => retiring.mock.calls.length === 1, 2_000);
  await held.entered;
  wallClock.mockReturnValue(firstUse + 1_000);
  const replacement = await rig.initialize();
  expect(replacement.response.status).toBe(200);
  const replacementRuntime = rig.runtimes[1]!;
  expect(replacementRuntime.store.databasePath).toBe(old.store.databasePath);
  wallClock.mockReturnValue(firstUse + 2_000);
  expect((await rig.listed("first", replacement.id)).status).toBe(200);
  await waitUntil("the replacement mirror to be acknowledged", () => replacementRuntime.store.pendingRooms().length === 0);
  rig.advance(2 * IDLE_MS);
  wallClock.mockReturnValue(firstUse + 3_000);
  await rig.host.sweepIdle();
  const mirrorDirectory = dirname(old.store.databasePath);
  await waitUntil("the replacement generation to persist its use and release", () =>
    statSync(mirrorDirectory).mtimeMs === firstUse + 2_000);
  wallClock.mockReturnValue(firstUse + 4_000);
  held.release();
  await rig.host.close();
  expect(statSync(mirrorDirectory).mtimeMs).toBe(firstUse + 2_000);
});

it("preserves a mirror's last use when the host shuts down before idle eviction", async () => {
  const rig = await fixture();
  const firstUse = Date.now();
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(firstUse);
  const first = await rig.initialize();
  wallClock.mockReturnValue(firstUse + 1_000);
  expect((await rig.listed("first", first.id)).status).toBe(200);
  wallClock.mockReturnValue(firstUse + 2_000);
  await rig.host.close();
  expect(statSync(dirname(rig.runtimes[0]!.store.databasePath)).mtimeMs).toBe(firstUse + 1_000);
});

it("retains an unacknowledged runtime across idle expiry and evicts it after the hub acknowledges", async () => {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  const rig = await fixture({ maxRuntimes: 1 }, hub);
  const one = await rig.initialize();
  const created = await rig.ok("first", one.id, "create_doc", { title: "Before outage", description: "Unsynced host content must survive idle eviction." });
  const runtime = rig.runtimes[0]!;
  await waitUntil("the initial hosted write to be acknowledged", () => runtime.store.pendingRooms().length === 0);
  const room = roomForDoc(WORKSPACE, created.uuid);
  const held = hub.holdNextMessage(room);
  releases.push(held.release);
  const write = rig.ok("first", one.id, "set_metadata", { uuid: created.uuid, title: "Pending through outage" });
  pending.push(write);
  await held.entered;
  expect(runtime.store.pendingRooms().some(item => item.room === room)).toBe(true);
  const paused = hub.pause();
  pending.push(paused);
  await waitUntil("the unacknowledged writer to disconnect", () => runtime.replicas.sync.state().status !== "connected");
  held.release();
  await paused;
  expect(await write).toMatchObject({ applied: true, synced: false });
  expect(runtime.store.pendingRooms().some(item => item.room === room)).toBe(true);
  const close = vi.spyOn(runtime, "close");
  const storeClose = vi.spyOn(runtime.store, "close");
  rig.advance(IDLE_MS);
  await rig.host.sweepIdle();
  expect(close).not.toHaveBeenCalled();
  expect(storeClose).not.toHaveBeenCalled();
  expectFull((await rig.initialize("second")).response);
  await hub.resume();
  await waitUntil("the retained runtime's pending write to reach the restarted hub", () => runtime.store.pendingRooms().length === 0);
  expect(hub.readRoom(room, doc => getMeta(doc).title)).toBe("Pending through outage");
  await rig.host.sweepIdle();
  expect(close).toHaveBeenCalledTimes(1);
  expect((await rig.initialize("second")).response.status).toBe(200);
});
