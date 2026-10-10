/** Settle distinguishes a failed dial, a pending upgrade and a lost open socket. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { HubSync } from "../src/sync.js";
import { formatHubFailure } from "../src/hub-failure.js";
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
  const fixture = { open, port: 0, sockets, close, status: 0, closeCode: 0, dropUpgrade: false };
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    if (fixture.dropUpgrade) { socket.destroy(); return; }
    if (fixture.status) {
      socket.end(`HTTP/1.1 ${fixture.status} private-http-reason\r\nContent-Length: 12\r\n\r\nprivate-body`);
      return;
    }
    if (!fixture.open) return;
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (fixture.closeCode) {
      const body = Buffer.alloc(2 + Buffer.byteLength("private-close-reason"));
      body.writeUInt16BE(fixture.closeCode);
      body.write("private-close-reason", 2);
      socket.end(Buffer.concat([Buffer.from([0x88, body.length]), body]));
    }
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
    expect(instance.state()).toMatchObject({ cause: "refused", detail: `ECONNREFUSED 127.0.0.1:${endpoint.port}` });
    expect(instance.isRoomQuiet(name)).toBe(false);
  }

  const hub = await startHub({ port: endpoint.port });
  cleanup.push(() => hub.stop());
  await waitUntil("the retry to open", () => instance.state().status === "connected");
  await instance.waitForQuiet();
  expect(instance.isRoomQuiet(name)).toBe(true);
  expect(instance.state()).not.toHaveProperty("cause");
  expect(instance.state()).not.toHaveProperty("detail");
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
  expect(instance.state()).toMatchObject({ cause: "timeout", detail: `0.5 127.0.0.1:${endpoint.port}` });
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
  expect(instance.state()).not.toHaveProperty("cause");
  expect(instance.state()).not.toHaveProperty("detail");

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

it("records only the DNS code and dialled host", async () => {
  const instance = new HubSync(testConfig({ hubUrl: "ws://missing.invalid/ws" }), () => {}, { silent: true });
  cleanup.push(() => instance.destroy());
  await waitUntil("DNS failure", () => instance.state().cause === "dns");
  const reading = instance.state();
  // An isolated runner has no resolver and reports EAI_AGAIN instead of ENOTFOUND.
  expect(reading.detail).toMatch(/^(?:ENOTFOUND|EAI_AGAIN) missing\.invalid$/);
  expect(formatHubFailure(reading)).toBe(`DNS lookup failed for missing.invalid (${reading.detail?.split(" ")[0]})`);
});

it("records a TLS failure without claiming a certificate problem", async () => {
  const fixture = await listener();
  const instance = new HubSync(testConfig({ hubUrl: `wss://127.0.0.1:${fixture.port}`, authSecret: TEST_SECRET }), () => {});
  cleanup.push(() => instance.destroy());
  await waitUntil("TLS failure", () => instance.state().cause === "tls");
  expect(instance.state().detail).toBe("ERR_SSL_WRONG_VERSION_NUMBER 127.0.0.1");
  expect(formatHubFailure(instance.state())).toBe("TLS failed for 127.0.0.1 (ERR_SSL_WRONG_VERSION_NUMBER)");
});

it("records an upgrade status and a hub close without their supplied text", async () => {
  const fixture = await listener(true);
  fixture.status = 502;
  const instance = sync(fixture.port);
  await waitUntil("upgrade failure", () => instance.state().cause === "http");
  expect(instance.state().detail).toBe("502 127.0.0.1");
  expect(formatHubFailure(instance.state())).toBe("HTTP 502 from 127.0.0.1 during WebSocket upgrade");

  fixture.status = 0;
  fixture.closeCode = 1001;
  await waitUntil("hub close", () => instance.state().cause === "closed");
  expect(instance.state().detail).toBe("1001");
  expect(formatHubFailure(instance.state())).toBe("closed by the hub (code 1001)");
  fixture.closeCode = 0;
  await waitUntil("successful retry", () => instance.state().status === "connected");
  expect(instance.state()).not.toHaveProperty("cause");
  fixture.open = false;
  for (const socket of fixture.sockets) socket.destroy();
  await waitUntil("unclassified loss after successful retry", () => instance.state().status === "hub-down");
  expect(instance.state()).not.toHaveProperty("cause");
  expect(instance.state()).not.toHaveProperty("detail");
});

it("clears a classified failure when a later upgrade drops without a classified error", async () => {
  const fixture = await listener();
  fixture.status = 502;
  const instance = sync(fixture.port);
  await waitUntil("upgrade failure", () => instance.state().cause === "http");
  fixture.status = 0;
  fixture.dropUpgrade = true;
  await waitUntil("unclassified later failure", () => instance.state().status === "hub-down" && instance.state().cause === undefined);
  expect(instance.state()).not.toHaveProperty("detail");
  fixture.dropUpgrade = false;
  fixture.status = 503;
  await waitUntil("replacement upgrade failure", () => instance.state().detail === "503 127.0.0.1");
});

it("attributes concurrent sockets and fetches to their own requests", async () => {
  const fixture = await listener();
  const first = sync(fixture.port, 1_500);
  // This socket remains pending while the next socket receives a 502.
  await waitUntil("first pending upgrade", () => fixture.sockets.size === 1);
  fixture.status = 502;
  const second = sync(fixture.port);
  await waitUntil("second upgrade failure", () => second.state().cause === "http");
  await fetch(`http://127.0.0.1:${fixture.port}/unrelated`, { signal: AbortSignal.timeout(50) }).catch(() => {});
  await first.waitForQuiet();
  expect(first.state()).toMatchObject({ cause: "timeout", detail: `1.5 127.0.0.1:${fixture.port}` });
  expect(second.state()).toMatchObject({ cause: "http", detail: "502 127.0.0.1" });
});
