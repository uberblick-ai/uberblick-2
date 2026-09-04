/** The real protocol boundary `ub open` serves, over loopback and real Yjs. */

import { randomUUID } from "node:crypto";
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
import {
  createLocalBrowserServer,
  type LocalBrowserServer,
  STORE_BUSY_REASON,
  STORE_REFUSED_REASON,
} from "../src/local-browser-server.js";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "../src/protocol.js";
import {
  OTHER_WORKSPACE,
  TEST_SECRET,
  TEXT_KEY,
  WORKSPACE,
  createClient,
  token,
  waitUntil,
  type TestClient,
} from "./helpers.js";

const servers: LocalBrowserServer[] = [];
const clients: TestClient[] = [];
const providers: HocuspocusProvider[] = [];
const websockets: HocuspocusProviderWebsocket[] = [];
const replicaAwareness: { awareness: Awareness; doc: Y.Doc }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const provider of providers.splice(0)) provider.destroy();
  for (const websocket of websockets.splice(0)) websocket.destroy();
  for (const server of servers.splice(0)) await server.stop();
  for (const replica of replicaAwareness.splice(0)) {
    replica.awareness.destroy();
    replica.doc.destroy();
  }
});

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

async function fixture() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const updates = new Map<string, Uint8Array[]>();
  let failure: unknown = null;
  let readFailure: unknown = null;
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
    workspaceId: WORKSPACE,
    authSecret: TEST_SECRET,
    expectedOrigin: origin,
    log: () => {},
    readRoom: (room) => {
      readAttempts += 1;
      if (readFailure !== null) throw readFailure;
      return {
        snapshot: null,
        updates: (updates.get(room) ?? []).map((payload, index) => ({
          seq: index + 1,
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
      token: await token(scope),
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
    connect,
    failWith: (error: unknown) => {
      failure = error;
    },
    failReadsWith: (error: unknown) => {
      readFailure = error;
    },
    readAttempts: () => readAttempts,
    recover: () => {
      failure = null;
    },
  };
}

describe("the ub open browser server", () => {
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
    const first = await box.connect(room);
    const second = await box.connect(room);
    await Promise.all([first.synced, second.synced]);

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

    const replica = box.awarenessForRoom(room);
    const firstId = first.provider.awareness?.clientID;
    const secondId = second.provider.awareness?.clientID;
    if (firstId === undefined || secondId === undefined) {
      throw new Error("the served providers have no awareness");
    }
    await waitUntil("both tab states to reach the replica", () =>
      [firstId, secondId].every((client) => replica.getStates().has(client)),
    );

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
    removeAwarenessStates(replica, [firstId], "upstream-close");
    expect(second.provider.awareness?.getStates().has(firstId)).toBe(true);
    first.provider.setAwarenessField("heartbeat", 1);
    await waitUntil("the tab's renewal to return to the replica", () =>
      replica.getStates().has(firstId),
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
      token: wrapToken(await token(), SYNC_PROTOCOL_VERSION),
      document: busyDoc,
    });
    const survivor = new HocuspocusProvider({
      websocketProvider: socket,
      name: survivorRoom,
      token: wrapToken(await token(), SYNC_PROTOCOL_VERSION),
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

  it("reuses hub auth, enforces read-only, and rejects a foreign Origin without throwing", async () => {
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
      token: await token("read-write", { workspace: OTHER_WORKSPACE }),
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
      token: await token("read-write", { workspace: OTHER_WORKSPACE }),
      origin: box.origin,
      reconnectDelayMs: 60_000,
    });
    clients.push(foreignStore);
    await expect(foreignStore.denied).resolves.toBe("workspace-mismatch");

    const valid = wrapToken(await token(), SYNC_PROTOCOL_VERSION);
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
