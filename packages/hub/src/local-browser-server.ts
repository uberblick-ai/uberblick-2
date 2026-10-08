/**
 * The loopback Hocuspocus server `ub open` puts in front of its local store.
 *
 * The browser-facing server owns protocol mechanics; its caller owns the
 * store. The only bridge between this server and the full upstream replica is
 * therefore the callbacks below: read a room from the update log, append a
 * browser update before Hocuspocus may apply or ack it, and pair the room's
 * awareness with its full upstream replica.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketLike } from "@hocuspocus/server";
import { Server } from "@hocuspocus/server";
import { parseRoom } from "@uberblick/schema";
import {
  messageYjsSyncStep1,
  messageYjsSyncStep2,
  messageYjsUpdate,
} from "y-protocols/sync";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  type Awareness,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { MAX_PENDING_DOCUMENTS } from "./config.js";
import { stderrLogger } from "./log.js";
import type { HubLogger } from "./log.js";
import {
  createRoomAuthenticator,
  PEER_ADDRESS_HEADER,
  type HubContext,
} from "./server.js";
import { SYNC_PROTOCOL_VERSION, isProtocolVersion } from "./protocol.js";

export const STORE_BUSY_REASON = "uberblick:store-busy";
export const STORE_REFUSED_REASON = "uberblick:store-refused";

/** The code is server-local; Hocuspocus sends the reason string to the client. */
const REFUSAL_CODE = 4900;

/** Loading is not a document edit and must never schedule a store hook. */
const LOAD_ORIGIN = Object.freeze({
  source: "local" as const,
  skipStoreHooks: true,
  uberblick: "store-load",
});

/** Awareness copied across the local browser/replica seam, never echoed back. */
const AWARENESS_BRIDGE = Symbol("uberblick/awareness-bridge");

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

/**
 * Relay presence between one served room and the full replica of that room.
 *
 * The served client ids stay owned for the bridge's lifetime, even after a
 * removal. The upstream provider clears every remote awareness state when its
 * socket closes; replaying those removals into the served room would otherwise
 * erase a live tab's own state and make its cursor flicker. The tab's periodic
 * awareness renewal re-adds it to the replica once the hub is reachable again.
 */
export function bridgeAwareness(served: Awareness, replica: Awareness): () => void {
  const servedClients = new Set<number>();

  const relay = (
    source: Awareness,
    target: Awareness,
    clients: number[],
  ): void => {
    if (clients.length === 0) return;
    applyAwarenessUpdate(
      target,
      encodeAwarenessUpdate(source, clients),
      AWARENESS_BRIDGE,
    );
  };

  const fromServed = (change: AwarenessChange, origin: unknown): void => {
    if (origin === AWARENESS_BRIDGE) return;
    for (const client of [...change.added, ...change.updated]) {
      servedClients.add(client);
    }
    relay(served, replica, [
      ...change.added,
      ...change.updated,
      ...change.removed,
    ]);
  };
  const fromReplica = (change: AwarenessChange, origin: unknown): void => {
    if (origin === AWARENESS_BRIDGE) return;
    const clients = [...change.added, ...change.updated, ...change.removed].filter(
      (client) => !servedClients.has(client),
    );
    relay(replica, served, clients);
  };

  served.on("update", fromServed);
  replica.on("update", fromReplica);

  // A room's first tab receives what the hub already relayed into the replica.
  relay(replica, served, [...replica.getStates().keys()]);

  return () => {
    served.off("update", fromServed);
    replica.off("update", fromReplica);
  };
}

/** A log replay broadcasts through Hocuspocus but never writes another row. */
const REPLAY_ORIGIN = Object.freeze({
  source: "local" as const,
  skipStoreHooks: true,
  uberblick: "store-replay",
});

/** Retry a refused replay without spinning or waiting for another store write. */
const REPLAY_RETRY_MS = 25;

export interface LocalRoomSlice {
  snapshot: { state: Uint8Array; throughSeq: number } | null;
  updates: readonly { seq: number; payload: Uint8Array }[];
}

export interface LocalBrowserServerConfig {
  port: number;
  expectedOrigin: string;
  /** Each local admission key admits only its workspace, never another store. */
  workspaces: ReadonlyMap<string, string>;
  protocolVersion?: number;
  log?: HubLogger;
  /** Prepare an authenticated room's replica before reading its store. */
  prepareRoom?(room: string): Promise<void>;
  readRoom(room: string, afterSeq: number): LocalRoomSlice;
  appendUpdate(room: string, payload: Uint8Array): void;
  awarenessForRoom(room: string): Awareness;
  onRequest(request: IncomingMessage, response: ServerResponse): void;
}

export interface LocalBrowserServer {
  readonly port: number;
  /** Replay loaded stores, optionally only those of the named workspace. */
  refresh(workspaceId?: string): void;
  stop(): Promise<void>;
}

function applyRoomSlice(
  document: Y.Doc,
  slice: LocalRoomSlice,
  afterSeq: number,
  origin: object,
): number {
  let throughSeq = afterSeq;
  if (slice.snapshot !== null) {
    Y.applyUpdate(document, slice.snapshot.state, origin);
    throughSeq = Math.max(throughSeq, slice.snapshot.throughSeq);
  }
  for (const update of slice.updates) {
    Y.applyUpdate(document, update.payload, origin);
    throughSeq = Math.max(throughSeq, update.seq);
  }
  return throughSeq;
}

/** SQLite's primary busy result, including extended BUSY codes. */
function isBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === 5;
}

function refused(reason: string, cause: unknown): Error {
  return Object.assign(new Error(`${reason}: ${String(cause)}`), {
    code: REFUSAL_CODE,
    reason,
    cause,
  });
}

function sockets(server: Server<HubContext>): Set<WebSocketLike> {
  const result = new Set<WebSocketLike>();
  for (const document of server.hocuspocus.documents.values()) {
    for (const connection of document.getConnections()) {
      result.add(connection.webSocket);
    }
  }
  return result;
}

async function listen(server: Server<HubContext>): Promise<void> {
  let onError!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    onError = reject;
  });
  server.httpServer.once("error", onError);
  try {
    await Promise.race([server.listen(), failed]);
  } finally {
    server.httpServer.off("error", onError);
  }
}

/**
 * Start the authenticated loopback server for its caller's local replicas.
 * The HTTP callback lets the same port serve the web bundle and websocket.
 */
export async function createLocalBrowserServer(
  config: LocalBrowserServerConfig,
): Promise<LocalBrowserServer> {
  const workspaces = new Map(config.workspaces);
  if (workspaces.size === 0 || [...workspaces.values()].some((key) => key === "")) {
    throw new Error("createLocalBrowserServer: browserKey must not be empty");
  }
  const protocolVersion = config.protocolVersion ?? SYNC_PROTOCOL_VERSION;
  if (!isProtocolVersion(protocolVersion)) {
    throw new Error(
      `createLocalBrowserServer: protocolVersion must be an integer between 1 and 999999, got ${protocolVersion}`,
    );
  }
  const log = config.log ?? stderrLogger;
  const authenticate = await createRoomAuthenticator({
    workspaceKeys: workspaces,
    protocolVersion,
    log,
  });
  const upgradedSockets = new Set<Duplex>();
  const awarenessBridges = new Map<string, () => void>();
  const appliedThrough = new WeakMap<Y.Doc, number>();
  const retryRooms = new Set<string>();

  const server = new Server<HubContext>({
    port: config.port,
    address: "127.0.0.1",
    stopOnSignals: false,
    quiet: true,
    maxPendingDocuments: MAX_PENDING_DOCUMENTS,

    async onRequest({ request, response }) {
      config.onRequest(request, response);
      // The callback answered every request. An empty rejection stops the
      // dependency's default "Welcome to Hocuspocus" response without being
      // rethrown from its async request listener.
      return Promise.reject();
    },

    async onUpgrade({ request, socket }) {
      if (request.headers.origin !== config.expectedOrigin) {
        socket.destroy();
        // A truthy rejection escapes Hocuspocus' async upgrade listener and
        // terminates the process. Destroy, then reject with no value.
        return Promise.reject();
      }
      request.headers[PEER_ADDRESS_HEADER] = request.socket?.remoteAddress ?? "";
      upgradedSockets.add(socket);
      socket.once("close", () => upgradedSockets.delete(socket));
    },

    async onAuthenticate(payload) {
      const context = await authenticate(payload);
      try {
        // Loaded documents skip onLoadDocument for subsequent tabs. Check the
        // replica for each authenticated connection as well as its first one.
        await config.prepareRoom?.(payload.documentName);
      } catch (error) {
        const reason = isBusy(error) ? STORE_BUSY_REASON : STORE_REFUSED_REASON;
        log({
          event: "ub-open.store.refused",
          room: payload.documentName,
          cause: reason,
          error: String(error),
        });
        throw refused(reason, error);
      }
      return context;
    },

    async onLoadDocument({ document, documentName }) {
      try {
        appliedThrough.set(
          document,
          applyRoomSlice(
            document,
            config.readRoom(documentName, 0),
            0,
            LOAD_ORIGIN,
          ),
        );
        awarenessBridges.set(
          documentName,
          bridgeAwareness(document.awareness, config.awarenessForRoom(documentName)),
        );
      } catch (error) {
        const reason = isBusy(error) ? STORE_BUSY_REASON : STORE_REFUSED_REASON;
        log({
          event: "ub-open.store.refused",
          room: documentName,
          cause: reason,
          error: String(error),
        });
        // There is no room Connection until loading succeeds. Hocuspocus
        // carries this reason in its per-document permission-denied response,
        // leaving other rooms on the same socket intact.
        throw refused(reason, error);
      }
    },

    async afterUnloadDocument({ documentName }) {
      awarenessBridges.get(documentName)?.();
      awarenessBridges.delete(documentName);
      retryRooms.delete(documentName);
    },

    async beforeSync({ connection, documentName, type, payload }) {
      if (type === messageYjsSyncStep1 || connection.readOnly) return;
      if (type !== messageYjsSyncStep2 && type !== messageYjsUpdate) return;

      let decoded: ReturnType<typeof Y.decodeUpdate>;
      try {
        decoded = Y.decodeUpdate(payload);
      } catch (error) {
        log({
          event: "ub-open.store.refused",
          room: documentName,
          cause: "malformed-update",
          error: String(error),
        });
        throw refused(STORE_REFUSED_REASON, error);
      }
      // The reconnect handshake produces a real two-byte Yjs update carrying
      // neither structs nor deletes. It changes nothing, so it earns no row.
      if (decoded.structs.length === 0 && decoded.ds.clients.size === 0) return;

      try {
        // Raw bytes in, the same raw bytes committed. Decoding above validates
        // replay but is never an excuse to re-encode the client's update.
        config.appendUpdate(documentName, payload);
      } catch (error) {
        const reason = isBusy(error) ? STORE_BUSY_REASON : STORE_REFUSED_REASON;
        log({
          event: "ub-open.store.refused",
          room: documentName,
          cause: reason,
          error: String(error),
        });
        throw refused(reason, error);
      }
    },
  });

  try {
    await listen(server);
  } catch (error) {
    await server.destroy().catch(() => {});
    throw error;
  }

  let retryTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  const refresh = (workspaceId?: string): void => {
    if (stopped) return;

    for (const [room, document] of server.hocuspocus.documents) {
      if (workspaceId !== undefined && parseRoom(room).workspaceId !== workspaceId) continue;
      const afterSeq = appliedThrough.get(document);
      if (afterSeq === undefined) continue;
      try {
        appliedThrough.set(
          document,
          applyRoomSlice(
            document,
            config.readRoom(room, afterSeq),
            afterSeq,
            REPLAY_ORIGIN,
          ),
        );
        retryRooms.delete(room);
      } catch (error) {
        const busy = isBusy(error);
        if (busy) retryRooms.add(room);
        else retryRooms.delete(room);
        log({
          event: "ub-open.store.refused",
          room,
          cause: busy ? STORE_BUSY_REASON : STORE_REFUSED_REASON,
          error: String(error),
        });
        if (!busy) {
          // A failed replica must no longer serve its stale in-memory rooms.
          // Close document connections, rather than their shared websocket.
          appliedThrough.delete(document);
          for (const connection of document.getConnections()) {
            connection.close({ code: REFUSAL_CODE, reason: STORE_REFUSED_REASON });
          }
        }
      }
    }

    if (retryRooms.size > 0 && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        // A scoped API replay must not later turn into an unscoped retry.
        for (const workspace of new Set([...retryRooms].map((room) => parseRoom(room).workspaceId))) {
          refresh(workspace);
        }
      }, REPLAY_RETRY_MS);
    } else if (retryRooms.size === 0 && retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  let stopPromise: Promise<void> | null = null;
  return {
    port: server.address.port,
    refresh,
    stop() {
      stopped = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      stopPromise ??= Promise.resolve().then(async () => {
        for (const socket of sockets(server)) {
          try {
            socket.close(1001, "ub open shutting down");
          } catch {
            // A socket that left between enumeration and close is already done.
          }
        }
        server.httpServer.closeAllConnections();
        await server.destroy();

        // Node's HTTP close helpers deliberately exclude upgraded sockets, and
        // Hocuspocus only enumerates sockets that already own a loaded room.
        // Destroy the accepted remainder after its graceful document closes,
        // then wait for the raw handles to leave the process.
        const remaining = [...upgradedSockets];
        const closed = remaining.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.destroyed) resolve();
              else socket.once("close", () => resolve());
            }),
        );
        for (const socket of remaining) socket.destroy();
        await Promise.all(closed);
      });
      return stopPromise;
    },
  };
}
