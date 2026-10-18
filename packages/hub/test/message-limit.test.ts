import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/schema/protocol";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { MAX_MESSAGE_BYTES } from "../src/config.js";
import type { HubLogRecord } from "../src/log.js";
import type { Hub } from "../src/server.js";
import {
  createClient,
  removeTempDatabases,
  startHub,
  testRoom,
  token,
  waitUntil,
  type TestClient,
} from "./helpers.js";

const hubs: Hub[] = [];
const clients: TestClient[] = [];
const providers: HocuspocusProvider[] = [];
const websockets: HocuspocusProviderWebsocket[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const websocket of websockets.splice(0)) websocket.destroy();
  for (const client of clients.splice(0)) client.destroy();
  for (const socket of sockets.splice(0)) socket.close();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

it("syncs a message just below the ceiling and isolates an unauthenticated oversize sender", async () => {
  const records: HubLogRecord[] = [];
  const hub = await startHub({ log: record => records.push(record) });
  hubs.push(hub);
  const room = testRoom();
  const doc = new Y.Doc();
  const sent: number[] = [];
  const websocket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${hub.port}`,
    autoConnect: false,
    WebSocketPolyfill: class extends WebSocket {
      override send(data: Parameters<WebSocket["send"]>[0]): void {
        if (data instanceof Uint8Array) sent.push(data.byteLength);
        super.send(data);
      }
    },
  });
  websockets.push(websocket);
  const provider = new HocuspocusProvider({
    websocketProvider: websocket,
    name: room,
    document: doc,
    awareness: null,
    token: wrapToken(await token(), SYNC_PROTOCOL_VERSION),
  });
  providers.push(provider);
  provider.attach();
  await websocket.connect();
  await waitUntil("initial authenticated sync", () => provider.isSynced);

  // Leave only framing headroom: the observed wire message must sit within
  // 128 bytes of the real production ceiling, rather than a test override.
  doc.getText("body").insert(0, "x".repeat(MAX_MESSAGE_BYTES - 128));
  await waitUntil("near-limit message acknowledgement", () => !provider.hasUnsyncedChanges);
  const largest = Math.max(...sent);
  expect(largest).toBeGreaterThan(MAX_MESSAGE_BYTES - 128);
  expect(largest).toBeLessThan(MAX_MESSAGE_BYTES);
  expect(hub.hocuspocus.documents.get(room)?.getText("body").length)
    .toBe(MAX_MESSAGE_BYTES - 128);

  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}`);
  sockets.push(socket);
  socket.addEventListener("error", () => {});
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", event => resolve(event.code), { once: true });
  });
  await new Promise<void>(resolve => socket.addEventListener("open", () => resolve(), { once: true }));
  socket.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
  expect(await closed).toBe(1009);
  expect(records.some(record => record.event === "hub.hocuspocus.error" &&
    String(record.message).includes("Max payload size exceeded"))).toBe(true);

  // The already-connected peer still writes, and a fresh peer still attaches.
  doc.getText("after").insert(0, "still serving");
  await waitUntil("healthy peer acknowledgement", () => !provider.hasUnsyncedChanges);
  expect(hub.hocuspocus.documents.get(room)?.getText("after").toString()).toBe("still serving");
  const fresh = createClient({ port: hub.port, room: testRoom(), token: await token() });
  clients.push(fresh);
  await fresh.synced;
});
