/** The current room's upstream acknowledgement, read from `ub open`. */

import { useEffect, useMemo, useState } from "react";
import type { DocumentSearchClient } from "../shell/document-search.js";
import { useCalmSyncState } from "./calm.js";

/** Keep the status current without turning every render into an HTTP request. */
export const SERVING_STATUS_POLL_MS = 1_000;

interface RoomAnswer {
  client: DocumentSearchClient;
  room: string;
  hubAcked: boolean | null;
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
): boolean | null {
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
  );

  useEffect(() => {
    if (client === null || client === undefined || room === null) return;
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const status = await client.status(controller.signal);
        if (!active) return;
        setAnswer({
          client,
          room,
          hubAcked: status.rooms[room]?.hubAcked ?? null,
        });
      } catch {
        if (!active) return;
        setAnswer({ client, room, hubAcked: null });
      }
      if (active) {
        timer = setTimeout(() => void poll(), SERVING_STATUS_POLL_MS);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    };
  }, [client, room]);

  if (current === null || calm === null) return null;
  return calm === "synced";
}
