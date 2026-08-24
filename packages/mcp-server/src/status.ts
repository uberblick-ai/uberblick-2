/**
 * What this replica holds and what the hub has acknowledged, in one shape.
 *
 * Two surfaces report it — the `sync_status` MCP tool and `ub status` — and they
 * must not drift: an agent and a human looking at the same replica should see
 * the same numbers under the same names. The tool's description carries the
 * wording that explains the units; this module owns the fields.
 */

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
