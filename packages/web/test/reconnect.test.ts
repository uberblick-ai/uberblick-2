// @vitest-environment node
/**
 * The hub-restart contract, against a real hub.
 *
 * Node rather than jsdom: this file needs a working WebSocket, and jsdom's
 * `Event` and Node's global `WebSocket` refuse to work together. Everything
 * else is the real thing — real hub, real socket, real providers — because the
 * bug being defended against lives entirely in the protocol's edges: the hub
 * closes a *document* without closing the socket, and Hocuspocus never
 * announces a lost sync.
 *
 * The rig is harsher than a real hub restart: `hub.stop()` closes the listener
 * and tells clients their document is gone, but the process stays alive, so the
 * client's socket is never closed for it. A tab in that state is exactly the
 * reported bug — "synced", and receiving nothing until a reload.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { createHub, mintToken, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { getBlocks, initDoc, insertBlock } from "@uberblick/schema";
import * as Y from "yjs";
import type { RoomStatus } from "../src/collab/rooms.js";

const SECRET = "reconnect-test-secret";

/**
 * `rooms.ts` reads the hub address and the signing secret from the config
 * module at import time, and the hub's port is only known once it is listening
 * — so the config is mocked and the module imported after the hub is up.
 */
const injected = vi.hoisted(() => ({ url: "", secret: "" }));
vi.mock("../src/config.js", () => ({
  get HUB_URL() {
    return injected.url;
  },
  get HUB_AUTH_TOKEN() {
    return injected.secret;
  },
  WORKSPACE: "main",
}));

const hubs: Hub[] = [];
const dirs: string[] = [];
const teardown: Array<() => void> = [];

afterEach(async () => {
  for (const undo of teardown.splice(0).reverse()) undo();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-web-"));
  dirs.push(dir);
  return join(dir, "hub.sqlite");
}

async function startHub(port: number, path: string): Promise<Hub> {
  const hub = await createHub({
    authSecret: SECRET,
    port,
    databasePath: path,
    log: silentLogger,
    debounce: 200,
    maxDebounce: 1_000,
    shutdownTimeoutMs: 2_000,
  });
  hubs.push(hub);
  return hub;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

/** A second client, on its own socket, standing in for an agent or a peer tab. */
function peer(port: number, room: string): { doc: Y.Doc; destroy(): void } {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: room,
    document: doc,
    token: () =>
      mintToken(SECRET, { sub: "peer", workspace: "main", scope: "read-write" }),
  });
  return {
    doc,
    destroy: () => provider.destroy(),
  };
}

it("resumes live sync after a hub restart, and never claims to be synced while it is not", async () => {
  const path = databasePath();
  const first = await startHub(0, path);
  const port = first.port;
  const uuid = randomUUID();
  const room = `main/${uuid}`;

  injected.url = `ws://127.0.0.1:${port}`;
  injected.secret = SECRET;
  const { acquireRoom } = await import("../src/collab/rooms.js");

  const { connection, release } = acquireRoom(room, {
    name: "tab",
    color: "#abcdef",
  });
  let status: RoomStatus = connection.status;
  const unsubscribe = connection.onStatusChange((next) => {
    status = next;
  });
  teardown.push(() => {
    unsubscribe();
    release();
    // The shared socket outlives every room by design, and keeps retrying; the
    // test process has to take it down explicitly.
    connection.provider.configuration.websocketProvider.destroy();
  });

  await waitFor("the first sync", () => status.connected && status.synced);
  initDoc(connection.ydoc, { uuid, title: "Reconnect" });
  insertBlock(connection.ydoc, null, { type: "paragraph", text: "before" });
  await waitFor("the document to reach the hub", () => status.unsyncedChanges === 0);
  await first.flush();

  // The hub goes away. Its shutdown closes every document and leaves the
  // socket open — the state in which the indicator used to lie.
  await first.stop();
  await waitFor(
    "the status to stop claiming 'synced'",
    () => !(status.connected && status.synced),
    5_000,
  );

  // The hub comes back on the same address, with the same database.
  const second = await startHub(port, path);
  expect(second.port).toBe(port);

  // An agent writes through the restarted hub. Nothing rebinds or reloads on
  // this side: the same connection, the same Y.Doc, the same listeners.
  const agent = peer(port, room);
  teardown.push(() => agent.destroy());
  await waitFor("the agent to sync", () =>
    getBlocks(agent.doc).some((block) => block.text === "before"),
  );
  insertBlock(agent.doc, null, { type: "paragraph", text: "after the restart" });

  await waitFor("the remote insert to arrive live", () =>
    getBlocks(connection.ydoc).some((block) => block.text === "after the restart"),
  );
  await waitFor("the status to read synced again", () =>
    status.connected && status.synced && status.unsyncedChanges === 0,
  );
}, 40_000);
