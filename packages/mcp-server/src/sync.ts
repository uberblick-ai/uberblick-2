/**
 * Background sync with the hub.
 *
 * Everything here is optional to the server's operation. The local update log
 * is the authoritative replica; this module only pushes it up and pulls other
 * clients' updates down. Nothing in a tool call waits for the hub beyond a
 * bounded settle, and a hub that is down, unreachable or refusing the token
 * changes no tool's answer except `sync_status`.
 *
 * Three decisions worth keeping:
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

    if (!this.enabled) {
      log.warn(
        "HUB_AUTH_TOKEN is not set: running local-only, no hub sync (every tool still works)",
      );
      return;
    }

    // A local hub restart should be picked up in seconds, not minutes: the
    // default backoff climbs to 30s, which would strand an offline-created doc
    // long after the hub is back. `minDelay` is the retry library's floor and
    // must not exceed the first delay or the cap.
    const retryDelay = Math.min(250, config.reconnectMaxDelayMs);

    this.socket = new HocuspocusProviderWebsocket({
      url: config.hubUrl,
      delay: retryDelay,
      minDelay: retryDelay,
      factor: 2,
      maxDelay: config.reconnectMaxDelayMs,
      jitter: false,
      onStatus: ({ status }) => {
        const previous = this.socketStatus;
        this.socketStatus = status as "connecting" | "connected" | "disconnected";
        if (status === "connected") {
          this.sawFailure = false;
          this.onConnected();
        } else if (previous === "connected") {
          this.connectingSince = Date.now();
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
      onAuthenticationFailed: () => {
        // Distinct from an unreachable hub: a human has to fix the secret. The
        // hub's own wording is discarded rather than stored or logged — it is
        // remote text about a token we just sent, and every consumer of this
        // state renders it. See AUTH_REJECTED.
        this.authRejected = true;
        log.error("hub rejected the token", { room });
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
    for (const provider of this.providers.values()) {
      provider.destroy();
    }
    this.providers.clear();
    this.socket?.destroy();
  }
}
