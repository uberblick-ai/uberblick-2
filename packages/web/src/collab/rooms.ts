/**
 * Share one multiplexed socket and refcount each room's document/provider.
 * Release only at the last holder, including overlapping React effects.
 * Unsolicited document closes need a socket drop to make providers rejoin;
 * derive sync from current state because Hocuspocus emits synced only for true.
 * Async token callables mint afresh before every connection attempt.
 */

import {
  type HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import * as Y from "yjs";
import {
  directoryRoom,
  enforceDeletedDirectoryEntries,
  isDirectoryEntryDeleted,
  listDeletedDirectoryUuids,
  parseRoom,
  parseWorkspaceId,
  roomForDoc,
  SETTINGS_SUFFIX,
} from "@uberblick/schema";
import {
  isDocDeletedReason,
  readProtocolMismatch,
  SETTINGS_RESET_REASON,
  STORE_REFUSED_REASON,
  SYNC_PROTOCOL_VERSION,
  wrapToken,
} from "@uberblick/schema/protocol";
import { HUB_CONFIG_PATH, hubAuthToken, hubUrl, resolveClientConfig, servedLocally } from "../config.js";
import { localRoomToken } from "./local-session.js";
import { getSetting, subscribeSettings } from "../settings.js";
import { toast } from "sonner";
import { MAX_TOKEN_LIFETIME_SECONDS, importRootSecret, mintToken } from "@uberblick/schema/token";
import { WEB_CLIENT } from "./identity.js";
import type { AwarenessUser } from "./identity.js";
import { PacedRoomProvider, RoomAdmission } from "./room-admission.js";

/**
 * Bound hub-restart recovery in seconds and jitter clients that fail together.
 * Full jitter draws uniformly from minDelay to min(delay * factor^(n-1), maxDelay).
 * Set minDelay explicitly below delay: the retry library otherwise defaults it
 * to 1000 and refuses connect with "delay cannot be less than minDelay".
 */
export const SOCKET_BACKOFF = {
  delay: 250,
  minDelay: 125,
  factor: 2,
  maxDelay: 2_000,
  jitter: true,
} as const;

let socket: HocuspocusProviderWebsocket | null = null;
const admission = new RoomAdmission();

/** Set while a forced drop is in flight, so the `disconnect` handler re-dials. */
let redialAfterDrop = false;

/** Randomize each forced-drop window to avoid retry waves; trailing drops wait at most 5s. */
export const FORCED_DROP_COOLDOWN = { minMs: 2_500, maxMs: 5_000 } as const;

/** Draw uniformly; an injected source lets tests check the band's endpoints. */
export function forcedDropCooldownMs(
  random: () => number = Math.random,
  band: ForcedDropBand = FORCED_DROP_COOLDOWN,
): number {
  const { minMs, maxMs } = band;
  return Math.round(minMs + (maxMs - minMs) * random());
}

type ForcedDropBand = { readonly minMs: number; readonly maxMs: number };

/** The band {@link dropSocket} draws from: {@link FORCED_DROP_COOLDOWN} in the app. */
let forcedDropBand: ForcedDropBand = FORCED_DROP_COOLDOWN;

/** Narrow the band for deferral tests without waiting seconds; unused by the app. */
export function setForcedDropCooldownForTesting(band: ForcedDropBand): void {
  forcedDropBand = band;
}

/**
 * Protocol refusal stops the shared socket until reload. A room disconnect is
 * insufficient: providers do not manage the socket, and permission denial does
 * not close it. Retrying cannot make an incompatible protocol readable.
 */
let protocolMismatch: { hub: number; client: number } | null = null;

/** Rooms the store refused remain closed until this page is reloaded. */
const storeRefusedRooms = new Set<string>();

/** Deletion is permanent even if the directory has not reached this page yet. */
const deletedRooms = new Set<string>();

let lastForcedDrop = 0;
/** Retain the last drop's window; use the band's maximum before any drop. */
let forcedDropWindowMs: number = FORCED_DROP_COOLDOWN.maxMs;

/** A drop asked for during the cooldown, waiting for the window to end. */
let pendingDrop: ReturnType<typeof setTimeout> | null = null;

function cancelPendingDrop(): void {
  if (pendingDrop === null) return;
  clearTimeout(pendingDrop);
  pendingDrop = null;
}

/** Stop retries, deferred drops and every room at the shared socket's protocol boundary. */
function haltForProtocolMismatch(hub: number): void {
  if (protocolMismatch !== null) return;
  protocolMismatch = { hub, client: SYNC_PROTOCOL_VERSION };
  cancelPendingDrop();
  redialAfterDrop = false;
  socket?.disconnect();
  for (const entry of entries.values()) {
    const status = entry.connection.status;
    status.hasAnswered = true;
    entry.refreshStatus();
  }
}

function sharedSocket(): HocuspocusProviderWebsocket {
  if (socket !== null) return socket;
  const created = new HocuspocusProviderWebsocket({
    // Room acquisition waits for startup config before creating this socket.
    url: hubUrl(),
    ...SOCKET_BACKOFF,
  });
  created.on("disconnect", () => {
    if (!redialAfterDrop) return;
    // disconnect() clears shouldConnect; wait for close because connect()
    // returns early while the socket still reports connected.
    redialAfterDrop = false;
    void created.connect();
  });
  socket = created;
  return created;
}

/**
 * Rejoin providers orphaned by a document close on a live socket.
 * Coalesce suppressed closes into one trailing drop; never discard the sole
 * signal that a room needs repair. The cooldown bounds reconnect frequency.
 */
function dropSocket(): void {
  // Terminal refusal must not reconnect through its own resulting close.
  if (protocolMismatch !== null) return;
  const current = sharedSocket();
  // A down socket already retries and resyncs rooms; do not fight that loop.
  if (current.status !== WebSocketStatus.Connected) return;

  const sinceLastDrop = Date.now() - lastForcedDrop;
  // Use the retained draw so the check and trailing timer share a deadline.
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
  forcedDropWindowMs = forcedDropCooldownMs(Math.random, forcedDropBand);
  redialAfterDrop = true;
  current.disconnect();
}

/** Import each signing key once per page; rotating a held key requires reload. */
const signingKeys = new Map<string, Promise<CryptoKey>>();

/** Missing keys are workspace-local and retryable; the next minted key clears the flag. */
const missingWorkspaceKeys = new Set<string>();

/** Tell this workspace's open rooms whether their signing key is missing. */
function setTokenMissing(workspace: string, missing: boolean): void {
  if (missingWorkspaceKeys.has(workspace) === missing) return;
  if (missing) missingWorkspaceKeys.add(workspace);
  else missingWorkspaceKeys.delete(workspace);
  for (const entry of entries.values()) {
    if (parseRoom(entry.connection.room).workspaceId !== workspace) continue;
    const status = entry.connection.status;
    status.tokenMissing = missing;
    if (missing) status.hasAnswered = true;
    entry.refreshStatus();
  }
}

async function signedAuthMessage(
  secret: string,
  workspace: string,
  subject: string,
): Promise<string> {
  let signingKey = signingKeys.get(secret);
  if (signingKey === undefined) {
    signingKey = importRootSecret(secret);
    signingKeys.set(secret, signingKey);
  }
  return wrapToken(
    await mintToken(await signingKey, {
      typ: "room",
      sub: subject,
      workspace,
      scope: "read-write",
      // The loopback development secret signs directly; no kid.
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    }),
  );
}

/**
 * A ub open page asks for a token with its session; direct loopback
 * development signs its own. Null means this page holds no usable credential.
 */
async function authMessage(workspace: string, subject: string): Promise<string | null> {
  const config = await resolveClientConfig();
  if (config.servedWorkspaces !== undefined) {
    if (!servedLocally(workspace)) return null;
    const token = await localRoomToken(parseWorkspaceId(workspace).uuid, subject);
    return token === null ? null : wrapToken(token);
  }
  const secret = hubAuthToken();
  return secret === "" ? null : await signedAuthMessage(secret, workspace, subject);
}

const NO_CREDENTIAL =
  `uberblick web: ${HUB_CONFIG_PATH} names no hubAuthToken and this page has no ub open session, so this client cannot authenticate`;

/** Mint the protocol auth message shared by room and same-origin API requests. */
export async function mintHubAuthMessage(
  workspace: string,
  subject: string,
): Promise<string> {
  const message = await authMessage(workspace, subject);
  if (message === null) throw new Error(NO_CREDENTIAL);
  return message;
}

/**
 * Derive the bare UUID claim from the room so the hub's string comparison agrees.
 * Re-read config before each connect: missing keys retry under the same deadline;
 * already resolved keys reuse the memoised answer.
 */
async function hubToken(room: string, identity: AwarenessUser): Promise<string> {
  const config = await resolveClientConfig();
  const workspace = parseRoom(room).workspaceId;
  // Reconnects mint rather than replay tokens; both sources bound expiry.
  const message = await authMessage(workspace, getSetting("presenceName") ?? identity.name);
  setTokenMissing(workspace, message === null);
  if (message === null) {
    // Hocuspocus resends tokens on open; force a bounded reconnect to retry
    // missing config promptly. A ub open map is settled: leave healthy
    // workspaces on the shared socket uninterrupted.
    if (config.servedWorkspaces === undefined) dropSocket();
    throw new Error(NO_CREDENTIAL);
  }
  return message;
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
   * Authentication marks live admission, not acknowledgement of each write.
   * A same-tick re-acquire can widen the in-flight loss window until repair if
   * the tab dies before the room rejoins.
   */
  writable: boolean;
  /** The local store refused this room; terminal until a page reload. */
  storeRefused: boolean;
  /** Terminal document deletion, distinct from authentication and storage failures. */
  deleted?: boolean;
  /** Unacked messages, not edits; batches merge and reconnect resets to one handshake. */
  unsyncedChanges: number;
  /** Terminal page-wide client/hub versions; new rooms inherit refusal without dialing. */
  protocolMismatch: { hub: number; client: number } | null;
  /**
   * Non-protocol token refusal; do not render the hub's message. Wrong keys and
   * old envelopes are indistinguishable. Keep retrying: an unloading hub can
   * also refuse, and the next accepted token clears this flag.
   */
  authFailed: boolean;
  /** Workspace key missing: no token was sent; retry config rather than imply hub refusal. */
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

export const BLANK_ROOM_STATUS: RoomStatus = {
  connected: false,
  synced: false,
  hasReceivedServerState: false,
  hasAnswered: false,
  writable: false,
  storeRefused: false,
  deleted: false,
  unsyncedChanges: 0,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

export function refused(status: RoomStatus): boolean {
  return status.protocolMismatch !== null || status.storeRefused || status.deleted === true ||
    status.authFailed || status.tokenMissing;
}

interface Entry {
  connection: RoomConnection;
  listeners: Set<(status: RoomStatus) => void>;
  refreshStatus: () => void;
  startPresence: () => void;
  stopPresence: (withdraw: boolean) => void;
  presenceRefs: number;
  refs: number;
  haltDeleted: () => void;
  replacements: Set<(connection: RoomConnection) => void>;
}

const entries = new Map<string, Entry>();

function rememberDeletedRoom(room: string): void {
  deletedRooms.add(room);
  entries.get(room)?.haltDeleted();
}

function watchDirectoryDeletion(ydoc: Y.Doc, workspaceId: string): void {
  const reconcileDeleted = (): void => {
    enforceDeletedDirectoryEntries(ydoc);
    for (const uuid of listDeletedDirectoryUuids(ydoc)) {
      rememberDeletedRoom(roomForDoc(workspaceId, uuid));
    }
  };
  ydoc.on("update", reconcileDeleted);
}

function refreshRoomStatus(
  status: RoomStatus,
  provider: PacedRoomProvider,
  socket: HocuspocusProviderWebsocket,
): void {
  // disconnect() precedes its close event, so the page-wide halt wins over
  // socket/provider state even during a late or re-entrant refresh.
  status.protocolMismatch = protocolMismatch;
  const halted = protocolMismatch !== null || status.storeRefused || status.deleted;
  status.connected = !halted &&
    provider.isAttached && socket.status === WebSocketStatus.Connected;
  status.synced = !halted && provider.isSynced;
  // Permission denial emits before the provider clears its authentication.
  status.writable = status.connected && provider.hasAuthenticated && !refused(status);
  status.unsyncedChanges = status.deleted ? 0 : provider.unsyncedChanges;
}

function createRoomProvider(room: string, identity: AwarenessUser, onSettingsReset: () => void): PacedRoomProvider {
  const parsed = parseRoom(room);
  let settingsGeneration: number | null = null;
  let syncReady = parsed.uuid !== SETTINGS_SUFFIX;
  const provider = new PacedRoomProvider(admission, {
    name: room,
    document: new Y.Doc(),
    websocketProvider: sharedSocket(),
    sessionAwareness: parsed.uuid === SETTINGS_SUFFIX,
    // Async callable form: re-minted on every (re)connect.
    token: async () => {
      const config = await resolveClientConfig();
      syncReady = parsed.uuid !== SETTINGS_SUFFIX || config.servedWorkspaces === undefined;
      return hubToken(room, identity);
    },
  }, () => syncReady);
  provider.on("stateless", ({ payload }: { payload: string }) => {
    if (parsed.uuid !== SETTINGS_SUFFIX) return;
    let notice: unknown;
    try { notice = JSON.parse(payload); }
    catch { return; }
    if (notice === null || typeof notice !== "object" || !("type" in notice)) return;
    if (notice.type === "settings-reset") {
      if ("message" in notice && typeof notice.message === "string") {
        toast.error(notice.message, { id: "workspace-settings-refused" });
      }
      return;
    }
    if (notice.type !== "settings-generation" || !("generation" in notice) ||
      typeof notice.generation !== "number" || !Number.isSafeInteger(notice.generation) || notice.generation < 0) return;
    if (settingsGeneration !== null && settingsGeneration !== notice.generation) {
      onSettingsReset();
      return;
    }
    settingsGeneration = notice.generation;
    syncReady = true;
    provider.startSync();
  });
  return provider;
}

function openRoom(room: string, identity: AwarenessUser): Entry {
  const parsed = parseRoom(room);
  const provider = createRoomProvider(room, identity, () => replaceSettingsRoom(room, identity, connection));
  const ydoc = provider.document;
  const socket = provider.configuration.websocketProvider;

  // Injected sockets require attach(): the provider constructor attaches only
  // sockets it owns. destroy() detaches without destroying the shared socket.
  // Keep terminally refused rooms detached; they still expose their status.
  const storeRefused = storeRefusedRooms.has(room);
  const directory = entries.get(directoryRoom(parsed.workspaceId));
  const deleted = deletedRooms.has(room) ||
    (directory !== undefined && isDirectoryEntryDeleted(directory.connection.ydoc, parsed.uuid));
  const tokenMissing = missingWorkspaceKeys.has(parseRoom(room).workspaceId);
  if (protocolMismatch === null && !storeRefused && !deleted) {
    provider.attach();
  }

  /** Publish settings live; compare values so unrelated changes send no awareness update. */
  let publishedColor = "";
  let publishedName = "";
  const publishUser = (): void => {
    const color = getSetting("presenceColor") ?? identity.color;
    const name = getSetting("presenceName") ?? identity.name;
    if (color === publishedColor && name === publishedName) return;
    publishedColor = color;
    publishedName = name;
    provider.setAwarenessField("user", { name, color });
  };
  let stopPreference = (): void => {};
  const startPresence = (): void => {
    if (status.deleted) return;
    publishedColor = "";
    publishedName = "";
    publishUser();
    stopPreference = subscribeSettings(publishUser);
    provider.setAwarenessField("client", WEB_CLIENT);
  };
  const stopPresence = (withdraw: boolean): void => {
    stopPreference();
    if (!withdraw) return;
    const awareness = provider.awareness;
    const state = awareness?.getLocalState();
    if (state === null || state === undefined) return;
    const next = { ...state };
    delete next.user;
    delete next.client;
    // An ordinary update reaches peers immediately; setting null would leave
    // a stale presence at hubs that discard inbound awareness removals.
    awareness?.setLocalState(next);
  };

  // A room joining an already-connected socket receives no status transition;
  // seed from the socket or it would stay falsely offline.
  const status: RoomStatus = {
    ...BLANK_ROOM_STATUS,
    hasReceivedServerState: provider.isSynced,
    hasAnswered:
      provider.isSynced || protocolMismatch !== null || storeRefused || deleted || tokenMissing,
    storeRefused,
    deleted,
    // Seed the workspace's known missing-key state before its first attempt.
    tokenMissing,
  };
  refreshRoomStatus(status, provider, socket);
  const listeners = new Set<(status: RoomStatus) => void>();
  const emit = (): void => {
    for (const listener of listeners) listener({ ...status });
  };
  const haltDeleted = (): void => {
    if (status.deleted) return;
    status.deleted = true;
    status.authFailed = false;
    status.hasAnswered = true;
    stopPresence(false);
    provider.detach();
    refresh();
  };

  // Read current socket/provider state: synced emits only true, so mirroring
  // events would retain a stale true after disconnect.
  const refresh = (): void => {
    // Terminal refusal wins over late close events and stale provider sync.
    refreshRoomStatus(status, provider, socket);
    emit();
  };
  // Match protocol refusal strictly and never render hub text. Other refusals
  // remain room-local while the shared socket retries.
  provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
    if (status.deleted) return;
    if (isDocDeletedReason(reason)) {
      if (provider.hasAuthenticated) rememberDeletedRoom(room);
      else {
        status.hasAnswered = true;
        provider.detach();
        refresh();
      }
      return;
    }
    const hub = readProtocolMismatch(reason);
    if (hub !== null) {
      haltForProtocolMismatch(hub);
      return;
    }
    status.authFailed = true;
    status.hasAnswered = true;
    refresh();
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
    // Unsolicited document CLOSE resets sync but leaves the socket up; only a
    // socket open makes that provider rejoin. provider_initiated is our detach
    // echo (navigation/remount) and must not churn the shared socket.
    const reason = event?.event?.reason;
    if (reason === "provider_initiated") return;
    if (reason === SETTINGS_RESET_REASON && parsed.uuid === SETTINGS_SUFFIX) {
      replaceSettingsRoom(room, identity, connection);
      return;
    }
    if (reason !== undefined && isDocDeletedReason(reason)) {
      // A transport reason cannot authorize deletion. A room CLOSE only
      // detaches this room; a socket close keeps ordinary reconnect recovery.
      const webSocket = socket.webSocket;
      if (webSocket !== null && webSocket.readyState === webSocket.OPEN) provider.detach();
      status.hasAnswered = true;
      refresh();
      return;
    }
    if (status.deleted) return;
    status.hasAnswered = true;
    // Store-busy remains retryable through ordinary reconnect backoff.
    if (reason === STORE_REFUSED_REASON) {
      storeRefusedRooms.add(room);
      status.storeRefused = true;
      refresh();
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

  if (parsed.isDirectory) watchDirectoryDeletion(ydoc, parsed.workspaceId);

  return { connection, listeners, refreshStatus: refresh, startPresence, stopPresence, haltDeleted, replacements: new Set(), presenceRefs: 0, refs: 0 };
}

/** A refused replica's clocks must never join its authoritative replacement. */
function replaceSettingsRoom(room: string, identity: AwarenessUser, previous: RoomConnection): void {
  const held = entries.get(room);
  if (held === undefined || held.connection !== previous) return;
  held.stopPresence(false);
  previous.provider.destroy();
  previous.ydoc.destroy();
  held.listeners.clear();
  const next = openRoom(room, identity);
  held.connection = next.connection;
  held.listeners = next.listeners;
  held.refreshStatus = next.refreshStatus;
  held.startPresence = next.startPresence;
  held.stopPresence = next.stopPresence;
  held.haltDeleted = next.haltDeleted;
  if (held.presenceRefs > 0) held.startPresence();
  for (const replacement of held.replacements) replacement(next.connection);
}

/**
 * Acquire a shared connection to `room`. Call the returned `release` when done;
 * the connection is destroyed when the last holder releases it.
 */
export function acquireRoom(
  room: string,
  identity: AwarenessUser,
  { presence = true }: { presence?: boolean } = {},
): { connection: RoomConnection; release: () => void; onReplace?: (listener: (connection: RoomConnection) => void) => () => void } {
  let entry = entries.get(room);
  if (entry === undefined) {
    entry = openRoom(room, identity);
    entries.set(room, entry);
  }
  entry.refs += 1;
  if (presence && entry.presenceRefs++ === 0) entry.startPresence();
  const held = entry;
  let released = false;
  return {
    get connection() { return held.connection; },
    onReplace(listener) {
      held.replacements.add(listener);
      return () => held.replacements.delete(listener);
    },
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (presence && --held.presenceRefs === 0) held.stopPresence(held.refs > 0);
      if (held.refs > 0) return;
      entries.delete(room);
      held.listeners.clear();
      held.replacements.clear();
      held.connection.provider.destroy();
      held.connection.ydoc.destroy();
      // Cancel deferred repair once no room holds the socket.
      if (entries.size === 0) cancelPendingDrop();
    },
  };
}
