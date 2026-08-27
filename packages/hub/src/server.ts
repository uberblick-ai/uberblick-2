/**
 * The sync hub.
 *
 * A Hocuspocus server with SQLite persistence and claims-token auth. One Y.Doc
 * per room; a room is `<workspaceId>/<docUuid>`, with a workspace's directory
 * doc at `<workspaceId>/_directory`.
 *
 * Two things here are load-bearing beyond "start a websocket server":
 *
 * 1. **Auth is scoped to a workspace.** `onAuthenticate` verifies the token,
 *    then refuses any room outside `claims.workspace`. Tokens arrive in the
 *    Hocuspocus auth message; a token in the URL query string is rejected
 *    outright, because query strings end up in access logs and proxy traces.
 *
 * 2. **The flush is an operation, not a side effect.** Hocuspocus debounces
 *    `onStoreDocument` (2s by default), so a document lives in memory for a
 *    while before it is durable. Its `destroy()` does fire those pending stores
 *    and wait for the documents to unload, and it installs signal handlers that
 *    await that — but only as part of shutting the whole server down, and
 *    `flushPendingStores()` (the piece that fires them) returns `void`, so
 *    nothing can await the writes on their own. "Kill the hub loses nothing" is
 *    an acceptance criterion, so {@link Hub.flush} makes that step explicit,
 *    awaitable and testable without a shutdown, and `stop()` and the signal
 *    handler in `main.ts` run it first.
 *
 * 3. **Only the hub can tell whether a store landed.** `storeDocumentHooks()`
 *    catches a failing store, logs it, keeps the document in memory and
 *    *resolves*, so completion is not durability: a hub whose database went
 *    away would flush, stop and exit 0 having written nothing.
 *    {@link HubDatabase} records the failure where it is still an exception,
 *    and `flush()`/`stop()` reject on it — `stop()` after the teardown as well
 *    as before, because the teardown stores too. Likewise, storage is opened
 *    before the socket, here rather than in a Hocuspocus hook nobody awaits:
 *    a hub that is listening is a hub that can persist.
 *
 * Persistence is {@link HubDatabase} — the hub's own `node:sqlite` adapter, one
 * row per document holding `Y.encodeStateAsUpdate(doc)`, hydrated with
 * `Y.applyUpdate`. Yjs v1, matching the one-encoding-everywhere invariant.
 */

import type { Hocuspocus, onStoreDocumentPayload } from "@hocuspocus/server";
import { Server } from "@hocuspocus/server";
import { parseRoom } from "@uberblick/schema";
import type { HubConfig } from "./config.js";
import { DEFAULT_HOST, DEFAULT_PORT, defaultDatabasePath } from "./config.js";
import type { HubLogger } from "./log.js";
import { stderrLogger } from "./log.js";
import { HubDatabase, isEphemeralDatabase } from "./persistence.js";
import type { TokenClaims } from "./token.js";
import { clampToken, importRootSecret, verifyToken } from "./token.js";

/**
 * Connection context. The claims *are* the context: everything downstream
 * (readOnly, future awareness identity) should derive from what the token
 * asserted, never from what the client says about itself.
 */
export type HubContext = TokenClaims;

export interface Hub {
  /** The bound port. The real one, even when `config.port` was 0. */
  readonly port: number;
  readonly databasePath: string;
  readonly server: Server<HubContext>;
  readonly hocuspocus: Hocuspocus<HubContext>;
  /**
   * Execute every pending debounced `onStoreDocument` now and await it, so
   * that everything currently in memory is on disk when this resolves.
   *
   * @throws when any store has failed — resolving would claim a durability the
   * hub does not have.
   */
  flush(): Promise<void>;
  /**
   * Quiesce connections, flush, unload documents, close the database. Rejects
   * unless the hub's state is known to be on disk when it returns — a failed
   * store, before or during teardown, or a teardown that did not finish inside
   * the shutdown timeout. The resources are released either way, so a caller
   * can exit on the rejection rather than because of it.
   */
  stop(): Promise<void>;
}

/** Query parameters that would carry a token. Their presence is a rejection. */
const TOKEN_QUERY_PARAMS = ["token", "access_token", "auth", "authToken"];


class AuthError extends Error {
  /** Hocuspocus sends this to the client as the permission-denied reason. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.reason = reason;
  }
}

/**
 * The workspace a room belongs to, or `null` when the name is not a room.
 *
 * Schema owns what a room name is — exactly two segments, the first a workspace
 * uuid — and this is the one place the hub asks. A name that is not a room has
 * no workspace to match a token claim against, so it fails authentication with
 * the workspace mismatch rather than opening a document keyed by a name nobody
 * can name again. Room names are also SQLite keys, so the strictness earns its
 * keep twice.
 */
function roomWorkspace(room: string): string | null {
  try {
    return parseRoom(room).workspaceId;
  } catch {
    return null;
  }
}

/**
 * Execute all pending debounced document stores and await them.
 *
 * Hocuspocus ships `flushPendingStores()`, which fires the same debounced
 * callbacks but returns `void` — fine inside its own shutdown, which then waits
 * for the documents to unload, useless when you want to know the writes landed
 * without tearing the server down. `storeDocumentHooks(document, payload,
 * true)` re-enters the debouncer with a 0ms delay, which cancels the pending
 * timer, waits for any in-flight store of that document, runs the store hooks
 * under the document's save mutex, and hands back a promise.
 *
 * Documents with nothing pending are skipped: Hocuspocus already stores a
 * document when its last client disconnects, so re-storing every loaded
 * document on every flush would write rows for no reason.
 */
async function flushPendingStores(
  hocuspocus: Hocuspocus<HubContext>,
  log: HubLogger,
): Promise<void> {
  const pending: Promise<unknown>[] = [];

  for (const document of hocuspocus.documents.values()) {
    if (document.isLoading) {
      continue;
    }
    const debounceId = `onStoreDocument-${document.name}`;
    const isPending =
      hocuspocus.debouncer.isDebounced(debounceId) ||
      hocuspocus.debouncer.isCurrentlyExecuting(debounceId);
    if (!isPending) {
      continue;
    }

    const payload: onStoreDocumentPayload = {
      instance: hocuspocus,
      clientsCount: document.getConnectionsCount(),
      document,
      documentName: document.name,
      lastContext: {},
      lastTransactionOrigin: null,
    };
    pending.push(hocuspocus.storeDocumentHooks(document, payload, true));
  }

  if (pending.length === 0) {
    return;
  }

  log({ event: "hub.flush", documents: pending.length });
  await Promise.all(pending);
}

async function withTimeout(
  work: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bind the socket, with a bind failure as a rejection.
 *
 * `Server.listen()` resolves from the HTTP server's `listening` callback and
 * never subscribes to its `error` event, so a failed bind — a second hub on the
 * same port, `EADDRINUSE` — takes the process down with an uncaught exception
 * while the returned promise stays pending forever. The listener is
 * startup-only: once the hub is up, socket errors are Hocuspocus' business.
 */
async function listen(
  server: Server<HubContext>,
): Promise<Hocuspocus<HubContext>> {
  let onError!: (error: Error) => void;
  const bindFailed = new Promise<never>((_resolve, reject) => {
    onError = reject;
  });

  server.httpServer.once("error", onError);
  try {
    return await Promise.race([server.listen(), bindFailed]);
  } finally {
    server.httpServer.off("error", onError);
  }
}

/**
 * Build and start a hub.
 *
 * Resolves once the database is open *and* the server is listening, so
 * `hub.port` is the real bound port even for `port: 0` and a resolved hub is a
 * hub that can persist. Rejects — leaving nothing open behind it — when the
 * database cannot be opened or the port cannot be bound. Installs no signal
 * handlers and mutates no process state — `main.ts` owns the process, this owns
 * a server — which is what makes it usable from tests.
 */
export async function createHub(config: HubConfig): Promise<Hub> {
  if (config.authSecret === "") {
    throw new Error(
      "createHub: authSecret must not be empty — it is the HMAC secret tokens are signed with",
    );
  }

  const log = config.log ?? stderrLogger;
  // Imported once, here: the root secret never changes for the life of a hub,
  // and `onAuthenticate` wants a key rather than a string.
  const rootKey = await importRootSecret(config.authSecret);
  const databasePath = config.databasePath ?? defaultDatabasePath();
  const address = config.address ?? DEFAULT_HOST;
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 10_000;

  // Sticky on purpose: once a store has failed, the hub cannot claim that what
  // it holds is on disk, so every later flush and the shutdown must say so.
  let storeFailure: { error: unknown } | undefined;
  const database = new HubDatabase(databasePath, (error) => {
    storeFailure ??= { error };
    log({
      event: "hub.store.failed",
      database: databasePath,
      error: String(error),
    });
  });

  /** Releasing the handle is never the reason a shutdown fails; it is logged. */
  const closeDatabase = (): void => {
    try {
      database.close();
    } catch (error) {
      log({ event: "hub.database.closeFailed", error: String(error) });
    }
  };

  // Before the socket, not after: a hub that is listening has a database.
  try {
    database.open();
  } catch (error) {
    closeDatabase();
    throw new Error(
      `createHub: cannot open the SQLite database at ${databasePath}`,
      { cause: error },
    );
  }

  if (isEphemeralDatabase(databasePath)) {
    // The extension said this with console.warn (plus a blank line on stdout);
    // it is one structured stderr line now, and still worth saying: nothing
    // written to an anonymous database survives the handle being closed.
    log({ event: "hub.database.ephemeral", database: databasePath });
  }

  const server = new Server<HubContext>({
    port: config.port ?? DEFAULT_PORT,
    address,
    // Hocuspocus would otherwise add its own SIGINT/SIGQUIT/SIGTERM handlers
    // here. A factory must not touch process state: every hub a test starts
    // would hijack the runner's signals. main.ts wires them instead.
    stopOnSignals: false,
    // No start banner on stdout; startup is one structured line on stderr.
    quiet: true,
    ...(config.debounce === undefined ? {} : { debounce: config.debounce }),
    ...(config.maxDebounce === undefined
      ? {}
      : { maxDebounce: config.maxDebounce }),
    extensions: [database],

    async onAuthenticate({
      token,
      documentName,
      requestParameters,
      connectionConfig,
    }) {
      const queried = TOKEN_QUERY_PARAMS.find((name) =>
        requestParameters.has(name),
      );
      if (queried !== undefined) {
        log({
          event: "hub.auth.rejected",
          room: documentName,
          cause: `token in query parameter ${queried}`,
        });
        throw new AuthError(
          "token-in-query",
          `token must be sent in the auth message, not the "${queried}" query parameter`,
        );
      }

      const claims = await verifyToken(rootKey, token);
      if (claims === null) {
        log({
          event: "hub.auth.rejected",
          room: documentName,
          cause: "invalid token",
        });
        throw new AuthError(
          "invalid-token",
          "token is missing, malformed or badly signed",
        );
      }

      // The lifetime ceiling, applied whatever the token claimed. Every MCP
      // server and every `ub` mints locally, so this is the only place a
      // decade-long token gets refused. The cause is logged and the wire
      // reason is not: an expired token and a forged one are the same refusal
      // to whoever sent it.
      const clamped = clampToken(claims, Math.floor(Date.now() / 1000));
      if (clamped !== null) {
        log({
          event: "hub.auth.rejected",
          room: documentName,
          sub: claims.sub,
          cause: `token ${clamped}`,
        });
        throw new AuthError(
          "invalid-token",
          "token is missing, malformed or badly signed",
        );
      }

      const workspace = roomWorkspace(documentName);
      if (workspace === null || workspace !== claims.workspace) {
        log({
          event: "hub.auth.rejected",
          room: documentName,
          sub: claims.sub,
          cause: `token is scoped to workspace ${claims.workspace}`,
        });
        throw new AuthError(
          "workspace-mismatch",
          `token for workspace "${claims.workspace}" may not open room "${documentName}"`,
        );
      }

      if (claims.scope === "read-only") {
        connectionConfig.readOnly = true;
      }

      log({
        event: "hub.auth.accepted",
        room: documentName,
        sub: claims.sub,
        workspace: claims.workspace,
        scope: claims.scope,
      });

      return claims;
    },

    /**
     * Connection lifecycle, per room and not per socket: Hocuspocus runs these
     * hooks once per document a client attaches to, so one client on three
     * documents produces three of each event. Hence the names and the `room`
     * field — and `socketId`, which is what ties a room's events back to one
     * client and makes a reconnect legible (same room, new socket).
     *
     * `connected` rather than `onConnect` because only the post-handshake hook
     * has the token claims in its context. The close is registered on the
     * connection rather than read from the `onDisconnect` hook because
     * Hocuspocus discards the websocket close event when it builds that hook's
     * payload; `Connection.onClose` still carries it.
     *
     * A close the hub initiated names itself (`4205 Reset Connection` on
     * shutdown, the timeout code when a client stops answering). A client
     * going away does not: it arrives as `1006` with an empty reason, or with
     * no event at all when the hub noticed the dead socket on its next write
     * before the close frame got here. Both mean the same thing, so they are
     * logged under one name instead of as an empty field.
     */
    async connected({ documentName, context, socketId, connection }) {
      log({
        event: "hub.room.connected",
        room: documentName,
        sub: context.sub,
        socketId,
      });

      connection.onClose((_document, event) => {
        log({
          event: "hub.room.closed",
          room: documentName,
          sub: context.sub,
          socketId,
          code: event?.code ?? null,
          reason: event?.reason || "client-gone",
        });
      });
    },
  });

  let hocuspocus: Hocuspocus<HubContext>;
  try {
    hocuspocus = await listen(server);
  } catch (error) {
    // Half a hub is worse than none: release the socket and the handle so the
    // caller sees a rejection and nothing else.
    await server.destroy().catch((cleanup: unknown) => {
      log({ event: "hub.start.cleanupFailed", error: String(cleanup) });
    });
    closeDatabase();
    throw error;
  }
  const port = server.address.port;

  log({ event: "hub.listen", address, port, database: databasePath });

  /** The sticky store failure, as the error a durability claim should not hide. */
  const storeError = (): Error | undefined =>
    storeFailure === undefined
      ? undefined
      : new Error(
          "hub: a document store failed, so the hub's state is not durable: " +
            String(storeFailure.error),
          { cause: storeFailure.error },
        );

  const flush = async (): Promise<void> => {
    await flushPendingStores(hocuspocus, log);
    const failed = storeError();
    if (failed !== undefined) {
      throw failed;
    }
  };
  let stopping: Promise<void> | undefined;

  const runStop = async (): Promise<void> => {
    // Quiesce first. Closing the socket and the open connections is what makes
    // the flush below final: while clients can still send updates — or connect —
    // a document can go dirty again after it was stored, and the write that
    // would have caught up happens during the teardown, where a failure is
    // Hocuspocus' to swallow.
    server.httpServer.close();
    hocuspocus.closeConnections();

    // A failed flush must not skip the teardown — the socket and the handle are
    // released either way — but it is what stop() reports.
    let failure: unknown;
    try {
      await flush();
    } catch (error) {
      failure = error;
    }

    // destroy() closes every connection and waits for the documents to unload.
    // It can only wait forever if a document refuses to unload — which is
    // exactly what a failing store makes it do — so bound it rather than
    // hanging a shutdown, and remember that the wait did not finish.
    let timedOut = false;
    await withTimeout(server.destroy(), shutdownTimeoutMs, () => {
      timedOut = true;
      log({
        event: "hub.stop.timeout",
        timeoutMs: shutdownTimeoutMs,
        documents: hocuspocus.getDocumentsCount(),
      });
    });

    // Sockets that never saw the close frame would otherwise keep the HTTP
    // server's handle (and the port) alive.
    server.httpServer.closeAllConnections?.();

    closeDatabase();

    // Teardown stores too: it fires the pending stores of the documents it
    // unloads, and Hocuspocus swallows a failure there as it does everywhere
    // else. Only re-reading the sticky failure after the teardown can tell
    // whether those writes landed.
    failure ??= storeError();
    if (failure === undefined && timedOut) {
      failure = new Error(
        `hub: shutdown did not finish within ${shutdownTimeoutMs}ms, so the hub's state is not durable`,
      );
    }
    if (failure !== undefined) {
      throw failure;
    }

    log({ event: "hub.stopped", port });
  };

  return {
    port,
    databasePath,
    server,
    hocuspocus,
    flush,
    stop() {
      stopping ??= runStop();
      return stopping;
    },
  };
}
