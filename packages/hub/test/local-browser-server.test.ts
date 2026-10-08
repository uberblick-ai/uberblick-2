/** The real protocol boundary `ub open` serves, over loopback and real Yjs. */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Server as NetServer } from "node:net";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { parseRoom } from "@uberblick/schema";
import {
  bridgeAwareness,
  createLocalBrowserServer,
  type LocalBrowserServer,
  STORE_BUSY_REASON,
  STORE_REFUSED_REASON,
} from "../src/local-browser-server.js";
import type { HubLogRecord } from "../src/log.js";
import type { Hub } from "../src/server.js";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "../src/protocol.js";
import { importCredentialKey, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "../src/token.js";
import {
  OTHER_WORKSPACE,
  TEXT_KEY,
  WORKSPACE,
  createClient,
  forgeToken,
  removeTempDatabases,
  startHub,
  token as hubToken,
  waitUntil,
  type TestClient,
} from "./helpers.js";

const TEST_BROWSER_KEY = "independent-local-browser-test-key";
const OTHER_BROWSER_KEY = "other-independent-local-browser-test-key";
const BROWSER_KEYS = new Map([
  [WORKSPACE, TEST_BROWSER_KEY],
  [OTHER_WORKSPACE, OTHER_BROWSER_KEY],
]);

const servers: LocalBrowserServer[] = [];
const hubs: Hub[] = [];
const clients: TestClient[] = [];
const providers: HocuspocusProvider[] = [];
const websockets: HocuspocusProviderWebsocket[] = [];
const replicaAwareness: { awareness: Awareness; doc: Y.Doc }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const provider of providers.splice(0)) provider.destroy();
  for (const websocket of websockets.splice(0)) websocket.destroy();
  for (const server of servers.splice(0)) await server.stop();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
  for (const replica of replicaAwareness.splice(0)) {
    replica.awareness.destroy();
    replica.doc.destroy();
  }
});

function browserToken(
  scope: "read-write" | "read-only" = "read-write",
  options: { workspace?: string; secret?: string } = {},
): Promise<string> {
  return hubToken(scope, { secret: TEST_BROWSER_KEY, ...options });
}

async function freePort(): Promise<number> {
  const server: NetServer = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a loopback port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function textFrom(updates: readonly Uint8Array[]): string {
  const doc = new Y.Doc();
  try {
    for (const update of updates) Y.applyUpdate(doc, update);
    return doc.getText(TEXT_KEY).toString();
  } finally {
    doc.destroy();
  }
}

function updateWithText(text: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.getText(TEXT_KEY).insert(0, text);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

async function fixture(options: {
  workspaces?: ReadonlyMap<string, string>;
  prepareRoom?: (room: string) => Promise<void>;
} = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const updates = new Map<string, Uint8Array[]>();
  const reads: { room: string; afterSeq: number }[] = [];
  const logs: HubLogRecord[] = [];
  let failure: unknown = null;
  let readFailure: unknown = null;
  const roomReadFailures = new Map<string, unknown>();
  let readAttempts = 0;
  const awarenessByRoom = new Map<string, Awareness>();
  const awarenessForRoom = (room: string): Awareness => {
    const existing = awarenessByRoom.get(room);
    if (existing !== undefined) return existing;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    replicaAwareness.push({ awareness, doc });
    awarenessByRoom.set(room, awareness);
    return awareness;
  };
  const server = await createLocalBrowserServer({
    port,
    workspaces: options.workspaces ?? new Map([[WORKSPACE, TEST_BROWSER_KEY]]),
    ...(options.prepareRoom === undefined ? {} : { prepareRoom: options.prepareRoom }),
    expectedOrigin: origin,
    log: (record) => logs.push(record),
    readRoom: (room, afterSeq) => {
      readAttempts += 1;
      reads.push({ room, afterSeq });
      if (roomReadFailures.has(room)) throw roomReadFailures.get(room);
      if (readFailure !== null) throw readFailure;
      return {
        snapshot: null,
        updates: (updates.get(room) ?? []).slice(afterSeq).map((payload, index) => ({
          seq: afterSeq + index + 1,
          payload,
        })),
      };
    },
    appendUpdate: (room, payload) => {
      if (failure !== null) throw failure;
      const stored = updates.get(room) ?? [];
      stored.push(payload);
      updates.set(room, stored);
    },
    awarenessForRoom,
    onRequest: (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("still serving\n");
    },
  });
  servers.push(server);

  const connect = async (
    room: string,
    scope: "read-write" | "read-only" = "read-write",
  ): Promise<TestClient> => {
    const client = createClient({
      port,
      room,
      token: await browserToken(scope, {
        workspace: parseRoom(room).workspaceId,
        secret: options.workspaces?.get(parseRoom(room).workspaceId) ?? TEST_BROWSER_KEY,
      }),
      origin,
      reconnectDelayMs: 60_000,
    });
    clients.push(client);
    return client;
  };

  return {
    server,
    port,
    origin,
    updates,
    awarenessForRoom,
    logs,
    storeUpdate: (room: string, payload: Uint8Array) => {
      const stored = updates.get(room) ?? [];
      stored.push(payload);
      updates.set(room, stored);
    },
    readsFor: (room: string) =>
      reads.filter((read) => read.room === room).map((read) => read.afterSeq),
    connect,
    failWith: (error: unknown) => {
      failure = error;
    },
    failReadsWith: (error: unknown) => {
      readFailure = error;
    },
    failReadsFor: (room: string, error: unknown) => {
      roomReadFailures.set(room, error);
    },
    recoverReadsFor: (room: string) => {
      roomReadFailures.delete(room);
    },
    readAttempts: () => readAttempts,
    recover: () => {
      failure = null;
    },
  };
}

function sharedSocket(box: { port: number; origin: string }) {
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${box.port}`,
    autoConnect: false,
    delay: 60_000,
    minDelay: 60_000,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string | URL) {
        super(url, { headers: { Origin: box.origin } } as unknown as string[]);
      }
    },
  });
  websockets.push(socket);
  return socket;
}

function sharedClient(socket: HocuspocusProviderWebsocket, room: string, token: string) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: room,
    token: wrapToken(token, SYNC_PROTOCOL_VERSION),
    document: doc,
  });
  providers.push(provider);
  const synced = new Promise<void>((resolve) => provider.on("synced", resolve));
  const denied = new Promise<string>((resolve) => {
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => resolve(reason));
  });
  provider.attach();
  return { provider, text: doc.getText(TEXT_KEY), synced, denied };
}

describe("the ub open browser server", () => {
  it("serves several workspaces on one socket with keys scoped to each store", async () => {
    const prepared: string[] = [];
    const box = await fixture({
      workspaces: BROWSER_KEYS,
      prepareRoom: async (room) => { prepared.push(room); },
    });
    const firstRoom = `${WORKSPACE}/${randomUUID()}`;
    const otherRoom = `${OTHER_WORKSPACE}/${randomUUID()}`;
    box.storeUpdate(firstRoom, updateWithText("first replica"));
    box.storeUpdate(otherRoom, updateWithText("other replica"));
    const socket = sharedSocket(box);
    const first = sharedClient(socket, firstRoom, await browserToken());
    const other = sharedClient(socket, otherRoom, await browserToken("read-write", {
      workspace: OTHER_WORKSPACE,
      secret: OTHER_BROWSER_KEY,
    }));
    await socket.connect();
    await Promise.all([first.synced, other.synced]);
    expect(first.text.toString()).toBe("first replica");
    expect(other.text.toString()).toBe("other replica");
    first.text.insert(first.text.length, " edited");
    other.text.insert(other.text.length, " edited");
    await waitUntil("each workspace's edit to reach its own store", () =>
      textFrom(box.updates.get(firstRoom) ?? []) === "first replica edited" &&
      textFrom(box.updates.get(otherRoom) ?? []) === "other replica edited",
    );
    const firstReads = box.readsFor(firstRoom);
    const otherReads = box.readsFor(otherRoom);
    box.failReadsFor(firstRoom, Object.assign(new Error("database is locked"), { errcode: 5 }));
    box.server.refresh(WORKSPACE);
    expect(box.readsFor(firstRoom)).toHaveLength(firstReads.length + 1);
    expect(box.readsFor(otherRoom)).toEqual(otherReads);
    box.recoverReadsFor(firstRoom);
    await waitUntil("a scoped replay to retry its own workspace", () =>
      box.readsFor(firstRoom).length > firstReads.length + 1,
    );
    expect(box.readsFor(otherRoom)).toEqual(otherReads);

    const unservedWorkspace = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const attacks = [
      {
        room: `${OTHER_WORKSPACE}/${randomUUID()}`,
        token: await browserToken("read-write", { workspace: OTHER_WORKSPACE }),
        reason: "invalid-token",
      },
      {
        room: `${WORKSPACE}/${randomUUID()}`,
        token: await browserToken("read-write", { secret: OTHER_BROWSER_KEY }),
        reason: "invalid-token",
      },
      {
        room: `${WORKSPACE}/${randomUUID()}`,
        token: await browserToken("read-write", { workspace: OTHER_WORKSPACE }),
        reason: "workspace-mismatch",
      },
      {
        room: `${unservedWorkspace}/${randomUUID()}`,
        token: await browserToken("read-write", { workspace: unservedWorkspace }),
        reason: "workspace-mismatch",
      },
      {
        room: `${WORKSPACE}/${randomUUID()}`,
        token: await forgeToken({
          typ: "room", sub: "forged", workspace: WORKSPACE,
          scope: "admin", kid: null, iat: now, exp: now + 60,
        }, TEST_BROWSER_KEY),
        reason: "invalid-token",
      },
    ];
    for (const attack of attacks) {
      const refused = sharedClient(socket, attack.room, attack.token);
      await expect(refused.denied).resolves.toBe(attack.reason);
      expect(box.readsFor(attack.room)).toEqual([]);
      expect(prepared).not.toContain(attack.room);
      refused.provider.destroy();
    }
    first.text.insert(first.text.length, " after refusals");
    await waitUntil("the shared socket to remain writable after denials", () =>
      textFrom(box.updates.get(firstRoom) ?? []) === "first replica edited after refusals",
    );
  });

  it("contains failed replica preparation, loading and refresh to their rooms", async () => {
    const failedRoom = `${OTHER_WORKSPACE}/${randomUUID()}`;
    let otherUnavailable = false;
    const box = await fixture({
      workspaces: BROWSER_KEYS,
      prepareRoom: async (room) => {
        if (room === failedRoom || (otherUnavailable && parseRoom(room).workspaceId === OTHER_WORKSPACE)) {
          throw new Error("replica held by another server");
        }
      },
    });
    const socket = sharedSocket(box);
    const healthyRoom = `${WORKSPACE}/${randomUUID()}`;
    const healthy = sharedClient(socket, healthyRoom, await browserToken());
    const otherToken = await browserToken("read-write", {
      workspace: OTHER_WORKSPACE, secret: OTHER_BROWSER_KEY,
    });
    const failed = sharedClient(socket, failedRoom, otherToken);
    await socket.connect();
    await Promise.all([healthy.synced, expect(failed.denied).resolves.toBe(STORE_REFUSED_REASON)]);
    expect(box.readsFor(failedRoom)).toEqual([]);
    failed.provider.destroy();

    const loadFailedRoom = `${OTHER_WORKSPACE}/${randomUUID()}`;
    box.failReadsFor(loadFailedRoom, new Error("replica quarantined"));
    const loadFailed = sharedClient(socket, loadFailedRoom, otherToken);
    await expect(loadFailed.denied).resolves.toBe(STORE_REFUSED_REASON);
    loadFailed.provider.destroy();

    const loadedRoom = `${OTHER_WORKSPACE}/${randomUUID()}`;
    const loaded = sharedClient(socket, loadedRoom, otherToken);
    await loaded.synced;
    otherUnavailable = true;
    const lateTab = await box.connect(loadedRoom);
    await expect(lateTab.denied).resolves.toBe(STORE_REFUSED_REASON);
    const closed = new Promise<string>((resolve) => {
      loaded.provider.on("close", ({ event }: { event: CloseEvent }) => resolve(event.reason));
    });
    box.failReadsFor(loadedRoom, new Error("replica failed after admission"));
    const loadedReads = box.readsFor(loadedRoom);
    box.server.refresh(WORKSPACE);
    expect(box.readsFor(loadedRoom)).toEqual(loadedReads);
    box.server.refresh(OTHER_WORKSPACE);
    await expect(closed).resolves.toBe(STORE_REFUSED_REASON);
    loaded.provider.destroy();

    healthy.text.insert(0, "unrelated replica survived");
    await waitUntil("the healthy workspace on the same socket to remain writable", () =>
      textFrom(box.updates.get(healthyRoom) ?? []) === "unrelated replica survived",
    );
    expect(await (await fetch(`http://127.0.0.1:${box.port}/`)).text()).toBe("still serving\n");
  });

  it("admits its independent browser key and refuses hub and device keys", async () => {
    const box = await fixture();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const writer = await box.connect(room);
    await writer.synced;

    const deviceToken = await mintToken(await importCredentialKey(randomBytes(32)), {
      typ: "room",
      sub: "device-client",
      workspace: WORKSPACE,
      scope: "read-write",
      kid: randomUUID(),
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    });
    for (const presented of [await hubToken(), deviceToken]) {
      const refused = createClient({
        port: box.port,
        room,
        token: presented,
        origin: box.origin,
        reconnectDelayMs: 60_000,
      });
      clients.push(refused);
      await expect(refused.denied).resolves.toBe("invalid-token");
    }

    const hub = await startHub();
    hubs.push(hub);
    const refusedByHub = createClient({
      port: hub.port,
      room,
      token: await browserToken(),
      reconnectDelayMs: 60_000,
    });
    clients.push(refusedByHub);
    await expect(refusedByHub.denied).resolves.toBe("invalid-token");
  });

  it("hydrates from the log and commits the raw update before acknowledging it", async () => {
    const box = await fixture();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const writer = await box.connect(room);
    await writer.synced;
    expect(box.updates.get(room)).toBeUndefined(); // empty SyncStep2 is skipped

    let authored: Uint8Array | null = null;
    writer.doc.once("update", (update: Uint8Array) => {
      authored = update;
    });
    writer.text.insert(0, "durable before ack");
    await waitUntil("the browser update to be acknowledged", () =>
      !writer.provider.hasUnsyncedChanges,
    );

    const stored = box.updates.get(room) ?? [];
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0] ?? []).equals(Buffer.from(authored ?? []))).toBe(true);
    expect(textFrom(stored)).toBe("durable before ack");

    const reload = await box.connect(room);
    await reload.synced;
    expect(reload.text.toString()).toBe("durable before ack");
  });

  it("relays room awareness both ways without echoing served clients", async () => {
    const box = await fixture();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const replica = box.awarenessForRoom(room);
    const agentDoc = new Y.Doc();
    const agent = new Awareness(agentDoc);
    replicaAwareness.push({ awareness: agent, doc: agentDoc });
    agent.setLocalState({
      user: { name: "agent", color: "#abcdef" },
      client: "agent",
      cursor: { blockId: "block-1", anchor: 1, head: 1 },
    });
    applyAwarenessUpdate(
      replica,
      encodeAwarenessUpdate(agent, [agent.clientID]),
      "hub-relay",
    );

    const first = await box.connect(room);
    await first.synced;
    await waitUntil("the first tab to receive existing upstream presence", () =>
      first.provider.awareness?.getStates().has(agent.clientID) === true,
    );
    const second = await box.connect(room);
    await second.synced;

    first.provider.setAwarenessField("user", {
      name: "first tab",
      color: "#112233",
    });
    first.provider.setAwarenessField("client", "web");
    second.provider.setAwarenessField("user", {
      name: "second tab",
      color: "#445566",
    });
    second.provider.setAwarenessField("client", "web");

    const firstId = first.provider.awareness?.clientID;
    const secondId = second.provider.awareness?.clientID;
    if (firstId === undefined || secondId === undefined) {
      throw new Error("the served providers have no awareness");
    }
    await waitUntil("both tab states to reach the replica", () =>
      [firstId, secondId].every((client) => replica.getStates().has(client)),
    );

    await waitUntil("the relayed agent to reach both tabs", () =>
      [first, second].every(
        (client) =>
          [...(client.provider.awareness?.getStates().values() ?? [])].filter(
            (state) => state.client === "agent",
          ).length === 1,
      ),
    );
    expect(
      [...replica.getStates().values()].filter((state) => state.client === "web"),
    ).toHaveLength(2);

    // An upstream close clears remote states from the replica. A served tab is
    // one of those states, but must not be played back into its own room as a
    // removal: the other local tab keeps seeing it without a cursor flicker.
    // The relay is synchronous, so a removal played back into the room would
    // reach both tabs ahead of an agent move relayed right after it: the move
    // arriving is the barrier, where a tab's own heartbeat would re-add it.
    removeAwarenessStates(replica, [firstId, secondId], "upstream-close");
    agent.setLocalStateField("cursor", { blockId: "block-1", anchor: 3, head: 3 });
    applyAwarenessUpdate(
      replica,
      encodeAwarenessUpdate(agent, [agent.clientID]),
      "hub-relay",
    );
    await waitUntil("the agent's move to reach both tabs", () =>
      [first, second].every(
        (client) =>
          client.provider.awareness?.getStates().get(agent.clientID)?.cursor?.anchor === 3,
      ),
    );
    expect(second.provider.awareness?.getStates().has(firstId)).toBe(true);
    expect(first.provider.awareness?.getStates().has(secondId)).toBe(true);
    first.provider.setAwarenessField("heartbeat", 1);
    second.provider.setAwarenessField("heartbeat", 1);
    await waitUntil("the tabs' renewals to return to the replica", () =>
      [firstId, secondId].every((client) => replica.getStates().has(client)),
    );

    removeAwarenessStates(replica, [agent.clientID], "hub-ended");
    await waitUntil("the ended agent to leave both tabs", () =>
      [first, second].every(
        (client) => !client.provider.awareness?.getStates().has(agent.clientID),
      ),
    );
    expect(first.provider.awareness?.getStates().has(secondId)).toBe(true);
    expect(second.provider.awareness?.getStates().has(firstId)).toBe(true);

    agent.setLocalStateField("cursor", null);
    agent.setLocalStateField("cursor", {
      blockId: "block-2",
      anchor: 2,
      head: 2,
    });
    applyAwarenessUpdate(
      replica,
      encodeAwarenessUpdate(agent, [agent.clientID]),
      "hub-returned",
    );
    await waitUntil("the returned agent to reach both tabs", () =>
      [first, second].every(
        (client) => client.provider.awareness?.getStates().has(agent.clientID) === true,
      ),
    );

    first.destroy();
    await waitUntil("the departed tab to leave the local room and replica", () =>
      !replica.getStates().has(firstId) &&
      second.provider.awareness?.getStates().has(firstId) === false,
    );
  });

  it("does not let a served-side timeout claim an upstream client", async () => {
    const servedDoc = new Y.Doc();
    const replicaDoc = new Y.Doc();
    const agentDoc = new Y.Doc();
    const served = new Awareness(servedDoc);
    const replica = new Awareness(replicaDoc);
    const agent = new Awareness(agentDoc);
    const detach = bridgeAwareness(served, replica);
    try {
      agent.setLocalState({ client: "agent", heartbeat: 0 });
      applyAwarenessUpdate(
        replica,
        encodeAwarenessUpdate(agent, [agent.clientID]),
        "hub-relay",
      );
      expect(served.getStates().has(agent.clientID)).toBe(true);

      // Exercise the removal a resumed y-protocols timeout emits directly,
      // without waiting for its 30-second timer.
      removeAwarenessStates(served, [agent.clientID], "timeout");
      expect(replica.getStates().has(agent.clientID)).toBe(false);
      agent.setLocalStateField("heartbeat", 1);
      applyAwarenessUpdate(
        replica,
        encodeAwarenessUpdate(agent, [agent.clientID]),
        "hub-renewal",
      );
      expect(served.getStates().has(agent.clientID)).toBe(true);
    } finally {
      detach();
      served.destroy();
      replica.destroy();
      agent.destroy();
      servedDoc.destroy();
      replicaDoc.destroy();
      agentDoc.destroy();
    }
  });

  it("replays only the unseen store tail into every connected tab", async () => {
    const box = await fixture();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const writer = await box.connect(room);
    const observer = await box.connect(room);
    await Promise.all([writer.synced, observer.synced]);

    let observedUpdates = 0;
    observer.doc.on("update", () => {
      observedUpdates += 1;
    });
    writer.text.insert(0, "browser");
    await waitUntil("the browser update to reach the other tab", () =>
      observer.text.toString() === "browser",
    );
    expect(box.updates.get(room)).toHaveLength(1);
    expect(observedUpdates).toBe(1);

    // Replaying the gate's own row is a Yjs no-op: no second document update,
    // broadcast or store row is produced.
    box.server.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedUpdates).toBe(1);
    expect(box.updates.get(room)).toHaveLength(1);

    const external = new Y.Doc();
    try {
      for (const update of box.updates.get(room) ?? []) {
        Y.applyUpdate(external, update);
      }
      let appended: Uint8Array | null = null;
      external.once("update", (update: Uint8Array) => {
        appended = update;
      });
      external.getText(TEXT_KEY).insert(external.getText(TEXT_KEY).length, " + agent");
      if (appended === null) throw new Error("the external edit produced no update");
      box.storeUpdate(room, appended);
    } finally {
      external.destroy();
    }

    box.server.refresh();
    await waitUntil("the external store update to reach every tab", () =>
      writer.text.toString() === "browser + agent" &&
      observer.text.toString() === "browser + agent",
    );
    expect(observedUpdates).toBe(2);

    box.server.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedUpdates).toBe(2);
    expect(box.updates.get(room)).toHaveLength(2);
    expect(box.readsFor(room)).toEqual([0, 0, 1, 2]);
  });

  it("retries a refused room while replaying later rooms", async () => {
    const box = await fixture();
    const refusedRoom = `${WORKSPACE}/${randomUUID()}`;
    const laterRoom = `${WORKSPACE}/${randomUUID()}`;
    const refused = await box.connect(refusedRoom);
    await refused.synced;
    const later = await box.connect(laterRoom);
    await later.synced;

    box.storeUpdate(refusedRoom, updateWithText("retried"));
    box.storeUpdate(laterRoom, updateWithText("not starved"));
    box.failReadsFor(
      refusedRoom,
      Object.assign(new Error("database is locked"), { errcode: 5 }),
    );

    box.server.refresh();
    await waitUntil("the later room to replay despite the refusal", () =>
      later.text.toString() === "not starved",
    );
    box.recoverReadsFor(refusedRoom);
    await waitUntil("the refused room to replay without another append", () =>
      refused.text.toString() === "retried",
    );
    expect(box.logs).toContainEqual({
      event: "ub-open.store.refused",
      room: refusedRoom,
      cause: STORE_BUSY_REASON,
      error: "Error: database is locked",
    });
  });

  it("names busy and failed appends, stores no refused update, and recovers per room", async () => {
    const box = await fixture();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const observer = await box.connect(room);
    await observer.synced;

    const socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${box.port}`,
      autoConnect: false,
      delay: 60_000,
      minDelay: 60_000,
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string | URL) {
          super(url, { headers: { Origin: box.origin } } as unknown as string[]);
        }
      },
    });
    websockets.push(socket);
    const busyDoc = new Y.Doc();
    const survivorDoc = new Y.Doc();
    const survivorRoom = `${WORKSPACE}/${randomUUID()}`;
    const busy = new HocuspocusProvider({
      websocketProvider: socket,
      name: room,
      token: wrapToken(await browserToken(), SYNC_PROTOCOL_VERSION),
      document: busyDoc,
    });
    const survivor = new HocuspocusProvider({
      websocketProvider: socket,
      name: survivorRoom,
      token: wrapToken(await browserToken(), SYNC_PROTOCOL_VERSION),
      document: survivorDoc,
    });
    providers.push(busy, survivor);
    const synced = Promise.all([
      new Promise<void>((resolve) => busy.on("synced", resolve)),
      new Promise<void>((resolve) => survivor.on("synced", resolve)),
    ]);
    busy.attach();
    survivor.attach();
    await socket.connect();
    await synced;
    const busyClosed = new Promise<string>((resolve) => {
      busy.on("close", ({ event }: { event: CloseEvent }) => {
        resolve(event.reason);
      });
    });
    box.failWith(Object.assign(new Error("database is locked"), { errcode: 5 }));
    busyDoc.getText(TEXT_KEY).insert(0, "refused");
    await expect(busyClosed).resolves.toBe(STORE_BUSY_REASON);
    busy.destroy();
    expect(box.updates.get(room)).toBeUndefined();
    expect(observer.text.toString()).toBe("");

    box.recover();
    survivorDoc.getText(TEXT_KEY).insert(0, "other room survived");
    await waitUntil(
      "the other room on the shared socket to remain writable",
      () => textFrom(box.updates.get(survivorRoom) ?? []) === "other room survived",
    );
    const recovered = await box.connect(room);
    await recovered.synced;
    recovered.text.insert(0, "accepted");
    await waitUntil("the later tab's write to flow", () =>
      observer.text.toString() === "accepted",
    );
    expect(textFrom(box.updates.get(room) ?? [])).toBe("accepted");

    const failedRoom = `${WORKSPACE}/${randomUUID()}`;
    const failed = await box.connect(failedRoom);
    await failed.synced;
    const failedClosed = new Promise<string>((resolve) => {
      failed.provider.on("close", ({ event }: { event: CloseEvent }) => {
        resolve(event.reason);
      });
    });
    box.failWith(new Error("simulated disk refusal"));
    failed.text.insert(0, "not durable");
    await expect(failedClosed).resolves.toBe(STORE_REFUSED_REASON);
    expect(box.updates.get(failedRoom)).toBeUndefined();

    box.recover();
    const malformedRoom = `${WORKSPACE}/${randomUUID()}`;
    const malformed = await box.connect(malformedRoom);
    await malformed.synced;
    const malformedClosed = new Promise<string>((resolve) => {
      malformed.provider.on("close", ({ event }: { event: CloseEvent }) => {
        resolve(event.reason);
      });
    });
    malformed.provider.documentUpdateHandler(Uint8Array.of(0xff), null);
    await expect(malformedClosed).resolves.toBe(STORE_REFUSED_REASON);
    expect(box.updates.get(malformedRoom)).toBeUndefined();
  });

  it("closes every accepted upgraded socket on stop, including a refused room load", async () => {
    const box = await fixture();
    const raw = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${box.port}`,
      autoConnect: false,
      delay: 60_000,
      minDelay: 60_000,
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string | URL) {
          super(url, { headers: { Origin: box.origin } } as unknown as string[]);
        }
      },
    });
    websockets.push(raw);
    const rawOpened = new Promise<void>((resolve) => raw.on("open", () => resolve()));
    const rawClosed = new Promise<void>((resolve) => {
      raw.on("close", () => resolve());
    });
    raw.connect();
    await rawOpened;

    box.failReadsWith(Object.assign(new Error("database is locked"), { errcode: 5 }));
    const readsBefore = box.readAttempts();
    const refused = await box.connect(`${WORKSPACE}/${randomUUID()}`);
    const refusedClosed = new Promise<void>((resolve) => {
      refused.provider.on("close", () => resolve());
    });
    await waitUntil(
      "the refused room load to reach the store",
      () => box.readAttempts() > readsBefore,
    );

    await box.server.stop();
    await expect(Promise.all([rawClosed, refusedClosed])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("enforces read-only and the served workspace, and rejects a foreign Origin without throwing", async () => {
    const box = await fixture();
    const room = `${WORKSPACE}/${randomUUID()}`;
    const writer = await box.connect(room);
    const reader = await box.connect(room, "read-only");
    await Promise.all([writer.synced, reader.synced]);

    reader.text.insert(0, "not writable");
    reader.provider.setAwarenessField("proof", "processed after the write");
    await waitUntil("the read-only client's later frame to be processed", () =>
      [...(writer.provider.awareness?.getStates().values() ?? [])].some(
        (state) => state.proof === "processed after the write",
      ),
    );
    expect(box.updates.get(room)).toBeUndefined();
    expect(writer.text.toString()).toBe("");

    const foreignClaim = createClient({
      port: box.port,
      room,
      token: await browserToken("read-write", { workspace: OTHER_WORKSPACE }),
      origin: box.origin,
      reconnectDelayMs: 60_000,
    });
    clients.push(foreignClaim);
    await expect(foreignClaim.denied).resolves.toBe("workspace-mismatch");

    // Token and room agree with each other, so only this server's one-store
    // boundary can refuse the otherwise valid foreign workspace.
    const foreignStore = createClient({
      port: box.port,
      room: `${OTHER_WORKSPACE}/${randomUUID()}`,
      token: await browserToken("read-write", { workspace: OTHER_WORKSPACE }),
      origin: box.origin,
      reconnectDelayMs: 60_000,
    });
    clients.push(foreignStore);
    await expect(foreignStore.denied).resolves.toBe("workspace-mismatch");

    const valid = wrapToken(await browserToken(), SYNC_PROTOCOL_VERSION);
    let originRejected!: () => void;
    const rejectedOrigin = new Promise<void>((resolve) => {
      originRejected = resolve;
    });
    const wrongOrigin = new HocuspocusProvider({
      url: `ws://127.0.0.1:${box.port}`,
      name: `${WORKSPACE}/${randomUUID()}`,
      token: valid,
      document: new Y.Doc(),
      onClose: originRejected,
      ...{
        // The provider forwards this runtime websocket option although its
        // document-level public type omits it.
        WebSocketPolyfill: class extends WebSocket {
          constructor(url: string | URL) {
            super(url, {
              headers: { Origin: "http://not-this-ub-open.invalid" },
            } as unknown as string[]);
          }
        },
      },
    });
    providers.push(wrongOrigin);
    await rejectedOrigin;

    expect(await (await fetch(`http://127.0.0.1:${box.port}/`)).text()).toBe(
      "still serving\n",
    );
  });
});
