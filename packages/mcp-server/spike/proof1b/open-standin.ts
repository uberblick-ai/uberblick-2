/**
 * Proof 1b — a minimal `ub open` stand-in for plan v3 §5.3. Throwaway.
 *
 * One process, two halves joined only by the store:
 *
 * - The replica half is the MCP server's real engine: a `MirrorStore` on a
 *   file and a `Replicas` attached to the upstream hub. Nothing in it is
 *   changed; it is driven by a settle loop instead of tool calls.
 * - The serving half is an in-process Hocuspocus 4.6.0 `Server` on loopback
 *   whose rooms are served to "browser" providers. A served room is two
 *   Y.Docs here — the replica's and Hocuspocus's own `Document`.
 *
 * Browser → store → everyone: the `beforeSync` hook (MessageReceiver.ts:189)
 * runs before Hocuspocus applies, acknowledges or broadcasts a sync frame. It
 * validates the update on a scratch Y.Doc and appends it to the store as a
 * local-origin update (pending mark included) before returning; a throw closes
 * the connection with the error's own `code`/`reason` (Connection.ts:292-295).
 *
 * Everyone → store → browser: a loop, woken by `PRAGMA data_version` (other
 * connections' commits) or by this process's own appends (which do not move
 * data_version), runs `Replicas.settle()` and then replays each served room's
 * tail (`readSince`: snapshot + tail) into the server Document with a marker
 * origin. Anything the browser itself sent comes back as a Yjs no-op.
 *
 * Awareness is bridged both ways between `document.awareness` and the
 * replica's awareness; the bridge filters its own origin, and y-protocols'
 * clock rule drops the one-hop echo.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Document } from "@hocuspocus/server";
import { Server as HocuspocusServer } from "@hocuspocus/server";
import {
  DIRECTORY_SUFFIX,
  FEEDBACK_SUFFIX,
  SIDEBAR_SUFFIX,
  parseRoom,
} from "@uberblick/schema";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  messageYjsSyncStep1,
  messageYjsSyncStep2,
  messageYjsUpdate,
} from "y-protocols/sync";
import * as Y from "yjs";
import type { McpConfig } from "../../src/config.js";
import { Replicas } from "../../src/replica.js";
import type { Replica } from "../../src/replica.js";
import { MirrorStore } from "../../src/store.js";
import type { UpdateOrigin } from "../../src/store.js";

/** Close reasons the gate names. The client sees the reason string (in-band CLOSE). */
export const REFUSED_REASON = "uberblick:store-refused";
export const MALFORMED_REASON = "uberblick:malformed-update";
/** The code goes only to the server-side onClose callbacks; see the report. */
export const REFUSAL_CODE = 4900;

/**
 * Marker origin for every bridge apply into a server Document. Shaped as a
 * Hocuspocus `LocalTransactionOrigin` with `skipStoreHooks` so the server's
 * `onStoreDocument` debounce is not scheduled for replayed updates
 * (types.ts:15-19, 40-50); identity-compared everywhere else.
 */
export const BRIDGE_ORIGIN = Object.freeze({
  source: "local" as const,
  skipStoreHooks: true,
  uberblick: "bridge",
});

const AWARENESS_BRIDGE = Symbol("uberblick/awareness-bridge");

export interface GateSample {
  type: number;
  bytes: number;
  validateMs: number;
  appendMs: number;
  totalMs: number;
  seq: number;
}

export interface AppendRecord {
  room: string;
  origin: UpdateOrigin;
  bytes: number;
  seq: number;
  /** Which half appended: the gate, or the replica's own update observer. */
  by: "gate" | "replica";
  at: number;
}

export interface OpenStats {
  /** beforeSync invocations by y-sync type (0 step1, 1 step2, 2 update). */
  hookByType: Record<number, number>;
  readOnlySkipped: number;
  emptySkipped: number;
  refusals: { room: string; reason: string; type: number; cause: string }[];
  gate: GateSample[];
  bridgeApplied: number;
  bridgeTicks: number;
  settleErrors: string[];
  /** Every `update` the server Documents emitted after load, by origin kind. */
  documentUpdates: { room: string; bytes: number; origin: "connection" | "bridge" | "other" }[];
}

/** The real store plus one refusal switch and an append ledger. */
export class ProbeStore extends MirrorStore {
  /** Throw on the next N appends, whoever calls. */
  failNext = 0;
  appender: "gate" | "replica" = "replica";
  onAppend: (() => void) | null = null;
  readonly appends: AppendRecord[] = [];

  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("simulated store refusal");
    }
    const seq = super.appendUpdate(room, payload, origin);
    this.appends.push({
      room,
      origin,
      bytes: payload.length,
      seq,
      by: this.appender,
      at: Date.now(),
    });
    this.onAppend?.();
    return seq;
  }

  /** `PRAGMA data_version` on the store's own connection. */
  dataVersion(): number {
    const db = (
      this as unknown as {
        db: { prepare(sql: string): { get(): Record<string, unknown> } };
      }
    ).db;
    return Number(db.prepare("PRAGMA data_version").get().data_version);
  }
}

export interface OpenOptions {
  workspaceId: string;
  databasePath: string;
  hubUrl: string;
  authSecret: string;
  /** 0 (default) binds an ephemeral port. */
  port?: number;
  settleIntervalMs?: number;
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
}

export interface ServedRoom {
  room: string;
  document: Document;
  replica: Replica;
  /** The highest store seq replayed into `document`. */
  seq: number;
  detachAwareness: () => void;
}

export interface OpenHandle {
  port: number;
  url: string;
  store: ProbeStore;
  replicas: Replicas;
  server: HocuspocusServer;
  served: Map<string, ServedRoom>;
  stats: OpenStats;
  /** Force one settle + bridge pass now (after any pass in flight). */
  tick(): Promise<void>;
  attach(room: string): Replica;
  close(): Promise<void>;
}

function refusal(reason: string, cause: unknown): Error {
  return Object.assign(new Error(`${reason}: ${String(cause)}`), {
    code: REFUSAL_CODE,
    reason,
    cause,
  });
}

function isConnectionOrigin(origin: unknown): boolean {
  return (
    typeof origin === "object" &&
    origin !== null &&
    (origin as { source?: unknown }).source === "connection"
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startOpen(options: OpenOptions): Promise<OpenHandle> {
  const config: McpConfig = {
    workspaceId: options.workspaceId,
    hubUrl: options.hubUrl,
    authSecret: options.authSecret,
    databasePath: options.databasePath,
    sessionId: `open-${randomUUID()}`,
    color: "#7b5ec7",
    connectTimeoutMs: options.connectTimeoutMs ?? 1_500,
    syncTimeoutMs: options.syncTimeoutMs ?? 3_000,
    reconnectMaxDelayMs: 250,
    cursorTtlMs: 30_000,
    compactAfter: 500,
    reconcileRetryMs: 0,
    updatedAtCoarsenessMs: 5 * 60_000,
  };

  const store = new ProbeStore(options.databasePath, options.workspaceId);
  const replicas = new Replicas(config, store);
  const served = new Map<string, ServedRoom>();
  const stats: OpenStats = {
    hookByType: {},
    readOnlySkipped: 0,
    emptySkipped: 0,
    refusals: [],
    gate: [],
    bridgeApplied: 0,
    bridgeTicks: 0,
    settleErrors: [],
    documentUpdates: [],
  };

  // The loop's two triggers: another connection's commit moves data_version;
  // this process's own appends (gate or replica observer) do not, so they
  // raise a flag instead.
  let dirty = true;
  let lastDataVersion = -1;
  let ticking: Promise<void> | null = null;
  let closed = false;
  store.onAppend = () => {
    dirty = true;
  };

  const attach = (room: string): Replica => {
    const parsed = parseRoom(room);
    if (parsed.uuid === DIRECTORY_SUFFIX) return replicas.directory();
    if (parsed.uuid === SIDEBAR_SUFFIX) return replicas.sidebar();
    if (parsed.uuid === FEEDBACK_SUFFIX) return replicas.feedback();
    return replicas.replica(parsed.uuid);
  };

  /** Hydrate a fresh server Document from the store: snapshot, then tail. */
  const hydrate = (room: string, document: Document): number => {
    const slice = store.readSince(room, 0);
    let seq = 0;
    if (slice.snapshot !== null) {
      Y.applyUpdate(document, slice.snapshot.state, BRIDGE_ORIGIN);
      seq = slice.snapshot.throughSeq;
    }
    for (const update of slice.updates) {
      Y.applyUpdate(document, update.payload, BRIDGE_ORIGIN);
      seq = update.seq;
    }
    return seq;
  };

  const bridgeAwareness = (document: Document, replica: Replica): (() => void) => {
    type Change = { added: number[]; updated: number[]; removed: number[] };
    const fromServer = ({ added, updated, removed }: Change, origin: unknown) => {
      if (origin === AWARENESS_BRIDGE) return;
      const clients = [...added, ...updated, ...removed];
      if (clients.length === 0) return;
      applyAwarenessUpdate(
        replica.awareness,
        encodeAwarenessUpdate(document.awareness, clients),
        AWARENESS_BRIDGE,
      );
    };
    const fromReplica = ({ added, updated, removed }: Change, origin: unknown) => {
      if (origin === AWARENESS_BRIDGE) return;
      const clients = [...added, ...updated, ...removed];
      if (clients.length === 0) return;
      applyAwarenessUpdate(
        document.awareness,
        encodeAwarenessUpdate(replica.awareness, clients),
        AWARENESS_BRIDGE,
      );
    };
    document.awareness.on("update", fromServer);
    replica.awareness.on("update", fromReplica);
    // What the hub already relayed into the replica is shown to the first tab.
    const known = [...replica.awareness.getStates().keys()];
    if (known.length > 0) {
      applyAwarenessUpdate(
        document.awareness,
        encodeAwarenessUpdate(replica.awareness, known),
        AWARENESS_BRIDGE,
      );
    }
    return () => {
      document.awareness.off("update", fromServer);
      replica.awareness.off("update", fromReplica);
    };
  };

  /**
   * The gate. Runs awaited before Hocuspocus reads the sync payload
   * (MessageReceiver.ts:189-194), for every sync frame on an established
   * connection — including read-only ones, whose readOnly check comes later
   * (:217, :259). Awareness frames never reach it (they take the
   * MessageType.Awareness branch, :72-110).
   */
  const gate = async ({
    connection,
    documentName,
    type,
    payload,
  }: {
    connection: { readOnly: boolean };
    documentName: string;
    type: number;
    payload: Uint8Array;
  }): Promise<void> => {
    stats.hookByType[type] = (stats.hookByType[type] ?? 0) + 1;
    // Step 1 carries a state vector, not content.
    if (type === messageYjsSyncStep1) return;
    // Anything else Hocuspocus refuses itself with "unknown type" (:284-285).
    if (type !== messageYjsSyncStep2 && type !== messageYjsUpdate) return;
    // Hocuspocus will not apply a read-only connection's write; nothing to store.
    if (connection.readOnly) {
      stats.readOnlySkipped += 1;
      return;
    }

    const t0 = performance.now();
    const scratch = new Y.Doc();
    let empty: boolean;
    try {
      Y.applyUpdate(scratch, payload, BRIDGE_ORIGIN);
      // Nothing integrated and nothing pending: the empty reconnect diff.
      empty =
        scratch.store.clients.size === 0 &&
        scratch.store.pendingStructs === null &&
        scratch.store.pendingDs === null;
    } catch (error) {
      stats.refusals.push({
        room: documentName,
        reason: MALFORMED_REASON,
        type,
        cause: String(error),
      });
      throw refusal(MALFORMED_REASON, error);
    } finally {
      scratch.destroy();
    }
    if (empty) {
      stats.emptySkipped += 1;
      return;
    }
    const t1 = performance.now();

    let seq: number;
    try {
      store.appender = "gate";
      seq = store.appendUpdate(documentName, payload, "local");
    } catch (error) {
      stats.refusals.push({
        room: documentName,
        reason: REFUSED_REASON,
        type,
        cause: String(error),
      });
      throw refusal(REFUSED_REASON, error);
    } finally {
      store.appender = "replica";
    }
    const t2 = performance.now();
    stats.gate.push({
      type,
      bytes: payload.length,
      validateMs: t1 - t0,
      appendMs: t2 - t1,
      totalMs: t2 - t0,
      seq,
    });
  };

  const server = new HocuspocusServer({
    port: options.port ?? 0,
    address: "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
    async onAuthenticate({ token, documentName, connectionConfig }) {
      if (parseRoom(documentName).workspaceId !== options.workspaceId) {
        throw new Error("workspace-mismatch");
      }
      if (token === "ro") {
        connectionConfig.readOnly = true;
        return { token };
      }
      if (token === "rw") return { token };
      throw new Error("unauthorized");
    },
    async onLoadDocument({ document, documentName }) {
      const replica = attach(documentName);
      const seq = hydrate(documentName, document);
      served.set(documentName, {
        room: documentName,
        document,
        replica,
        seq,
        detachAwareness: bridgeAwareness(document, replica),
      });
      document.on("update", (update: Uint8Array, origin: unknown) => {
        stats.documentUpdates.push({
          room: documentName,
          bytes: update.length,
          origin:
            origin === BRIDGE_ORIGIN
              ? "bridge"
              : isConnectionOrigin(origin)
                ? "connection"
                : "other",
        });
      });
    },
    async beforeUnloadDocument({ documentName }) {
      served.get(documentName)?.detachAwareness();
      served.delete(documentName);
    },
    beforeSync: gate,
  });
  await server.listen();
  const port = server.address.port;

  const pass = async (force: boolean): Promise<void> => {
    const dataVersion = store.dataVersion();
    if (!force && !dirty && dataVersion === lastDataVersion) return;
    dirty = false;
    lastDataVersion = dataVersion;
    stats.bridgeTicks += 1;
    // Replay the tail into the replica docs (LOG_ORIGIN: not logged again,
    // forwarded upstream by the providers), adopt rooms, release pending
    // rooms the hub acknowledged, compact.
    await replicas.settle();
    // Then the same tail into every served server Document.
    for (const entry of served.values()) {
      const slice = store.readSince(entry.room, entry.seq);
      if (slice.snapshot !== null) {
        Y.applyUpdate(entry.document, slice.snapshot.state, BRIDGE_ORIGIN);
        entry.seq = slice.snapshot.throughSeq;
        stats.bridgeApplied += 1;
      }
      for (const update of slice.updates) {
        Y.applyUpdate(entry.document, update.payload, BRIDGE_ORIGIN);
        entry.seq = update.seq;
        stats.bridgeApplied += 1;
      }
    }
  };
  const tick = (force: boolean): Promise<void> => {
    if (ticking !== null) return ticking;
    ticking = pass(force)
      .catch((error: unknown) => {
        stats.settleErrors.push(String(error));
      })
      .finally(() => {
        ticking = null;
      });
    return ticking;
  };
  const timer = setInterval(() => {
    if (!closed) void tick(false);
  }, options.settleIntervalMs ?? 25);

  const close = async (): Promise<void> => {
    closed = true;
    clearInterval(timer);
    if (ticking !== null) await ticking;
    for (const entry of served.values()) entry.detachAwareness();
    served.clear();
    await Promise.race([server.destroy(), sleep(3_000)]);
    replicas.destroy();
    store.close();
  };

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    store,
    replicas,
    server,
    served,
    stats,
    async tick() {
      if (ticking !== null) await ticking;
      await tick(true);
    },
    attach,
    close,
  };
}

// Child mode: `PROOF1B_CHILD=1 node --import tsx open-standin.ts`.
if (process.env.PROOF1B_CHILD === "1") {
  const env = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`missing ${name}`);
    return value;
  };
  const handle = await startOpen({
    workspaceId: env("PROOF1B_WORKSPACE"),
    databasePath: env("PROOF1B_DB"),
    hubUrl: env("PROOF1B_HUB_URL"),
    authSecret: env("PROOF1B_SECRET"),
    port: Number(env("PROOF1B_PORT")),
  });
  process.stdout.write(
    `${JSON.stringify({ ready: true, port: handle.port, pid: process.pid })}\n`,
  );
  const stop = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
