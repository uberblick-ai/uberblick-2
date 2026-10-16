/** Immediate page attributes, independent of the status line's presentation. */
import type { RoomConnection, RoomStatus } from "../../collab/rooms.js";
import { rawSyncState } from "./calm.js";

export type SettleState = "pending" | "acknowledged" | "offline";

interface SyncObservation {
  subscribe: (listener: (local: SettleState, upstream: SettleState) => void) => () => void;
  request: () => (hubAcked: boolean | null) => void;
  release: () => void;
}

interface SharedObservation {
  observation: SyncObservation;
  refs: number;
}
const observations = new WeakMap<RoomConnection, SharedObservation>();

function localState(status: RoomStatus): SettleState {
  if (status.authFailed || status.tokenMissing || status.storeRefused || status.protocolMismatch !== null) return "offline";
  const raw = rawSyncState(status);
  if (raw !== "offline" && !status.writable) return "pending";
  return raw === "synced" ? "acknowledged" : raw === "offline" ? "offline" : "pending";
}

/** Share the provider subscription with the existing upstream status poll. */
export function observeSyncState(connection: RoomConnection): SyncObservation {
  let shared = observations.get(connection);
  if (shared === undefined) {
    let local = localState(connection.status);
    let upstream: SettleState = "pending";
    let epoch = 0;
    const listeners = new Set<(local: SettleState, upstream: SettleState) => void>();
    const publish = (): void => {
      for (const listener of listeners) listener(local, upstream);
    };
    const stop = connection.onStatusChange(status => {
      const next = localState(status);
      if (next !== local) {
        epoch += 1;
        local = next;
        upstream = next === "offline" ? "offline" : "pending";
      }
      publish();
    });
    const held: SharedObservation = {
      refs: 0,
      observation: {
        subscribe(listener) {
          listeners.add(listener);
          listener(local, upstream);
          return () => { listeners.delete(listener); };
        },
        request() {
          // A response started during a backlog cannot confirm that backlog,
          // even if it arrives after the browser receives its local ack.
          const requested = local === "acknowledged" ? epoch : null;
          return hubAcked => {
            upstream = local === "offline" || hubAcked === null ? "offline" :
              hubAcked && requested === epoch && local === "acknowledged" ? "acknowledged" : "pending";
            publish();
          };
        },
        release() {
          if (--held.refs !== 0) return;
          stop();
          observations.delete(connection);
        },
      },
    };
    observations.set(connection, held);
    shared = held;
  }
  shared.refs += 1;
  return shared.observation;
}

/** Provider events update the DOM synchronously, before a React render. */
export function bindSyncAttributes(element: HTMLElement, connection: RoomConnection, served: boolean): () => void {
  const observation = observeSyncState(connection);
  const unsubscribe = observation.subscribe((local, upstream) => {
    element.dataset.localSync = local;
    if (served) element.dataset.upstreamSync = upstream;
    else delete element.dataset.upstreamSync;
  });
  return () => {
    unsubscribe();
    observation.release();
  };
}
