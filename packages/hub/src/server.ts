import type {
  Extension,
  Hocuspocus,
  WebSocketLike,
  onAuthenticatePayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@hocuspocus/server";
import { parseRoom } from "@uberblick/schema";
import type { HubConfig } from "./config.js";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_DOCUMENTS,
} from "./config.js";
import type { HubLogger } from "./log.js";
import type { CredentialContext } from "./credential-admission.js";
import { hocuspocusLogger, stderrLogger } from "./log.js";
import { HubDatabase, isEphemeralDatabase } from "./persistence.js";
import { isAdmissibleRoom } from "./admissible-room.js";
import { DeletedRooms } from "./deleted-rooms.js";
import {
  isProtocolVersion,
  protocolMismatchReason,
  readAuthEnvelope,
  SYNC_PROTOCOL_VERSION,
} from "@uberblick/schema/protocol";
import type {
  ClampFailure,
  TokenClaims,
  TokenFailure,
  TokenIdentity,
} from "@uberblick/schema/token";
import { clampToken, importRootSecret, inspectToken } from "@uberblick/schema/token";
import { isLoopbackHost } from "@uberblick/schema/loopback";

/**
 * Local connections carry verified claims. Remote connections carry the
 * hub-owned credential and principal, with an access fence shared by hooks.
 */
export type HubContext = TokenClaims | CredentialContext;

export interface Hub {
  /** The bound port. The real one, even when `config.port` was 0. */
  readonly port: number;
  readonly databasePath: string;
  readonly server: Server<HubContext>;
  readonly hocuspocus: Hocuspocus<HubContext>;
  /** Await pending stores until documents are on disk; rejects if any store has failed. */
  flush(): Promise<void>;
  /**
   * Quiesce sockets/rooms, flush, unload, then close the database; release resources
   * even when a store fails or teardown times out, and reject on either failure.
   * Room sockets receive 1001; pending upgrades are refused and the port releases
   * immediately. Roomless sockets are unreachable through Connection.webSocket:
   * no close frame is sent, so Hocuspocus ends them with 4408 within about 60s
   * of connection. Tracking raw upgrade sockets would permit only abrupt resets.
   */
  stop(): Promise<void>;
}

/** Optional release wiring, created only after the core database is open. */
export interface HubExtensionContext {
  database: HubDatabase;
  server(): Server<HubContext>;
  deviceCredentials: boolean;
  protocolVersion: number;
  log: HubLogger;
  flush(): Promise<void>;
  storeFailure(): string | null;
}

export interface HubExtension {
  extensions: Extension[];
  admissionConfigured: boolean;
  signInConfigured: boolean;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Preserve the HTTP surface of an embedded hub with no sign-in configured. */
function handleUnconfiguredAuthRequest(request: IncomingMessage, response: ServerResponse): boolean {
  const path = request.url ?? "";
  if (!path.startsWith("/auth/")) return false;
  let status = 404;
  let body: unknown = { status: "unknown-request" };
  const claimState = path === "/auth/claim-state";
  if (claimState) {
    const valid = request.method === "GET";
    status = valid ? 200 : 405;
    body = valid ? { unclaimed: false, canClaim: false } : { status: "invalid-request" };
  } else if (["/auth/credential/renew", "/auth/manage", "/auth/github/start", "/auth/github/collect", "/auth/github/cancel",
    "/auth/browser/start", "/auth/browser/collect", "/auth/browser/cancel", "/auth/browser/session", "/auth/browser/sign-out"].includes(path)) {
    status = 503;
    body = { status: "not-configured" };
  }
  response.writeHead(status, {
    "Content-Type": "application/json", "Cache-Control": "no-store",
    ...(claimState && status === 405 ? { Allow: "GET" } : {}),
  });
  response.end(JSON.stringify(body));
  return true;
}

/** Reject even empty token query parameters: URLs reach access logs and proxy traces. */
export const TOKEN_QUERY_PARAMS = ["token", "access_token", "auth", "authToken"];

/**
 * onAuthenticate receives headers without the TCP socket. Stamp the address
 * during upgrade, overwriting client-supplied values before authentication.
 */
export const PEER_ADDRESS_HEADER = "x-uberblick-peer-address";

/** The proxy's header, read only from a peer allowed to speak for others. */
const FORWARDED_FOR_HEADER = "x-forwarded-for";

/** What an address may be spelled with. A header is not a licence to write prose into the log. */
const ADDRESS_CHARACTERS = /^[0-9a-fA-F:.%[\]]{1,64}$/;

/** Who the hub is talking to, as far as it can honestly tell. */
export interface PeerAddress {
  /** The client's address, or `"unknown"` when the socket reported none. */
  address: string;
  /** True when the address came from the trusted proxy rather than the socket. */
  proxied: boolean;
}

/** Unwrap IPv4-mapped IPv6 before recognizing loopback, private and link-local peers. */
function isLocalProxy(address: string): boolean {
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  const octets = ip.split(".");
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet))) {
    const [first = -1, second = -1] = octets.map(Number);
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  // ::1, fc00::/7 (unique local), fe80::/10 (link-local).
  const v6 = ip.toLowerCase();
  return v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * Log-only attribution, never authentication. Trust forwarded addresses only
 * from local/private/link-local peers; tailnet 100.64/10 speaks for itself.
 * Take the last hop appended by the proxy, since earlier hops may be client-controlled.
 * This assumes one proxy: Compose exposes no hub port and only Caddy reaches
 * it over the bridge. On a direct loopback bind any local client can supply a
 * forwarded address, so proxied:true without a deployed proxy is untrusted attribution.
 */
export function resolvePeer(headers: Headers): PeerAddress {
  const direct = headers.get(PEER_ADDRESS_HEADER) ?? "";
  const forwarded = headers.get(FORWARDED_FOR_HEADER);
  if (forwarded !== null && isLocalProxy(direct)) {
    const hops = forwarded.split(",");
    const observed = (hops[hops.length - 1] ?? "").trim();
    if (ADDRESS_CHARACTERS.test(observed)) {
      return { address: observed, proxied: true };
    }
  }
  return { address: direct === "" ? "unknown" : direct, proxied: false };
}

/** Every reason the hub refuses a connection, as one closed vocabulary. */
type RejectionCause =
  | "room-name-invalid"
  | "token-in-query"
  | "protocol-mismatch"
  | TokenFailure
  | ClampFailure
  | "workspace-mismatch";

/**
 * Unverified typ/sub for diagnostics only; never log the token, signature or secret.
 */
function tokenFields(identity: TokenIdentity | null): Record<string, unknown> {
  return identity === null
    ? { token: "unparseable" }
    : { typ: identity.typ, sub: identity.sub };
}

class AuthError extends Error {
  /** Hocuspocus sends this to the client as the permission-denied reason. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.reason = reason;
  }
}

export type RoomAuthenticator = (
  payload: onAuthenticatePayload<HubContext>,
) => Promise<HubContext>;

/**
 * Shared query, protocol, signature, lifetime, read-only and logging boundary.
 * ub open supplies per-workspace keys; the ordinary hub's root key admits only
 * rooms whose workspace matches the signed claim.
 */
export async function createRoomAuthenticator(options: {
  protocolVersion: number;
  log: HubLogger;
} & (
  | { authSecret: string; workspaceKeys?: never }
  | {
      workspaceKeys: ReadonlyMap<string, string>;
      authSecret?: never;
    }
)): Promise<RoomAuthenticator> {
  const rootKey = options.authSecret === undefined
    ? undefined
    : await importRootSecret(options.authSecret);
  const workspaceKeys = options.workspaceKeys === undefined
    ? undefined
    : new Map(await Promise.all([...options.workspaceKeys].map(
        async ([workspace, secret]) => [workspace, await importRootSecret(secret)] as const,
      )));

  return async (payload) => {
    const { documentName, requestHeaders, requestParameters, connectionConfig } = payload;
    // Attribute each rejection to its peer without exposing token contents.
    const peer = resolvePeer(requestHeaders);
    if (!isAdmissibleRoom(documentName)) {
      options.log({ event: "hub.auth.rejected", peer: peer.address,
        proxied: peer.proxied, cause: "room-name-invalid" });
      throw new AuthError("room-name-invalid", "room name exceeds admission bounds");
    }
    const rejected = (
      cause: RejectionCause,
      fields: Record<string, unknown> = {},
    ) => ({
      event: "hub.auth.rejected",
      room: documentName,
      peer: peer.address,
      proxied: peer.proxied,
      ...fields,
      cause,
    });

    const queried = TOKEN_QUERY_PARAMS.find((name) =>
      requestParameters.has(name),
    );
    if (queried !== undefined) {
      // No token identity here: the connection is refused on the URL, before
      // any token has been read, and the parameter is the whole finding.
      options.log(rejected("token-in-query", { parameter: queried }));
      throw new AuthError(
        "token-in-query",
        `token must be sent in the auth message, not the "${queried}" query parameter`,
      );
    }

    // Bound the envelope before parsing; reject skew/bare tokens before trusting claims.
    const envelope = readAuthEnvelope(payload.token);
    if (
      envelope === null ||
      envelope.protocolVersion !== options.protocolVersion
    ) {
      options.log(
        rejected("protocol-mismatch", {
          // Integers or absence only: never log the token or its envelope.
          clientProtocol: envelope?.protocolVersion ?? null,
          hubProtocol: options.protocolVersion,
        }),
      );
      throw new AuthError(
        protocolMismatchReason(options.protocolVersion),
        `this hub speaks sync protocol ${options.protocolVersion}`,
      );
    }

    const workspace = roomWorkspace(documentName);
    // Select by the requested room, never by an unverified token claim. A
    // served workspace's key cannot mint admission to a different store.
    const verificationKey = workspaceKeys === undefined
      ? rootKey
      : workspace === null ? undefined : workspaceKeys.get(workspace);
    if (verificationKey === undefined) {
      options.log(rejected("workspace-mismatch"));
      throw new AuthError("workspace-mismatch", "room is outside the served workspaces");
    }
    const inspected = await inspectToken(verificationKey, envelope.token);
    if ("failure" in inspected) {
      options.log(rejected(inspected.failure, tokenFields(inspected.identity)));
      throw new AuthError(
        "invalid-token",
        "token is missing, malformed or badly signed",
      );
    }
    const claims = inspected;

    // Every client mints locally, so the hub applies the lifetime ceiling.
    // Log the specific cause, but expose the same wire refusal for an expired
    // token as for a forged one.
    const clamped = clampToken(claims, Math.floor(Date.now() / 1000));
    if (clamped !== null) {
      options.log(rejected(clamped, { typ: claims.typ, sub: claims.sub }));
      throw new AuthError(
        "invalid-token",
        "token is missing, malformed or badly signed",
      );
    }

    if (workspace === null || workspace !== claims.workspace) {
      options.log(
        rejected("workspace-mismatch", {
          typ: claims.typ,
          sub: claims.sub,
          workspace: claims.workspace,
        }),
      );
      throw new AuthError(
        "workspace-mismatch",
        `token for workspace "${claims.workspace}" may not open room "${documentName}"`,
      );
    }

    if (claims.scope === "read-only") {
      connectionConfig.readOnly = true;
    }

    options.log({
      event: "hub.auth.accepted",
      room: documentName,
      sub: claims.sub,
      workspace: claims.workspace,
      scope: claims.scope,
    });

    return claims;
  };
}

/**
 * Schema owns two-segment room names with a bare workspace UUID.
 * Reject malformed names before they can become authenticated rooms or SQLite keys.
 */
function roomWorkspace(room: string): string | null {
  try {
    return parseRoom(room).workspaceId;
  } catch {
    return null;
  }
}

function unconfiguredRoomAuthenticator(protocolVersion: number, log: HubLogger): RoomAuthenticator {
  return async payload => {
    if (!isAdmissibleRoom(payload.documentName)) {
      log({ event: "hub.auth.rejected", cause: "room-name-invalid" });
      throw new AuthError("room-name-invalid", "room name exceeds admission bounds");
    }
    const envelope = readAuthEnvelope(payload.token);
    const reason = envelope === null || envelope.protocolVersion !== protocolVersion
      ? protocolMismatchReason(protocolVersion) : "device-sign-in-unavailable";
    log({ event: "hub.auth.rejected", cause: "sign-in-not-configured" });
    throw new AuthError(reason, "Remote hub requires configured GitHub sign-in");
  };
}

/**
 * Awaitable counterpart to Hocuspocus' void flushPendingStores. Immediate stores
 * cancel pending timers, wait for in-flight writes and use the document save mutex.
 * Skip loading/clean documents; disconnect already stores them when needed.
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

/** WebSocket "going away": the hub is leaving, this client did nothing wrong. */
const GOING_AWAY = 1001;

/**
 * Collect before closing rooms, which removes the connections exposing sockets.
 * Deduplicate multiplexed rooms; Hocuspocus closes rooms without a websocket
 * close frame, so the hub closes these sockets itself. Roomless sockets remain unreachable.
 */
function openSockets(hocuspocus: Hocuspocus<HubContext>): Set<WebSocketLike> {
  const sockets = new Set<WebSocketLike>();
  for (const document of hocuspocus.documents.values()) {
    for (const connection of document.getConnections()) {
      sockets.add(connection.webSocket);
    }
  }
  return sockets;
}

/** Send each collected socket the close frame. Never fails a shutdown. */
function closeSockets(sockets: Set<WebSocketLike>, log: HubLogger): void {
  let closed = 0;
  for (const socket of sockets) {
    try {
      socket.close(GOING_AWAY, "hub shutting down");
      closed += 1;
    } catch (error) {
      // A concurrently closed socket must not turn teardown into a failure.
      log({ event: "hub.stop.socketCloseFailed", error: String(error) });
    }
  }
  if (closed > 0) {
    log({ event: "hub.stop.socketsClosed", sockets: closed });
  }
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
 * Server.listen does not watch HTTP errors. Reject bind failures instead of
 * leaving a pending promise and uncaught error; remove this listener after startup.
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
 * Resolve only with an open database and bound port; release both on startup failure.
 * Signal handlers belong to main.ts so this factory stays embeddable.
 */
export async function createHub(config: HubConfig, options: {
  /** Test seam that can only make loopback admission stricter. */
  deviceCredentials?: true;
  extension?: (context: HubExtensionContext) => HubExtension;
} = {}): Promise<Hub> {
  const address = config.address ?? DEFAULT_HOST;
  const deviceCredentials = !isLoopbackHost(address) || options.deviceCredentials === true;
  if (!deviceCredentials && (config.authSecret === undefined || config.authSecret === "")) {
    throw new Error(
      "createHub: authSecret must not be empty — it is the HMAC secret tokens are signed with",
    );
  }

  const log = config.log ?? stderrLogger;
  // Production uses the build version; tests can override one end to observe skew.
  const protocolVersion = config.protocolVersion ?? SYNC_PROTOCOL_VERSION;
  // Versions outside 1..999999 cannot be represented by the refusal sentinel.
  if (!isProtocolVersion(protocolVersion)) {
    throw new Error(
      `createHub: protocolVersion must be an integer between 1 and 999999, got ${protocolVersion}`,
    );
  }
  const authenticate = deviceCredentials ? undefined : await createRoomAuthenticator({
    authSecret: config.authSecret ?? "",
    protocolVersion,
    log,
  });
  const databasePath = config.databasePath;
  if (databasePath === undefined || databasePath.trim() === "") {
    throw new Error("createHub: databasePath must not be empty");
  }
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 10_000;

  // Hocuspocus swallows store failures; retain the first so flush/stop cannot claim durability.
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
    // Anonymous databases lose all writes when this handle closes.
    log({ event: "hub.database.ephemeral", database: databasePath });
  }

  let extension: HubExtension | undefined;
  try {
    extension = options.extension?.({ database, server: () => server, deviceCredentials, protocolVersion, log,
      flush, storeFailure: () => storeFailure === undefined ? null : String(storeFailure.error) });
  } catch (error) {
    closeDatabase();
    throw error;
  }

  const deletedRooms: DeletedRooms = new DeletedRooms(database, () => server.hocuspocus);
  const server = new Server<HubContext>({
    port: config.port ?? DEFAULT_PORT,
    address,
    // Leave process signals to main.ts; embedded/test hubs must not install handlers.
    stopOnSignals: false,
    // No start banner on stdout; startup is one structured line on stderr.
    quiet: true,
    logger: hocuspocusLogger(log),
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES },
    // Own the auth-in-flight ceiling across library upgrades; see MAX_PENDING_DOCUMENTS.
    maxPendingDocuments: config.maxPendingDocuments ?? MAX_PENDING_DOCUMENTS,
    ...(config.debounce === undefined ? {} : { debounce: config.debounce }),
    ...(config.maxDebounce === undefined
      ? {}
      : { maxDebounce: config.maxDebounce }),
    extensions: [database, ...(extension?.extensions ?? [])],

    /**
     * Stamp the direct peer before losing the socket. Never throw: Hocuspocus
     * rethrows upgrade errors from an async listener with no catch.
     */
    async onUpgrade({ request }) {
      request.headers[PEER_ADDRESS_HEADER] = request.socket?.remoteAddress ?? "";
    },

    ...(authenticate !== undefined ? { onAuthenticate: authenticate } :
      extension?.admissionConfigured === true ? {} : {
        onAuthenticate: unconfiguredRoomAuthenticator(protocolVersion, log),
      }),

    async onRequest({ request, response }) {
      if (extension !== undefined
        ? await extension.handleRequest(request, response)
        : handleUnconfiguredAuthRequest(request, response)) return Promise.reject();
    },

    ...deletedRooms.hooks(),

    /**
     * These hooks run per room; socketId groups multiplexed rooms and changes on reconnect.
     * connected has verified claims; Connection.onClose retains the close event
     * that onDisconnect discards. Empty/absent client close reasons share client-gone;
     * hub resets/timeouts keep their supplied code/reason.
     */
    async connected({ documentName, context, socketId, connection }) {
      deletedRooms.requireRoom(documentName, connection);
      log({
        event: "hub.room.connected",
        room: documentName,
        sub: "principalId" in context ? context.principalId : context.sub,
        socketId,
      });

      connection.onClose((_document, event) => {
        log({
          event: "hub.room.closed",
          room: documentName,
          sub: "principalId" in context ? context.principalId : context.sub,
          socketId,
          code: event?.code ?? null,
          reason: event?.reason || "client-gone",
        });
      });
    },
  });


  let hocuspocus: Hocuspocus<HubContext>;
  try {
    await extension?.start();
    hocuspocus = await listen(server);
  } catch (error) {
    // Startup rejection must leave no socket, database or identity task running.
    await extension?.stop();
    await server.destroy().catch((cleanup: unknown) => {
      log({ event: "hub.start.cleanupFailed", error: String(cleanup) });
    });
    closeDatabase();
    throw error;
  }
  const port = server.address.port;

  log({ event: "hub.listen", address, port, database: databasePath });
  if (deviceCredentials && extension?.signInConfigured !== true) {
    log({ event: "hub.auth.unavailable", reason: "GitHub sign-in is not configured; this remote hub admits no clients" });
  }

  /** The sticky store failure, as the error a durability claim should not hide. */
  function storeError(): Error | undefined {
    return storeFailure === undefined
      ? undefined
      : new Error(
          "hub: a document store failed, so the hub's state is not durable: " +
            String(storeFailure.error),
          { cause: storeFailure.error },
        );
  }

  async function flush(): Promise<void> {
    await deletedRooms.flush();
    await flushPendingStores(server.hocuspocus, log);
    const failed = storeError();
    if (failed !== undefined) {
      throw failed;
    }
  }
  let stopping: Promise<void> | undefined;

  const runStop = async (): Promise<void> => {
    // Fence asynchronous identity reads before any database teardown. An
    // outstanding HTTP request can complete only with a safe failure now.
    await extension?.stop();
    // Closing rooms removes the connections exposing their sockets.
    const sockets = openSockets(hocuspocus);

    // Stop admissions and begin socket closes before room Close messages can provoke
    // replies/reattachment. Quiesce before flushing so no update can dirty a stored document.
    server.httpServer.close();
    closeSockets(sockets, log);
    hocuspocus.closeConnections();

    // Flush failure must still release resources, then reject stop().
    let failure: unknown;
    try {
      await flush();
    } catch (error) {
      failure = error;
    }

    // A failing store can prevent document unload forever; bound destroy and retain the timeout.
    let timedOut = false;
    await withTimeout(server.destroy(), shutdownTimeoutMs, () => {
      timedOut = true;
      log({
        event: "hub.stop.timeout",
        timeoutMs: shutdownTimeoutMs,
        documents: hocuspocus.getDocumentsCount(),
      });
    });

    // End HTTP keep-alives; Node no longer tracks upgraded websockets here.
    server.httpServer.closeAllConnections?.();

    closeDatabase();

    // Teardown stores too, swallowing failures; recheck the sticky error after it finishes.
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
