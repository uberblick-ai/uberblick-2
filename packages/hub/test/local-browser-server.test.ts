/** The real protocol boundary `ub open` serves, over loopback and real Yjs. */

import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
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
const rawClients: Socket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const provider of providers.splice(0)) provider.destroy();
  for (const websocket of websockets.splice(0)) websocket.destroy();
  for (const server of servers.splice(0)) await server.stop();
  for (const socket of rawClients.splice(0)) socket.destroy();
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

/** Upgrade successfully without opening a Hocuspocus document. */
async function rawUpgrade(port: number, origin: string): Promise<Socket> {
  const socket = createConnection(port, "127.0.0.1");
  rawClients.push(socket);
  let response = "";
  socket.setEncoding("utf8");
  const upgraded = new Promise<Socket>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (!response.includes("\r\n\r\n")) return;
      if (!response.startsWith("HTTP/1.1 101")) {
        reject(new Error(`websocket upgrade was refused: ${response}`));
        return;
      }
      resolve(socket);
    });
  });
  socket.write(
    `GET / HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      `Origin: ${origin}\r\n\r\n`,
  );
  return await upgraded;
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
    const raw = await rawUpgrade(box.port, box.origin);
    const rawClosed = new Promise<void>((resolve) => {
      raw.once("close", () => resolve());
    });

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
    expect(raw.destroyed).toBe(true);
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
