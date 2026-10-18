/** Background transport for the authoritative local update log. */

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  MessageType,
} from "@hocuspocus/provider";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  importCredentialKey,
  importRootSecret,
  mintToken,
} from "@uberblick/schema/token";
import {
  AUTH_REJECTED,
  isDocDeletedReason,
  protocolSkew,
  readProtocolMismatch,
  SYNC_PROTOCOL_VERSION,
  wrapToken,
} from "@uberblick/schema/protocol";
import { ensureDeviceLogin, readDeviceLogin, type DeviceLoginFailure } from "@uberblick/mcp-server/device-login";
import type { StoredHubLogin } from "@uberblick/mcp-server/auth-store";
import { hubTransportProblem, isLoopbackEndpoint } from "@uberblick/mcp-server/remote-url";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { settingsRoom } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import { HubConnection } from "./hub-connection.js";
import type { HubFailureCause } from "./hub-failure.js";

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
  /** Local reason for a refusal or outage; never raw wire text. */
  reason?: string;
  /** Socket failure evidence for CLI diagnostics; excluded from MCP outputs. */
  cause?: HubFailureCause;
  /** Only a code, numbers and the dialled host/address/port; never wire text. */
  detail?: string;
  /** Transient transport failures retry; authority and protocol refusals need action. */
  recoveryClass?: "retry" | "manual";
  /** Safe device-login recovery detail, never credential contents. */
  authRecovery?: "sign-in-required" | "no-workspace-access" | "credential-store" | "renewal-unavailable";
  /** Included even when disabled or offline, so diagnostics can name this client. */
  protocolVersion: number;
  /** Validated integer from a protocol refusal; absent until the hub supplies it. */
  hubProtocolVersion?: number;
}

export type SyncWaitResult =
  | { caughtUp: true; reason: "caught-up" }
  | { caughtUp: false; reason: "deadline" | "unavailable" };

/**
 * Room refusal can leave the socket open without another handshake. Rebuild
 * at most this many times per durable connection, then leave recovery to the
 * provider's dead-connection timeout so one unloadable room cannot churn every room.
 */
const MAX_REBUILDS = 3;

/**
 * Keep pending auth well below the hub's per-socket ceiling: exceeding it
 * terminates every room on the socket, and answers arrive a round trip late.
 * Pace initial attaches and reconnects alike, with slots scoped to one connection.
 */
export const MAX_CONCURRENT_ROOM_ATTACHES = 32;

const SOCKET_RETRY_BASE_MS = 250;

export interface SocketBackoff {
  delay: number;
  minDelay: number;
  factor: number;
  maxDelay: number;
  jitter: true;
}

/**
 * Cap socket retries for prompt recovery after a local hub restart and jitter
 * even the first retry so clients recovering together do not dial in lockstep.
 * The provider draws uniformly from minDelay to the capped doubling delay;
 * it owns randomness and its retry validator requires delay >= minDelay.
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
 * Jitter each capped doubling delay in its upper half to spread simultaneous
 * room resets across clients. The injected random source makes the bounds testable.
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

/** Device recovery polls grow to thirty seconds, with a short first refusal. */
export function deviceRetryDelayMs(
  attempts: number,
  reconnectMaxDelayMs: number,
  afterRefusal = false,
  random: () => number = Math.random,
  maxDelayMs = 30_000,
): number {
  if (afterRefusal && attempts === 0) {
    return rebuildDelayMs(0, socketBackoff(reconnectMaxDelayMs).delay, reconnectMaxDelayMs, random);
  }
  const base = Math.max(1_000, reconnectMaxDelayMs);
  return rebuildDelayMs(attempts, base, Math.max(base, maxDelayMs), random);
}

export interface AttachOptions {
  room: string;
  doc: Y.Doc;
  awareness: Awareness;
}

/** Drop closing-window frames; the next sync handshake reconciles their state. */
class UnqueuedHocuspocusProviderWebsocket extends HocuspocusProviderWebsocket {
  override send(
    message: Parameters<HocuspocusProviderWebsocket["send"]>[0],
  ): void {
    const socket = this.webSocket;
    if (socket === null || socket.readyState !== socket.OPEN) {
      return;
    }
    super.send(message);
  }
}

/**
 * Hocuspocus listeners can send before the async token resolves, bypassing the
 * room bound. Gate updates and presence until the hub authenticates this room;
 * the handshake reconciles suppressed updates and closed-socket frames.
 * Explicit detach CLOSE frames on an open socket bypass this gate.
 */
class AdmittedHocuspocusProvider extends HocuspocusProvider {
  private admittedGeneration: number | null = null;

  private tokenSent = false;

  private syncStarted = false;

  private currentGeneration: () => number | null = () => null;

  useGeneration(source: () => number | null): void {
    this.currentGeneration = source;
  }

  admitToken(generation: number): void {
    this.admittedGeneration = generation;
  }

  hasCurrentAdmission(): boolean {
    const generation = this.currentGeneration();
    return generation !== null && this.admittedGeneration === generation;
  }

  blockUntilToken(): void {
    this.admittedGeneration = null;
    this.tokenSent = false;
    this.syncStarted = false;
    this.isAuthenticated = false;
  }

  hasCurrentSync(): boolean {
    return this.syncStarted && this.isAuthenticated && this.hasCurrentAdmission();
  }

  override onMessage(event: MessageEvent): void {
    if (!this.isAttached || !this.socketOpen()) return;
    if (!this.hasCurrentSync()) {
      // The socket has already routed the room name. Inspect only its bounded
      // byte-length prefix and frame type; Hocuspocus still decodes the payload.
      const bytes = new Uint8Array(event.data);
      let nameLength = 0;
      let factor = 1;
      let type: number | undefined;
      for (let offset = 0; offset < 5 && offset < bytes.length; offset += 1) {
        const byte = bytes[offset];
        if (byte === undefined) return;
        nameLength += (byte & 0x7f) * factor;
        if (nameLength > bytes.length) return;
        if (byte < 0x80) {
          type = bytes[offset + 1 + nameLength];
          break;
        }
        factor *= 128;
      }
      if (type !== MessageType.Auth && type !== MessageType.CLOSE) return;
    }
    super.onMessage(event);
  }

  private socketOpen(): boolean {
    const socket = this.configuration.websocketProvider.webSocket;
    return socket !== null && socket.readyState === socket.OPEN;
  }

  override authenticatedHandler(scope: string): void {
    if (!this.tokenSent || !this.hasCurrentAdmission() || !this.socketOpen() || !this.isAttached) return;
    super.authenticatedHandler(scope);
    this.startSync();
  }

  override startSync(): void {
    if (!this.isAuthenticated || !this.tokenSent || !this.hasCurrentAdmission() || this.syncStarted) return;
    // The parent resets acknowledgement debt. Run once so a duplicate auth or
    // token continuation cannot discard debt for an update already sent.
    this.syncStarted = true;
    super.startSync();
  }

  override send(
    Message: Parameters<HocuspocusProvider["send"]>[0],
    args: Parameters<HocuspocusProvider["send"]>[1],
  ): void {
    if (args.token === "" || !this.socketOpen()) {
      return;
    }
    if (this.hasCurrentSync()) {
      super.send(Message, args);
      return;
    }

    // Inspect the public frame type only before admission; ordinary updates
    // avoid this allocation once the handshake has opened the gate.
    const type = new Message().type;
    if (type === MessageType.CLOSE) {
      super.send(Message, args);
      return;
    }
    if (type !== MessageType.Auth) {
      return;
    }
    const generation = this.admittedGeneration;
    if (generation === null || this.currentGeneration() !== generation) {
      return;
    }
    super.send(Message, args);
    this.tokenSent = true;
  }
}

export interface HubSyncOptions {
  /** An authenticated room's deletion refusal authorizes purging only its copy. */
  onDocDeleted?: (room: string) => void;
  /** Replace a refused settings replica only after a clean hub read completes. */
  onSettingsReset?: (state: Uint8Array, refused: Y.Doc) => void;
  /**
   * Override the admission bound for small stress fixtures. Must be a positive
   * integer: zero would leave every room queued forever on a working socket.
   */
  maxConcurrentAttaches?: number;

  /**
   * For probes whose caller renders HubState: silence missing-credential,
   * token-refusal and protocol-skew diagnostics, all represented in that state.
   * Off by default; quarantine logging remains because probes hold no update log.
   */
  silent?: boolean;
}

export class HubSync {
  /** False when neither signing-secret nor device-login sync is composed. */
  readonly enabled: boolean;

  private config: McpConfig;

  private readonly onConnected: () => void;

  private readonly roomQuietListeners = new Set<() => void>();

  private readonly stateListeners = new Set<() => void>();

  private readonly socket: HocuspocusProviderWebsocket | null = null;

  private readonly providers = new Map<string, AdmittedHocuspocusProvider>();

  private readonly deletedRooms = new Set<string>();

  private readonly onDocDeleted: ((room: string) => void) | undefined;

  private readonly onSettingsReset: ((state: Uint8Array, refused: Y.Doc) => void) | undefined;

  private settingsRecovery: { doc: Y.Doc; awareness: Awareness; refused: Y.Doc } | null = null;

  private socketStatus: "connecting" | "connected" | "disconnected" =
    "connecting";

  /** A close or failed connect seen since the last successful open. */
  private sawFailure = false;

  /** A dial failed before opening; only a successful open clears it. */
  private failedDial = false;

  private readonly connection: HubConnection;

  /** Start of the connect grace; expiry reports hub-down even without a close event. */
  private connectingSince = Date.now();

  /** Keep only refusal state, never the hub's token-related message. */
  private authRejected = false;

  /**
   * A validated refusal version, retained until restart so diagnostics identify
   * which side needs updating and later socket events cannot undo the refusal.
   */
  private hubProtocolVersion: number | null = null;

  /**
   * These terminal states require restart. Check before minting, admission,
   * room attachment or dialling, including continuations resumed after an await.
   */
  private get stopped(): boolean {
    return this.destroyed || this.quarantined || this.hubProtocolVersion !== null;
  }

  /**
   * Known refusals end a settle. Keep a device check's bounded settle alive
   * through reconnect until the probe can classify renewal, sign-in or access.
   */
  private refusedByHub(): boolean {
    return this.authRejected || this.hubProtocolVersion !== null ||
      (this.deviceReading !== null && !this.checkingDeviceRefusal &&
        (this.socketStatus === "connected" || this.deviceReading.status !== "auth-failed"));
  }

  /** The socket's own first retry delay, reused by {@link rebuild}. */
  private readonly reconnectDelayMs: number;

  /** The bound on concurrent attach/auth. See {@link MAX_CONCURRENT_ROOM_ATTACHES}. */
  private readonly maxConcurrentAttaches: number;

  /**
   * Admission belongs to one connection. Advance on disconnect so a token
   * minted across a flap must queue again before entering the new socket's count.
   */
  private socketGeneration = 0;

  /**
   * Rooms admitted but unanswered, including tokens still minting. Reset when
   * a connection ends; no pending answer can carry into its replacement.
   */
  private readonly attaching = new Set<string>();

  /**
   * FIFO, one shared ticket per room across repeated onOpen calls. Duplicate
   * admissions resolve null: the hub answers a room once, so another slot would leak.
   */
  private readonly waiting = new Map<
    string,
    {
      promise: Promise<number | null>;
      admit: (generation: number | null) => void;
    }
  >();

  /** Rebuilt connections since the last durable one. See {@link MAX_REBUILDS}. */
  private rebuilds = 0;

  /**
   * Clear on each open. Only syncing proves durability: a hub can accept auth
   * then refuse to load the room, which must not reset the rebuild budget.
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
  private readonly transportProblem: { reason: string; fix: string } | null;
  private closing: Promise<void> | null = null;

  /** See {@link HubSyncOptions.silent}. */
  private readonly silent: boolean;

  /** Cache the typed signing key; reconnects need fresh tokens, not repeated imports. */
  private signingKey: Promise<CryptoKey> | null = null;

  private deviceReading: Omit<HubState, "protocolVersion"> | null = null;
  private rejectedLogin: StoredHubLogin | undefined;
  /** The credential actually offered by each room, rather than a later login. */
  private readonly offeredLogins = new Map<string, StoredHubLogin>();
  private deviceRetryTimer: NodeJS.Timeout | null = null;
  private deviceRetryAttempts = 0;
  private checkingDeviceRefusal = false;
  private readonly deviceWork = new Set<Promise<unknown>>();
  private readonly deviceAbort = new AbortController();

  constructor(
    config: McpConfig,
    onConnected: () => void,
    options: HubSyncOptions = {},
  ) {
    this.onDocDeleted = options.onDocDeleted;
    this.onSettingsReset = options.onSettingsReset;
    if (!isLoopbackEndpoint(config.hubUrl)) {
      config = { ...config, authSecret: null, deviceLogin: config.deviceLogin ?? {} };
    }
    this.config = config;
    this.connection = new HubConnection(config.connectTimeoutMs);
    this.onConnected = onConnected;
    this.enabled = config.deviceLogin !== undefined || config.authSecret !== null;
    this.silent = options.silent === true;
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
    this.reconnectDelayMs = backoff.delay;

    this.transportProblem = hubTransportProblem(config.hubUrl, config.authEnv ?? config.deviceLogin?.env);
    if (this.transportProblem !== null) return;

    if (config.deviceLogin !== undefined) {
      const stored = readDeviceLogin(config.hubUrl, config.workspaceId, config.deviceLogin.env);
      if (stored.status !== "ready") this.deviceReading = this.deviceFailure(stored);
    }

    if (!this.enabled) {
      if (!this.silent && config.authEnv?.UB_HUB_URL !== "local") {
        log.warn(
          "HUB_AUTH_TOKEN is not set: running local-only, no hub sync (every tool still works)",
        );
      }
      return;
    }

    this.socket = new UnqueuedHocuspocusProviderWebsocket({
      url: config.hubUrl,
      WebSocketPolyfill: this.connection.websocket(),
      ...backoff,
      onStatus: ({ status }) => {
        queueMicrotask(() => this.stateChanged());
        const previous = this.socketStatus;
        this.socketStatus = status as "connecting" | "connected" | "disconnected";
        if (status !== "connected") {
          // Revoke in-flight admissions, including minting tokens. Keep queued
          // tickets: those rooms have sent nothing and still need their turn.
          this.socketGeneration += 1;
          this.attaching.clear();
          for (const provider of this.providers.values()) {
            provider.blockUntilToken();
          }
        }
        if (status === "connected") {
          // The provider repeats this status after its first inbound message.
          // Only a new socket may reset room state or cancel a recovery poll.
          if (previous === "connected") return;
          if (this.deviceRetryTimer !== null) {
            clearTimeout(this.deviceRetryTimer);
            this.deviceRetryTimer = null;
          }
          this.sawFailure = false;
          this.failedDial = false;
          // Reset durability evidence before any room on this connection answers.
          this.syncedRooms.clear();
          this.connectionDisowned = false;
          this.onConnected();
          return;
        }
        if (previous === "connected") {
          this.connectingSince = Date.now();
        }
        // disconnect() stops retries; connect() cannot dial until close lands.
        if (status === "disconnected" && this.rebuilding) {
          this.rebuilding = false;
          if (this.stopped) {
            return;
          }
          void this.socket?.connect().catch(() => {
            // The socket owns retrying failed dials.
          });
        }
      },
      onClose: () => {
        this.sawFailure = true;
        // The configured close callback runs before the provider reports
        // disconnected. A close after open still deserves reconnect grace.
        if (this.socketStatus !== "connected") this.failedDial = true;
        this.stateChanged();
      },
    });

    // Subscribe after construction: configured onOpen runs before the socket
    // saves its payload. This listener runs with that payload, ahead of providers.
    this.socket.on("open", () => {
      if (this.stopped) {
        return;
      }
      this.pumpAdmissions();
    });
  }

  /**
   * Gate initial and reconnect token calls before any auth or sync frame.
   * Return the admitted generation for the caller to check, or null when a
   * duplicate continuation already holds this room's slot.
   */
  private admission(room: string): Promise<number | null> {
    if (this.deletedRooms.has(room)) return Promise.resolve(null);
    if (this.stopped) {
      // Terminal callers must resolve rather than queue for a nonexistent connection.
      return Promise.resolve(this.socketGeneration);
    }
    const queued = this.waiting.get(room);
    if (queued !== undefined) {
      return queued.promise;
    }
    let admit!: (generation: number | null) => void;
    const promise = new Promise<number | null>((resolve) => {
      admit = resolve;
    });
    this.waiting.set(room, { promise, admit });
    this.pumpAdmissions();
    this.stateChanged();
    return promise;
  }

  /** Let as many queued rooms through as the bound and this connection allow. */
  private pumpAdmissions(): void {
    if (this.socketStatus === "connected") {
      for (const [room, ticket] of this.waiting) {
        // The hub answers a room once; a duplicate onOpen would strand its slot.
        if (this.attaching.has(room)) {
          this.waiting.delete(room);
          ticket.admit(null);
          continue;
        }
        if (this.attaching.size >= this.maxConcurrentAttaches) {
          break;
        }
        this.waiting.delete(room);
        this.attaching.add(room);
        ticket.admit(this.socketGeneration);
      }
    }
  }

  /**
   * Auth success, refusal and room closure all release the pending room's slot.
   */
  private roomAnswered(room: string): void {
    if (this.attaching.delete(room)) {
      this.pumpAdmissions();
    }
    this.stateChanged();
  }

  /**
   * Release terminal callers on the current generation so they end rather
   * than requeue. Minting calls also check terminal state after their awaits.
   */
  private releaseAdmissions(): void {
    for (const [room, ticket] of this.waiting) {
      this.waiting.delete(room);
      ticket.admit(this.socketGeneration);
    }
    this.attaching.clear();
    this.stateChanged();
  }

  /**
   * Direct evidence for terminal-state tests; silence on the hub cannot prove
   * that a client has stopped minting rather than merely delayed reconnecting.
   */
  mintCount = 0;

  /** Mint a fresh token for this agent session. */
  private async token(room: string): Promise<string | null> {
    if (this.config.deviceLogin !== undefined) {
      const rejected = this.rejectedLogin;
      const work = ensureDeviceLogin(this.config.hubUrl, this.config.workspaceId, {
        ...(this.config.deviceLogin.env === undefined ? {} : { env: this.config.deviceLogin.env }),
        ...(rejected === undefined ? {} : { rejected }),
        signal: this.deviceAbort.signal,
        ...(this.config.deviceRenewalCooldownMs === undefined ? {} : { renewalCooldownMs: this.config.deviceRenewalCooldownMs }),
      });
      this.deviceWork.add(work);
      const result = await work.finally(() => this.deviceWork.delete(work));
      if (this.stopped) return null;
      // A token already minting before the refusal says nothing about it.
      if (rejected !== undefined || this.offeredLogins.size === 0) this.checkingDeviceRefusal = false;
      if (result.status !== "ready") {
        this.deviceReading = this.deviceFailure(result);
        this.stateChanged();
        if (result.status === "update-required" && result.hubVersion !== undefined) {
          this.stopForProtocolMismatch(result.hubVersion);
        } else {
          this.retryDeviceConnection();
        }
        return null;
      }
      this.deviceReading = null;
      this.stateChanged();
      this.rejectedLogin = undefined;
      this.offeredLogins.set(room, result.login);
      this.mintCount += 1;
      return mintToken(await importCredentialKey(Buffer.from(result.login.credential.key, "base64url")), {
        typ: "room",
        sub: this.config.sessionId,
        workspace: this.config.workspaceId,
        scope: "read-write",
        kid: result.login.credential.record.id,
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      });
    }
    this.mintCount += 1;
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
        // Each connect mints anew; use the allowed lifetime to avoid needless reconnects.
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      }),
    );
  }

  private deviceFailure(result: DeviceLoginFailure): Omit<HubState, "protocolVersion"> {
    const authRecovery = result.status === "sign-in-required" ? "sign-in-required"
      : result.status === "no-access" ? "no-workspace-access"
      : result.status === "renewal-unavailable" ? "renewal-unavailable" : "credential-store";
    return {
      status: result.status === "hub-down" ? "hub-down"
        : result.status === "update-required" ? "update-required" : "auth-failed",
      url: this.config.hubUrl,
      reason: result.message,
      recoveryClass: result.status === "hub-down" ? "retry" : "manual",
      ...(result.status === "hub-down" || result.status === "update-required" ? {} : { authRecovery }),
    };
  }

  private stopDeviceWork(): void {
    this.deviceAbort.abort();
    if (this.deviceRetryTimer !== null) clearTimeout(this.deviceRetryTimer);
    this.deviceRetryTimer = null;
    this.checkingDeviceRefusal = false;
    this.offeredLogins.clear();
    this.rejectedLogin = undefined;
  }

  /**
   * Re-read login in a growing random band, including while waiting for a
   * human. The first refusal gets the socket's short band so a bounded probe
   * can classify it; subsequent failures grow to a thirty-second ceiling.
   */
  private retryDeviceConnection(afterRefusal = false): void {
    if (this.stopped || this.deviceRetryTimer !== null) return;
    const delay = deviceRetryDelayMs(
      this.deviceRetryAttempts, this.config.reconnectMaxDelayMs, afterRefusal, Math.random, this.config.deviceRetryMaxDelayMs,
    );
    this.deviceRetryAttempts += 1;
    this.deviceRetryTimer = setTimeout(() => {
      this.deviceRetryTimer = null;
      if (this.stopped) return;
      if (this.socketStatus === "connected") {
        this.rebuilding = true;
        this.socket?.disconnect();
      } else {
        // Refusal can close the socket before this timer fires. connect() also
        // re-enables a disconnected provider, so a later login is observed even
        // after its ordinary reconnect loop has stopped.
        void this.socket?.connect().catch(() => {});
        this.retryDeviceConnection();
      }
    }, delay);
  }

  /**
   * Only the first disowned room may reset the budget, and only if every room
   * had synced on this connection. Later closes in the same wave share that budget.
   */
  private hubDisownedRoom(): void {
    // Socket loss already retries every room through the provider.
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
   * One bounded, jittered rebuild per backoff window; simultaneous room closes
   * must not each restart the shared socket.
   */
  private rebuild(): void {
    if (
      this.socket === null ||
      this.stopped ||
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
      if (this.stopped || this.socketStatus !== "connected") {
        return;
      }
      this.rebuilding = true;
      this.socket?.disconnect();
    }, delay);
  }

  /**
   * Join each room once without throwing or waiting for the network; connect,
   * retry and sync run in the background.
   * Disabled and terminal clients attach nothing.
   */
  attach({ room, doc, awareness }: AttachOptions): void {
    if (this.socket === null || this.stopped || this.providers.has(room) || this.deletedRooms.has(room)) {
      return;
    }

    const provider = new AdmittedHocuspocusProvider({
      name: room,
      // Refusal recovery replaces providers on the same socket. Session routing
      // keeps late acknowledgements and CLOSEs on their retired incarnation.
      sessionAwareness: room === settingsRoom(this.config.workspaceId),
      document: doc,
      awareness,
      websocketProvider: this.socket,
      // Mint freshly on each reconnect after admission. Authentication carries
      // the token in its message, never the URL; a queued room publishes nothing.
      token: async () => {
        for (;;) {
          if (this.providers.get(room) !== provider) return "";
          if (provider.hasCurrentAdmission()) {
            return "";
          }
          const generation = await this.admission(room);
          if (this.providers.get(room) !== provider) return "";
          if (this.stopped || generation === null || this.deletedRooms.has(room)) {
            // Empty means send nothing: no terminal or duplicate call may requeue.
            return "";
          }
          if (provider.hasCurrentAdmission()) {
            // The first ticket answered while this duplicate was queued; return its slot.
            this.roomAnswered(room);
            return "";
          }
          const token = await this.roomToken(room, provider);
          if (this.providers.get(room) !== provider) return "";
          if (token === null || this.stopped || this.deletedRooms.has(room)) {
            this.roomAnswered(room);
            return "";
          }
          // Across a flap, two onOpen calls can share a ticket; only the first sends.
          if (provider.hasCurrentAdmission()) {
            return "";
          }
          if (generation === this.socketGeneration) {
            // No await between the generation check and send admission. Empty
            // returns above remain unwrapped so they cannot become an auth frame.
            provider.admitToken(generation);
            return wrapToken(token);
          }
          // The socket changed during minting; requeue against its new pending count.
        }
      },
      onAuthenticated: () => {
        this.authRejected = false;
        this.deviceRetryAttempts = 0;
        this.roomAnswered(room);
      },
      onSynced: ({ state }) => {
        if (state) {
          this.syncedRooms.add(room);
        }
        this.stateChanged();
        this.finishSettingsRecovery(room, provider);
      },
      onUnsyncedChanges: ({ number }) => {
        if (number === 0) {
          for (const listener of this.roomQuietListeners) listener();
        }
        this.stateChanged();
        this.finishSettingsRecovery(room, provider);
      },
      onMessage: ({ message }) => {
        if (room !== settingsRoom(this.config.workspaceId) || this.onSettingsReset === undefined) return;
        message.readVarString();
        if (message.readVarUint() !== MessageType.SyncStatus || message.readVarUint() !== 0) return;
        // Finish this receiver before retiring its provider. A refusal belongs
        // to this room and never starts device-login or shared-socket recovery.
        queueMicrotask(() => {
          if (this.providers.get(room) === provider) this.recoverSettings(room);
        });
      },
      onAuthenticationFailed: ({ reason }: { reason: string }) => {
        const authenticated = provider.hasCurrentSync();
        provider.blockUntilToken();
        if (isDocDeletedReason(reason)) {
          this.detach(room);
          if (authenticated) this.onDocDeleted?.(room);
          return;
        }
        // Strict parsing yields only a validated different version, never wire
        // text. Other reasons, including our own version, remain token refusals.
        const hubProtocol = readProtocolMismatch(reason);
        if (hubProtocol !== null) {
          this.stopForProtocolMismatch(hubProtocol);
          return;
        }
        // A Docker proxy may be reached over loopback while the hub itself
        // requires device authority. Its strict sentinel can select stronger
        // admission, but never authorize a secret on a non-loopback endpoint.
        if (reason === "device-credential-refused" && this.config.deviceLogin === undefined) {
          this.config = {
            ...this.config, authSecret: null,
            deviceLogin: { ...(this.config.authEnv === undefined ? {} : { env: this.config.authEnv }) },
          };
          this.authRejected = false;
        }
        if (this.config.deviceLogin !== undefined) {
          this.rejectedLogin ??= this.offeredLogins.get(room);
          this.checkingDeviceRefusal = true;
          this.deviceReading = {
            status: "hub-down", url: this.config.hubUrl, recoveryClass: "retry",
            reason: "the hub refused this connection; checking the stored device login on reconnect",
          };
          this.roomAnswered(room);
          this.retryDeviceConnection(true);
          return;
        }
        // Keep auth-failed distinct from retryable hub-down, using the local
        // AUTH_REJECTED reason because remote token-related text must not escape.
        this.authRejected = true;
        this.roomAnswered(room);
        if (!this.silent) {
          log.error("hub rejected the token", { room });
        }
        // Unloading or unloadable rooms can refuse valid tokens. Retry on a new
        // connection, retaining auth-failed until authentication actually succeeds.
        this.hubDisownedRoom();
      },
      onClose: ({ event }) => {
        provider.blockUntilToken();
        const socket = this.socket?.webSocket ?? null;
        if (isDocDeletedReason(event.reason) && socket !== null && socket.readyState === socket.OPEN) {
          this.detach(room);
          return;
        }
        // A closed room releases its slot even without an auth answer.
        this.roomAnswered(room);
        if (this.deletedRooms.has(room)) return;
        // Rebuild only for a room close; hubDisownedRoom ignores socket loss.
        this.hubDisownedRoom();
      },
    });
    provider.useGeneration(() =>
      this.socketStatus === "connected" ? this.socketGeneration : null,
    );
    // Shared-socket providers require explicit attach to subscribe and authenticate.
    this.providers.set(room, provider);
    provider.attach();
    this.stateChanged();
  }

  /** Permanently retire one room without disturbing its shared connection. */
  detach(room: string): void {
    if (this.deletedRooms.has(room) && !this.providers.has(room) && !this.waiting.has(room) && !this.attaching.has(room)) return;
    this.deletedRooms.add(room);
    this.releaseRoom(room);
  }

  /** Retire a provider while allowing the same room to attach a fresh replica. */
  releaseRoom(room: string): void {
    const ticket = this.waiting.get(room);
    this.waiting.delete(room);
    ticket?.admit(null);
    const provider = this.providers.get(room);
    this.providers.delete(room);
    this.syncedRooms.delete(room);
    this.offeredLogins.delete(room);
    if (provider !== undefined) {
      provider.blockUntilToken();
      provider.destroy();
    }
    const recovery = this.settingsRecovery;
    if (recovery !== null && provider?.document === recovery.doc) {
      this.settingsRecovery = null;
      recovery.awareness.destroy();
      recovery.doc.destroy();
    }
    this.roomAnswered(room);
  }

  private recoverSettings(room: string): void {
    if (this.settingsRecovery !== null || this.stopped) return;
    const refused = this.providers.get(room)?.document;
    if (refused === undefined) return;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    this.releaseRoom(room);
    this.settingsRecovery = { doc, awareness, refused };
    this.attach({ room, doc, awareness });
  }

  private finishSettingsRecovery(room: string, provider: AdmittedHocuspocusProvider): void {
    const recovery = this.settingsRecovery;
    const quiet = () => this.state().status === "connected" && provider.hasCurrentSync() && provider.isSynced && !provider.hasUnsyncedChanges;
    if (recovery === null || provider.document !== recovery.doc || !quiet()) return;
    queueMicrotask(() => {
      if (this.settingsRecovery !== recovery || this.providers.get(room) !== provider || !quiet()) return;
      this.settingsRecovery = null;
      try {
        this.onSettingsReset?.(Y.encodeStateAsUpdate(recovery.doc), recovery.refused);
      } finally {
        recovery.awareness.destroy();
        recovery.doc.destroy();
      }
    });
  }

  private async roomToken(room: string, provider: AdmittedHocuspocusProvider): Promise<string | null> {
    try {
      return await this.token(room);
    } catch {
      if (this.providers.get(room) !== provider) return null;
      if (this.config.deviceLogin === undefined) throw new Error("could not mint a hub token");
      if (!this.stopped) {
        // Store, transport and crypto exceptions may contain secrets.
        this.deviceReading = {
          status: "hub-down", url: this.config.hubUrl, recoveryClass: "retry",
          reason: "could not check the stored device login; the client will retry",
        };
        this.checkingDeviceRefusal = false;
        this.retryDeviceConnection();
      }
      return null;
    }
  }

  /**
   * Both local and remote updates are logged; provider identity selects their log origin.
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
   * A failed log append does not stop Yjs's other listeners. Detach makes send
   * inert before those listeners can broadcast an unlogged mutation, then
   * disconnect permanently; only process restart rebuilds a durable replica.
   */
  quarantine(): void {
    if (this.quarantined) {
      return;
    }
    this.quarantined = true;
    this.stateChanged();
    this.stopDeviceWork();
    for (const provider of this.providers.values()) {
      provider.detach();
    }
    // Detached providers are inert; release their suspended token calls.
    this.releaseAdmissions();
    this.socket?.disconnect();
    log.error("quarantined the hub connection: this replica is not durable");
  }

  /**
   * Protocol skew is terminal until restart, even if the hub changes later:
   * neither reconnect nor fresh tokens change our version. Set terminal state
   * before releasing awaiters, cancel retries and detach all providers; one
   * process-level diagnostic and no rebuild budget are spent.
   */
  private stopForProtocolMismatch(hubProtocol: number): void {
    if (this.hubProtocolVersion !== null) {
      return;
    }
    this.hubProtocolVersion = hubProtocol;
    this.stateChanged();
    this.stopDeviceWork();
    if (!this.silent) {
      log.error("the hub speaks a different sync protocol: update required", {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        hubProtocolVersion: hubProtocol,
      });
    }
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.rebuilding = false;
    for (const provider of this.providers.values()) {
      provider.detach();
    }
    this.releaseAdmissions();
    this.socket?.disconnect();
  }

  isQuarantined(): boolean {
    return this.quarantined;
  }

  /**
   * Add our protocol version centrally so every reading, including offline, carries it.
   */
  state(): HubState {
    const reach = this.reach();
    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      recoveryClass: reach.status === "connecting" || reach.status === "connected" || reach.status === "hub-down" ? "retry" : "manual",
      ...reach,
    };
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
    if (this.transportProblem !== null) return {
      status: "hub-down", url: this.config.hubUrl, recoveryClass: "manual",
      reason: `${this.transportProblem.reason}; ${this.transportProblem.fix}`,
    };
    if (!this.enabled) {
      return {
        status: "disabled",
        url: null,
        reason: "HUB_AUTH_TOKEN is not set",
      };
    }
    // A validated protocol refusal takes precedence over generic auth failure.
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
    if (this.deviceReading !== null && (this.socketStatus === "connected" ||
        this.deviceReading.status !== "auth-failed" ||
        (!this.sawFailure && Date.now() - this.connectingSince <= this.config.connectTimeoutMs))) return this.deviceReading;
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
        ...this.connection.failure(Date.now() - this.connectingSince > this.config.connectTimeoutMs),
      };
    }
    return { status: "connecting", url: this.config.hubUrl };
  }

  /**
   * Quiet proves hub acknowledgement only; debounced hub storage can still be pending.
   */
  isRoomQuiet(room: string): boolean {
    if (this.state().status !== "connected") return false;
    const provider = this.providers.get(room);
    if (provider === undefined) {
      return false;
    }
    if (provider.document === this.settingsRecovery?.doc) return false;
    return provider.hasCurrentSync() && provider.isSynced && !provider.hasUnsyncedChanges;
  }

  private stateChanged(): void {
    for (const listener of this.stateListeners) listener();
  }

  /** Observe connection, admission and provider acknowledgement changes. */
  onStateChange(listener: () => void): () => void {
    if (this.destroyed) return () => {};
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /** Wake work that can advance once a provider has no outstanding messages. */
  onRoomQuiet(listener: () => void): () => void {
    if (this.destroyed) return () => {};
    this.roomQuietListeners.add(listener);
    return () => {
      this.roomQuietListeners.delete(listener);
    };
  }

  /**
   * Count pending messages, not updates: batching merges updates into one message,
   * and reconnect resets the room backlog to its single handshake message.
   */
  unsyncedChanges(): number {
    let total = 0;
    for (const provider of this.providers.values()) {
      total += provider.unsyncedChanges;
    }
    return total;
  }

  /**
   * Check our queues as well as provider flags: rooms not yet admitted cannot
   * support synced: true, even if the currently admitted rooms are quiet.
   */
  private allQuiet(): boolean {
    if (this.waiting.size > 0 || this.attaching.size > 0) {
      return false;
    }
    for (const room of this.providers.keys()) {
      if (!this.isRoomQuiet(room)) {
        return false;
      }
    }
    return true;
  }

  /**
   * A connected drain can outlast one settle budget; callers must settle again
   * next time. Exclude offline queues so every offline call does not repay connect grace.
   */
  isDraining(): boolean {
    return (
      this.socketStatus === "connected" &&
      (this.waiting.size > 0 || this.attaching.size > 0)
    );
  }

  /**
   * Bound network waiting to one connect grace and one sync budget, independent
   * of corpus or queue size. Known unavailability ends early; unfinished rooms
   * remain synced: false and a connected drain owes another settle on the next call.
   */
  async waitForQuiet(options: {
    /** Use a narrower acknowledgement condition than all attached rooms. */
    isQuiet?: () => boolean;
    /** Absolute monotonic deadline shared with the caller's remaining work. */
    deadline?: number;
    /** Additional local state that can change the caller's acknowledgement condition. */
    subscribe?: (wake: () => void) => () => void;
  } = {}): Promise<SyncWaitResult> {
    if (this.socket === null || this.destroyed) {
      return { caughtUp: false, reason: "unavailable" };
    }
    const deadline = options.deadline ?? Infinity;
    const connectDeadline = Date.now() + this.config.connectTimeoutMs;
    let syncDeadline: number | undefined;
    return new Promise<SyncWaitResult>((resolve, reject) => {
      let finished = false;
      let queued = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribeLocal = () => {};
      let unsubscribe = () => {};
      const cleanup = () => {
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        unsubscribeLocal();
      };
      const finish = (result: SyncWaitResult) => {
        cleanup();
        resolve(result);
      };
      const evaluate = () => {
        queued = false;
        if (finished) return;
        clearTimeout(timer);
        if (this.stopped || this.failedDial || this.refusedByHub() ||
          (syncDeadline !== undefined && this.socketStatus !== "connected" && !this.checkingDeviceRefusal)) {
          finish({ caughtUp: false, reason: "unavailable" });
          return;
        }
        if (performance.now() >= deadline) {
          finish({ caughtUp: false, reason: "deadline" });
          return;
        }
        if (this.socketStatus === "connected") {
          syncDeadline ??= Date.now() + this.config.syncTimeoutMs;
          if (options.isQuiet?.() ?? this.allQuiet()) {
            finish({ caughtUp: true, reason: "caught-up" });
            return;
          }
        }
        const phaseDeadline = syncDeadline ?? connectDeadline;
        if (Date.now() >= phaseDeadline) {
          finish({ caughtUp: false, reason: "deadline" });
          return;
        }
        // One deadline timer, rearmed only by actual state changes. Subscribe
        // before the first reading so an acknowledgement cannot fall between them.
        timer = setTimeout(wake, Math.min(phaseDeadline - Date.now(), deadline - performance.now()));
      };
      const wake = () => {
        if (finished || queued) return;
        queued = true;
        queueMicrotask(() => {
          try {
            evaluate();
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
      };
      unsubscribe = this.onStateChange(wake);
      try {
        unsubscribeLocal = options.subscribe?.(wake) ?? unsubscribeLocal;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      wake();
    });
  }

  destroy(): Promise<void> {
    if (this.closing !== null) return this.closing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.destroyed = true;
    this.connection.close(() => {
      const errors: unknown[] = [];
      const close = (action: () => void) => {
        try { action(); } catch (error) { errors.push(error); }
      };
      close(() => this.stateChanged());
      this.stateListeners.clear();
      close(() => this.stopDeviceWork());
      this.roomQuietListeners.clear();
      if (this.rebuildTimer !== null) {
        clearTimeout(this.rebuildTimer);
        this.rebuildTimer = null;
      }
      for (const provider of this.providers.values()) {
        close(() => provider.destroy());
      }
      this.providers.clear();
      if (this.settingsRecovery !== null) {
        close(() => this.settingsRecovery?.awareness.destroy());
        close(() => this.settingsRecovery?.doc.destroy());
        this.settingsRecovery = null;
      }
      close(() => this.releaseAdmissions());
      close(() => this.socket?.destroy());
      if (errors.length) throw new AggregateError(errors, "hub sync teardown failed");
    }).then(resolve, reject);
    return this.closing;
  }

  /** After destruction, drain any issued credential's conditional publication. */
  async waitForDeviceWork(): Promise<void> {
    await Promise.allSettled(this.deviceWork);
  }
}
