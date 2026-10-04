/**
 * Status readings derived from one full local replica.
 *
 * The `sync_status` MCP tool and `ub status` share {@link SyncStatus}; `ub open`
 * exposes the smaller {@link ServingSyncStatus} its browser consumers need.
 * Neither shape turns a hub acknowledgement into a claim that the hub owns the
 * document.
 */

import type { UberblickMcpEngine } from "./engine.js";
import type { Replicas } from "./replica.js";
import type { PendingRoom } from "./store.js";
import type { HubState } from "./sync.js";

export interface RoomSyncStatus {
  /** `<workspaceId>/<uuid>`, or the workspace's `_directory` room. */
  room: string;
  /** The highest log sequence applied to this replica. */
  appliedSeq: number;
  /** Hub-acknowledged, never hub-stored. */
  synced: boolean;
}

export interface SyncStatus {
  /** This process's agent session id. */
  session: string;
  /** The awareness display name this session publishes. */
  agent: string;
  workspace: string;
  database: string;
  hub: HubState;
  /** Rooms holding local changes the hub has not acknowledged. Counts ROOMS. */
  unsyncedChanges: number;
  pendingRooms: PendingRoom[];
  /** Provider sync MESSAGES awaiting acknowledgement on this connection. */
  inFlightUpdates: number;
  rooms: RoomSyncStatus[];
  logEntries: number;
  /** Non-null only when an update failed to reach the log. */
  persistence: { room: string; message: string } | null;
}

export interface ServedRoomSyncStatus {
  hubAcked: boolean;
}

export interface ServingSyncStatus {
  /** Why durable local edits cannot currently be shared upstream. */
  notSharedReason: "no-hub-credentials" | "sign-in-required" | "no-workspace-access"
    | "credential-store" | "renewal-unavailable" | null;
  /** The full replica completed this hub handshake and its attach drain. */
  caughtUp: boolean;
  /** Only rooms currently loaded by the in-process browser server. */
  rooms: Record<string, ServedRoomSyncStatus>;
}

function unavailableServingStatus(
  servedRooms: readonly string[],
): ServingSyncStatus {
  return {
    notSharedReason: null,
    caughtUp: false,
    rooms: Object.fromEntries(
      servedRooms.map((room) => [room, { hubAcked: false }]),
    ),
  };
}

/**
 * Read the two sync facts served to the browser, without waiting on the hub.
 *
 * A provider's quiet flag is necessary but not sufficient: another process
 * can append, apply and acknowledge a change, then release the one shared
 * pending marker while this replica is still behind. A true reading therefore
 * also requires this replica to cover the store cut sampled with that marker.
 */
export function collectServingSyncStatus(
  engine: UberblickMcpEngine,
  rooms: Iterable<string>,
): ServingSyncStatus {
  const servedRooms = [...new Set(rooms)].sort();
  if (engine.refreshStatus.status !== "running") {
    return unavailableServingStatus(servedRooms);
  }

  const attached = engine.replicas.attachedReplicas();
  const store = engine.store.syncSnapshot(
    attached.map(({ room, lastSeq }) => ({ room, throughSeq: lastSeq })),
  );
  const pending = new Set(store.pendingRooms.map(({ room }) => room));
  const hub = engine.replicas.sync.state();
  const hubStatus = hub.status;
  const connected = hubStatus === "connected";
  const acknowledged = new Map(
    attached.map((replica) => [
      replica.room,
      connected &&
        !pending.has(replica.room) &&
        !store.unappliedRooms.has(replica.room) &&
        engine.replicas.isRoomQuiet(replica.room),
    ]),
  );
  const served = Object.fromEntries(
    servedRooms.map((room) => [
      room,
      { hubAcked: acknowledged.get(room) === true },
    ]),
  );

  return {
    notSharedReason: hubStatus === "disabled" ? "no-hub-credentials" : hub.authRecovery ?? null,
    caughtUp:
      connected &&
      !engine.replicas.sync.isDraining() &&
      store.pendingRooms.length === 0 &&
      attached.every((replica) => acknowledged.get(replica.room) === true) &&
      servedRooms.every((room) => acknowledged.get(room) === true),
    rooms: served,
  };
}

/**
 * Settle, then read.
 *
 * `requireHealthy: false` because diagnostics must still answer when persistence
 * has failed — that is exactly when someone needs to know why everything else
 * stopped.
 */
export async function collectSyncStatus(
  replicas: Replicas,
): Promise<SyncStatus> {
  await replicas.settle({ requireHealthy: false });
  const pending = replicas.store.pendingRooms();

  return {
    session: replicas.config.sessionId,
    agent: replicas.name,
    workspace: replicas.config.workspaceId,
    database: replicas.store.databasePath,
    hub: replicas.sync.state(),
    unsyncedChanges: pending.length,
    pendingRooms: pending,
    inFlightUpdates: replicas.sync.unsyncedChanges(),
    rooms: replicas.attachedReplicas().map((replica) => ({
      room: replica.room,
      appliedSeq: replica.lastSeq,
      synced: replicas.isRoomQuiet(replica.room),
    })),
    logEntries: replicas.store.logSize(),
    persistence: replicas.persistenceError(),
  };
}
