/** Settle distinguishes a failed dial, a pending upgrade and a lost open socket. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { HubSync } from "../src/sync.js";
import { hubUrl, removeTempDirs, startHub, testConfig, TEST_SECRET, waitUntil, WORKSPACE } from "./helpers.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  removeTempDirs();
});

/** An HTTP listener whose upgrade can stall or open without answering rooms. */
async function listener(open = false) {
  const server = createServer();
  const sockets = new Set<Socket>();
  const fixture = { open, port: 0, sockets, close };
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    if (!fixture.open) return;
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.port = (server.address() as { port: number }).port;
  async function close() {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  cleanup.push(close);
  return fixture;
}

function sync(port: number, connectTimeoutMs = 500, syncTimeoutMs = 750) {
  const instance = new HubSync(testConfig({
    hubUrl: hubUrl(port), authSecret: TEST_SECRET, connectTimeoutMs, syncTimeoutMs,
  }), () => {});
  cleanup.push(() => instance.destroy());
  return instance;
}

function room(instance: HubSync) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  cleanup.push(() => { awareness.destroy(); doc.destroy(); });
  const name = `${WORKSPACE}/_directory`;
  instance.attach({ room: name, doc, awareness });
  return name;
}

it("ends the first and later settles on a failed dial, then syncs when the hub opens", async () => {
  const endpoint = await listener();
  await endpoint.close();
  const instance = sync(endpoint.port, 5_000, 5_000);
  const name = room(instance);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = Date.now();
    await instance.waitForQuiet();
    // A wide margin against five seconds, including the first dial's failure.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(instance.state()).toMatchObject({ status: "hub-down", url: hubUrl(endpoint.port) });
    expect(instance.isRoomQuiet(name)).toBe(false);
  }

  const hub = await startHub({ port: endpoint.port });
  cleanup.push(() => hub.stop());
  await waitUntil("the retry to open", () => instance.state().status === "connected");
  await instance.waitForQuiet();
  expect(instance.isRoomQuiet(name)).toBe(true);
});

it("keeps the connect grace while the WebSocket upgrade is pending", async () => {
  const endpoint = await listener();
  const instance = sync(endpoint.port);
  const started = Date.now();
  await instance.waitForQuiet();
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(endpoint.sockets.size).toBeGreaterThan(0);
  expect(instance.state().status).toBe("hub-down");
});

it("uses the sync budget after open even without an inbound frame", async () => {
  const endpoint = await listener(true);
  const instance = sync(endpoint.port, 100, 750);
  room(instance);
  await waitUntil("WebSocket open", () => instance.state().status === "connected");
  const started = Date.now();
  await instance.waitForQuiet();
  expect(Date.now() - started).toBeGreaterThanOrEqual(750);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(instance.state().status).toBe("connected");
});

it("keeps reconnect grace after open, but ends it once a re-dial fails", async () => {
  const endpoint = await listener(true);
  const instance = sync(endpoint.port, 500);
  await waitUntil("WebSocket open", () => instance.state().status === "connected");
  endpoint.open = false;
  for (const socket of endpoint.sockets) socket.destroy();
  await waitUntil("the open socket to close", () => instance.state().status === "hub-down");

  const started = Date.now();
  await instance.waitForQuiet();
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(endpoint.sockets.size).toBeGreaterThan(0);

  // This retry never completed its upgrade, so closing it proves a failed dial.
  await endpoint.close();
  const failed = Date.now();
  await instance.waitForQuiet();
  expect(Date.now() - failed).toBeLessThan(300);
});
