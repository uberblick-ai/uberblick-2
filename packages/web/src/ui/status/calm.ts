/**
 * Delay redraws, never provider truth: busy must persist 400ms, synced 300ms,
 * and offline appears immediately. A backlog surviving its window must remain
 * visible.
 */

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RoomStatus } from "../../collab/rooms.js";

export type SyncState = "offline" | "syncing" | "synced";

/** How long a state must hold before the indicator adopts it, in milliseconds. */
export const SETTLE_MS: Readonly<Record<SyncState, number>> = {
  offline: 0,
  syncing: 400,
  synced: 300,
};

/**
 * Synced requires both the provider handshake flag and an empty
 * unacknowledged-message backlog. isSynced alone stays true after later
 * writes queue; the compact status names busy work and details carries the
 * count.
 */
export function rawSyncState(status: RoomStatus): SyncState {
  if (!status.connected) return "offline";
  return status.synced && status.unsyncedChanges === 0 ? "synced" : "syncing";
}

/**
 * Count provider sync messages, not Yjs updates or unsynced rooms. Updates
 * can batch into one message, and reconnect resets the backlog to one
 * handshake message.
 */
export function backlogLabel(count: number): string {
  return `${count} sync message${count === 1 ? "" : "s"} unacked`;
}

/**
 * Restart ordinary persistence windows when raw changes. A new source starts
 * blank and gets one bounded initial deadline that does not slide with
 * typing; later transitions use normal windows. Callers without a source
 * start from raw.
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
  const settleInitial = useEffectEvent((source: object) => {
    setSettled({ source, state: raw });
  });
  const boundary = useRef({ source: key, raw });
  if (boundary.current.source !== key) boundary.current = { source: key, raw };
  const firstRaw = boundary.current.raw;
  const shown = settled.source === key ? settled.state : null;

  // A source gets one bounded initial window. This effect intentionally does
  // not follow `raw`: its effect event reads the latest value, while
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
      () => settleInitial(key),
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
