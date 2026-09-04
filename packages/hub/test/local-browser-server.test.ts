/** The real protocol boundary `ub open` serves, over loopback and real Yjs. */

import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Server as NetServer } from "node:net";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createLocalBrowserServer,
  type LocalBrowserServer,
  STORE_BUSY_REASON,
  STORE_REFUSED_REASON,
} from "../src/local-browser-server.js";
import type { HubLogRecord } from "../src/log.js";
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

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const provider of providers.splice(0)) provider.destroy();
  for (const websocket of websockets.splice(0)) websocket.destroy();
  for (const server of servers.splice(0)) await server.stop();
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

function updateWithText(text: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.getText(TEXT_KEY).insert(0, text);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

async function fixture() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const updates = new Map<string, Uint8Array[]>();
  const reads: { room: string; afterSeq: number }[] = [];
  const logs: HubLogRecord[] = [];
  let failure: unknown = null;
  let readFailure: unknown = null;
  const roomReadFailures = new Map<string, unknown>();
  let readAttempts = 0;
  const server = await createLocalBrowserServer({
    port,
    workspaceId: WORKSPACE,
    authSecret: TEST_SECRET,
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
