/**
 * Room connections: one Y.Doc per room, a Hocuspocus provider, and an
 * IndexedDB replica alongside it.
 *
 * Two things worth knowing:
 *
 * - **One WebSocket, many rooms.** A tab is always in at least two rooms (the
 *   directory doc and whatever document is open). Hocuspocus multiplexes rooms
 *   over a single `HocuspocusProviderWebsocket`, so we create one and share it;
 *   a socket per room would mean a fresh auth handshake per document.
 *
 * - **Refcounted, keyed by room name.** React effects mount and unmount
 *   (twice per mount under StrictMode), and the directory doc is needed by the
 *   list *and* by the create flow. Connections are shared and only torn down
 *   when the last holder releases them.
 *
 * - **A closed document means a dead connection.** The hub can close a
 *   document without closing the socket, which leaves a provider attached to a
 *   live-looking socket that delivers nothing — and Hocuspocus never announces
 *   the lost sync, because it only emits `synced` for `true`. Both halves are
 *   handled below: status is derived from the socket and provider rather than
 *   from event payloads, and an unsolicited close drops the socket so every
 *   room re-joins on the next `open`.
 *
 * The token is passed as an async callable, not a string: Hocuspocus accepts
 * `() => Promise<string>` and calls it before each connection attempt, so a
 * reconnect after the token would have expired re-mints instead of failing.
 */

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { parseRoom } from "@uberblick/schema";
import {
  readProtocolMismatch,
  SYNC_PROTOCOL_VERSION,
  wrapToken,
} from "@uberblick/hub/protocol";
import { HUB_AUTH_TOKEN, hubUrl } from "../config.js";
import { getSetting, subscribeSettings } from "../settings.js";
import { MAX_TOKEN_LIFETIME_SECONDS, importRootSecret, mintToken } from "./token.js";
import type { AwarenessUser } from "./identity.js";

/**
 * What this client publishes as its `client` awareness field (#74).
 *
 * Awareness has no "this is an agent" marker — an MCP session publishes the
 * same `user` a browser tab does, and #73 is where a richer one would arrive.
 * A web tab does know what a web tab looks like, though, so it says so: a
 * remote session that does not claim to be one is an MCP session, which is
 * what the user menu counts.
 */
export const WEB_CLIENT = "web";

/**
 * The shared socket's reconnect band.
 *
 * A hub restart should be picked up in seconds, not half a minute: the
 * library's default backoff climbs to 30s.
 *
 * Randomized, because release 1 is three clients — two Macs and the agent
 * machine — against one remote hub, plus however many tabs the owner has open.
 * They lose the hub together and come back together, so a deterministic ladder
 * has all of them redialling in the same millisecond, every time. `jitter: true`
 * is the retry library's full-jitter strategy: attempt *n* waits a uniform draw
 * from `[minDelay, min(delay * factor^(n-1), maxDelay)]`. The randomness is the
 * library's own `Math.random` — `HocuspocusProviderWebsocket` forwards only
 * these fields to it, so there is no source to inject, and this band is what a
 * test can pin instead.
 *
 * `minDelay` is not decorative: Hocuspocus defaults it to 1000, and the retry
 * library validates `delay >= minDelay` on every `connect()` regardless of
 * jitter — leave it out and each attempt rejects with "delay cannot be less
 * than minDelay" instead of dialling. Half the delay, so the first retry — the
 * one every client makes together — already spreads.
 */
export const SOCKET_BACKOFF = {
  delay: 250,
  minDelay: 125,
  factor: 2,
  maxDelay: 2_000,
  jitter: true,
} as const;

let socket: HocuspocusProviderWebsocket | null = null;

/** Set while a forced drop is in flight, so the `disconnect` handler re-dials. */
let redialAfterDrop = false;

/**
 * One forced drop per window: a hub that keeps closing us must not spin.
 *
 * A band rather than a number, drawn per drop. Release 1 is three clients
 * against one remote hub, and a hub that closes documents closes them for all
 * three at once — a fixed 5s window had every tab redialling in the same
 * millisecond, wave after wave, for as long as the hub kept doing it.
 *
 * The maximum stays at the 5s this used to be, because
 * `packages/web/test/reconnect.test.ts` derives its deadlines from it: a
 * suppressed close waits out at most one window before the trailing drop, and
 * lengthening that would invalidate the derivation rather than the test.
 */
export const FORCED_DROP_COOLDOWN = { minMs: 2_500, maxMs: 5_000 } as const;

/**
 * How long the next forced-drop window lasts: a uniform draw from
 * {@link FORCED_DROP_COOLDOWN}. The source is a parameter rather than a bare
 * `Math.random` so a test can state the band's ends instead of sampling it.
 */
export function forcedDropCooldownMs(random: () => number = Math.random): number {
  const { minMs, maxMs } = FORCED_DROP_COOLDOWN;
  return Math.round(minMs + (maxMs - minMs) * random());
}

/**
 * Set once the hub has refused this page for speaking a different sync
 * protocol: our version and its.
 *
 * Page-wide rather than per room, because the refusal is about the *socket*.
 * Every room shares one (see {@link sharedSocket}), `provider.disconnect()` is
 * a no-op on a socket the provider does not manage, and a permission denial
 * never closes the socket by itself — so "this room stops retrying" would not
 * be a mechanism. What stops is the socket, and nothing re-dials it: a client
 * the hub cannot talk to is not made compatible by connecting again. A reload
 * starts over, which is exactly what a person does after updating.
 */
let protocolMismatch: { hub: number; client: number } | null = null;

let lastForcedDrop = 0;
/**
 * The window the last drop opened. Only read after a drop has set it — the
 * band's maximum is a safe standing value until then.
 */
let forcedDropWindowMs: number = FORCED_DROP_COOLDOWN.maxMs;

/** A drop asked for during the cooldown, waiting for the window to end. */
let pendingDrop: ReturnType<typeof setTimeout> | null = null;

function cancelPendingDrop(): void {
  if (pendingDrop === null) return;
  clearTimeout(pendingDrop);
  pendingDrop = null;
}

/**
 * Stop this page: the hub refuses the protocol it speaks.
 *
 * Idempotent, and deliberately at socket granularity — one refusal ends the
 * page's sync, not one room's. The socket is disconnected (which also clears
 * its own retry), any deferred forced drop is cancelled and the redial flag is
 * cleared, so nothing dials again; then every open room is told, because they
 * are all on the socket that just stopped.
 */
function haltForProtocolMismatch(hub: number): void {
  if (protocolMismatch !== null) return;
  protocolMismatch = { hub, client: SYNC_PROTOCOL_VERSION };
  cancelPendingDrop();
  redialAfterDrop = false;
  socket?.disconnect();
  for (const entry of entries.values()) {
    entry.connection.status.protocolMismatch = protocolMismatch;
    for (const listener of entry.listeners) {
      listener({ ...entry.connection.status });
    }
  }
}

function sharedSocket(): HocuspocusProviderWebsocket {
  if (socket !== null) return socket;
  const created = new HocuspocusProviderWebsocket({
    // Resolved before the first render (see main.tsx), so it is a plain read
    // here — the socket is created by a React effect, long after startup.
    url: hubUrl(),
    ...SOCKET_BACKOFF,
  });
  created.on("disconnect", () => {
    if (!redialAfterDrop) return;
    // `disconnect()` cleared `shouldConnect`, so nothing would dial again on its
    // own. Doing it here rather than straight after `disconnect()` is the whole
    // point: `connect()` returns early while the status still reads
    // "connected", which it does until the close event lands.
    redialAfterDrop = false;
    void created.connect();
  });
  socket = created;
  return created;
}

/**
 * Drop the shared socket and dial again.
 *
 * Called when the hub closes a *document* while the socket is still up — see
 * {@link openRoom}. Every attached provider re-authenticates and re-syncs on
 * the next `open`, which is what actually resumes live sync; nothing else does.
 *
 * The cooldown *defers*, never discards. A close is the only signal that a room
 * needs repairing — no later socket transition or provider event repeats it — so
 * dropping one inside the cooldown window would strand the room in exactly the
 * orphaned state this whole path exists to repair. Suppressed closes coalesce
 * into one trailing drop at the end of the window, which bounds how often we
 * reconnect without ever forgetting that we owe a reconnect.
 */
function dropSocket(): void {
  // A page the hub has refused has nothing to repair by reconnecting, and the
  // close that refusal produces would otherwise land here and redial straight
  // back into the same refusal. See {@link protocolMismatch}.
  if (protocolMismatch !== null) return;
  const current = sharedSocket();
  // Only meaningful while the socket believes it is connected: a socket that
  // already knows it is down is reconnecting on its own — and every attached
  // provider re-syncs on that `open` — so dropping it here would fight the
  // retry loop that is already doing the repair.
  if (current.status !== WebSocketStatus.Connected) return;

  const sinceLastDrop = Date.now() - lastForcedDrop;
  // The window the last drop drew, not a fresh draw: the check and the trailing
  // timer below have to agree about when this one ends.
  if (sinceLastDrop < forcedDropWindowMs) {
    // One trailing drop covers every close suppressed in this window.
    if (pendingDrop !== null) return;
    pendingDrop = setTimeout(() => {
      pendingDrop = null;
      dropSocket();
    }, forcedDropWindowMs - sinceLastDrop);
    return;
  }

  cancelPendingDrop();
  lastForcedDrop = Date.now();
  forcedDropWindowMs = forcedDropCooldownMs();
  redialAfterDrop = true;
  current.disconnect();
}

/** The signing key, imported once for the life of the page. */
let signingKey: Promise<CryptoKey> | null = null;

/**
 * Mint a fresh hub token for one room. Called by Hocuspocus before every
 * connect.
 *
 * The workspace claim comes from the room name rather than from configuration:
 * the hub compares the two as strings, so reading them out of one place is what
 * keeps them equal. A room name carries the bare uuid by construction
 * (`roomForDoc` parses any slug off), which is exactly what the claim must be.
 */
async function hubToken(room: string, identity: AwarenessUser): Promise<string> {
  if (HUB_AUTH_TOKEN === "") {
    // `fnox exec --if-missing warn` leaves the secret unset for contributors
    // without the age key. Fail loudly here rather than sending garbage.
    throw new Error(
      "uberblick web: HUB_AUTH_TOKEN is empty — run through `mise run web` with a decryptable fnox.toml",
    );
  }
  signingKey ??= importRootSecret(HUB_AUTH_TOKEN);
  // Wrapped for the wire: the hub reads the protocol version out of the auth
  // message before it reads the token. The token itself is unchanged.
  return wrapToken(
    await mintToken(await signingKey, {
    typ: "room",
    sub: identity.name,
    workspace: parseRoom(room).workspaceId,
    scope: "read-write",
    // Root-signed: the bundle carries the root secret, not a credential.
    kid: null,
      // The ceiling itself. Hocuspocus calls this before every connect, so each
      // reconnect mints a fresh token rather than replaying an expired one.
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    }),
  );
}

export interface RoomStatus {
  connected: boolean;
  synced: boolean;
  /**
   * Provider sync messages awaiting the hub's acknowledgement. Messages, not
   * updates: a batch merges into one message, and a reconnect resets the
   * backlog to the single sync-handshake message — see `StatusLine`, which is
   * where the number is labelled.
   */
  unsyncedChanges: number;
  /**
   * True once the local read is done: the IndexedDB replica has been applied to
   * the Y.Doc — or there is no IndexedDB, or it refused to open, so there was
   * never anything to apply. Either way the Y.Doc now holds everything this
   * replica has offline, so an empty document is an answer rather than a
   * not-yet.
   *
   * A question about *time*, not about storage: it says the read is over, never
   * that anything was read. For "is this document actually cached here",
   * which is a different claim and the one worth showing a reader, see
   * {@link RoomStatus.hasLocalCache}.
   */
  localReplicaLoaded: boolean;
  /**
   * True only where IndexedDB actually opened and applied its replica — the
   * document survives a reload of this browser with the hub down.
   *
   * Split from `localReplicaLoaded` because the status line says the words
   * "local cache" to the reader, and a browser with no IndexedDB (or one that
   * refused to open it) reaches the end of its local read with no cache at all.
   * Sharing one flag between the two would put that promise on screen in
   * exactly the environments that cannot keep it.
   */
  hasLocalCache: boolean;
  /**
   * Set when the hub refused this page for speaking a different sync protocol
   * version: `hub` is the hub's, `client` is ours. `null` while it has not.
   *
   * Both integers, because "which side is old" is the whole of what a reader
   * can act on. Page-wide and terminal — see {@link protocolMismatch} — so
   * every open room carries the same object and a room opened after the
   * refusal carries it too, without dialling.
   */
  protocolMismatch: { hub: number; client: number } | null;
}

export interface RoomConnection {
  room: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  status: RoomStatus;
  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(listener: (status: RoomStatus) => void): () => void;
  /**
   * Resolves once the local read is over: the replica applied, or nothing to
   * apply. Always settles — see `localReplicaLoaded`, which it moves with.
   */
  whenLocalReplicaLoaded: Promise<void>;
}

interface Entry {
  connection: RoomConnection;
  persistence: IndexeddbPersistence | null;
  listeners: Set<(status: RoomStatus) => void>;
  /** Stop republishing this room's awareness colour — see `publishUser`. */
  stopPreference: () => void;
  refs: number;
}

const entries = new Map<string, Entry>();

function openRoom(room: string, identity: AwarenessUser): Entry {
  const ydoc = new Y.Doc();
  const socket = sharedSocket();
  const provider = new HocuspocusProvider({
    name: room,
    document: ydoc,
    websocketProvider: socket,
    // Async callable form: re-minted on every (re)connect.
    token: () => hubToken(room, identity),
    onAuthenticationFailed: ({ reason }: { reason: string }) => {
      // The hub's one string, read by strict match and never rendered. A
      // mismatch yields a validated integer and stops the page; anything else
      // is a token the hub refused, which is the pre-existing path and is left
      // exactly as it was.
      const hub = readProtocolMismatch(reason);
      if (hub !== null) haltForProtocolMismatch(hub);
    },
  });

  // Required when the socket is shared. `HocuspocusProvider` only attaches
  // itself in its constructor if it created the socket (`manageSocket`); with an
  // injected `websocketProvider` it stays detached — no listeners, no room in
  // the socket's provider map, no connection at all — until `attach()` is
  // called. `destroy()` detaches again on its own, and leaves the shared socket
  // alone. This is silent when you get it wrong: the UI just reads "offline".
  // Not on a page the hub has already refused: attaching is what subscribes the
  // provider to the socket and sends its token, and there is nothing to send an
  // envelope this hub will not read. The room still opens — its local replica
  // loads and the status line says why it is not syncing.
  if (protocolMismatch === null) {
    provider.attach();
  }

  /**
   * Publish who is here: the tab's identity, with the browser's chosen presence
   * colour over it (#74).
   *
   * Re-run whenever a setting changes, because the picker is the *menu*, not
   * this module — and a colour peers only see after a reconnect is not a live
   * presence colour. Compared before it is published: a settings write about
   * something else must not put an awareness message on the wire per room.
   */
  let publishedColor = "";
  const publishUser = (): void => {
    const color = getSetting("presenceColor") ?? identity.color;
    if (color === publishedColor) return;
    publishedColor = color;
    provider.setAwarenessField("user", { ...identity, color });
  };
  publishUser();
  const stopPreference = subscribeSettings(publishUser);
  // What kind of client this is, so remote sessions can be told apart — see
  // `WEB_CLIENT`.
  provider.setAwarenessField("client", WEB_CLIENT);

  // Seeded from the socket rather than defaulted to false. A room joined while
  // the shared socket is already connected gets no `status` event — the event
  // fires on socket transitions, and the socket is not transitioning — so a
  // second room would read "offline" forever.
  const status: RoomStatus = {
    connected: socket.status === WebSocketStatus.Connected,
    synced: provider.isSynced,
    unsyncedChanges: provider.unsyncedChanges,
    localReplicaLoaded: false,
    hasLocalCache: false,
    // A room opened after the refusal reads the same terminal state as the
    // rooms that were open when it arrived.
    protocolMismatch,
  };
  const listeners = new Set<(status: RoomStatus) => void>();
  const emit = (): void => {
    for (const listener of listeners) listener({ ...status });
  };

  // Read from the socket and the provider rather than from the event payloads.
  // Hocuspocus only emits `synced` when it becomes *true* — losing sync is
  // silent — so mirroring payloads leaves a stale `synced: true` behind after
  // every disconnect, which is the indicator claiming "synced" over a
  // connection that stopped delivering anything.
  const refresh = (): void => {
    status.connected = socket.status === WebSocketStatus.Connected;
    status.synced = provider.isSynced;
    status.unsyncedChanges = provider.unsyncedChanges;
    emit();
  };
  provider.on("status", refresh);
  provider.on("synced", refresh);
  provider.on("unsyncedChanges", refresh);
  provider.on("close", refresh);

  provider.on("close", (event: { event?: { reason?: string } }) => {
    // A close on a live socket is the hub closing this *document*:
    // `closeConnections` (hub shutdown, document reset) drops the connection
    // server-side and sends a CLOSE message without touching the socket. The
    // provider resets its own sync state and then waits for an `open` that will
    // never come, so the room silently stops receiving updates while the socket
    // still looks connected. The socket is the only thing that can re-join.
    //
    // `provider_initiated` is the hub echoing back a close *we* asked for by
    // detaching (switching documents, a StrictMode remount). Re-joining after
    // that works by itself, so dropping the socket there would be pure churn.
    if (event?.event?.reason === "provider_initiated") return;
    dropSocket();
  });

  // Local-first: the IndexedDB replica is keyed by the room name, so a tab that
  // reopens a document offline still has it. `hasIndexedDB` is false in jsdom
  // and in private-mode Safari; the app still works, it just has no cache.
  let persistence: IndexeddbPersistence | null = null;
  let resolveLocal: () => void = () => {};
  const whenLocalReplicaLoaded = new Promise<void>((resolve) => {
    resolveLocal = resolve;
  });
  /**
   * The local read is over — with content, or with nothing. Terminal and
   * idempotent, because every reader of `localReplicaLoaded` treats false as
   * "still reading": a read that can never finish must not be spelled the same
   * way as one that has not finished yet, or the pane waits on it in silence
   * instead of showing the waiting screen (`replicaHasAnswered`).
   */
  const localReadDone = (): void => {
    if (status.localReplicaLoaded) return;
    status.localReplicaLoaded = true;
    resolveLocal();
    emit();
  };
  if (typeof indexedDB !== "undefined") {
    persistence = new IndexeddbPersistence(room, ydoc);
    persistence.once("synced", () => {
      // The only path where a cache genuinely exists: the database opened and
      // its updates are in the Y.Doc.
      status.hasLocalCache = true;
      localReadDone();
    });
    // Opening the database can fail outright: a private window, a browser told
    // to block site data, a quota refusal. `y-indexeddb` has no error event and
    // never emits `synced` after that — the rejection of its open promise is
    // the only signal, and leaving it unhandled is also an unhandled rejection.
    // There is no cache to read, so the honest terminal answer is "read, found
    // nothing", and the room runs on live sync alone.
    //
    // Read defensively, because `_db` is the library's own field and not part
    // of what it promises to keep: a version that renames it should cost us
    // this one signal, not every room. Without it a blocked database falls back
    // to the pre-existing behaviour — the read never finishes — rather than
    // throwing where the room is opened.
    const opening = (persistence as { _db?: Promise<IDBDatabase> })._db;
    opening?.catch(localReadDone);
  } else {
    // No IndexedDB at all (jsdom, some embedded webviews): the same terminal
    // state, reached without an attempt.
    localReadDone();
  }

  const connection: RoomConnection = {
    room,
    ydoc,
    provider,
    status,
    onStatusChange(listener) {
      listeners.add(listener);
      listener({ ...status });
      return () => listeners.delete(listener);
    },
    whenLocalReplicaLoaded,
  };

  return { connection, persistence, listeners, stopPreference, refs: 0 };
}

/**
 * Acquire a shared connection to `room`. Call the returned `release` when done;
 * the connection is destroyed when the last holder releases it.
 */
export function acquireRoom(
  room: string,
  identity: AwarenessUser,
): { connection: RoomConnection; release: () => void } {
  let entry = entries.get(room);
  if (entry === undefined) {
    entry = openRoom(room, identity);
    entries.set(room, entry);
  }
  entry.refs += 1;
  const held = entry;
  let released = false;
  return {
    connection: held.connection,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      entries.delete(room);
      held.listeners.clear();
      held.stopPreference();
      // `destroy` closes the database through the same open promise, so on a
      // room whose database never opened it rejects. Nothing to repair — the
      // thing being closed was never there.
      held.persistence?.destroy().catch(() => {});
      held.connection.provider.destroy();
      held.connection.ydoc.destroy();
      // Nothing left to repair: a deferred drop would reconnect a socket no
      // room is listening on.
      if (entries.size === 0) cancelPendingDrop();
    },
  };
}
