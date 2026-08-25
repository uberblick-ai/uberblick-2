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
import { HUB_AUTH_TOKEN, WORKSPACE, hubUrl } from "../config.js";
import { mintToken } from "./token.js";
import type { AwarenessUser } from "./identity.js";

let socket: HocuspocusProviderWebsocket | null = null;

/** Set while a forced drop is in flight, so the `disconnect` handler re-dials. */
let redialAfterDrop = false;

/** One forced drop per this window: a hub that keeps closing us must not spin. */
const FORCED_DROP_COOLDOWN_MS = 5_000;
let lastForcedDrop = 0;

/** A drop asked for during the cooldown, waiting for the window to end. */
let pendingDrop: ReturnType<typeof setTimeout> | null = null;

function cancelPendingDrop(): void {
  if (pendingDrop === null) return;
  clearTimeout(pendingDrop);
  pendingDrop = null;
}

function sharedSocket(): HocuspocusProviderWebsocket {
  if (socket !== null) return socket;
  const created = new HocuspocusProviderWebsocket({
    // Resolved before the first render (see main.tsx), so it is a plain read
    // here — the socket is created by a React effect, long after startup.
    url: hubUrl(),
    // A hub restart should be picked up in seconds, not half a minute: the
    // default backoff climbs to 30s. Deterministic, like the MCP server's —
    // one tab dialling a local hub has nothing to spread out.
    //
    // `minDelay` is not decorative and not about jitter: Hocuspocus defaults it
    // to 1000, and the retry library validates `delay >= minDelay` on every
    // `connect()` regardless of jitter — leave it out and each attempt rejects
    // with "delay cannot be less than minDelay" instead of dialling. Lower it
    // with `delay`, never past it.
    delay: 250,
    minDelay: 250,
    maxDelay: 2_000,
    jitter: false,
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
  const current = sharedSocket();
  // Only meaningful while the socket believes it is connected: a socket that
  // already knows it is down is reconnecting on its own — and every attached
  // provider re-syncs on that `open` — so dropping it here would fight the
  // retry loop that is already doing the repair.
  if (current.status !== WebSocketStatus.Connected) return;

  const sinceLastDrop = Date.now() - lastForcedDrop;
  if (sinceLastDrop < FORCED_DROP_COOLDOWN_MS) {
    // One trailing drop covers every close suppressed in this window.
    if (pendingDrop !== null) return;
    pendingDrop = setTimeout(() => {
      pendingDrop = null;
      dropSocket();
    }, FORCED_DROP_COOLDOWN_MS - sinceLastDrop);
    return;
  }

  cancelPendingDrop();
  lastForcedDrop = Date.now();
  redialAfterDrop = true;
  current.disconnect();
}

/** Mint a fresh hub token. Called by Hocuspocus before every connect. */
async function hubToken(identity: AwarenessUser): Promise<string> {
  if (HUB_AUTH_TOKEN === "") {
    // `fnox exec --if-missing warn` leaves the secret unset for contributors
    // without the age key. Fail loudly here rather than sending garbage.
    throw new Error(
      "uberblick web: HUB_AUTH_TOKEN is empty — run through `mise run web` with a decryptable fnox.toml",
    );
  }
  return mintToken(HUB_AUTH_TOKEN, {
    sub: identity.name,
    workspace: WORKSPACE,
    scope: "read-write",
  });
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
   * the Y.Doc — or there is no IndexedDB, so there was never anything to apply.
   * Either way the Y.Doc now holds everything this replica has offline, so an
   * empty document is an answer rather than a not-yet.
   */
  localReplicaLoaded: boolean;
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
    token: () => hubToken(identity),
  });

  // Required when the socket is shared. `HocuspocusProvider` only attaches
  // itself in its constructor if it created the socket (`manageSocket`); with an
  // injected `websocketProvider` it stays detached — no listeners, no room in
  // the socket's provider map, no connection at all — until `attach()` is
  // called. `destroy()` detaches again on its own, and leaves the shared socket
  // alone. This is silent when you get it wrong: the UI just reads "offline".
  provider.attach();

  provider.setAwarenessField("user", identity);

  // Seeded from the socket rather than defaulted to false. A room joined while
  // the shared socket is already connected gets no `status` event — the event
  // fires on socket transitions, and the socket is not transitioning — so a
  // second room would read "offline" forever.
  const status: RoomStatus = {
    connected: socket.status === WebSocketStatus.Connected,
    synced: provider.isSynced,
    unsyncedChanges: provider.unsyncedChanges,
    localReplicaLoaded: false,
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
    persistence.once("synced", localReadDone);
    // Opening the database can fail outright: a private window, a browser told
    // to block site data, a quota refusal. `y-indexeddb` has no error event and
    // never emits `synced` after that — the rejection of its open promise is
    // the only signal, and leaving it unhandled is also an unhandled rejection.
    // There is no cache to read, so the honest terminal answer is "read, found
    // nothing", and the room runs on live sync alone.
    persistence._db.catch(localReadDone);
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

  return { connection, persistence, listeners, refs: 0 };
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
