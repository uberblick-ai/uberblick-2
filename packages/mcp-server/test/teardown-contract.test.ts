import { createServer } from "node:http";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTestResources, hubUrl, peerClient, startHub, startServer,
  TEST_SECRET, testConfig, trackListener, WORKSPACE,
} from "./helpers.js";
import { drainWaits, waitUntil } from "./lifecycle.js";

const clients: (() => Promise<unknown>)[] = [];
const peers: (() => Promise<unknown>)[] = [];
const hubs: (() => Promise<unknown>)[] = [];
afterEach(() => cleanupTestResources({
  clients: clients.splice(0), peers: peers.splice(0), hubs: hubs.splice(0),
}));

it("resolves rig and peer closure after each captured native socket closes", async () => {
  const hub = await startHub();
  hubs.push(() => hub.stop());
  const rig = await startServer(testConfig({ authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port) }));
  clients.push(() => rig.close());
  const peer = await peerClient(hub.port, `${WORKSPACE}/_directory`);
  peers.push(() => peer.destroy());
  await peer.synced;
  await waitUntil("the rig's hub connection", () => rig.instance.replicas.sync.state().status === "connected");
  const rigSocket = (rig.instance.replicas.sync as unknown as { socket: { webSocket: WebSocket } }).socket.webSocket;
  const peerSocket = peer.provider.configuration.websocketProvider.webSocket;
  if (peerSocket === null) throw new Error("peer did not connect");
  let rigClosed = false;
  let peerClosed = false;
  rigSocket.addEventListener("close", () => { rigClosed = true; }, { once: true });
  peerSocket.addEventListener("close", () => { peerClosed = true; }, { once: true });
  await rig.close();
  expect(rigClosed).toBe(true);
  expect(peerClosed).toBe(false);
  await peer.destroy();
  expect(peerClosed).toBe(true);
});

it("awaits each cleanup phase and preserves every failure while closing the rest", async () => {
  const closed: string[] = [];
  const clientError = new Error("client close rejected");
  const hubError = new Error("hub stop rejected");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const cleaning = cleanupTestResources({
    clients: [async () => { await held; closed.push("client"); throw clientError; }],
    peers: [() => { closed.push("peer"); }],
    hubs: [() => { closed.push("hub"); throw hubError; }, () => { closed.push("listener"); }],
    after: [() => { closed.push("directory"); }],
  });
  const failed = expect(cleaning).rejects.toMatchObject({ errors: [clientError, hubError] });
  await Promise.resolve();
  expect(closed).toEqual([]);
  release();
  await failed;
  expect(closed).toEqual(["client", "peer", "hub", "listener", "directory"]);
});

it("drains an in-flight predicate before cleanup closes its resource", async () => {
  let release!: () => void;
  let entered!: () => void;
  let calls = 0;
  let closed = false;
  const held = new Promise<boolean>((resolve) => { release = () => resolve(false); });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const polling = waitUntil("an unfinished predicate", async () => {
    calls += 1;
    entered();
    return held;
  });
  const observed = polling.then(() => undefined, () => undefined);
  await started;
  const cleaning = cleanupTestResources({ clients: [() => { closed = true; }] });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await cleaning;
  await observed;
  expect(closed).toBe(true);
  expect(calls).toBe(1);
});

it("stops idle polling before the first client closes", async () => {
  let calls = 0;
  const polling = waitUntil("a condition that never arrives", () => { calls += 1; return false; });
  const observed = polling.then(() => undefined, () => undefined);
  await drainWaits();
  const beforeClose = calls;
  await cleanupTestResources({ clients: [() => { expect(calls).toBe(beforeClose); }] });
  await observed;
  expect(calls).toBe(beforeClose);
});

it("reports a predicate failure during teardown and still closes clients", async () => {
  const failure = new Error("the active predicate failed");
  let reject!: (reason: unknown) => void;
  let closed = false;
  const held = new Promise<boolean>((_resolve, fail) => { reject = fail; });
  const polling = waitUntil("a failing predicate", () => held);
  const observed = expect(polling).rejects.toBe(failure);
  const cleaning = cleanupTestResources({ clients: [() => { closed = true; }] });
  const failed = expect(cleaning).rejects.toMatchObject({ errors: [{ errors: [failure] }] });
  reject(failure);
  await failed;
  await observed;
  expect(closed).toBe(true);
});

it.each(["ECONNRESET", "EPIPE"])("attributes an upgraded listener socket's %s to its cleanup", async (code) => {
  const server = createServer();
  const listener = trackListener(server);
  hubs.push(() => listener.close());
  const error = Object.assign(new Error("accepted socket failed"), { code });
  const upgraded = new Promise<void>((resolve) => {
    server.on("upgrade", (_request, socket) => {
      socket.emit("error", error);
      resolve();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener did not bind");
  const client = createConnection({ host: "127.0.0.1", port: address.port });
  client.on("error", (failure: NodeJS.ErrnoException) => {
    if (failure.code !== "ECONNRESET") throw failure;
  });
  const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  clients.push(async () => { client.destroy(); await clientClosed; });
  try {
    client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    await upgraded;
    if (code === "ECONNRESET") await listener.close();
    else await expect(listener.close()).rejects.toMatchObject({ errors: [error] });
    expect(listener.sockets.size).toBe(0);
  } finally {
    client.destroy();
    await clientClosed;
    if (server.listening) await listener.close();
  }
});

describe("polling when a test finishes", () => {
  let finished: Promise<void> | undefined;
  let polledAfterClose = false;
  let resourceClosed = false;
  let pollingEnded = false;
  let continuedAfterTimeout = false;
  const closedWhilePolling: boolean[] = [];

  afterEach(async () => {
    await cleanupTestResources({ clients: [() => {
      resourceClosed = true;
      if (finished) closedWhilePolling.push(!pollingEnded);
    }] });
    await finished;
    expect(polledAfterClose).toBe(false);
    finished = undefined;
    resourceClosed = false;
    pollingEnded = false;
  });

  function poll() {
    const waiting = waitUntil("a test-owned resource", () => {
      if (resourceClosed) polledAfterClose = true;
      return false;
    });
    finished = waiting.then(() => { pollingEnded = true; }, (error: unknown) => {
      pollingEnded = true;
      expect(error).toMatchObject({ name: "AbortError" });
    });
    return waiting;
  }

  it("ends a passing test's unfinished wait before closing resources", () => { void poll(); });

  it.fails("ends a failed test's unfinished wait before closing resources", () => {
    void poll();
    throw new Error("the test failed before its wait finished");
  });

  it.fails("ends a timed-out test's wait before closing resources", { timeout: 50 }, async () => {
    await poll();
    continuedAfterTimeout = true;
  });

  it("closed resources after polling ended in all three preceding outcomes", () => {
    expect(closedWhilePolling).toEqual([false, false, false]);
    expect(polledAfterClose).toBe(false);
    expect(continuedAfterTimeout).toBe(false);
  });
});
