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
 * Persistence is `@hocuspocus/extension-sqlite`, which stores one row per
 * document holding `Y.encodeStateAsUpdate(doc)` and hydrates with
 * `Y.applyUpdate` — Yjs v1 encoding, the extension's own default, matching the
 * one-encoding-everywhere invariant. (It upserts a full state snapshot per
 * document rather than appending updates, so there is no updates table to
 * prune.)
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLite } from "@hocuspocus/extension-sqlite";
import type { Hocuspocus, onStoreDocumentPayload } from "@hocuspocus/server";
import { Server } from "@hocuspocus/server";
import type { HubConfig } from "./config.js";
import { DEFAULT_PORT, defaultDatabasePath } from "./config.js";
import type { HubLogger } from "./log.js";
import { stderrLogger } from "./log.js";
import type { TokenClaims } from "./token.js";
import { verifyToken } from "./token.js";

/**
 * Connection context. The claims *are* the context: everything downstream
 * (readOnly, future awareness identity) should derive from what the token
 * asserted, never from what the client says about itself.
 */
export type HubContext = TokenClaims;

export interface StopOptions {
  /**
   * Flush pending stores before shutting down. Defaults to `true`; only a test
   * proving that the flush is what persists the data passes `false`.
   */
  flush?: boolean;
}

export interface Hub {
  /** The bound port. The real one, even when `config.port` was 0. */
  readonly port: number;
  readonly databasePath: string;
  readonly server: Server<HubContext>;
  readonly hocuspocus: Hocuspocus<HubContext>;
  /**
   * Execute every pending debounced `onStoreDocument` now and await it, so
   * that everything currently in memory is on disk when this resolves.
   */
  flush(): Promise<void>;
  /** Flush, close connections, unload documents, close the database. */
  stop(options?: StopOptions): Promise<void>;
}

/** Query parameters that would carry a token. Their presence is a rejection. */
const TOKEN_QUERY_PARAMS = ["token", "access_token", "auth", "authToken"];

const SEPARATOR = "/";

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
 * A room is exactly two non-empty segments — `<workspaceId>/<docUuid>` — so a
 * bare name (pre-tenancy) or a name with extra segments is not a room here.
 * Room names are also SQLite keys, so the strictness is worth having.
 *
 * Duplicated rather than imported from `@uberblick/schema` on purpose: the hub
 * needs a stricter reading than the schema's tolerant `parseRoom` (which maps a
 * bare name onto the default workspace), and the hub's dependency list stays
 * limited to the transport.
 */
function roomWorkspace(room: string): string | null {
  const separator = room.indexOf(SEPARATOR);
  if (separator <= 0) {
    return null;
  }
  const workspace = room.slice(0, separator);
  const document = room.slice(separator + 1);
  if (document === "" || document.includes(SEPARATOR)) {
    return null;
  }
  return workspace;
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

/** Only used to close the SQLite handle; the extension never closes its own. */
interface ClosableDatabase {
  close(): unknown;
}

/**
 * Build and start a hub.
 *
 * Resolves once the server is listening, so `hub.port` is the real bound port
 * even for `port: 0`. Installs no signal handlers and mutates no process state
 * — `main.ts` owns the process, this owns a server — which is what makes it
 * usable from tests.
 */
export async function createHub(config: HubConfig): Promise<Hub> {
  if (config.authSecret === "") {
    throw new Error(
      "createHub: authSecret must not be empty — it is the HMAC secret tokens are signed with",
    );
  }

  const log = config.log ?? stderrLogger;
  const authSecret = config.authSecret;
  const databasePath = config.databasePath ?? defaultDatabasePath();
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 10_000;

  if (databasePath !== ":memory:" && databasePath !== "") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new SQLite({ database: databasePath });

  const server = new Server<HubContext>({
    port: config.port ?? DEFAULT_PORT,
    ...(config.address === undefined ? {} : { address: config.address }),
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
    extensions: [sqlite],

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

      const claims = await verifyToken(authSecret, token);
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
  });

  const hocuspocus = await server.listen();
  const port = server.address.port;

  log({
    event: "hub.listen",
    port,
    database: databasePath,
    ...(config.address === undefined ? {} : { address: config.address }),
  });

  const flush = () => flushPendingStores(hocuspocus, log);
  let stopping: Promise<void> | undefined;

  const runStop = async (options: StopOptions): Promise<void> => {
    if (options.flush !== false) {
      await flush();
    }

    // destroy() closes the HTTP server, closes every connection and waits for
    // the documents to unload. It can only wait forever if a document refuses
    // to unload, and the flush above already made the data durable, so bound
    // it rather than hanging a shutdown.
    await withTimeout(server.destroy(), shutdownTimeoutMs, () => {
      log({
        event: "hub.stop.timeout",
        timeoutMs: shutdownTimeoutMs,
        documents: hocuspocus.getDocumentsCount(),
      });
    });

    // Sockets that never saw the close frame would otherwise keep the HTTP
    // server's handle (and the port) alive.
    server.httpServer.closeAllConnections?.();

    // The SQLite extension opens its handle in onConfigure and never closes it.
    try {
      (sqlite as { db?: ClosableDatabase }).db?.close();
    } catch (error) {
      log({ event: "hub.stop.databaseCloseFailed", error: String(error) });
    }

    log({ event: "hub.stopped", port });
  };

  return {
    port,
    databasePath,
    server,
    hocuspocus,
    flush,
    stop(options: StopOptions = {}) {
      stopping ??= runStop(options);
      return stopping;
    },
  };
}
