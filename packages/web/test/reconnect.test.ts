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
 *
 * The last test is the same shape of claim about a different input: since #426
 * the signing secret arrives in the served document, so "no secret yet" is a
 * state a healthy tab can start in — a host still booting, a proxy holding one
 * request. It must also end without a reload.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HocuspocusProvider, HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import {
  createHub,
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
  silentLogger,
  STORE_BUSY_REASON,
  STORE_REFUSED_REASON,
} from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import { getBlocks, getWorkspaceName, initDoc, insertBlock, setWorkspaceName, settingsRoom } from "@uberblick/schema";
import * as Y from "yjs";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { PacedRoomProvider, RoomAdmission } from "../src/collab/room-admission.js";

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
  HUB_CONFIG_PATH: "/uberblick-config.json",
  hubUrl: () => injected.url,
  hubAuthToken: () => injected.secret,
  // `rooms.ts` re-reads the configuration before every connect attempt; a
  // resolved one is what the mock stands for, so this is the settled read.
  resolveClientConfig: async () => ({}),
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

/**
 * How long one awaited condition gets here.
 *
 * Generous rather than tight. Every wait in this file is on a real hub over a
 * real socket, and the review container runs every package's suite at once: a
 * deadline sized for a quiet machine turns load into a red gate, and a gate
 * that fails for load reasons teaches everyone to re-run it. The precision
 * that matters is in the label, not the clock — an expired wait still names
 * the condition that never arrived.
 */
const WAIT_TIMEOUT_MS = 20_000;

/**
 * The one deadline that has to outlast a repair rather than interrupt it.
 *
 * What is measured, and all that is claimed here: when a room is released and
 * re-joined in the same tick — a document switch, a StrictMode remount — the
 * re-joined room sometimes goes quiet. It reports "synced" within
 * milliseconds, and then neither is anything another client writes delivered
 * to it, nor does the hub acknowledge anything it writes, until the provider
 * repairs itself. Rare (single-digit occurrences in thousands of cycles) and
 * not load-dependent — idle machines produce it too. *Why* the hub stops
 * serving a room it has just been re-joined on is #402's question, not this
 * file's; the wait below depends only on the two observables above.
 *
 * The repair is the socket's message-reconnect check: Hocuspocus runs
 * `checkConnection` every `messageReconnectTimeout / 10` (3s), forces a
 * reconnect once `messageReconnectTimeout` (30s) has passed without a message,
 * takes up to two close attempts to get there, and then still owes a reconnect
 * delay and a fresh handshake — end to end, 30.4s to 33.3s across every
 * instrumented recovery. So 30s is a floor rather than the number, and
 * WAIT_TIMEOUT_MS is under it either way: the step this replaces went red on a
 * live write that would have landed a second or two later. 45s is that
 * measured band plus ~12s, the same kind of margin WAIT_TIMEOUT_MS gives an
 * ordinary condition — not a guess at how slow a machine is, and not
 * trimmable to the 31s that a single run happens to show.
 */
const REJOIN_REPAIR_TIMEOUT_MS = 45_000;

/**
 * Vitest's own budget per test.
 *
 * The rule: above the longest chain of named waits a test here makes in
 * sequence, so whichever timeout fires first is the one that can explain the
 * failure. "Test timed out" explains nothing; "timed out waiting for the second
 * close to reach the tab" is a diagnosis.
 *
 * The chain that sets the number is "repairs a document close that arrives
 * during the forced-drop cooldown": eight waits end to end — two in
 * `seedDocument`, four in the test body, two in `expectLiveWrite` — at
 * WAIT_TIMEOUT_MS each, so 160s. The runner-up is "leaves the socket alone…",
 * whose five WAIT_TIMEOUT_MS waits sit beside one REJOIN_REPAIR_TIMEOUT_MS:
 * 145s. Change any of the three constants and check that this one is still the
 * larger.
 */
const TEST_TIMEOUT_MS = 180_000;

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
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
      wrapToken(
        await mintToken(await importRootSecret(SECRET), {
          typ: "room",
          sub: "peer",
          workspace: WORKSPACE,
          scope: "read-write",
          kid: null,
          lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
        }),
      ),
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
async function openTab(room: string, port: number, secret = SECRET): Promise<Tab> {
  injected.url = `ws://127.0.0.1:${port}`;
  injected.secret = secret;
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
  await waitFor("the room to become writable", () => tab.latest().writable);
  initDoc(tab.connection.ydoc, { uuid, title: "Reconnect" });
  insertBlock(tab.connection.ydoc, null, { type: "paragraph", text: "before" });
  await waitFor(
    "the document to reach the hub",
    () => tab.latest().unsyncedChanges === 0,
  );
}

it("keeps a room on a live socket read-only until its token is admitted", async () => {
  const hub = await startHub(0, databasePath());
  const firstUuid = randomUUID();
  const first = await openTab(`${WORKSPACE}/${firstUuid}`, hub.port);
  teardown.push(() => sharedSocket(first.connection).destroy());
  await seedDocument(first, firstUuid);

  const second = await openTab(`${WORKSPACE}/${randomUUID()}`, hub.port);
  expect(second.history[0]).toMatchObject({
    hasReceivedServerState: false,
    hasAnswered: false,
  });
  await waitFor("the second room's token to be admitted", () =>
    second.latest().writable,
  );
  expect(
    second.history.slice(1).some(({ connected, writable }) => connected && !writable),
  ).toBe(true);
  await waitFor("the second room's server answer", () => second.latest().hasAnswered);
  expect(second.latest().hasReceivedServerState).toBe(true);
}, TEST_TIMEOUT_MS);

/** Send the same room-local close reason the local browser bridge sends. */
function closeRoom(hub: Hub, room: string, reason: string): void {
  const document = hub.hocuspocus.documents.get(room);
  if (document === undefined) throw new Error(`hub has no document ${room}`);
  for (const connection of document.getConnections()) {
    connection.close({ code: 1000, reason });
  }
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
  );
  expect(tab.latest().writable).toBe(false);
  expect(tab.latest().hasReceivedServerState).toBe(true);

  // The hub comes back on the same address, with the same database. Nothing
  // rebinds or reloads on this side: same connection, same Y.Doc, same
  // listeners.
  const second = await startHub(port, path);
  expect(second.port).toBe(port);

  await expectLiveWrite(tab, port, room, "after the restart");
  await waitFor(
    "the status to read synced again",
    () => tab.latest().connected && tab.latest().synced && tab.latest().writable,
  );
}, TEST_TIMEOUT_MS);

it("redials after a busy store close and republishes the last local write", async () => {
  const hub = await startHub(0, databasePath());
  const uuid = randomUUID();
  const room = `${WORKSPACE}/${uuid}`;
  const tab = await openTab(room, hub.port);
  teardown.push(() => sharedSocket(tab.connection).destroy());
  await seedDocument(tab, uuid);

  insertBlock(tab.connection.ydoc, null, {
    type: "paragraph",
    text: "before the busy close",
  });
  const beforeClose = tab.history.length;
  closeRoom(hub, room, STORE_BUSY_REASON);
  await waitFor("the busy room to become read-only", () =>
    tab.history.slice(beforeClose).some((status) => !status.writable),
  );
  await waitFor("the busy room to be admitted again", () => tab.latest().writable);

  const observer = peer(hub.port, room);
  teardown.push(() => observer.destroy());
  await waitFor("the pre-close write to reach the hub", () =>
    getBlocks(observer.doc).some((block) => block.text === "before the busy close"),
  );
}, TEST_TIMEOUT_MS);

it("keeps a store-refused room read-only across reacquire without dropping peers", async () => {
  const hub = await startHub(0, databasePath());
  const refusedUuid = randomUUID();
  const otherUuid = randomUUID();
  const refusedRoom = `${WORKSPACE}/${refusedUuid}`;
  const otherRoom = `${WORKSPACE}/${otherUuid}`;
  const refused = await openTab(refusedRoom, hub.port);
  const other = await openTab(otherRoom, hub.port);
  teardown.push(() => sharedSocket(refused.connection).destroy());
  await seedDocument(refused, refusedUuid);
  await seedDocument(other, otherUuid);

  closeRoom(hub, refusedRoom, STORE_REFUSED_REASON);
  await waitFor("the refusal reading", () => refused.latest().storeRefused);
  expect(refused.latest().hasAnswered).toBe(true);
  expect(refused.latest().writable).toBe(false);
  expect(other.latest().writable).toBe(true);
  await expectLiveWrite(other, hub.port, otherRoom, "the other room stays live");

  refused.release();
  const reopened = await openTab(refusedRoom, hub.port);
  expect(reopened.latest().storeRefused).toBe(true);
  expect(reopened.latest().hasAnswered).toBe(true);
  expect(reopened.latest().writable).toBe(false);
  expect(reopened.connection.provider.isAttached).toBe(false);
  expect(other.latest().writable).toBe(true);
}, TEST_TIMEOUT_MS);

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
}, TEST_TIMEOUT_MS);

it("leaves the socket alone when it is the client that leaves a room", async () => {
  const path = databasePath();
  const hub = await startHub(0, path);
  const uuid = randomUUID();
  const room = `${WORKSPACE}/${uuid}`;

  const first = await openTab(room, hub.port);
  const socket = sharedSocket(first.connection);
  teardown.push(() => socket.destroy());
  let drops = 0;
  let countDrops = true;
  socket.on("disconnect", () => {
    if (countDrops) drops += 1;
  });
  await seedDocument(first, uuid);

  // Leaving and re-joining a room — a document switch, or a StrictMode remount
  // — makes the hub echo our own close back to us. Re-joining already works on
  // its own, so that echo must not drop the socket.
  first.release();
  const second = await openTab(room, hub.port);
  await waitFor("the re-joined room to sync", () => second.latest().synced);

  // The echoed provider_initiated close has had its chance once the replacement
  // room has synced. Only that phase is this assertion's contract: a later
  // message-reconnect repair may legitimately replace a stranded socket.
  expect(drops).toBe(0);
  countDrops = false;

  // "Synced" is the handshake alone, and a re-joined room can report it and
  // still be unserved — see REJOIN_REPAIR_TIMEOUT_MS and #402. What gates a
  // live write is the hub actually serving this room, and the tab can prove
  // that without asking the hub directly: write something, and wait for the
  // acknowledgement to come back. An ack is a message the hub only sends over
  // a connection it is still serving, and it stops in the same window live
  // delivery does.
  insertBlock(second.connection.ydoc, null, { type: "paragraph", text: "re-joined" });
  await waitFor(
    "the hub to acknowledge a write from the re-joined room",
    () => second.latest().unsyncedChanges === 0,
    REJOIN_REPAIR_TIMEOUT_MS,
  );

  await expectLiveWrite(second, hub.port, room, "after re-joining");
}, TEST_TIMEOUT_MS);

it("says it has no token, and syncs once the document supplies one", async () => {
  const hub = await startHub(0, databasePath());
  const room = `${WORKSPACE}/${randomUUID()}`;

  // A tab that loaded while its configuration document was answering with
  // nothing usable: an endpoint, and no secret.
  const tab = await openTab(room, hub.port, "");
  teardown.push(() => sharedSocket(tab.connection).destroy());

  // The reading a person gets, and it is not "synced": nothing was ever sent to
  // the hub, so what is incomplete is the deployment serving this app.
  await waitFor("the missing-token reading", () => tab.latest().tokenMissing);
  expect(tab.latest().synced).toBe(false);

  // The deployment finishes coming up. Nothing reloads and nothing re-mounts:
  // `hubToken` re-reads the document before every connect attempt, and a mint
  // it cannot make drops the socket so that the next attempt is seconds away.
  // Without that drop this took ~60s — Hocuspocus sends a token only on an
  // `open`, and its own message-reconnect needed two cycles to produce one,
  // which is a tab dead for a minute after its host came up.
  injected.secret = SECRET;
  await waitFor("the room to sync on a later attempt", () => tab.latest().synced);
  expect(tab.latest().tokenMissing).toBe(false);
}, TEST_TIMEOUT_MS);

async function admissionToken(workspace = WORKSPACE): Promise<string> {
  return wrapToken(await mintToken(await importRootSecret(SECRET), {
    typ: "room", sub: "test", workspace, scope: "read-write", kid: null,
    lifetimeSeconds: 60,
  }));
}

it("paces live name rooms below the hub ceiling, including after a reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), `room-admission-${process.env.UB_AGENTS_RUN ?? process.pid}-`));
  const hub = await createHub({
    authSecret: SECRET, port: 0, databasePath: join(dir, "hub.sqlite"),
    maxPendingDocuments: 3, log: silentLogger,
    debounce: 10, maxDebounce: 50, shutdownTimeoutMs: 2_000,
  });
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${hub.port}`, delay: 10, minDelay: 5, maxDelay: 20,
  });
  const admission = new RoomAdmission(2);
  const providers: PacedRoomProvider[] = [];
  let disconnects = 0;
  socket.on("disconnect", () => { disconnects += 1; });
  try {
    for (let index = 0; index < 8; index += 1) {
      const workspace = randomUUID();
      const doc = new Y.Doc();
      const provider = new PacedRoomProvider(admission, {
        name: settingsRoom(workspace), document: doc, websocketProvider: socket,
        token: () => admissionToken(workspace),
      });
      providers.push(provider);
      provider.attach();
      // A queued room's first frame must be the admitted token, even if its
      // document and awareness change before the async token has returned.
      setWorkspaceName(doc, `Workspace ${index}`);
      provider.awareness?.setLocalStateField("user", { name: "test" });
    }
    await expect.poll(() => providers.every((provider) => provider.isSynced), { timeout: 10_000 }).toBe(true);
    expect(disconnects).toBe(0);
    for (const [index, provider] of providers.entries()) {
      expect(getWorkspaceName(hub.hocuspocus.documents.get(provider.configuration.name)!)).toBe(`Workspace ${index}`);
    }

    socket.disconnect();
    await expect.poll(() => disconnects).toBe(1);
    await socket.connect();
    await expect.poll(() => providers.every((provider) => provider.isSynced && provider.isAuthenticated), { timeout: 10_000 }).toBe(true);
    expect(disconnects).toBe(1);
    expect(hub.hocuspocus.documents.size).toBe(8);
  } finally {
    for (const provider of providers) {
      provider.destroy();
      provider.document.destroy();
    }
    socket.destroy();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("discards a token that resolves after its socket generation ended", async () => {
  const dir = mkdtempSync(join(tmpdir(), `room-admission-${process.env.UB_AGENTS_RUN ?? process.pid}-`));
  const hub = await createHub({
    authSecret: SECRET, port: 0, databasePath: join(dir, "hub.sqlite"), log: silentLogger,
    shutdownTimeoutMs: 2_000,
  });
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${hub.port}`, delay: 10, minDelay: 5, maxDelay: 20,
  });
  let finishOld!: (value: string) => void;
  const oldToken = new Promise<string>((resolve) => { finishOld = resolve; });
  let calls = 0;
  let authFrames = 0;
  let disconnects = 0;
  const doc = new Y.Doc();
  const provider = new PacedRoomProvider(new RoomAdmission(1), {
    name: settingsRoom(WORKSPACE), document: doc, websocketProvider: socket,
    token: () => ++calls === 1 ? oldToken : admissionToken(),
  });
  provider.on("outgoingMessage", ({ message }: { message: { type: number } }) => {
    if (message.type === MessageType.Auth) authFrames += 1;
  });
  socket.on("disconnect", () => { disconnects += 1; });
  try {
    provider.attach();
    await expect.poll(() => calls).toBe(1);
    setWorkspaceName(doc, "Queued name");
    expect(authFrames).toBe(0);
    expect(hub.hocuspocus.documents.size).toBe(0);
    socket.disconnect();
    await expect.poll(() => disconnects).toBe(1);
    await socket.connect();
    await expect.poll(() => provider.isSynced, { timeout: 10_000 }).toBe(true);
    expect(authFrames).toBe(1);
    finishOld(await admissionToken());
    await oldToken;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(authFrames).toBe(1);
    expect(getWorkspaceName(hub.hocuspocus.documents.get(settingsRoom(WORKSPACE))!)).toBe("Queued name");
  } finally {
    finishOld("");
    provider.destroy();
    doc.destroy();
    socket.destroy();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
