/**
 * Calm presentation of the sync status.
 *
 * What the connection reports is unchanged — #49 owns that, and it stays
 * instantaneous. What changes here is the *cadence* at which the status line
 * redraws it. Every keystroke pushes the provider through synced → unsynced →
 * synced within a few milliseconds, and rendering that verbatim makes the
 * primary writing surface strobe once per key.
 *
 * The rule is one line: a state is shown only once it has persisted.
 *
 * - **Busy waits.** `syncing` has to hold for 400ms before it is drawn, so a
 *   burst of keystrokes produces no transition at all rather than one per key.
 * - **Good news waits.** `synced` needs 300ms of quiet, so the indicator does
 *   not bounce back the instant a single message is acknowledged.
 * - **Bad news never waits.** `offline` is adopted immediately. A debounce that
 *   also delayed a disconnect would quietly undo the one thing #49 is for, so
 *   the zero in the table below is the load-bearing entry.
 *
 * Delaying a state is the only licence taken here. Hiding one is not: a backlog
 * that outlives its window is drawn, however long it lasts. Calm is a cadence,
 * never a quieter version of the truth.
 */

import { useEffect, useState } from "react";
import type { RoomStatus } from "../collab/rooms.js";

export type SyncState = "offline" | "syncing" | "synced";

/** How long a state must hold before the indicator adopts it, in milliseconds. */
export const SETTLE_MS: Readonly<Record<SyncState, number>> = {
  offline: 0,
  syncing: 400,
  synced: 300,
};

/**
 * The state the connection is actually in, undebounced.
 *
 * `synced` requires an empty backlog as well as the provider's own flag.
 * `provider.isSynced` means "the initial handshake completed", and it is never
 * lowered again — queuing an unacknowledged message does not reset it. Reading
 * the flag alone would therefore call a room with writes stranded at the hub
 * "synced" forever, and #76 suppresses the backlog badge in that state, so the
 * two together would hide the outage outright rather than merely calming it.
 * The backlog is the other half of the truth, so it is the other half of the
 * condition.
 */
export function rawSyncState(status: RoomStatus): SyncState {
  if (!status.connected) return "offline";
  return status.synced && status.unsyncedChanges === 0 ? "synced" : "syncing";
}

/**
 * The state the indicator should draw: `raw`, once it has survived its settle
 * window.
 *
 * The pending timer is keyed on `raw`, so any change restarts it. That is the
 * whole debounce: a state that flickers away before its window is up is never
 * rendered, and a state that keeps flickering back and forth never accumulates
 * a window either — the indicator simply holds whatever it last settled on.
 */
export function useCalmSyncState(raw: SyncState): SyncState {
  const [shown, setShown] = useState(raw);
  useEffect(() => {
    if (raw === shown) return;
    if (SETTLE_MS[raw] === 0) {
      setShown(raw);
      return;
    }
    const timer = setTimeout(() => setShown(raw), SETTLE_MS[raw]);
    return () => clearTimeout(timer);
  }, [raw, shown]);
  return shown;
}
