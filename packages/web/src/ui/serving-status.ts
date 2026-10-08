/** The current room's upstream acknowledgement, read from `ub open`. */

import { useEffect, useMemo, useState } from "react";
import type {
  DocumentSearchClient,
  NotSharedReason,
  ReplicaUnavailable,
} from "../shell/document-search.js";
import { useCalmSyncState } from "./calm.js";

/** Keep the status current without turning every render into an HTTP request. */
export const SERVING_STATUS_POLL_MS = 1_000;
/** A local status request older than this is not a usable current answer. */
export const SERVING_STATUS_TIMEOUT_MS = 5_000;
/** Two contrary samples must survive before the upstream fact moves. */
export const SERVING_STATUS_SETTLE_MS = SERVING_STATUS_POLL_MS * 2 + 100;
const SERVING_STATUS_CADENCE = {
  offline: 0,
  syncing: SERVING_STATUS_SETTLE_MS,
  synced: SERVING_STATUS_SETTLE_MS,
} as const;

interface RoomAnswer {
  client: DocumentSearchClient;
  room: string;
  hubAcked: boolean | null;
  notSharedReason: NotSharedReason | null;
  replicaUnavailable: ReplicaUnavailable | null;
}

export interface ServingRoomStatus {
  hubAcked: boolean | null;
  notSharedReason: NotSharedReason | null;
  replicaUnavailable: ReplicaUnavailable | null;
}

/**
 * Poll the local serving endpoint for one room.
 *
 * No client or room returns null. A failed or malformed request, or an answer
 * that omits this room, returns a null acknowledgement and makes no upstream
 * claim. The acknowledgement is keyed by both client and room before it is
 * returned, so a render after either changes cannot expose the previous mode's
 * value while the effect cleanup catches up. Abort plus the `active` guard
 * keeps a late answer from an old room from becoming current.
 * The reason describes the serving run, not a room: keep its last answer for
 * this client through room changes and failed polls. A successful response
 * replaces it even when the response omits the current room.
 *
 * The usable boolean follows the same calm cadence as the room connection:
 * brief pending windows do not strobe while someone types, good news waits for
 * quiet, and loss of the HTTP reading itself blanks the fact immediately.
 */
export function useServingRoomStatus(
  client: DocumentSearchClient | null | undefined,
  room: string | null,
): ServingRoomStatus | null {
  const [answer, setAnswer] = useState<RoomAnswer | null>(null);
  const current =
    answer !== null && answer.client === client && answer.room === room
      ? answer.hubAcked
      : null;
  const source = useMemo(
    () => (client === null || client === undefined || room === null ? null : {}),
    [client, room],
  );
  const calm = useCalmSyncState(
    current === true ? "synced" : "syncing",
    current === null ? null : source,
    SERVING_STATUS_CADENCE,
  );

  useEffect(() => {
    if (client === null || client === undefined || room === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | null = null;

    const poll = async (): Promise<void> => {
      const request = new AbortController();
      inFlight = request;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            request.abort();
            reject(new Error("ub open status request timed out"));
          }, SERVING_STATUS_TIMEOUT_MS);
        });
        const status = await Promise.race([
          client.status(request.signal),
          expired,
        ]);
        if (!active) return;
        setAnswer({
          client,
          room,
          hubAcked: status.rooms[room]?.hubAcked ?? null,
          notSharedReason: status.notSharedReason ?? null,
          replicaUnavailable: status.replicaUnavailable ?? null,
        });
      } catch {
        if (!active) return;
        setAnswer((previous) => ({
          client,
          room,
          hubAcked: null,
          notSharedReason: previous?.client === client ? previous.notSharedReason : null,
          replicaUnavailable: previous?.client === client ? previous.replicaUnavailable : null,
        }));
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (inFlight === request) inFlight = null;
      }
      if (active) {
        timer = setTimeout(() => void poll(), SERVING_STATUS_POLL_MS);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      inFlight?.abort();
    };
  }, [client, room]);

  if (client === null || client === undefined || room === null) return null;
  return {
    hubAcked: current === null || calm === null ? null : calm === "synced",
    notSharedReason: answer?.client === client ? answer.notSharedReason : null,
    replicaUnavailable: answer?.client === client ? answer.replicaUnavailable : null,
  };
}
