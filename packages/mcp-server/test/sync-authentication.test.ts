import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { MessageType } from "@hocuspocus/provider";
import {
  appendBlock, applyDocData, createAnnotation, getBlocks, getMeta,
  initDoc, isDirectoryEntryDeleted, listAnnotations, readDocData, setTitle,
} from "@uberblick/schema";
import { afterEach, expect, it } from "vitest";
import { writeSyncStep1, writeSyncStep2, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import {
  cleanupTestResources, hubUrl, startServer, testConfig, TEST_SECRET, trackListener, waitUntil,
  type Rig,
} from "./helpers.js";

// Use the pinned transport's dependencies, matching the bytes its receiver reads.
const providerRequire = createRequire(createRequire(import.meta.url).resolve("@hocuspocus/provider"));
type Encoder = Parameters<typeof writeSyncStep1>[0];
const encoding = providerRequire("lib0/encoding") as {
  createEncoder(): Encoder;
  writeVarUint(encoder: Encoder, value: number): void;
  writeVarString(encoder: Encoder, value: string): void;
  toUint8Array(encoder: Encoder): Uint8Array;
};
const decoding = providerRequire("lib0/decoding") as {
  createDecoder(data: Uint8Array): object;
  readVarString(decoder: object): string;
  readVarUint(decoder: object): number;
};
const { AuthMessageType } = providerRequire("@hocuspocus/common") as {
  AuthMessageType: { Authenticated: number; PermissionDenied: number };
};

interface WireSocket {
  send(data: Uint8Array): void;
  ping(): void;
  close(code: number, reason: string): void;
}
const hubRequire = createRequire(createRequire(import.meta.url).resolve("@uberblick/hub"));
const serverRequire = createRequire(hubRequire.resolve("@hocuspocus/server"));

type Frame = { room: string; type: number };
const workspaces: WorkspaceReplicaSet[] = [];
const rigs: Rig[] = [];
const endpoints: (() => Promise<void>)[] = [];
const documents: Y.Doc[] = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: [
      ...rigs.splice(0).map(rig => () => rig.close()),
      ...workspaces.splice(0).map(workspace => () => workspace.close()),
    ],
    hubs: endpoints.splice(0),
    after: documents.splice(0).map(doc => () => doc.destroy()),
  });
});

function frame(room: string, type: number, body: (encoder: Encoder) => void = () => {}): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, room);
  encoding.writeVarUint(encoder, type);
  body(encoder);
  return encoding.toUint8Array(encoder);
}

async function endpoint() {
  const { default: nodeAdapter } = await import(/* @vite-ignore */ pathToFileURL(serverRequire.resolve("crossws/adapters/node")).href) as {
    default(options: {
      idleTimeout: number;
      hooks: {
        open(socket: WireSocket): void;
        message(socket: WireSocket, message: { uint8Array(): Uint8Array }): void;
        pong(socket: WireSocket): void;
      };
    }): {
      handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
      closeAll(code: number, reason: string, force: boolean): void;
    };
  };
  const server = createServer();
  const tracked = trackListener(server);
  const sockets: WireSocket[] = [];
  const received = new Map<WireSocket, Frame[]>();
  const pongs = new Map<WireSocket, () => void>();
  const adapter = nodeAdapter({ idleTimeout: 0, hooks: {
    open(socket) { sockets.push(socket); received.set(socket, []); },
    message(socket, message) {
      const data = message.uint8Array();
      const decoder = decoding.createDecoder(data);
      received.get(socket)!.push({ room: decoding.readVarString(decoder), type: decoding.readVarUint(decoder) });
    },
    pong(socket) { pongs.get(socket)?.(); pongs.delete(socket); },
  } });
  server.on("upgrade", (request, socket, head) => {
    void adapter.handleUpgrade(request, socket, head);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoints.push(async () => {
    adapter.closeAll(1001, "test cleanup", true);
    await tracked.close();
  });
  return {
    port: (server.address() as { port: number }).port,
    sockets,
    frames: (socket: WireSocket, room: string) => received.get(socket)!.filter(value => value.room === room),
    async authenticated(socket: WireSocket, room: string) {
      socket.send(frame(room, MessageType.Auth, encoder => {
        encoding.writeVarUint(encoder, AuthMessageType.Authenticated);
        encoding.writeVarString(encoder, "read-write");
      }));
      await waitUntil("the authenticated room's sync handshake", () =>
        received.get(socket)!.some(value => value.room === room && value.type === MessageType.Sync),
      );
    },
    refused(socket: WireSocket, room: string) {
      socket.send(frame(room, MessageType.Auth, encoder => {
        encoding.writeVarUint(encoder, AuthMessageType.PermissionDenied);
        encoding.writeVarString(encoder, "uberblick:doc-deleted");
      }));
    },
    async roundTrip(socket: WireSocket) {
      let returned = false;
      pongs.set(socket, () => { returned = true; });
      socket.ping();
      await waitUntil("the raw endpoint's socket round trip", () => returned);
      await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}

function workspace(port: number) {
  const opened = openWorkspaceReplicas(testConfig({ hubUrl: hubUrl(port), authSecret: TEST_SECRET }));
  workspaces.push(opened);
  return opened;
}

function seed(workspace: WorkspaceReplicaSet, title = "Retained offline title") {
  const uuid = randomUUID();
  const replica = workspace.replicas.replica(uuid);
  initDoc(replica.doc, { uuid, title });
  const block = appendBlock(replica.doc, { type: "paragraph", text: "Private local content" });
  createAnnotation(replica.doc, block, 0, 7, "agent", "Private local comment");
  applyDocData(replica.doc, workspace.replicas.directory().doc, [{
    collection: "private", schema: { version: 1, schema: { type: "object", properties: { secret: { type: "string" } }, additionalProperties: false } },
    upsert: [{ id: "one", value: { secret: "local data" } }],
  }]);
  workspace.store.compact(replica.room, Y.encodeStateAsUpdate(replica.doc), replica.lastSeq);
  setTitle(replica.doc, `${title} with pending edit`);
  return { uuid, replica, state: Y.encodeStateAsUpdate(replica.doc) };
}

it("does not apply or answer inbound sync until that room authenticates on the current socket", async () => {
  const peer = await endpoint();
  const opened = workspace(peer.port);
  const target = seed(opened);
  const healthy = seed(opened, "Healthy room");
  await waitUntil("both room auth frames", () => peer.sockets.length === 1 &&
    peer.frames(peer.sockets[0]!, target.replica.room).some(value => value.type === MessageType.Auth) &&
    peer.frames(peer.sockets[0]!, healthy.replica.room).some(value => value.type === MessageType.Auth));
  const socket = peer.sockets[0]!;
  const malicious = new Y.Doc();
  const empty = new Y.Doc();
  documents.push(malicious, empty);
  malicious.getMap("injected").set("value", "untrusted content");
  const before = opened.store.readSince(target.replica.room, 0);
  socket.send(frame(target.replica.room, MessageType.Sync, encoder => writeSyncStep1(encoder, empty)));
  socket.send(frame(target.replica.room, MessageType.Sync, encoder => writeSyncStep2(encoder, malicious)));
  malicious.getMap("injected").set("later", "untrusted update");
  socket.send(frame(target.replica.room, MessageType.Sync, encoder => writeUpdate(encoder, Y.encodeStateAsUpdate(malicious))));
  socket.send(frame(target.replica.room, MessageType.QueryAwareness));
  target.replica.awareness.setLocalStateField("private", "never sent before auth");
  await peer.authenticated(socket, healthy.replica.room);
  await peer.roundTrip(socket);
  expect(Y.encodeStateAsUpdate(target.replica.doc)).toEqual(target.state);
  expect(opened.store.readSince(target.replica.room, 0)).toEqual(before);
  expect(peer.frames(socket, target.replica.room).map(value => value.type)).toEqual([MessageType.Auth]);

  setTitle(target.replica.doc, "Still local before authentication");
  await peer.roundTrip(socket);
  expect(peer.frames(socket, target.replica.room).map(value => value.type)).toEqual([MessageType.Auth]);
  await peer.authenticated(socket, target.replica.room);
  socket.send(frame(target.replica.room, MessageType.Sync, encoder => writeUpdate(encoder, Y.encodeStateAsUpdate(malicious))));
  await waitUntil("the authenticated room's remote update", () => target.replica.doc.getMap("injected").has("later"));
  expect(opened.store.updateCount(target.replica.room)).toBeGreaterThan(before.updates.length + 1);

  socket.close(1001, "new connection");
  await waitUntil("fresh socket and room auth", () => peer.sockets.length === 2 &&
    peer.frames(peer.sockets[1]!, target.replica.room).some(value => value.type === MessageType.Auth));
  const next = peer.sockets[1]!;
  const nextLog = opened.store.readSince(target.replica.room, 0);
  malicious.getMap("injected").set("new-socket", "requires new authentication");
  next.send(frame(target.replica.room, MessageType.Sync, encoder => writeSyncStep1(encoder, empty)));
  next.send(frame(target.replica.room, MessageType.Sync, encoder => writeSyncStep2(encoder, malicious)));
  next.send(frame(target.replica.room, MessageType.Sync, encoder => writeUpdate(encoder, Y.encodeStateAsUpdate(malicious))));
  next.send(frame(target.replica.room, MessageType.QueryAwareness));
  setTitle(target.replica.doc, "Pending on the new socket");
  target.replica.awareness.setLocalStateField("private", "also withheld after reconnect");
  const localState = Y.encodeStateAsUpdate(target.replica.doc);
  await peer.authenticated(next, healthy.replica.room);
  await peer.roundTrip(next);
  expect(Y.encodeStateAsUpdate(target.replica.doc)).toEqual(localState);
  expect(target.replica.doc.getMap("injected").has("new-socket")).toBe(false);
  expect(peer.frames(next, target.replica.room).map(value => value.type)).toEqual([MessageType.Auth]);
  expect(opened.store.readSince(target.replica.room, 0).updates.length).toBe(nextLog.updates.length + 1);
  peer.refused(next, target.replica.room);
  await peer.roundTrip(next);
  expect(opened.store.hasRoom(target.replica.room)).toBe(true);
  expect(Y.encodeStateAsUpdate(target.replica.doc)).toEqual(localState);
  expect(isDirectoryEntryDeleted(opened.replicas.directory().doc, target.uuid)).toBe(false);
});

it.each([
  { event: "socket close", authenticated: false },
  { event: "socket close", authenticated: true },
  { event: "room close", authenticated: false },
  { event: "room close", authenticated: true },
  { event: "pre-auth refusal", authenticated: false },
])(
  "$event carrying doc-deleted retains local data across restart (authenticated: $authenticated)",
  async ({ event, authenticated }) => {
    const peer = await endpoint();
    const opened = workspace(peer.port);
    const target = seed(opened);
    const healthy = seed(opened, "Another retained room");
    await waitUntil("all initial room auth frames", () => peer.sockets.length === 1 &&
      peer.frames(peer.sockets[0]!, healthy.replica.room).some(value => value.type === MessageType.Auth));
    const socket = peer.sockets[0]!;
    await peer.authenticated(socket, healthy.replica.room);
    if (authenticated) await peer.authenticated(socket, target.replica.room);
    const directoryState = Y.encodeStateAsUpdate(opened.replicas.directory().doc);
    const directoryLog = opened.store.readSince(opened.replicas.directory().room, 0);
    const targetLog = opened.store.readSince(target.replica.room, 0);
    const targetSnapshot = opened.store.snapshot(target.replica.room);
    expect(targetSnapshot).not.toBeNull();
    if (event === "socket close") {
      socket.close(1001, "uberblick:doc-deleted");
      await waitUntil("a replacement socket", () => peer.sockets.length > 1);
    } else {
      if (event === "room close") socket.send(frame(target.replica.room, MessageType.CLOSE,
        encoder => encoding.writeVarString(encoder, "uberblick:doc-deleted")));
      else peer.refused(socket, target.replica.room);
      await peer.roundTrip(socket);
    }
    expect(Y.encodeStateAsUpdate(opened.replicas.directory().doc)).toEqual(directoryState);
    expect(opened.store.readSince(opened.replicas.directory().room, 0)).toEqual(directoryLog);
    expect(opened.store.readSince(target.replica.room, 0)).toEqual(targetLog);
    expect(opened.store.snapshot(target.replica.room)).toEqual(targetSnapshot);
    expect(isDirectoryEntryDeleted(opened.replicas.directory().doc, target.uuid)).toBe(false);
    expect(isDirectoryEntryDeleted(opened.replicas.directory().doc, healthy.uuid)).toBe(false);
    expect(opened.store.pendingRooms().map(row => row.room)).toEqual(expect.arrayContaining([target.replica.room, healthy.replica.room]));
    const activeSocket = event === "socket close" ? peer.sockets[1]! : socket;
    if (event === "socket close") {
      await waitUntil("the surviving room's new auth frame", () => peer.frames(activeSocket, healthy.replica.room).some(value => value.type === MessageType.Auth));
      await peer.authenticated(activeSocket, healthy.replica.room);
    }
    const before = peer.frames(activeSocket, healthy.replica.room).length;
    setTitle(healthy.replica.doc, "Other room still sends after the transport event");
    await waitUntil("the healthy room's later update", () => peer.frames(activeSocket, healthy.replica.room).length > before);
    expect(peer.sockets).toHaveLength(event === "socket close" ? 2 : 1);
    await opened.close();
    const restarted = await startServer({ ...opened.replicas.config, authSecret: null });
    rigs.push(restarted);
    const reopened = restarted.instance;
    expect(await restarted.ok("get_doc", { uuid: target.uuid })).toMatchObject({
      uuid: target.uuid, title: "Retained offline title with pending edit",
    });
    expect(Y.encodeStateAsUpdate(reopened.replicas.replica(target.uuid).doc)).toEqual(target.state);
    expect(getBlocks(reopened.replicas.replica(target.uuid).doc)).toHaveLength(1);
    expect(listAnnotations(reopened.replicas.replica(target.uuid).doc)).toHaveLength(1);
    expect(readDocData(reopened.replicas.replica(target.uuid).doc)?.collections[0]?.records).toEqual([{ id: "one", value: { secret: "local data" } }]);
    expect(reopened.store.pendingRooms().map(row => row.room)).toEqual(expect.arrayContaining([target.replica.room, healthy.replica.room]));
    expect(reopened.store.hasRoom(healthy.replica.room)).toBe(true);
  },
);

it("purges only a room refused after authentication without writing a directory mark", async () => {
  const peer = await endpoint();
  const opened = workspace(peer.port);
  const target = seed(opened);
  const healthy = seed(opened, "Healthy retained room");
  await waitUntil("all room auth frames", () => peer.sockets.length === 1 &&
    peer.frames(peer.sockets[0]!, healthy.replica.room).some(value => value.type === MessageType.Auth));
  const socket = peer.sockets[0]!;
  await peer.authenticated(socket, target.replica.room);
  await peer.authenticated(socket, healthy.replica.room);
  const directoryState = Y.encodeStateAsUpdate(opened.replicas.directory().doc);
  const directoryLog = opened.store.readSince(opened.replicas.directory().room, 0);
  expect(opened.store.snapshot(target.replica.room)).not.toBeNull();
  expect(opened.store.updateCount(target.replica.room)).toBeGreaterThan(0);
  expect(opened.store.pendingRooms().some(row => row.room === target.replica.room)).toBe(true);
  peer.refused(socket, target.replica.room);
  await waitUntil("the authenticated refused room to be purged", () => !opened.store.hasRoom(target.replica.room));
  expect(opened.store.snapshot(target.replica.room)).toBeNull();
  expect(opened.store.updateCount(target.replica.room)).toBe(0);
  expect(opened.store.pendingRooms().some(row => row.room === target.replica.room)).toBe(false);
  expect(opened.store.isIndexed(target.uuid)).toBe(false);
  expect(opened.replicas.known(target.uuid)).toBe(false);
  expect(opened.replicas.isDeleted(target.uuid)).toBe(true);
  expect(() => opened.replicas.replica(target.uuid)).toThrow("permanently deleted");
  expect(isDirectoryEntryDeleted(opened.replicas.directory().doc, target.uuid)).toBe(false);
  expect(Y.encodeStateAsUpdate(opened.replicas.directory().doc)).toEqual(directoryState);
  expect(opened.store.readSince(opened.replicas.directory().room, 0)).toEqual(directoryLog);
  const before = peer.frames(socket, healthy.replica.room).length;
  setTitle(healthy.replica.doc, "Still syncing after the refusal");
  await waitUntil("healthy room's update after refusal", () => peer.frames(socket, healthy.replica.room).length > before);
  expect(getMeta(healthy.replica.doc).title).toBe("Still syncing after the refusal");
  expect(opened.store.hasRoom(healthy.replica.room)).toBe(true);
});
