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
import { HUB_AUTH_TOKEN, HUB_URL, WORKSPACE } from "../config.js";
import { mintToken } from "./token.js";
import type { AwarenessUser } from "./identity.js";

let socket: HocuspocusProviderWebsocket | null = null;

function sharedSocket(): HocuspocusProviderWebsocket {
  socket ??= new HocuspocusProviderWebsocket({ url: HUB_URL });
  return socket;
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
  /** Updates applied locally but not yet acknowledged by the hub. */
  unsyncedChanges: number;
  /** True once the IndexedDB replica has been loaded into the Y.Doc. */
  localReplicaLoaded: boolean;
}

export interface RoomConnection {
  room: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  status: RoomStatus;
  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(listener: (status: RoomStatus) => void): () => void;
  /** Resolves once the IndexedDB replica has been applied. */
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

  provider.on("status", (event: { status: string }) => {
    status.connected = event.status === "connected";
    emit();
  });
  provider.on("synced", (event: { state: boolean }) => {
    status.synced = event.state;
    emit();
  });
  provider.on("unsyncedChanges", (event: { number: number }) => {
    status.unsyncedChanges = event.number;
    emit();
  });

  // Local-first: the IndexedDB replica is keyed by the room name, so a tab that
  // reopens a document offline still has it. `hasIndexedDB` is false in jsdom
  // and in private-mode Safari; the app still works, it just has no cache.
  let persistence: IndexeddbPersistence | null = null;
  let resolveLocal: () => void = () => {};
  const whenLocalReplicaLoaded = new Promise<void>((resolve) => {
    resolveLocal = resolve;
  });
  if (typeof indexedDB !== "undefined") {
    persistence = new IndexeddbPersistence(room, ydoc);
    persistence.once("synced", () => {
      status.localReplicaLoaded = true;
      resolveLocal();
      emit();
    });
  } else {
    resolveLocal();
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
      held.persistence?.destroy();
      held.connection.provider.destroy();
      held.connection.ydoc.destroy();
    },
  };
}
