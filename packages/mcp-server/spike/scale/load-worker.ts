/**
 * Scale probe — one worker process hosting many simulated MCP processes.
 *
 * Each simulated process is one websocket carrying every room, exactly as
 * `HubSync` does: one `HocuspocusProviderWebsocket` per MCP process, one
 * provider per room multiplexed on it, admission paced in waves of
 * MAX_CONCURRENT_ROOM_ATTACHES (32) on the first connection and on every
 * re-open, and a full-jitter reconnect band from `socketBackoff`.
 *
 * What it does NOT do is hold a Y.Doc per room: it decodes the message
 * envelope, answers sync step 1 with an empty diff and drops everything else.
 * The hub allocates exactly the same per-connection, per-document state either
 * way — that is the point — while 300 × D client-side documents would not fit
 * on any machine.
 */

import { importRootSecret, mintToken, MAX_TOKEN_LIFETIME_SECONDS } from "@uberblick/hub/token";
import { wrapToken } from "@uberblick/hub/protocol";
import {
  authMessage,
  AUTH_DENIED,
  AUTH_OK,
  decodeIncoming,
  MSG_AUTH,
  MSG_SYNC,
  SECRET,
  SYNC_STEP1,
  syncStep1Message,
  syncStep2Message,
  WORKSPACE,
} from "./common.js";

const MAX_CONCURRENT_ROOM_ATTACHES = 32;
const SOCKET_RETRY_BASE_MS = 250;
const SOCKET_RETRY_MAX_MS = 4_000;

const keyPromise = importRootSecret(process.env.PROBE_SECRET ?? SECRET);

interface Totals {
  sockets: number;
  open: number;
  authenticated: number;
  synced: number;
  denied: number;
  resetClosures: number;
  closes: number;
  bytesIn: number;
  /** Wall-clock ms of the last full admission run per socket, max across all. */
  lastFullSyncAtMs: number;
}

const totals: Totals = {
  sockets: 0,
  open: 0,
  authenticated: 0,
  synced: 0,
  denied: 0,
  resetClosures: 0,
  closes: 0,
  bytesIn: 0,
  lastFullSyncAtMs: 0,
};

let rooms: string[] = [];
let url = "";

class SimulatedProcess {
  private socket: WebSocket | null = null;

  private readonly pending: string[] = [];

  private readonly inFlight = new Set<string>();

  private authed = new Set<string>();

  private synced = new Set<string>();

  private generation = 0;

  private attempts = 0;

  private stopped = false;

  constructor(readonly id: string) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  get authenticatedCount(): number {
    return this.authed.size;
  }

  get syncedCount(): number {
    return this.synced.size;
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.generation += 1;
    const generation = this.generation;

    socket.onopen = (): void => {
      totals.open += 1;
      this.attempts = 0;
      // A new connection re-authenticates every room — the stampede the wave
      // bound exists for, not only the first attach.
      this.authed = new Set();
      this.synced = new Set();
      this.inFlight.clear();
      this.pending.length = 0;
      this.pending.push(...rooms);
      this.pump(generation);
    };

    socket.onmessage = (event: MessageEvent): void => {
      const data = event.data as ArrayBuffer;
      totals.bytesIn += data.byteLength;
      const bytes = new Uint8Array(data);
      let frame;
      try {
        frame = decodeIncoming(bytes);
      } catch {
        return;
      }
      if (frame.type === MSG_AUTH) {
        if (frame.sub === AUTH_OK) {
          this.authed.add(frame.room);
          this.inFlight.delete(frame.room);
          this.pump(generation);
        } else if (frame.sub === AUTH_DENIED) {
          totals.denied += 1;
          this.inFlight.delete(frame.room);
          this.pump(generation);
        }
        return;
      }
      if (frame.type === MSG_SYNC) {
        if (frame.sub === SYNC_STEP1) {
          // The server's own state vector: answer with our (empty) diff, which
          // is what a fresh replica would send.
          socket.send(syncStep2Message(frame.room));
          return;
        }
        // Step 2 or an update: the room has content on the wire. Dropped on
        // purpose; the hub has already done all of its work by now.
        if (!this.synced.has(frame.room)) {
          this.synced.add(frame.room);
          if (this.synced.size === rooms.length) {
            totals.lastFullSyncAtMs = Math.max(totals.lastFullSyncAtMs, Date.now());
          }
        }
      }
    };

    socket.onclose = (event: CloseEvent): void => {
      totals.closes += 1;
      if (event.code === 4205) totals.resetClosures += 1;
      // Nothing on a connection that has gone away is authenticated or synced
      // any more. Cleared here as well as in `onopen` so that a restart's
      // resync time is measured from zero rather than from stale counters.
      this.authed = new Set();
      this.synced = new Set();
      this.inFlight.clear();
      if (this.stopped) return;
      this.attempts += 1;
      // socketBackoff's band: full jitter over [minDelay, min(base*2^n, max)].
      const ceiling = Math.min(
        SOCKET_RETRY_BASE_MS * 2 ** (this.attempts - 1),
        SOCKET_RETRY_MAX_MS,
      );
      const floorMs = Math.max(1, Math.floor(SOCKET_RETRY_BASE_MS / 2));
      const delay = floorMs + Math.random() * Math.max(0, ceiling - floorMs);
      setTimeout(() => this.connect(), delay);
    };

    socket.onerror = (): void => {
      /* the close handler is the one that retries */
    };
  }

  /** Admit rooms up to the wave bound, exactly as HubSync's `admission` does. */
  private pump(generation: number): void {
    if (generation !== this.generation) return;
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    while (this.inFlight.size < MAX_CONCURRENT_ROOM_ATTACHES) {
      const room = this.pending.shift();
      if (room === undefined) return;
      this.inFlight.add(room);
      void this.sendAuth(socket, room, generation);
    }
  }

  private async sendAuth(
    socket: WebSocket,
    room: string,
    generation: number,
  ): Promise<void> {
    const key = await keyPromise;
    const token = await mintToken(key, {
      typ: "room",
      sub: this.id,
      workspace: WORKSPACE,
      scope: "read-write",
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    });
    if (generation !== this.generation || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(authMessage(room, wrapToken(token)));
    // The real provider sends its sync step 1 immediately after the token, in
    // the same `onOpen` continuation.
    socket.send(syncStep1Message(room));
  }
}

const processes: SimulatedProcess[] = [];

process.on("message", (message: Record<string, unknown>) => {
  const type = message.type as string;
  if (type === "configure") {
    url = message.url as string;
    rooms = message.rooms as string[];
    process.send?.({ type: "configured" });
    return;
  }
  if (type === "spawn") {
    const count = message.count as number;
    const prefix = message.prefix as string;
    for (let index = 0; index < count; index += 1) {
      const simulated = new SimulatedProcess(`${prefix}-${processes.length}`);
      processes.push(simulated);
      totals.sockets += 1;
      simulated.start();
    }
    process.send?.({ type: "spawned", sockets: processes.length });
    return;
  }
  if (type === "stats") {
    let authenticated = 0;
    let synced = 0;
    let fullySynced = 0;
    for (const simulated of processes) {
      authenticated += simulated.authenticatedCount;
      synced += simulated.syncedCount;
      if (simulated.syncedCount === rooms.length) fullySynced += 1;
    }
    process.send?.({
      type: "stats",
      sockets: processes.length,
      authenticated,
      synced,
      fullySynced,
      denied: totals.denied,
      resetClosures: totals.resetClosures,
      closes: totals.closes,
      bytesInMb: totals.bytesIn / 1e6,
      rssMb: process.memoryUsage().rss / 1e6,
    });
    return;
  }
  if (type === "stop") {
    for (const simulated of processes) simulated.stop();
    process.send?.({ type: "stopped" });
    setTimeout(() => process.exit(0), 100);
  }
});
