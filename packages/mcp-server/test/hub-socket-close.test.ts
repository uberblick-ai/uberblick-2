import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { inspectRemote } from "../src/remote.js";
import { HubSync } from "../src/sync.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import { cleanupTestResources, hubUrl, testConfig, TEST_SECRET, trackListener, waitUntil } from "./helpers.js";

const clients: HubSync[] = [];
const listeners: ReturnType<typeof trackListener>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({
    clients: clients.splice(0).map((sync) => () => sync.destroy()),
    hubs: listeners.splice(0).map((listener) => () => listener.close()),
  });
});

function socketProvider(sync: HubSync): HocuspocusProviderWebsocket | null {
  return (sync as unknown as { socket: HocuspocusProviderWebsocket | null }).socket;
}

function nativeSocket(sync: HubSync): WebSocket | null {
  return socketProvider(sync)?.webSocket ?? null;
}

async function silentPeer(): Promise<number> {
  const server = createServer();
  const listener = trackListener(server);
  listeners.push(listener);
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.pause();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test listener port");
  return address.port;
}

async function connectSilentPeer(): Promise<{ sync: HubSync; socket: WebSocket }> {
  const port = await silentPeer();
  const sync = new HubSync(testConfig({ hubUrl: hubUrl(port), authSecret: TEST_SECRET }), () => {});
  clients.push(sync);
  await waitUntil("the silent peer's upgrade", () => nativeSocket(sync)?.readyState === WebSocket.OPEN);
  const socket = nativeSocket(sync);
  if (socket === null) throw new Error("no upgraded socket");
  return { sync, socket };
}

it("finishes destroy after native close when an upgraded peer never reads or answers close", async () => {
  const { sync, socket } = await connectSilentPeer();
  // Exceed ordinary socket buffers so shutdown cannot depend on draining writes.
  socket.send(new Uint8Array(16 * 1024 * 1024));
  let closed = false;
  socket.addEventListener("close", () => { closed = true; }, { once: true });
  const closing = sync.destroy();
  expect(sync.destroy()).toBe(closing);
  await closing;
  expect(closed).toBe(true);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
}, 5_000);

it("closes sockets forgotten by provider cleanup before destroy", async () => {
  const { sync, socket } = await connectSilentPeer();
  socketProvider(sync)?.cleanupWebSocket();
  expect(nativeSocket(sync)).toBeNull();
  expect(socket.readyState).toBe(WebSocket.CLOSING);
  await sync.destroy();
  expect(socket.readyState).toBe(WebSocket.CLOSED);
}, 5_000);

it("rejects a throwing state listener after the provider and native socket close", async () => {
  const { sync, socket } = await connectSilentPeer();
  const failure = new Error("state listener failed during destruction");
  sync.onStateChange(() => { throw failure; });
  const provider = socketProvider(sync);
  clients.splice(clients.indexOf(sync), 1);
  await expect(sync.destroy()).rejects.toMatchObject({ errors: [failure] });
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  expect(provider?.webSocket).toBeNull();
}, 5_000);

it("closes a TCP connection whose HTTP upgrade never completes", async () => {
  const server = createServer();
  const listener = trackListener(server);
  listeners.push(listener);
  server.on("connection", (socket) => socket.pause());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test listener port");
  const sync = new HubSync(testConfig({ hubUrl: hubUrl(address.port), authSecret: TEST_SECRET }), () => {});
  clients.push(sync);
  await waitUntil("the unfinished upgrade's TCP connection", () => listener.sockets.size > 0);
  const socket = nativeSocket(sync);
  expect(socket?.readyState).toBe(WebSocket.CONNECTING);
  let closed = false;
  socket?.addEventListener("close", () => { closed = true; }, { once: true });
  await sync.destroy();
  expect(closed).toBe(true);
}, 5_000);

it("closes immediately when destruction precedes the first TCP connection", async () => {
  const sync = new HubSync(testConfig({ hubUrl: hubUrl(1), authSecret: TEST_SECRET }), () => {});
  clients.push(sync);
  const socket = nativeSocket(sync);
  let closed = socket === null;
  socket?.addEventListener("close", () => { closed = true; }, { once: true });
  await sync.destroy();
  expect(nativeSocket(sync)).toBeNull();
  expect(closed).toBe(true);
}, 5_000);

it.each(["failed dial", "HTTP refusal"])("closes promptly after %s", async (kind) => {
  const server = createServer((_request, response) => response.writeHead(403).end());
  const listener = trackListener(server);
  listeners.push(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test listener port");
  if (kind === "failed dial") await listener.close();
  const sync = new HubSync(testConfig({ hubUrl: hubUrl(address.port), authSecret: TEST_SECRET }), () => {});
  clients.push(sync);
  await waitUntil("the failed connection", () => sync.state().status === "hub-down");
  await sync.destroy();
  expect(nativeSocket(sync)).toBeNull();
}, 5_000);

it("releases the workspace store and serving role after sync teardown rejects", async () => {
  const config = testConfig();
  const workspace = openWorkspaceReplicas(config, { serving: true });
  const failure = new Error("workspace sync teardown failed");
  workspace.replicas.sync.onStateChange(() => { throw failure; });
  await expect(workspace.close()).rejects.toMatchObject({ errors: [failure] });
  expect(() => workspace.store.dataVersion()).toThrow();
  const replacement = openWorkspaceReplicas(config, { serving: true });
  await replacement.close();
});

it("destroys remote probe documents after sync teardown rejects", async () => {
  const failure = new Error("remote probe teardown failed");
  const destroy = HubSync.prototype.destroy;
  vi.spyOn(HubSync.prototype, "destroy").mockImplementation(async function(this: HubSync) {
    await destroy.call(this);
    throw failure;
  });
  const destroyed = vi.spyOn(Y.Doc.prototype, "destroy");
  await expect(inspectRemote(testConfig({ hubUrl: hubUrl(1), authSecret: TEST_SECRET })))
    .rejects.toBe(failure);
  expect(destroyed).toHaveBeenCalled();
  expect(destroyed.mock.contexts.every((doc) => doc instanceof Y.Doc && doc.isDestroyed)).toBe(true);
});
