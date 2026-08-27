/**
 * Background sync with the hub.
 *
 * Everything here is optional to the server's operation. The local update log
 * is the authoritative replica; this module only pushes it up and pulls other
 * clients' updates down. Nothing in a tool call waits for the hub beyond a
 * bounded settle, and a hub that is down, unreachable or refusing the token
 * changes no tool's answer except `sync_status`.
 *
 * Four decisions worth keeping:
 *
 * - **One shared websocket for every room.** `HocuspocusProviderWebsocket` is
 *   created once and every per-room `HocuspocusProvider` attaches to it. A
 *   socket per document would mean one TCP connection, one auth handshake and
 *   one reconnect backoff per doc, and the corpus is enumerated in full on
 *   hydration.
 * - **The token is an async callable**, not a string: `mintToken` is async, and
 *   a callable is also what a real account service would need on reconnect. It
 *   travels in Hocuspocus' auth message, never in the URL. Tokens expire, so a
 *   callable is also what makes every reconnect mint a fresh one rather than
 *   replay a stale one.
 * - **"Hub down" and "auth failed" are different answers.** A rejected token is
 *   a configuration error a human must fix; an unreachable hub resolves itself.
 *   {@link HubSync.state} keeps them distinct, and every mutating tool reports
 *   it, because `{applied, synced}` without a reason is not actionable.
 * - **A connection the hub has disowned is rebuilt, not kept.** A hub closes a
 *   room, or refuses a token, without closing the socket underneath — so the
 *   socket outlives the hub that answered on it and nothing re-handshakes.
 *   {@link MAX_REBUILDS} is why, and how far it goes.
 */

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  importRootSecret,
  mintToken,
} from "@uberblick/hub/token";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";

export type HubStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "hub-down"
  | "auth-failed"
  | "quarantined";

export interface HubState {
  status: HubStatus;
  /** The endpoint being dialled, or null when sync is disabled. */
  url: string | null;
  /**
   * Why, for `auth-failed` and `hub-down`. Always composed here, never taken
   * from the wire — see {@link AUTH_REJECTED}.
   */
  reason?: string;
}

/**
 * What a rejected token reports, in place of whatever the endpoint said.
 *
 * The hub's rejection message is remote-supplied text, and the thing it is
 * rejecting is a token we just sent it: an endpoint that is hostile or merely
 * careless can echo that token straight back, and this reason is rendered by
 * `sync_status`, by every mutating tool's `{applied, synced}`, by `ub status`,
 * and by the stderr log. So the reason is fixed locally and the remote string is
 * dropped where it arrives. Which endpoint refused is already in `url`, and the
 * fix — the secret — is local either way.
 */
const AUTH_REJECTED = "authentication rejected by hub";

/**
 * How many times a connection the hub has disowned is rebuilt before the
 * answer is that the hub, not the socket, is the problem.
 *
 * A hub closes a room — its shutdown does exactly that, once per room per
 * client, with `4205 Reset Connection` — without closing the websocket
 * underneath it. Nothing on that socket ever offers a token again, so the room
 * is left unauthenticated and unsynced while {@link HubSync.state} still calls
 * the socket connected, and a hub that restarts on the same address is a
 * different process the old socket cannot reach at all. Only a new connection
 * re-handshakes every room, so a disowned one is dropped and dialled again.
 *
 * Bounded, and bounded per *durable* connection — see
 * {@link HubSync.hubDisownedRoom}. Three rebuilds cover a restart, whose first
 * one lands as soon as the hub is back; once they are spent this stops
 * re-dialling and leaves recovery to the provider's own dead-connection
 * timeout, because a hub that goes on disowning a room is not something a
 * fourth socket fixes. The budget matters most where the hub is *not* uniformly
 * broken: a document the hub cannot load is refused after the token has been
 * accepted, so the rooms beside it keep working, and without a bound this would
 * tear a healthy connection down several times a second forever.
 */
const MAX_REBUILDS = 3;

export interface AttachOptions {
  room: string;
  doc: Y.Doc;
  awareness: Awareness;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HubSync {
  /** False when no `HUB_AUTH_TOKEN` was configured: local-only, by design. */
  readonly enabled: boolean;

  private readonly config: McpConfig;

  private readonly onConnected: () => void;

  private readonly socket: HocuspocusProviderWebsocket | null = null;

  private readonly providers = new Map<string, HocuspocusProvider>();

  private socketStatus: "connecting" | "connected" | "disconnected" =
    "connecting";

  /** A close or failed connect seen since the last successful open. */
  private sawFailure = false;

  /**
   * When the current run of connection attempts started. A socket that has not
   * connected within the connect grace is reported as a hub that is down, even
   * if no close event arrived to prove it — "connecting" forever is not an
   * answer an agent can act on.
   */
  private connectingSince = Date.now();

  /**
   * Whether the hub refused our token — a flag, not the hub's message, so there
   * is nothing remote to leak downstream.
   */
  private authRejected = false;

  /** The socket's own first retry delay, reused by {@link rebuild}. */
  private readonly reconnectDelayMs: number;

  /** Rebuilt connections since the last durable one. See {@link MAX_REBUILDS}. */
  private rebuilds = 0;

  /**
   * Rooms that have synced on the connection currently open — the whole of what
   * "this connection worked" means, and cleared the moment a new one opens.
   *
   * Synced, not authenticated, because an accepted token is not evidence: a hub
   * that cannot load a document accepts the token for its room and refuses the
   * room immediately afterwards, so counting handshakes would call that
   * connection durable and hand it a fresh budget on every rebuild.
   */
  private readonly syncedRooms = new Set<string>();

  /** Whether the hub has already disowned a room on the connection now open. */
  private connectionDisowned = false;

  /** The rebuild waiting out its backoff — every room's close shares one. */
  private rebuildTimer: NodeJS.Timeout | null = null;

  /** True between a rebuild's disconnect and the reconnect it is waiting for. */
  private rebuilding = false;

  /** Set by {@link quarantine}: this process may no longer publish anything. */
  private quarantined = false;

  private destroyed = false;

  /**
   * The signing key, imported once. `mintToken` takes a key rather than a
   * secret — the type is what keeps a credential string from being handed to it
   * by mistake — and importing per mint would repeat that work on every
   * reconnect.
   */
  private signingKey: Promise<CryptoKey> | null = null;

  constructor(config: McpConfig, onConnected: () => void) {
    this.config = config;
    this.onConnected = onConnected;
    this.enabled = config.authSecret !== null;
    // A local hub restart should be picked up in seconds, not minutes: the
    // default backoff climbs to 30s, which would strand an offline-created doc
    // long after the hub is back. It is the socket's first retry delay — and
    // its `minDelay`, the retry library's floor, which must not exceed that
    // delay or the cap — and the first delay a rebuild waits out.
    this.reconnectDelayMs = Math.min(250, config.reconnectMaxDelayMs);

    if (!this.enabled) {
      log.warn(
        "HUB_AUTH_TOKEN is not set: running local-only, no hub sync (every tool still works)",
      );
      return;
    }

    this.socket = new HocuspocusProviderWebsocket({
      url: config.hubUrl,
      delay: this.reconnectDelayMs,
      minDelay: this.reconnectDelayMs,
      factor: 2,
      maxDelay: config.reconnectMaxDelayMs,
      jitter: false,
      onStatus: ({ status }) => {
        const previous = this.socketStatus;
        this.socketStatus = status as "connecting" | "connected" | "disconnected";
        if (status === "connected") {
          this.sawFailure = false;
          // A new connection has proven nothing yet and dropped nothing yet.
          // This runs before any of its rooms can answer, which is what makes
          // the two sets below a record of this connection and no other.
          this.syncedRooms.clear();
          this.connectionDisowned = false;
          this.onConnected();
          return;
        }
        if (previous === "connected") {
          this.connectingSince = Date.now();
        }
        // `disconnect()` stops the socket retrying, and `connect()` is a no-op
        // until the close has actually landed — so a rebuild dials from here,
        // where the socket has just said it is down, rather than guessing when.
        if (status === "disconnected" && this.rebuilding) {
          this.rebuilding = false;
          if (this.destroyed || this.quarantined) {
            return;
          }
          void this.socket?.connect().catch(() => {
            // The socket retries a failed dial forever; nothing here to report.
          });
        }
      },
      onClose: () => {
        this.sawFailure = true;
      },
    });
  }

  /** Mint a fresh token for this agent session. */
  private token(): Promise<string> {
    const secret = this.config.authSecret;
    if (secret === null) {
      throw new Error("HubSync.token: sync is disabled");
    }
    this.signingKey ??= importRootSecret(secret);
    return this.signingKey.then((key) =>
      mintToken(key, {
        typ: "room",
        sub: this.config.sessionId,
        workspace: this.config.workspaceId,
        scope: "read-write",
        // Root-signed: this process holds the root secret, not a credential.
        kid: null,
        // The ceiling itself. A room token is minted per connect, so a longer
        // life would buy nothing and a shorter one would only add reconnects.
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      }),
    );
  }

  /**
   * The hub let go of one room — a close it sent, or a token it refused — on a
   * connection it is otherwise keeping open. Decide what that says about the
   * connection, then rebuild it.
   *
   * The decision can only be made here, because it is about the connection this
   * room has just been dropped from: if it had every attached room in sync
   * before that, it was a working connection that something ended — a hub
   * shutting down, most often — and the rebuild that follows is the first of a
   * fresh budget. If it did not, this is the same connection failing the same
   * way again, and the budget it is spending is the one that stops it.
   *
   * Only the first disowned room of a connection judges it. A shutdown closes
   * every room, and the second close says nothing the first did not.
   */
  private hubDisownedRoom(): void {
    // The socket itself going away is not this: it already retries on its own,
    // and it takes every room with it.
    if (this.socketStatus !== "connected") {
      return;
    }
    if (!this.connectionDisowned && this.everyRoomSynced()) {
      this.rebuilds = 0;
    }
    this.connectionDisowned = true;
    this.rebuild();
  }

  /** Whether every attached room has synced on the connection now open. */
  private everyRoomSynced(): boolean {
    for (const room of this.providers.keys()) {
      if (!this.syncedRooms.has(room)) {
        return false;
      }
    }
    return this.providers.size > 0;
  }

  /**
   * Drop this socket and dial again, on the reconnect backoff.
   *
   * See {@link MAX_REBUILDS} for why a new connection is the only thing that
   * recovers a room the hub has disowned, and where this stops.
   *
   * One rebuild per backoff window, because a hub shutdown closes every room:
   * the first close schedules it and the rest are already covered.
   */
  private rebuild(): void {
    if (
      this.socket === null ||
      this.destroyed ||
      this.quarantined ||
      this.rebuildTimer !== null ||
      this.rebuilding ||
      this.socketStatus !== "connected" ||
      this.rebuilds >= MAX_REBUILDS
    ) {
      return;
    }

    const delay = Math.min(
      this.reconnectDelayMs * 2 ** this.rebuilds,
      this.config.reconnectMaxDelayMs,
    );
    this.rebuilds += 1;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      // A socket that went down on its own in the meantime is already retrying.
      if (
        this.destroyed ||
        this.quarantined ||
        this.socketStatus !== "connected"
      ) {
        return;
      }
      this.rebuilding = true;
      this.socket?.disconnect();
    }, delay);
  }

  /**
   * Join a room, or do nothing when sync is disabled or the room is already
   * attached. Never throws and never waits: the provider connects, retries and
   * syncs in the background.
   */
  attach({ room, doc, awareness }: AttachOptions): void {
    if (
      this.socket === null ||
      this.destroyed ||
      this.quarantined ||
      this.providers.has(room)
    ) {
      return;
    }

    const provider = new HocuspocusProvider({
      name: room,
      document: doc,
      awareness,
      websocketProvider: this.socket,
      token: () => this.token(),
      onAuthenticated: () => {
        this.authRejected = false;
      },
      onSynced: ({ state }) => {
        if (state) {
          this.syncedRooms.add(room);
        }
      },
      onAuthenticationFailed: () => {
        // Distinct from an unreachable hub: a human has to fix the secret. The
        // hub's own wording is discarded rather than stored or logged — it is
        // remote text about a token we just sent, and every consumer of this
        // state renders it. See AUTH_REJECTED.
        this.authRejected = true;
        log.error("hub rejected the token", { room });
        // A hub on its way out refuses the room it is unloading, and one that
        // cannot load a document refuses that document's room after accepting
        // the token — so a refusal is not proof the secret is wrong. The
        // rebuild offers a fresh token on a fresh connection; `auth-failed`
        // stands until one is accepted, so a secret that really is wrong is
        // never masked, only retried.
        this.hubDisownedRoom();
      },
      onClose: () => {
        // Fires for the socket going away — which retries itself — and for a
        // room the hub closed on a socket that stays open, which does not. See
        // MAX_REBUILDS; `hubDisownedRoom` ignores the first case.
        this.hubDisownedRoom();
      },
    });
    // A provider given a shared socket does not attach itself — it only
    // self-attaches when it owns the socket. Without this it never subscribes
    // to `open`, never sends its token, and silently never syncs.
    provider.attach();
    this.providers.set(room, provider);
  }

  /**
   * Whether a Yjs transaction origin is one of our providers — i.e. whether the
   * update came off the wire. Both origins are logged; the distinction is what
   * the log records.
   */
  isRemoteOrigin(origin: unknown): boolean {
    if (!(origin instanceof HocuspocusProvider)) {
      return false;
    }
    for (const provider of this.providers.values()) {
      if (provider === origin) return true;
    }
    return false;
  }

  /**
   * Cut this process off the wire, permanently.
   *
   * Called when an update could not be logged. Yjs runs every listener on a
   * document: this module's log append is one of them and the Hocuspocus
   * provider's broadcast is another, so a caught append failure still leaves the
   * provider ready to publish a mutation the log never accepted — the exact
   * inverse of "the log is the authoritative local replica".
   *
   * `detach()` unsubscribes the provider from the socket and makes its `send()`
   * inert, which is what stops the broadcast even though the provider's own
   * listener still runs; the socket is then disconnected so nothing else can
   * leave either. There is no un-quarantine: the replica is rebuilt by
   * restarting the process.
   */
  quarantine(): void {
    if (this.quarantined) {
      return;
    }
    this.quarantined = true;
    for (const provider of this.providers.values()) {
      provider.detach();
    }
    this.socket?.disconnect();
    log.error("quarantined the hub connection: this replica is not durable");
  }

  isQuarantined(): boolean {
    return this.quarantined;
  }

  state(): HubState {
    if (this.quarantined) {
      return {
        status: "quarantined",
        url: this.config.hubUrl,
        reason:
          "an update could not be logged, so this replica was cut off the wire to " +
          "keep an unlogged change from reaching other clients",
      };
    }
    if (!this.enabled) {
      return {
        status: "disabled",
        url: null,
        reason: "HUB_AUTH_TOKEN is not set",
      };
    }
    if (this.authRejected) {
      return {
        status: "auth-failed",
        url: this.config.hubUrl,
        reason: AUTH_REJECTED,
      };
    }
    if (this.socketStatus === "connected") {
      return { status: "connected", url: this.config.hubUrl };
    }
    if (
      this.sawFailure ||
      Date.now() - this.connectingSince > this.config.connectTimeoutMs
    ) {
      return {
        status: "hub-down",
        url: this.config.hubUrl,
        reason: `no connection to ${this.config.hubUrl}`,
      };
    }
    return { status: "connecting", url: this.config.hubUrl };
  }

  /**
   * True when the hub has acknowledged the room's local changes. Acknowledged,
   * not stored: the hub writes on a debounce, so this is what `synced` can
   * honestly claim and no more.
   */
  isRoomQuiet(room: string): boolean {
    const provider = this.providers.get(room);
    if (provider === undefined) {
      return false;
    }
    return provider.isSynced && !provider.hasUnsyncedChanges;
  }

  /**
   * Provider sync messages awaiting acknowledgement, summed over every attached
   * room. Messages, not updates: a batch merges into one message, and a
   * reconnect resets a room's backlog to the single sync-handshake message.
   */
  unsyncedChanges(): number {
    let total = 0;
    for (const provider of this.providers.values()) {
      total += provider.unsyncedChanges;
    }
    return total;
  }

  private allQuiet(): boolean {
    for (const provider of this.providers.values()) {
      if (!provider.isSynced || provider.hasUnsyncedChanges) {
        return false;
      }
    }
    return true;
  }

  /**
   * Wait — briefly, and only when it can help — until every attached room is in
   * sync.
   *
   * Returns as soon as the hub is known to be unavailable, so an offline tool
   * call costs at most one connect grace and never blocks on a hub that is not
   * there. This is the whole extent to which a tool call waits for the network.
   */
  async waitForQuiet(): Promise<void> {
    if (this.socket === null || this.destroyed) {
      return;
    }

    const connectDeadline = Date.now() + this.config.connectTimeoutMs;
    while (this.socketStatus !== "connected") {
      if (this.authRejected || Date.now() >= connectDeadline) {
        return;
      }
      await sleep(25);
    }
    if (this.authRejected) {
      return;
    }

    const syncDeadline = Date.now() + this.config.syncTimeoutMs;
    while (!this.allQuiet()) {
      if (
        this.socketStatus !== "connected" ||
        this.authRejected ||
        Date.now() >= syncDeadline
      ) {
        return;
      }
      await sleep(25);
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    for (const provider of this.providers.values()) {
      provider.destroy();
    }
    this.providers.clear();
    this.socket?.destroy();
  }
}
