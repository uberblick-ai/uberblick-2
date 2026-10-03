/** The current room's upstream acknowledgement, read from `ub open`. */

import { useEffect, useMemo, useState } from "react";
import type {
  DocumentSearchClient,
  NotSharedReason,
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
  status: ServingRoomStatus | null;
}

export interface ServingRoomStatus {
  hubAcked: boolean;
  notSharedReason: NotSharedReason | null;
}

/**
 * Poll the local serving endpoint for one room.
 *
 * Null is part of the contract: no client, no room, a failed or malformed
 * request, or an answer that omits this room makes no upstream claim. The
 * answer is keyed by both client and room before it is returned, so a render
 * after either changes cannot expose the previous mode's value while the
 * effect cleanup catches up. Abort plus the `active` guard keeps a late answer
 * from an old room from becoming current.
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
      ? answer.status
      : null;
  const source = useMemo(
    () => (client === null || client === undefined || room === null ? null : {}),
    [client, room],
  );
  const calm = useCalmSyncState(
    current?.hubAcked === true ? "synced" : "syncing",
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
          status:
            status.rooms[room] === undefined
              ? null
              : {
                  hubAcked: status.rooms[room].hubAcked,
                  notSharedReason: status.notSharedReason ?? null,
                },
        });
      } catch {
        if (!active) return;
        setAnswer({ client, room, status: null });
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

  if (current === null || calm === null) return null;
  return {
    hubAcked: calm === "synced",
    notSharedReason: current.notSharedReason,
  };
}
