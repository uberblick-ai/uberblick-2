/**
 * The loopback Hocuspocus server `ub open` puts in front of its local store.
 *
 * The browser-facing server owns protocol mechanics; its caller owns the
 * store. The only bridge between this server and the full upstream replica is
 * therefore the two callbacks below: read a room from the update log, and
 * append a browser update to that log before Hocuspocus may apply or ack it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketLike } from "@hocuspocus/server";
import { Server } from "@hocuspocus/server";
import {
  messageYjsSyncStep1,
  messageYjsSyncStep2,
  messageYjsUpdate,
} from "y-protocols/sync";
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

/** A log replay broadcasts through Hocuspocus but never writes another row. */
const REPLAY_ORIGIN = Object.freeze({
  source: "local" as const,
  skipStoreHooks: true,
  uberblick: "store-replay",
});

export interface LocalRoomSlice {
  snapshot: { state: Uint8Array; throughSeq: number } | null;
  updates: readonly { seq: number; payload: Uint8Array }[];
}

export interface LocalBrowserServerConfig {
  port: number;
  workspaceId: string;
  authSecret: string;
  expectedOrigin: string;
  protocolVersion?: number;
  log?: HubLogger;
  readRoom(room: string, afterSeq: number): LocalRoomSlice;
  appendUpdate(room: string, payload: Uint8Array): void;
  onRequest(request: IncomingMessage, response: ServerResponse): void;
}

export interface LocalBrowserServer {
  readonly port: number;
  /** Apply each loaded room's unseen store tail and broadcast real changes. */
  refresh(): void;
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
 * Start the authenticated loopback server after its caller's replica is ready.
 * The HTTP callback lets the same port serve the web bundle and websocket.
 */
export async function createLocalBrowserServer(
  config: LocalBrowserServerConfig,
): Promise<LocalBrowserServer> {
  if (config.authSecret === "") {
    throw new Error("createLocalBrowserServer: authSecret must not be empty");
  }
  const protocolVersion = config.protocolVersion ?? SYNC_PROTOCOL_VERSION;
  if (!isProtocolVersion(protocolVersion)) {
    throw new Error(
      `createLocalBrowserServer: protocolVersion must be an integer between 1 and 999999, got ${protocolVersion}`,
    );
  }
  const log = config.log ?? stderrLogger;
  const authenticate = await createRoomAuthenticator({
    authSecret: config.authSecret,
    protocolVersion,
    log,
    servedWorkspace: config.workspaceId,
  });
  const upgradedSockets = new Set<Duplex>();
  const appliedThrough = new WeakMap<Y.Doc, number>();

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

    onAuthenticate: authenticate,

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
      } catch (error) {
        const reason = isBusy(error) ? STORE_BUSY_REASON : STORE_REFUSED_REASON;
        log({
          event: "ub-open.store.refused",
          room: documentName,
          cause: reason,
          error: String(error),
        });
        // Hocuspocus creates the room's Connection only after this hook
        // succeeds, so no per-room close exists yet to carry `reason` to the
        // browser. Keep the structured terminal log honest and let the load
        // fail plainly; accepted raw sockets remain owned for shutdown below.
        throw error;
      }
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

  let stopPromise: Promise<void> | null = null;
  return {
    port: server.address.port,
    refresh() {
      for (const [room, document] of server.hocuspocus.documents) {
        const afterSeq = appliedThrough.get(document);
        if (afterSeq === undefined) continue;
        appliedThrough.set(
          document,
          applyRoomSlice(
            document,
            config.readRoom(room, afterSeq),
            afterSeq,
            REPLAY_ORIGIN,
          ),
        );
      }
    },
    stop() {
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
