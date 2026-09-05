/**
 * Room connections: one Y.Doc and one Hocuspocus provider per room.
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
import * as Y from "yjs";
import { parseRoom } from "@uberblick/schema";
import {
  readProtocolMismatch,
  SYNC_PROTOCOL_VERSION,
  wrapToken,
} from "@uberblick/hub/protocol";
import { HUB_CONFIG_PATH, hubAuthToken, hubUrl, resolveClientConfig } from "../config.js";
import { getSetting, subscribeSettings } from "../settings.js";
import { MAX_TOKEN_LIFETIME_SECONDS, importRootSecret, mintToken } from "./token.js";
import { WEB_CLIENT } from "./identity.js";
import type { AwarenessUser } from "./identity.js";

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

/** Rooms the store refused remain closed until this page is reloaded. */
const storeRefusedRooms = new Set<string>();

let lastForcedDrop = 0;
/**
 * The window the last drop opened. Only read after a drop has set it — the
 * band's maximum is a safe standing value until then.
 */
let forcedDropWindowMs: number = FORCED_DROP_COOLDOWN.maxMs;

/**
 * The store's terminal refusal. `uberblick:store-busy` is deliberately an
 * ordinary drop so the existing reconnect backoff handles it.
 */
const STORE_REFUSED_REASON = "uberblick:store-refused";

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
    const status = entry.connection.status;
    status.protocolMismatch = protocolMismatch;
    status.hasAnswered = true;
    // Said here rather than left to the socket's close event, which lands a
    // tick or more later: `disconnect()` above only *asks*, so `socket.status`
    // still reads connected right now and a reader told "refused, and
    // connected" would be told something that is already untrue. A halted page
    // never connects or syncs again, so both are settled at the halt — and
    // `refresh` keeps them settled when the close finally arrives.
    status.connected = false;
    status.synced = false;
    status.writable = false;
    for (const listener of entry.listeners) {
      listener({ ...status });
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

/**
 * The signing key, imported once for the life of the page.
 *
 * Once, not per connect: it is derived from the secret the *first* usable
 * document supplied, so a secret rotated under a tab that already has one keeps
 * minting with the old one until the page is reloaded. Stated rather than
 * solved — a rotation is a redeploy, and a redeploy is a reload (REMOTE.md).
 */
let signingKey: Promise<CryptoKey> | null = null;

/**
 * Set while the served document has supplied no secret to mint with.
 *
 * Page-wide, like {@link protocolMismatch} and for the same reason: there is
 * one configuration document for the page, so this is never one room's problem.
 * Unlike that one it is not terminal — {@link hubToken} re-reads the document
 * before every connect attempt, and the flag clears the moment one arrives.
 */
let tokenMissing = false;

/** Tell every open room whether a secret is missing. See {@link tokenMissing}. */
function setTokenMissing(missing: boolean): void {
  if (tokenMissing === missing) return;
  tokenMissing = missing;
  for (const entry of entries.values()) {
    const status = entry.connection.status;
    status.tokenMissing = missing;
    if (missing) {
      status.writable = false;
      status.hasAnswered = true;
    }
    for (const listener of entry.listeners) {
      listener({ ...status });
    }
  }
}

async function signedAuthMessage(
  secret: string,
  workspace: string,
  subject: string,
): Promise<string> {
  signingKey ??= importRootSecret(secret);
  return wrapToken(
    await mintToken(await signingKey, {
      typ: "room",
      sub: subject,
      workspace,
      scope: "read-write",
      // Root-signed: what this client was handed is the root secret itself —
      // served to it at runtime (#426) — and not a credential minted for it.
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    }),
  );
}

/** Mint the protocol auth message shared by room and same-origin API requests. */
export async function mintHubAuthMessage(
  workspace: string,
  subject: string,
): Promise<string> {
  await resolveClientConfig();
  const secret = hubAuthToken();
  if (secret === "") {
    throw new Error(
      `uberblick web: ${HUB_CONFIG_PATH} carries no hubAuthToken, so this client cannot authenticate`,
    );
  }
  return await signedAuthMessage(secret, workspace, subject);
}

/**
 * Mint a fresh hub token for one room. Called by Hocuspocus before every
 * connect.
 *
 * The workspace claim comes from the room name rather than from configuration:
 * the hub compares the two as strings, so reading them out of one place is what
 * keeps them equal. A room name carries the bare uuid by construction
 * (`roomForDoc` parses any slug off), which is exactly what the claim must be.
 *
 * The secret comes from the served document (#426), re-read here rather than
 * captured at page load: `resolveClientConfig` does not memoise a read that
 * produced no secret, so a document that missed its deadline is fetched again
 * on this attempt, under the same deadline. A page that already has one pays
 * nothing — the resolved answer is memoised and this returns immediately.
 */
async function hubToken(room: string, identity: AwarenessUser): Promise<string> {
  await resolveClientConfig();
  const secret = hubAuthToken();
  setTokenMissing(secret === "");
  if (secret === "") {
    // Ask for a fresh socket, because nothing else would. A token that cannot
    // be minted leaves the provider unauthenticated on a socket that is open
    // and staying open: Hocuspocus only re-sends a token on an `open`, and the
    // only thing that eventually produces one is its 30s message-reconnect —
    // measured at ~60s end to end, which is a tab dead for a minute after its
    // deployment came up. The window in {@link dropSocket} bounds this to one
    // attempt every few seconds, and each attempt re-reads the document.
    dropSocket();
    throw new Error(
      `uberblick web: ${HUB_CONFIG_PATH} carries no hubAuthToken, so this client cannot authenticate`,
    );
  }
  // The ceiling is inside signedAuthMessage. Hocuspocus calls this before every
  // connect, so each reconnect mints a fresh token rather than replaying an
  // expired one.
  return await signedAuthMessage(secret, parseRoom(room).workspaceId, identity.name);
}

export interface RoomStatus {
  connected: boolean;
  synced: boolean;
  /**
   * True once this room has completed a sync with its server. Unlike `synced`,
   * it stays true across a later disconnect; unlike `hasAnswered`, a refusal
   * over an empty Y.Doc does not count as server state.
   */
  hasReceivedServerState: boolean;
  /**
   * True once this room has completed a sync or its connection has failed or
   * been refused. Until then an empty Y.Doc is silence rather than evidence
   * that a deep-linked document is absent.
   */
  hasAnswered: boolean;
  /**
   * True only after this room's live connection has admitted the client.
   * Authentication is the observable admission boundary, not a per-write
   * acknowledgement: during #402's rare same-tick re-acquire race, the
   * accepted in-flight loss window widens until the room repairs itself if the
   * tab also dies before then.
   */
  writable: boolean;
  /** The local store refused this room; terminal until a page reload. */
  storeRefused: boolean;
  /**
   * Provider sync messages awaiting the hub's acknowledgement. Messages, not
   * updates: a batch merges into one message, and a reconnect resets the
   * backlog to the single sync-handshake message — see `StatusLine`, which is
   * where the number is labelled.
   */
  unsyncedChanges: number;
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
  /**
   * True while the hub's last word on this room's token was a refusal that is
   * *not* a protocol mismatch — a wrong secret, or a hub too old to read our
   * envelope, which answers identically and cannot be told apart.
   *
   * A flag, not the hub's message: what is rendered is composed locally (see
   * `AUTH_REJECTED`). Unlike {@link RoomStatus.protocolMismatch} this is not
   * terminal — a refusal is not proof the secret is wrong, since a hub on its
   * way out refuses the room it is unloading — so the socket goes on retrying
   * and the next accepted token clears it.
   */
  authFailed: boolean;
  /**
   * True while no token could be minted at all: the served configuration
   * document carried no signing secret (#426).
   *
   * A different reading from {@link RoomStatus.authFailed} — nothing was ever
   * sent, so the hub has said nothing — and the one a reader can act on: the
   * deployment serving this app is what is incomplete. Page-wide and not
   * terminal; see {@link tokenMissing}.
   */
  tokenMissing: boolean;
}

export interface RoomConnection {
  room: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  status: RoomStatus;
  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(listener: (status: RoomStatus) => void): () => void;
}

interface Entry {
  connection: RoomConnection;
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
  });

  // Required when the socket is shared. `HocuspocusProvider` only attaches
  // itself in its constructor if it created the socket (`manageSocket`); with an
  // injected `websocketProvider` it stays detached — no listeners, no room in
  // the socket's provider map, no connection at all — until `attach()` is
  // called. `destroy()` detaches again on its own, and leaves the shared socket
  // alone. This is silent when you get it wrong: the UI just reads "offline".
  // Not on a page the hub has already refused: attaching is what subscribes the
  // provider to the socket and sends its token, and there is nothing to send an
  // envelope this hub will not read. The room still opens and the status line
  // says why it is not syncing.
  const storeRefused = storeRefusedRooms.has(room);
  if (protocolMismatch === null && !storeRefused) {
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
    connected:
      protocolMismatch === null &&
      !storeRefused &&
      socket.status === WebSocketStatus.Connected,
    synced: protocolMismatch === null && !storeRefused && provider.isSynced,
    hasReceivedServerState: provider.isSynced,
    hasAnswered:
      provider.isSynced || protocolMismatch !== null || storeRefused || tokenMissing,
    writable: false,
    storeRefused,
    unsyncedChanges: provider.unsyncedChanges,
    // A room opened after the refusal reads the same terminal state as the
    // rooms that were open when it arrived.
    protocolMismatch,
    authFailed: false,
    // Same reasoning: a room opened while the page already knows it has no
    // secret reads that from the start rather than after its first attempt.
    tokenMissing,
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
    // The halt is terminal, so nothing the socket or the provider says
    // afterwards may raise either flag again — including the close event that
    // arrives after `haltForProtocolMismatch` has already settled them, and a
    // provider still reporting the sync it had before it was refused.
    const halted = protocolMismatch !== null;
    status.connected =
      !halted &&
      !status.storeRefused &&
      socket.status === WebSocketStatus.Connected;
    status.synced = !halted && !status.storeRefused && provider.isSynced;
    status.writable =
      status.connected &&
      provider.isAuthenticated &&
      !status.storeRefused &&
      !status.tokenMissing;
    status.unsyncedChanges = provider.unsyncedChanges;
    emit();
  };
  // The hub's one string about our token, read by strict match and never
  // rendered. A mismatch is terminal and stops the whole page; every other
  // refusal is a room-level reading the socket keeps retrying underneath.
  provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
    const hub = readProtocolMismatch(reason);
    if (hub !== null) {
      haltForProtocolMismatch(hub);
      return;
    }
    status.authFailed = true;
    status.hasAnswered = true;
    status.writable = false;
    emit();
  });
  provider.on("authenticated", () => {
    status.authFailed = false;
    refresh();
  });

  provider.on("status", ({ status: next }: { status: WebSocketStatus }) => {
    if (next === WebSocketStatus.Disconnected) status.hasAnswered = true;
    refresh();
  });
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
    const reason = event?.event?.reason;
    if (reason === "provider_initiated") return;
    status.hasAnswered = true;
    if (reason === STORE_REFUSED_REASON) {
      storeRefusedRooms.add(room);
      status.storeRefused = true;
      status.connected = false;
      status.synced = false;
      status.writable = false;
      emit();
      // Refusal is room-local. Detach this provider without disrupting the
      // shared socket, so other rooms remain live and this one cannot rejoin.
      provider.detach();
      return;
    }
    emit();
    dropSocket();
  });

  provider.on("synced", () => {
    status.hasReceivedServerState = true;
    status.hasAnswered = true;
    refresh();
  });

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
  };

  return { connection, listeners, stopPreference, refs: 0 };
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
      held.connection.provider.destroy();
      held.connection.ydoc.destroy();
      // Nothing left to repair: a deferred drop would reconnect a socket no
      // room is listening on.
      if (entries.size === 0) cancelPendingDrop();
    },
  };
}
