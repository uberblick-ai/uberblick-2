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
 * - **Rooms join the hub in waves, never all at once.** One socket carrying the
 *   whole corpus is also one socket that can be terminated for naming too many
 *   documents before any of them authenticates.
 *   {@link MAX_CONCURRENT_ROOM_ATTACHES} is the bound, and it holds on every
 *   connection, not only the first.
 */

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  importRootSecret,
  mintToken,
} from "@uberblick/hub/token";
import {
  protocolSkew,
  readProtocolMismatch,
  SYNC_PROTOCOL_VERSION,
  wrapToken,
} from "@uberblick/hub/protocol";
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
  | "update-required"
  | "quarantined";

export interface HubState {
  status: HubStatus;
  /** The endpoint being dialled, or null when sync is disabled. */
  url: string | null;
  /**
   * Why, for `auth-failed`, `hub-down` and `update-required`. Always composed
   * here, never taken from the wire — see {@link AUTH_REJECTED}.
   */
  reason?: string;
  /**
   * The sync protocol this client speaks. Reported on every reading, including
   * the ones with no hub in them: when the hub is down there is nothing to
   * compare against and this is still the number a person has to quote.
   */
  protocolVersion: number;
  /**
   * The hub's, learned only from a protocol refusal — the one integer a refused
   * client is told, validated before it is believed. Absent otherwise, because
   * a hub that has not refused us has not said.
   */
  hubProtocolVersion?: number;
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
const AUTH_REJECTED =
  "the hub rejected this client's token: the secret is wrong, or this hub is " +
  "older than this client — update the hub";

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

/**
 * How many of this process's rooms may be handshaking with the hub at once.
 *
 * The hub terminates a **whole socket** whose count of documents-not-yet-
 * authenticated reaches its ceiling (`MAX_PENDING_DOCUMENTS`, 100, in
 * `packages/hub/src/config.ts`) — not the offending room, the socket, and every
 * healthy room riding on it. This process puts the entire corpus on one socket,
 * so without a bound the corpus size *is* the count, and the hundred-and-first
 * document takes the connection down.
 *
 * Strictly below the ceiling, and with room to spare rather than by one: the
 * count this paces is the hub's, observed from here a round trip late, and a
 * bound set at the ceiling would be betting on that lag. No corpus this serves
 * is slowed by joining in waves of 32 — a wave costs one round trip, and a
 * document leaves the hub's count the moment its `onAuthenticate` resolves.
 *
 * The bound has to hold on **every** connection. Every attached provider
 * re-sends its token from its own `onOpen`, so a hub restart re-authenticates
 * the whole corpus in one tick; that stampede, not the first attach, is the
 * failure this exists for. A slot is therefore a place on *one* connection —
 * see {@link HubSync.socketGeneration} for why a flapping socket cannot carry
 * one wave's admissions into the next connection's count.
 */
export const MAX_CONCURRENT_ROOM_ATTACHES = 32;

/** The first retry delay a socket waits out, before jitter and before clamping. */
const SOCKET_RETRY_BASE_MS = 250;

/** What {@link socketBackoff} hands the websocket. */
export interface SocketBackoff {
  delay: number;
  minDelay: number;
  factor: number;
  maxDelay: number;
  jitter: true;
}

/**
 * The socket's reconnect band.
 *
 * A local hub restart should be picked up in seconds, not minutes: the
 * library's default backoff climbs to 30s, which would strand an
 * offline-created doc long after the hub is back.
 *
 * Randomized, because release 1 is three clients — two Macs and the agent
 * machine — against one remote hub. They go down together when it does and come
 * back together, so a deterministic ladder has all three redialling in the same
 * millisecond, every time, for as long as the hub is unwell. `jitter: true` is
 * the retry library's full-jitter strategy: attempt *n* waits a uniform draw
 * from `[minDelay, min(delay * factor^(n-1), maxDelay)]`. The randomness is the
 * library's own `Math.random` — `HocuspocusProviderWebsocket` forwards only
 * these fields, so there is no source to inject, and the band below is what a
 * test can pin instead.
 *
 * `minDelay` is not decorative: the retry library validates `delay >= minDelay`
 * on every `connect()`, so leaving it at its 1000 default with a 250 delay
 * makes every attempt reject with "delay cannot be less than minDelay" instead
 * of dialling. Half the delay, so the first retry — the one all three clients
 * make together — already spreads.
 */
export function socketBackoff(maxDelayMs: number): SocketBackoff {
  const delay = Math.min(SOCKET_RETRY_BASE_MS, maxDelayMs);
  return {
    delay,
    minDelay: Math.max(1, Math.floor(delay / 2)),
    factor: 2,
    maxDelay: maxDelayMs,
    jitter: true,
  };
}

/**
 * How long the *n*th rebuild of a disowned connection waits.
 *
 * A uniform draw from `[ceiling / 2, ceiling]`, where the ceiling is the
 * doubling ladder this used to walk exactly: `base * 2^n`, capped. Same reason
 * as {@link socketBackoff} — a hub shutdown disowns every room on every client
 * at once, so three clients on a fixed ladder rebuild in lockstep. The source is
 * a parameter rather than a bare `Math.random` so a test can state the band's
 * ends instead of sampling it.
 */
export function rebuildDelayMs(
  rebuilds: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(baseMs * 2 ** rebuilds, maxMs);
  const floorMs = Math.max(1, Math.floor(ceiling / 2));
  return Math.round(floorMs + (ceiling - floorMs) * random());
}

export interface AttachOptions {
  room: string;
  doc: Y.Doc;
  awareness: Awareness;
}

export interface HubSyncOptions {
  /**
   * Override {@link MAX_CONCURRENT_ROOM_ATTACHES}. A test seam: proving the
   * bound holds needs a corpus larger than a hub ceiling, and a ceiling of 100
   * would make that test a hundred rooms long.
   *
   * A positive integer, checked in the constructor: this number is both the
   * admission gate and a count nothing else re-derives, so a zero would queue
   * every room forever on a socket that is up and answering.
   */
  maxConcurrentAttaches?: number;
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

  /**
   * The hub's protocol version, once it has refused us for speaking a different
   * one; `null` while no such refusal has arrived.
   *
   * An integer rather than a flag because both numbers are what makes the
   * answer actionable — which side is old is the whole of what a person needs.
   * Terminal while it stands: nothing re-mints, no rebuild is spent, and the
   * refusal is logged once. Cleared only by an authentication that actually
   * succeeds, which is the one event that proves the skew is gone.
   */
  private hubProtocolVersion: number | null = null;

  /** The socket's own first retry delay, reused by {@link rebuild}. */
  private readonly reconnectDelayMs: number;

  /** The bound on concurrent attach/auth. See {@link MAX_CONCURRENT_ROOM_ATTACHES}. */
  private readonly maxConcurrentAttaches: number;

  /**
   * Which connection the slots now held belong to.
   *
   * A slot is a place on one connection, never a standing permission, because
   * the count it paces is per socket: the hub starts a fresh one for every
   * connection, and this process learns that a connection has ended a little
   * after it did. Minting a token takes a moment, and a socket that flaps
   * inside that moment leaves a continuation holding a slot on a connection
   * nobody will answer on — one that would otherwise wake up and send into the
   * *next* connection's count without ever having been paced against it. Repeat
   * that on every flap and the bound stops bounding anything.
   *
   * So a connection ending moves this, and a continuation that wakes to find it
   * moved queues again rather than sending. Whatever the flap pattern, the
   * rooms in flight on the connection now open are the ones admitted on it.
   */
  private socketGeneration = 0;

  /**
   * Rooms whose token is on the wire with no answer yet — the count the bound
   * applies to, and the same thing the hub counts as a pending document.
   *
   * Emptied whenever a connection opens or ends: nothing is authenticated on a
   * connection that has just started, and nothing will be answered on one that
   * has just finished.
   */
  private readonly attaching = new Set<string>();

  /**
   * Rooms holding a place in the queue, oldest first (a Map iterates in
   * insertion order), each with the resolve that lets its provider mint.
   *
   * One entry per room, never one per attempt: a socket that re-opens while a
   * room is still queued runs that provider's `onOpen` again, and handing the
   * second one the ticket the first is already waiting on is what keeps a
   * flapping socket from queueing the same room twice. Both then send when the
   * ticket clears — one extra auth and sync-step-1 for a single document, which
   * the hub answers idempotently and which cannot move its pending count,
   * because the count is per document and not per message.
   */
  private readonly waiting = new Map<
    string,
    { promise: Promise<number>; admit: (generation: number) => void }
  >();

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

  constructor(
    config: McpConfig,
    onConnected: () => void,
    options: HubSyncOptions = {},
  ) {
    this.config = config;
    this.onConnected = onConnected;
    this.enabled = config.authSecret !== null;
    this.maxConcurrentAttaches =
      options.maxConcurrentAttaches ?? MAX_CONCURRENT_ROOM_ATTACHES;
    if (
      !Number.isInteger(this.maxConcurrentAttaches) ||
      this.maxConcurrentAttaches < 1
    ) {
      throw new Error(
        `HubSync: maxConcurrentAttaches must be a positive integer, got ${this.maxConcurrentAttaches}`,
      );
    }
    const backoff = socketBackoff(config.reconnectMaxDelayMs);
    // The socket's first retry delay, and the first delay a rebuild waits out.
    this.reconnectDelayMs = backoff.delay;

    if (!this.enabled) {
      log.warn(
        "HUB_AUTH_TOKEN is not set: running local-only, no hub sync (every tool still works)",
      );
      return;
    }

    this.socket = new HocuspocusProviderWebsocket({
      url: config.hubUrl,
      ...backoff,
      onStatus: ({ status }) => {
        const previous = this.socketStatus;
        this.socketStatus = status as "connecting" | "connected" | "disconnected";
        if (status !== "connected") {
          // Nothing on a connection that is going away will ever be answered,
          // so the slots those rooms hold are not slots any more — including
          // the ones held by a token still being minted, which is what moving
          // the generation takes back. The queue stays: a queued room has sent
          // nothing, and its provider is still waiting on the ticket it will
          // need again on the next connection.
          this.socketGeneration += 1;
          this.attaching.clear();
        }
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

    // Subscribed here rather than passed as `onOpen`: the websocket calls the
    // configured `onOpen` *before* it records the payload every provider's own
    // `onOpen` is handed, so a listener registered there would start the wave
    // before the socket could carry it. Registered after construction, this one
    // runs once the payload is in place and still ahead of every provider.
    this.socket.on("open", () => {
      if (this.destroyed || this.quarantined) {
        return;
      }
      this.pumpAdmissions();
    });
  }

  /**
   * Wait for this room's turn to hand the hub a token.
   *
   * The gate is the token callable itself, and that is the whole trick: a
   * provider sends nothing at all — no auth message, no sync step — until its
   * token resolves, so a room waiting here is a room the hub has never heard of
   * and cannot be counting. It works the same on a first attach and on a
   * reconnect, because a reconnect is exactly every attached provider asking
   * for a token again.
   *
   * Resolves with the {@link socketGeneration} the slot was granted on, which
   * is what the caller checks before it lets anything leave.
   */
  private admission(room: string): Promise<number> {
    if (this.destroyed || this.quarantined) {
      // Terminal: every provider is inert and no connection will be opened
      // again, so a queue entry made here would never be admitted, its caller
      // would stay suspended, and both would be held until the process ends.
      // Resolving on the current generation ends the call instead.
      return Promise.resolve(this.socketGeneration);
    }
    const queued = this.waiting.get(room);
    if (queued !== undefined) {
      return queued.promise;
    }
    let admit!: (generation: number) => void;
    const promise = new Promise<number>((resolve) => {
      admit = resolve;
    });
    this.waiting.set(room, { promise, admit });
    this.pumpAdmissions();
    return promise;
  }

  /** Let as many queued rooms through as the bound and this connection allow. */
  private pumpAdmissions(): void {
    if (this.socketStatus === "connected") {
      for (const [room, ticket] of this.waiting) {
        // A room already counted is not a second document to the hub, so
        // letting it through costs no slot — see {@link waiting}.
        if (
          this.attaching.size >= this.maxConcurrentAttaches &&
          !this.attaching.has(room)
        ) {
          break;
        }
        this.waiting.delete(room);
        this.attaching.add(room);
        ticket.admit(this.socketGeneration);
      }
    }
  }

  /**
   * The hub has answered for this room — accepted it, refused it, or closed it.
   * Either way it is no longer pending on the hub, so the slot goes back.
   */
  private roomAnswered(room: string): void {
    if (this.attaching.delete(room)) {
      this.pumpAdmissions();
    }
  }

  /**
   * Stop gating: every provider is inert from here (detached or destroyed), so
   * the rooms still waiting can be let go rather than left suspended forever.
   *
   * Let go on the *current* generation, so a suspended token call returns
   * instead of queueing again — there is no next connection to queue for. A
   * call still minting when this runs is caught by the terminal-state guards in
   * {@link admission} and in the token callable, because the disconnect that
   * follows moves the generation out from under it.
   */
  private releaseAdmissions(): void {
    for (const [room, ticket] of this.waiting) {
      this.waiting.delete(room);
      ticket.admit(this.socketGeneration);
    }
    this.attaching.clear();
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
   * recovers a room the hub has disowned, and where this stops; and
   * {@link rebuildDelayMs} for the band each one waits out.
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

    const delay = rebuildDelayMs(
      this.rebuilds,
      this.reconnectDelayMs,
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
      // The bound lives here: nothing leaves this provider until the token
      // resolves, so a room waiting its turn is a room the hub has not been
      // told about. See {@link admission}.
      token: async () => {
        for (;;) {
          const generation = await this.admission(room);
          if (this.destroyed || this.quarantined) {
            // Quarantined or destroyed while this call was suspended. Every
            // provider is detached by then and `send()` on a detached provider
            // is inert, so this token travels nowhere; ending the call is what
            // matters, because looping would queue for a connection that is
            // never opened again and leave the entry behind with it.
            return "";
          }
          const token = await this.token();
          if (generation === this.socketGeneration) {
            // Wrapped on the way out, with no `await` between the check and the
            // return: the envelope is a string operation, so the slot this room
            // is holding is not widened by it. The `return ""` above stays
            // unwrapped — it is the "send nothing" path, not a token.
            return wrapToken(token);
          }
          // The connection this slot was granted on ended while the token was
          // being minted. Returning now would send this room's auth and sync
          // step into the *next* connection's pending count without its ever
          // having been paced against it — so queue again and be admitted on
          // the connection it will actually travel on. See socketGeneration.
        }
      },
      onAuthenticated: () => {
        this.authRejected = false;
        // A hub that accepts us is a hub we speak the same protocol as, which
        // is the only honest way out of `update-required`.
        this.hubProtocolVersion = null;
        this.roomAnswered(room);
      },
      onSynced: ({ state }) => {
        if (state) {
          this.syncedRooms.add(room);
        }
      },
      onAuthenticationFailed: ({ reason }: { reason: string }) => {
        // The one string the hub gets to say, read by strict match and never
        // rendered: a mismatch yields a validated integer, and everything else
        // — including a sentinel naming our own version — falls through to the
        // token rejection below, exactly as before. See readProtocolMismatch.
        const hubProtocol = readProtocolMismatch(reason);
        if (hubProtocol !== null) {
          // Terminal, and terminal cheaply. A version skew is not a connection
          // fault: re-minting the same envelope on a fresh socket produces the
          // same refusal, so this spends none of the rebuild budget and says so
          // once for the process rather than once per room per rebuild.
          if (this.hubProtocolVersion === null) {
            this.hubProtocolVersion = hubProtocol;
            log.error("the hub speaks a different sync protocol: update required", {
              protocolVersion: SYNC_PROTOCOL_VERSION,
              hubProtocolVersion: hubProtocol,
            });
          }
          // The slot still goes back: the hub has answered for this room, and a
          // room left pending would hold the attach bound shut behind it.
          this.roomAnswered(room);
          return;
        }
        // Distinct from an unreachable hub: a human has to fix the secret. The
        // hub's own wording is discarded rather than stored or logged — it is
        // remote text about a token we just sent, and every consumer of this
        // state renders it. See AUTH_REJECTED.
        this.authRejected = true;
        this.roomAnswered(room);
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
        // A room the hub closed is a room it is no longer deciding about, so
        // its slot goes back even though no answer ever came.
        this.roomAnswered(room);
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
    // Detached providers send nothing, so the queue is only holding suspended
    // token calls now.
    this.releaseAdmissions();
    this.socket?.disconnect();
    log.error("quarantined the hub connection: this replica is not durable");
  }

  isQuarantined(): boolean {
    return this.quarantined;
  }

  /**
   * What this client can say about the hub right now.
   *
   * The client's own protocol version rides on every reading, including the
   * ones with no hub in them — {@link reach} answers the rest, so no branch can
   * forget it and `sync_status` reports the number even with the hub down.
   */
  state(): HubState {
    return { protocolVersion: SYNC_PROTOCOL_VERSION, ...this.reach() };
  }

  private reach(): Omit<HubState, "protocolVersion"> {
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
    // Ahead of `auth-failed`: a refusal the hub explained is more actionable
    // than one it did not, and this one names the fix exactly.
    if (this.hubProtocolVersion !== null) {
      return {
        status: "update-required",
        url: this.config.hubUrl,
        hubProtocolVersion: this.hubProtocolVersion,
        reason: protocolSkew(this.hubProtocolVersion, SYNC_PROTOCOL_VERSION),
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

  /**
   * Whether every room this process holds is in sync — waiting rooms included.
   *
   * A room queued behind {@link MAX_CONCURRENT_ROOM_ATTACHES} has not reached
   * the hub yet, so it is not quiet, and saying otherwise is how a write comes
   * back `synced: true` while the queue is still draining. Its provider reports
   * that too — nothing it has not handshaked is `isSynced` — but the queue is
   * stated here rather than inferred, because `{applied, synced}` is an
   * invariant and not an emergent property of a library's flags.
   */
  private allQuiet(): boolean {
    if (this.waiting.size > 0 || this.attaching.size > 0) {
      return false;
    }
    for (const provider of this.providers.values()) {
      if (!provider.isSynced || provider.hasUnsyncedChanges) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether rooms are still queued for, or holding, an attach slot.
   *
   * The queue drains a wave per round trip, and {@link waitForQuiet} is one
   * budget: a corpus larger than the bound outlasts it by construction. So a
   * caller that records hydration as complete asks this first — a wait that
   * ended with the queue still draining spent its budget, not the drain, and
   * the settle is owed again on the next call rather than waited out longer
   * here.
   *
   * Only while connected: a queue nobody is draining is a hub that is down,
   * which every call already answers through the connect grace, and re-owing
   * the settle for it would make every offline tool call pay that grace again.
   */
  isDraining(): boolean {
    return (
      this.socketStatus === "connected" &&
      (this.waiting.size > 0 || this.attaching.size > 0)
    );
  }

  /**
   * Wait — briefly, and only when it can help — until every room this process
   * holds is in sync, including the ones still queued for an attach slot.
   *
   * `syncTimeoutMs` is the whole budget, however large the corpus is: a tool
   * call's wait is a promise to its caller, and a deadline multiplied by the
   * queue depth would make that promise grow with the corpus. A drain longer
   * than one budget is not hidden by waiting longer, it is *reported* — the
   * wait ends, {@link isDraining} still says the queue is going, every
   * unfinished room reports `synced: false` through `isRoomQuiet`, and the next
   * call settles again from there.
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
    this.releaseAdmissions();
    this.socket?.destroy();
  }
}
