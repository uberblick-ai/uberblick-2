// @vitest-environment node
/**
 * The reconnect contract, against a real hub.
 *
 * Node rather than jsdom: this file needs a working WebSocket, and jsdom's
 * `Event` and Node's global `WebSocket` refuse to work together. Everything
 * else is the real thing — real hub, real socket, real providers — because the
 * behaviour being defended lives entirely in the protocol's edges: the hub
 * closes a *document* without closing the socket, and Hocuspocus never
 * announces a lost sync.
 *
 * `hub.stop()` here is harsher than a real hub restart: it closes the listener
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
import {
  createHub,
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
  silentLogger,
} from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { getBlocks, initDoc, insertBlock } from "@uberblick/schema";
import * as Y from "yjs";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const SECRET = "reconnect-test-secret";
/** The workspace these rooms live in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

/**
 * `rooms.ts` reads the hub address and the signing secret from the config
 * module, and the hub's port is only known once it is listening — so the config
 * is mocked and the module imported after the hub is up. The mock stands in for
 * a completed `resolveClientConfig()`; resolution itself is covered by
 * `hub-config.test.ts`.
 */
const injected = vi.hoisted(() => ({ url: "", secret: "" }));
vi.mock("../src/config.js", () => ({
  hubUrl: () => injected.url,
  get HUB_AUTH_TOKEN() {
    return injected.secret;
  },
}));

const hubs: Hub[] = [];
const dirs: string[] = [];
const teardown: Array<() => void> = [];

afterEach(async () => {
  for (const undo of teardown.splice(0).reverse()) undo();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Every test gets its own `rooms.ts`: the shared socket and the forced-drop
  // cooldown are module state.
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
    token: async () =>
      mintToken(await importRootSecret(SECRET), {
        typ: "room",
        sub: "peer",
        workspace: WORKSPACE,
        scope: "read-write",
        kid: null,
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      }),
  });
  return { doc, destroy: () => provider.destroy() };
}

interface Tab {
  connection: RoomConnection;
  /** Every status the indicator would have rendered, in order. */
  readonly history: RoomStatus[];
  latest(): RoomStatus;
  /** How many times the tab has been told it is not synced. */
  lostSyncCount(): number;
  release(): void;
}

/**
 * A tab holding one room, wired the way the app wires it: `acquireRoom` plus a
 * status subscription. The status is recorded as a history rather than sampled,
 * so a sync that is lost and regained between polls cannot be missed.
 */
async function openTab(room: string, port: number): Promise<Tab> {
  injected.url = `ws://127.0.0.1:${port}`;
  injected.secret = SECRET;
  const { acquireRoom } = await import("../src/collab/rooms.js");
  const handle = acquireRoom(room, { name: "tab", color: "#abcdef" });
  const history: RoomStatus[] = [];
  const unsubscribe = handle.connection.onStatusChange((next) => {
    history.push(next);
  });
  let released = false;
  const tab: Tab = {
    connection: handle.connection,
    history,
    latest: () => history[history.length - 1] as RoomStatus,
    lostSyncCount: () => history.filter((entry) => !entry.synced).length,
    release: () => {
      if (released) return;
      released = true;
      unsubscribe();
      handle.release();
    },
  };
  teardown.push(() => tab.release());
  return tab;
}

/** The shared socket, which outlives every room and has to be taken down by hand. */
function sharedSocket(connection: RoomConnection) {
  return connection.provider.configuration.websocketProvider;
}

async function seedDocument(tab: Tab, uuid: string): Promise<void> {
  await waitFor("the first sync", () => tab.latest().synced);
  initDoc(tab.connection.ydoc, { uuid, title: "Reconnect" });
  insertBlock(tab.connection.ydoc, null, { type: "paragraph", text: "before" });
  await waitFor(
    "the document to reach the hub",
    () => tab.latest().unsyncedChanges === 0,
  );
}

/** Write a block from a second client and wait for the tab to see it live. */
async function expectLiveWrite(
  tab: Tab,
  port: number,
  room: string,
  text: string,
): Promise<void> {
  const agent = peer(port, room);
  teardown.push(() => agent.destroy());
  await waitFor("the agent to sync", () =>
    getBlocks(agent.doc).some((block) => block.text === "before"),
  );
  insertBlock(agent.doc, null, { type: "paragraph", text });
  await waitFor(`${JSON.stringify(text)} to arrive live`, () =>
    getBlocks(tab.connection.ydoc).some((block) => block.text === text),
  );
}

it("resumes live sync after a hub restart, and never claims to be synced while it is not", async () => {
  const path = databasePath();
  const first = await startHub(0, path);
  const port = first.port;
  const uuid = randomUUID();
  const room = `${WORKSPACE}/${uuid}`;

  const tab = await openTab(room, port);
  teardown.push(() => sharedSocket(tab.connection).destroy());
  await seedDocument(tab, uuid);
  await first.flush();

  // The hub goes away. Its shutdown closes every document and leaves the socket
  // open — the state in which the indicator used to lie.
  await first.stop();
  await waitFor(
    "the status to stop claiming 'synced'",
    () => !(tab.latest().connected && tab.latest().synced),
    5_000,
  );

  // The hub comes back on the same address, with the same database. Nothing
  // rebinds or reloads on this side: same connection, same Y.Doc, same
  // listeners.
  const second = await startHub(port, path);
  expect(second.port).toBe(port);

  await expectLiveWrite(tab, port, room, "after the restart");
  await waitFor(
    "the status to read synced again",
    () => tab.latest().connected && tab.latest().synced,
  );
}, 60_000);

it("repairs a document close that arrives during the forced-drop cooldown", async () => {
  const path = databasePath();
  const hub = await startHub(0, path);
  const uuid = randomUUID();
  const room = `${WORKSPACE}/${uuid}`;

  const tab = await openTab(room, hub.port);
  teardown.push(() => sharedSocket(tab.connection).destroy());
  await seedDocument(tab, uuid);

  // First close: repaired immediately, and it starts the cooldown.
  const beforeFirstClose = tab.lostSyncCount();
  hub.hocuspocus.closeConnections(room);
  await waitFor(
    "the first close to reach the tab",
    () => tab.lostSyncCount() > beforeFirstClose,
  );
  await waitFor(
    "the room to re-join after the first close",
    () => tab.latest().connected && tab.latest().synced,
  );

  // Second close, well inside the cooldown. Rate-limiting it must not throw the
  // repair away: this close is the only signal that the room needs re-joining,
  // and nothing else will ever repeat it.
  const beforeSecondClose = tab.lostSyncCount();
  hub.hocuspocus.closeConnections(room);
  await waitFor(
    "the second close to reach the tab",
    () => tab.lostSyncCount() > beforeSecondClose,
  );

  await expectLiveWrite(tab, hub.port, room, "after the second close");
  await waitFor(
    "the status to read synced again",
    () => tab.latest().connected && tab.latest().synced,
  );
}, 60_000);

it("leaves the socket alone when it is the client that leaves a room", async () => {
  const path = databasePath();
  const hub = await startHub(0, path);
  const uuid = randomUUID();
  const room = `${WORKSPACE}/${uuid}`;

  const first = await openTab(room, hub.port);
  const socket = sharedSocket(first.connection);
  teardown.push(() => socket.destroy());
  let drops = 0;
  socket.on("disconnect", () => {
    drops += 1;
  });
  await seedDocument(first, uuid);

  // Leaving and re-joining a room — a document switch, or a StrictMode remount
  // — makes the hub echo our own close back to us. Re-joining already works on
  // its own, so that echo must not drop the socket.
  first.release();
  const second = await openTab(room, hub.port);
  await waitFor("the re-joined room to sync", () => second.latest().synced);
  await expectLiveWrite(second, hub.port, room, "after re-joining");

  expect(drops).toBe(0);
}, 60_000);
