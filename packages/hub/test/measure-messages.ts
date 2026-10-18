/**
 * Manual transport sizing: pnpm --filter @uberblick/hub exec tsx test/measure-messages.ts /path/to/workspace.sqlite
 * Read the replica in one read-only SQLite transaction, replay every persisted
 * room, then attach through a shared provider socket to an empty loopback hub.
 * Record actual encoded socket sends and wait for the hub to receive each state.
 * The source workspace and its hub are never changed or connected to.
 */
import { DatabaseSync } from "node:sqlite";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import {
  appendBlock, applyDocData, canonicalJson, DATA_LIMITS, initDoc,
  listDirectory, readDocData,
} from "@uberblick/schema";
import * as Y from "yjs";
import { MAX_MESSAGE_BYTES } from "../src/config.js";

interface RoomState { room: string; doc: Y.Doc }

function readRooms(path: string): RoomState[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("BEGIN");
    const names = database.prepare("SELECT room FROM snapshots UNION SELECT room FROM updates ORDER BY room").all();
    const snapshot = database.prepare("SELECT state, through_seq FROM snapshots WHERE room = ?");
    const tail = database.prepare("SELECT payload FROM updates WHERE room = ? AND seq > ? ORDER BY seq");
    return names.map(({ room }) => {
      if (typeof room !== "string") throw new Error("Invalid stored room");
      const doc = new Y.Doc();
      const saved = snapshot.get(room);
      if (saved?.state instanceof Uint8Array) Y.applyUpdate(doc, saved.state);
      const through = typeof saved?.through_seq === "number" ? saved.through_seq : 0;
      for (const row of tail.all(room, through)) {
        if (!(row.payload instanceof Uint8Array)) throw new Error("Invalid stored update");
        Y.applyUpdate(doc, row.payload);
      }
      return { room, doc };
    });
  } finally {
    database.close();
  }
}

function dataFixture(): RoomState {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const directory = new Y.Doc();
  const uuid = "22222222-2222-4222-8222-222222222222";
  initDoc(doc, { uuid, title: "Transport measurement" });
  const schema = { version: 1 as const, schema: { type: "object" as const } };
  const records = Array.from({ length: 64 }, (_, index) => ({
    id: String(index).padStart(2, "0"),
    value: { text: "x".repeat(DATA_LIMITS.record - 11) },
  }));
  const entries = [
    [JSON.stringify(["schema", "measurement"]), schema],
    ...records.map(({ id, value }) => [JSON.stringify(["record", "measurement", id]), value]),
  ];
  const excess = Buffer.byteLength(canonicalJson(Object.fromEntries(entries))) - DATA_LIMITS.area;
  const last = records.at(-1);
  if (last === undefined) throw new Error("Missing fixture record");
  last.value.text = last.value.text.slice(excess);
  applyDocData(doc, directory, [{ collection: "measurement", schema }]);
  for (let offset = 0; offset < records.length; offset += 15) {
    applyDocData(doc, directory, [{ collection: "measurement", upsert: records.slice(offset, offset + 15) }]);
  }
  const data = readDocData(doc);
  if (data?.bytes !== DATA_LIMITS.area || !data.valid) throw new Error("Fixture does not exactly fill the valid data budget");
  appendBlock(doc, { type: "paragraph", text: "b".repeat(4 * 1024 * 1024) });
  directory.destroy();
  return { room: `11111111-1111-4111-8111-111111111111/${uuid}`, doc };
}

async function measure(rooms: RoomState[]) {
  const server = new Server({
    port: 0, address: "127.0.0.1", stopOnSignals: false, quiet: true,
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES },
    onAuthenticate: async () => ({}),
  });
  await server.listen();
  let maximumMessageBytes = 0;
  let outboundMessages = 0;
  let outboundBytes = 0;
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${server.address.port}`, autoConnect: false,
    WebSocketPolyfill: class extends WebSocket {
      override send(data: Parameters<WebSocket["send"]>[0]) {
        const bytes = typeof data === "string" ? Buffer.byteLength(data) : data instanceof Blob ? data.size : data.byteLength;
        maximumMessageBytes = Math.max(maximumMessageBytes, bytes);
        outboundMessages++;
        outboundBytes += bytes;
        super.send(data);
      }
    },
  });
  const providers: HocuspocusProvider[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  try {
    for (let offset = 0; offset < rooms.length; offset += 8) {
      const pending = rooms.slice(offset, offset + 8).map(({ room, doc }) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Attach timed out")), 15_000);
        timers.add(timer);
        const provider = new HocuspocusProvider({
          websocketProvider: socket, name: room, document: doc, awareness: null, token: "measurement",
          onSynced({ state }) {
            if (state) { clearTimeout(timer); timers.delete(timer); resolve(); }
          },
          onAuthenticationFailed({ reason }) {
            clearTimeout(timer);
            timers.delete(timer);
            reject(new Error(reason));
          },
        });
        providers.push(provider);
        provider.attach();
      }));
      if (offset === 0) await socket.connect();
      await Promise.all(pending);
    }
    const deadline = Date.now() + 15_000;
    while (rooms.some(({ room, doc }) => {
      const received = server.hocuspocus.documents.get(room);
      return received === undefined || !Buffer.from(Y.encodeStateVector(received)).equals(Buffer.from(Y.encodeStateVector(doc)));
    })) {
      if (Date.now() > deadline) throw new Error("Hub did not receive full room states");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return {
      rooms: rooms.length,
      maximumMessageBytes,
      outboundMessages,
      outboundBytes,
      largestYjsUpdateBytes: Math.max(...rooms.map(({ doc }) => Y.encodeStateAsUpdate(doc).byteLength)),
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const provider of providers) provider.destroy();
    socket.destroy();
    await server.destroy();
  }
}

const databasePath = process.argv[2];
if (databasePath === undefined) throw new Error("Pass a workspace SQLite path; it is opened read-only");
const rooms = readRooms(databasePath);
const directory = rooms.find(({ room }) => room.endsWith("/_directory"));
const directoryDocuments = directory === undefined ? [] : listDirectory(directory.doc);
const workspace = directory?.room.slice(0, directory.room.indexOf("/"));
const persistedNames = new Set(rooms.map(({ room }) => room));
const missingDocuments = directoryDocuments.filter(({ uuid }) => !persistedNames.has(`${workspace}/${uuid}`));
if (missingDocuments.length > 0) throw new Error(`The replica lacks persisted state for ${missingDocuments.length} active documents`);
const fixture = dataFixture();
try {
  console.log(JSON.stringify({
    source: "read-only local replica, every persisted room, empty loopback Hocuspocus hub",
    directoryDocuments: directoryDocuments.length,
    activeDocumentsWithPersistedRoomState: directoryDocuments.length - missingDocuments.length,
    persistedDocumentRooms: rooms.filter(({ room }) => !room.split("/").at(-1)?.startsWith("_")).length,
    realWorkspace: await measure(rooms),
    fixture: {
      dataAreaBytes: DATA_LIMITS.area, bodyBytes: 4 * 1024 * 1024,
      ...await measure([fixture]),
    },
  }));
} finally {
  for (const { doc } of rooms) doc.destroy();
  fixture.doc.destroy();
}
