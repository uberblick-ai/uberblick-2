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

import { useEffect, useRef, useState } from "react";
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
 * The backlog, in the unit the provider actually counts.
 *
 * One wording, in one place, because two surfaces say it — the status line
 * under the title and the sync panel — and `sync_status` reports a count of
 * unsynced *rooms* under a similar name. Two numbers labelled "pending" invite
 * the question of which one is lying.
 *
 * The unit is provider sync messages awaiting the hub's acknowledgement, not
 * Yjs updates: the provider merges a batch of updates into one message, counts
 * a message before it goes out, and resets the backlog to the single
 * sync-handshake message on every reconnect. So "1 sync message unacked" can
 * stand for a whole document's worth of unsent work — which is why this does
 * not say "1 update".
 */
export function backlogLabel(count: number): string {
  return `${count} sync message${count === 1 ? "" : "s"} unacked`;
}

/**
 * The state the indicator should draw: `raw`, once it has survived its settle
 * window.
 *
 * The pending timer is keyed on `raw`, so any change restarts it. That is the
 * whole debounce: a state that flickers away before its window is up is never
 * rendered, and a state that keeps flickering back and forth never accumulates
 * a window either — the indicator simply holds whatever it last settled on.
 *
 * `source` is the connection whose reading this is. A component can survive a
 * room change, but the settled state must not: a new source begins with an
 * empty slot and earns its first reading by one deadline measured from that
 * source's arrival. Changes before the deadline update what will be shown but
 * do not move the deadline, so continuous typing cannot hide the current room
 * forever. Once the first reading is shown, later changes use the ordinary
 * persistence windows above. Callers without a source retain the original
 * mount behaviour and begin from `raw`.
 */
export function useCalmSyncState(raw: SyncState): SyncState;
export function useCalmSyncState(
  raw: SyncState,
  source: object | null,
  settleMs?: Readonly<Record<SyncState, number>>,
): SyncState | null;
export function useCalmSyncState(
  raw: SyncState,
  source?: object | null,
  settleMs: Readonly<Record<SyncState, number>> = SETTLE_MS,
): SyncState | null {
  const scoped = source !== undefined;
  const key = source ?? null;
  const [settled, setSettled] = useState<{
    source: object | null;
    state: SyncState | null;
  }>(() => ({ source: key, state: scoped ? null : raw }));
  const latestRaw = useRef(raw);
  latestRaw.current = raw;
  const boundary = useRef({ source: key, raw });
  if (boundary.current.source !== key) boundary.current = { source: key, raw };
  const firstRaw = boundary.current.raw;
  const shown = settled.source === key ? settled.state : null;

  // A source gets one bounded initial window. This effect intentionally does
  // not follow `raw`: its timer reads the latest value through the ref, while
  // its deadline remains anchored to the source change.
  useEffect(() => {
    if (!scoped) return;
    setSettled({ source: key, state: null });
    if (key === null) return;
    if (settleMs[firstRaw] === 0) {
      setSettled({ source: key, state: firstRaw });
      return;
    }
    const timer = setTimeout(
      () => setSettled({ source: key, state: latestRaw.current }),
      settleMs[firstRaw],
    );
    return () => clearTimeout(timer);
  }, [firstRaw, key, scoped, settleMs]);

  useEffect(() => {
    if (settled.source !== key) return;
    if (shown === null) {
      // Bad news keeps its zero-delay contract even inside the initial window.
      if (scoped && key !== null && settleMs[raw] === 0) {
        setSettled({ source: key, state: raw });
      }
      return;
    }
    if (raw === shown) return;
    if (settleMs[raw] === 0) {
      setSettled({ source: key, state: raw });
      return;
    }
    const timer = setTimeout(
      () => setSettled({ source: key, state: raw }),
      settleMs[raw],
    );
    return () => clearTimeout(timer);
  }, [key, raw, scoped, settleMs, shown, settled.source]);
  return shown;
}
