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
 *    A refusal is one `hub.auth.rejected` line naming the peer, a stable cause
 *    and whatever the token said about itself; the client still learns only
 *    that it was refused.
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

import type {
  Hocuspocus,
  WebSocketLike,
  onAuthenticatePayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import { Server } from "@hocuspocus/server";
import { parseRoom } from "@uberblick/schema";
import type { HubConfig } from "./config.js";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_PENDING_DOCUMENTS,
  defaultDatabasePath,
  validateGithubClientId,
} from "./config.js";
import type { HubLogger } from "./log.js";
import { CredentialRegistry } from "./credentials.js";
import { handleCredentialRenewal } from "./credential-renewal.js";
import { startAdminSetup } from "./admin-setup.js";
import { GithubSignIn, handleGithubSignIn } from "./github-sign-in.js";
import { HubClaimState, handleHubClaimState } from "./hub-claim.js";
import { MembershipRegistry } from "./memberships.js";
import { PrincipalRegistry } from "./principals.js";
import { stderrLogger } from "./log.js";
import { HubDatabase, isEphemeralDatabase } from "./persistence.js";
import {
  isProtocolVersion,
  protocolMismatchReason,
  readAuthEnvelope,
  SYNC_PROTOCOL_VERSION,
} from "./protocol.js";
import type {
  ClampFailure,
  TokenClaims,
  TokenFailure,
  TokenIdentity,
} from "./token.js";
import { clampToken, importRootSecret, inspectToken } from "./token.js";

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
   * Quiesce every client websocket and its rooms, flush, unload documents, and
   * close the database. Rejects unless the hub's state is known to be on disk
   * when it returns — a failed store, before or during teardown, or a teardown
   * that did not finish inside the shutdown timeout. The resources are released
   * either way, so a caller can exit on the rejection rather than because of it.
   *
   * **What a client sees.** A socket holding at least one room is sent a `1001`
   * close frame and reports itself disconnected within ~5–10ms, which is what
   * makes an in-process stop as legible as a killed process — see
   * {@link openSockets} for why that is not what Hocuspocus does on its own. A
   * client whose upgrade is in flight, or accepted but not yet upgraded, when
   * `stop()` is called is refused within ~5ms by the `httpServer.close()` that
   * runs first, so it never lands on a dead socket either.
   *
   * **The one exception**, a boundary rather than a bug: a socket holding *no*
   * room — never authenticated, token refused, every room detached — is sent no
   * frame, because Hocuspocus exposes a socket only through
   * `Connection.webSocket`. Hocuspocus' own connection timeout ends it instead,
   * with code `4408`, no later than about 60s after it connected; the port is
   * released immediately either way. Reaching those sockets would mean tracking
   * raw ones from `onUpgrade`, where a socket can only be destroyed and not
   * closed — trading a 60s wait for an abrupt reset, on a connection that by
   * definition holds no client state — so it is not done.
   */
  stop(): Promise<void>;
}

/** Query parameters that would carry a token. Their presence is a rejection. */
export const TOKEN_QUERY_PARAMS = ["token", "access_token", "auth", "authToken"];

/**
 * The header the upgrade hook stamps the direct peer's address into, and the
 * only way `onAuthenticate` can learn it.
 *
 * Hocuspocus hands the auth hook a web-standard `Request` rebuilt from the
 * upgrade request's headers; the TCP socket, and with it `remoteAddress`, is
 * not on it. `onUpgrade` is the last hook that still holds the Node request, so
 * that is where the address is written. Stamped unconditionally: a client that
 * sends this header itself has its value overwritten before anything reads it.
 *
 * Exported for the tests, which build the headers `onAuthenticate` would see.
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

/**
 * Loopback, private, or link-local: an address no client reaches this hub from.
 *
 * Node reports an IPv4 peer on a dual-stack socket as `::ffff:127.0.0.1`, so
 * the mapped form is unwrapped first.
 */
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
 * The address to name in a log line: the socket's peer, or — when that peer is
 * the deployment's own proxy — the address the proxy observed.
 *
 * Exported for the tests, which cannot open a socket from an untrusted address.
 *
 * **Which peers may speak for others.** Only one that is not globally routable.
 * In the Compose deployment the hub publishes no port and Caddy reaches it over
 * the bridge network, so a private address on that socket is the proxy; a
 * client dialling the hub directly arrives from the tailnet (100.64/10,
 * deliberately not in the list) and speaks only for itself.
 *
 * **Which hop of `X-Forwarded-For`.** The *last* one — the address the proxy
 * itself saw. With this repo's Caddyfile, which configures no `trusted_proxies`,
 * Caddy discards whatever the client put in that header and writes the single
 * peer it observed, so the header has one hop today and both readings coincide.
 * The last hop is taken because it stays correct if `trusted_proxies` is ever
 * configured: Caddy would then preserve the client's entries and append its
 * own, making the conventional leftmost entry client-controlled. Two chained
 * proxies would make it the inner proxy's address, which is the reason the
 * deployment stays one hop deep.
 *
 * **What this address is for.** A log field, and never an auth input: nothing
 * downstream branches on it, so a wrong `peer` misleads a reader rather than
 * admitting a connection. That matters because the trust rule is about the
 * *shape* of the direct peer, not about a configured proxy — on a loopback-bound
 * `mise run hub` any local client can send `X-Forwarded-For` and be logged with
 * `proxied: true`, and `proxied: true` on a hub that has no proxy in front of it
 * is exactly the tell. In the Compose deployment it cannot happen at all: the
 * hub publishes no port, so Caddy on the bridge network is the only thing that
 * can open that socket.
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
  | "token-in-query"
  | "protocol-mismatch"
  | TokenFailure
  | ClampFailure
  | "workspace-mismatch";

/**
 * The token's own account of itself on a rejection line: `typ` and `sub` when
 * the payload was readable at all, and the fact that it was not otherwise.
 * Unverified by construction — the token did not verify — and never the token,
 * its signature or the secret.
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
 * Build the hub's room-authentication boundary for any Hocuspocus server.
 *
 * `ub open` serves rooms from one workspace-local store, so it supplies
 * `servedWorkspace`; the ordinary hub omits it and may admit any workspace
 * whose room and signed claim agree. Everything else — query-token refusal,
 * protocol envelope, signature and lifetime checks, read-only scope and log
 * vocabulary — is deliberately one implementation.
 */
export async function createRoomAuthenticator(options: {
  authSecret: string;
  protocolVersion: number;
  log: HubLogger;
  servedWorkspace?: string;
}): Promise<RoomAuthenticator> {
  const rootKey = await importRootSecret(options.authSecret);

  return async ({
    token,
    documentName,
    requestHeaders,
    requestParameters,
    connectionConfig,
  }) => {
    // Every rejection names the peer. A rejection nobody can attribute is
    // the operational problem this event exists to solve: several machines,
    // browser tabs and long-lived agent sessions present tokens to one server.
    const peer = resolvePeer(requestHeaders);
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

    // The version exchange comes before anything about the token is believed,
    // and before JSON parsing, which keeps MAX_TOKEN_LENGTH's promise that an
    // unauthenticated caller cannot choose how much work the server does. A
    // bare token is a flag-day mismatch too.
    const envelope = readAuthEnvelope(token);
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

    const inspected = await inspectToken(rootKey, envelope.token);
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

    const workspace = roomWorkspace(documentName);
    if (
      workspace === null ||
      workspace !== claims.workspace ||
      (options.servedWorkspace !== undefined &&
        workspace !== options.servedWorkspace)
    ) {
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

/** WebSocket "going away": the hub is leaving, this client did nothing wrong. */
const GOING_AWAY = 1001;

/**
 * The websockets the hub is currently holding, one entry per socket.
 *
 * Hocuspocus' `closeConnections()` closes *rooms*: it sends each connection an
 * in-band close message and drops it from its document, and leaves the socket
 * underneath open. A client therefore hears nothing it can act on when a hub
 * stops in-process — every room dead, no close frame, nothing that will ever
 * offer a token again — until its own dead-connection timer fires some thirty
 * seconds later, where a `SIGKILL`ed hub is noticed in milliseconds. Sending
 * the frame is what makes `stop()`'s "quiesce connections" true for the client
 * as well as for the server.
 *
 * The sockets are read back from the documents, so this must run *before* the
 * rooms are closed: closing one removes the connection that names its socket.
 * One client on three documents is three connections over one socket, hence the
 * Set. A socket holding no room is not reachable here at all; {@link Hub.stop}
 * states what that costs.
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
      // A socket that went away between the two steps is already gone, and
      // releasing one is never the reason a shutdown reports failure.
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
export async function createHub(config: HubConfig, options: {
  operatorSetup?: boolean;
  initializeDefaultWorkspace?: boolean;
} = {}): Promise<Hub> {
  if (config.github !== undefined) validateGithubClientId(config.github.clientId);
  if (config.authSecret === "") {
    throw new Error(
      "createHub: authSecret must not be empty — it is the HMAC secret tokens are signed with",
    );
  }

  const log = config.log ?? stderrLogger;
  // The build's, unless a test moved one end to observe a skew. See HubConfig.
  const protocolVersion = config.protocolVersion ?? SYNC_PROTOCOL_VERSION;
  // Held to the range the wire can carry: the refusal sentinel is the only way
  // a client learns this number, and it can only spell 1..999999. A hub outside
  // it would refuse every client with a reason none of them could read.
  if (!isProtocolVersion(protocolVersion)) {
    throw new Error(
      `createHub: protocolVersion must be an integer between 1 and 999999, got ${protocolVersion}`,
    );
  }
  const authenticate = await createRoomAuthenticator({
    authSecret: config.authSecret,
    protocolVersion,
    log,
  });
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

  let signIn: GithubSignIn | undefined;
  let credentials: CredentialRegistry | undefined;
  let principals: PrincipalRegistry | undefined;
  let memberships: MembershipRegistry | undefined;
  let claims: HubClaimState | undefined;
  try {
    // Standalone entry points opt in. ub open's embedded hub never initializes
    // or claims, even when it offers an explicitly configured GitHub sign-in.
    if (options.initializeDefaultWorkspace) claims = new HubClaimState(database);
    if (config.github !== undefined || options.operatorSetup) {
      principals = new PrincipalRegistry(database);
      memberships = new MembershipRegistry(database);
      if (config.github !== undefined) {
        credentials = new CredentialRegistry(database);
        signIn = new GithubSignIn(config.github, database, principals, credentials, memberships, log, claims);
      }
    }
  } catch (error) {
    closeDatabase();
    throw error;
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
    // The hub states its own ceiling rather than inheriting a library default
    // that an upgrade could move under it. See MAX_PENDING_DOCUMENTS for why
    // this is a guard and not a capacity knob, and why its two siblings stay
    // at their defaults.
    maxPendingDocuments: config.maxPendingDocuments ?? MAX_PENDING_DOCUMENTS,
    ...(config.debounce === undefined ? {} : { debounce: config.debounce }),
    ...(config.maxDebounce === undefined
      ? {}
      : { maxDebounce: config.maxDebounce }),
    extensions: [database],

    /**
     * Stamp the direct peer's address onto the upgrade request, the one place
     * it is still reachable. See {@link PEER_ADDRESS_HEADER}. It must not throw:
     * Hocuspocus rethrows out of an async `upgrade` listener, which nothing
     * catches.
     */
    async onUpgrade({ request }) {
      request.headers[PEER_ADDRESS_HEADER] = request.socket?.remoteAddress ?? "";
    },

    onAuthenticate: authenticate,

    async onRequest({ request, response }) {
      if (handleHubClaimState(claims, signIn !== undefined, request, response)) return Promise.reject();
      if (await handleCredentialRenewal(credentials, memberships, protocolVersion, log, request, response)) {
        return Promise.reject();
      }
      if (await handleGithubSignIn(signIn, request, response)) return Promise.reject();
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
  let adminSetup: Awaited<ReturnType<typeof startAdminSetup>> | undefined;
  try {
    if (options.operatorSetup) {
      if (principals === undefined || memberships === undefined || isEphemeralDatabase(databasePath)) {
        throw new Error("hub setup: durable hub database required");
      }
      adminSetup = await startAdminSetup({ database, principals, memberships, claims,
        github: config.github, log, hasLiveDocuments: (workspaceId) =>
          [...server.hocuspocus.documents.keys()].some((name) => name.startsWith(`${workspaceId}/`)) });
    }
    hocuspocus = await listen(server);
  } catch (error) {
    // Half a hub is worse than none: release the socket and the handle so the
    // caller sees a rejection and nothing else.
    signIn?.stop();
    await adminSetup?.stop();
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
    // Fence asynchronous identity reads before any database teardown. An
    // outstanding HTTP request can complete only with a safe failure now.
    signIn?.stop();
    await adminSetup?.stop();
    // Collected before the rooms are closed, because closing one removes the
    // connection that names its socket. See openSockets.
    const sockets = openSockets(hocuspocus);

    // Quiesce first. Begin the websocket close before closing its rooms, so
    // Hocuspocus' per-room Close messages cannot provoke replies or another
    // admission wave on the socket being stopped. Closing the rooms then makes
    // the flush final: while clients can still send updates — or connect — a
    // document can go dirty again after it was stored, and the write that would
    // have caught up happens during the teardown, where a failure is
    // Hocuspocus' to swallow.
    server.httpServer.close();
    closeSockets(sockets, log);
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

    // Plain HTTP keep-alive connections only: Node stops tracking a socket the
    // moment it is upgraded, so this reaches no websocket, and the port is
    // released by `httpServer.close()` above either way. It is kept because a
    // request that never upgraded is otherwise free to hold its socket open.
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
