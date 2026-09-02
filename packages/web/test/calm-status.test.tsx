/**
 * The sync indicator's timing contract (#76).
 *
 * The status line used to redraw once per keystroke, because that is how often
 * the provider actually goes unsynced and back. `useCalmSyncState` is the whole
 * fix, so this pins the numbers that define it: busy has to persist before it
 * is drawn, good news has to hold before it is believed, and bad news is never
 * delayed at all.
 *
 * Two deliberate choices about how it is pinned:
 *
 * - **The boundaries are literals, not `SETTLE_MS`.** A test that advances the
 *   clock by the production constant passes at any value of that constant, so
 *   it would sit there green while a 400ms debounce grew into a 5s one. The
 *   numbers below are the contract; the table is asserted against literals too.
 * - **The input is a `RoomStatus`, not a `SyncState`.** Deriving the state is
 *   half the behaviour — the provider's `isSynced` stays true once the initial
 *   handshake is done, so a test that fed states directly would never notice
 *   that a real backlog was being read as "synced".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SETTLE_MS, rawSyncState, useCalmSyncState } from "../src/ui/calm.js";
import type { SyncState } from "../src/ui/calm.js";
import type { RoomStatus } from "../src/collab/rooms.js";

/** A connected, quiet room — the settled good state, patched per case. */
function room(patch: Partial<RoomStatus> = {}): RoomStatus {
  return {
    connected: true,
    synced: true,
    unsyncedChanges: 0,
    localReplicaLoaded: true,
    hasLocalCache: false,
    protocolMismatch: null,
    authFailed: false,
    tokenMissing: false,
    ...patch,
  };
}

/** What a keystroke does: one message out, acknowledged a moment later. */
const UNACKED = room({ unsyncedChanges: 1 });
const OFFLINE = room({ connected: false, synced: false, unsyncedChanges: 2 });

/** The hook under the derivation the status line actually feeds it. */
function probe(initial: RoomStatus): {
  shown: () => SyncState;
  feed: (status: RoomStatus) => void;
  wait: (ms: number) => void;
  unmount: () => void;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let shown: SyncState = "synced";
  function Probe({ status }: { status: RoomStatus }): null {
    shown = useCalmSyncState(rawSyncState(status));
    return null;
  }
  const feed = (status: RoomStatus): void => {
    act(() => root.render(<Probe status={status} />));
  };
  feed(initial);
  return {
    shown: () => shown,
    feed,
    wait: (ms) => act(() => void vi.advanceTimersByTime(ms)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** The same reading, scoped to one newly selected room connection. */
function scopedProbe(initial: RoomStatus): {
  shown: () => SyncState | null;
  feed: (status: RoomStatus) => void;
  wait: (ms: number) => void;
  unmount: () => void;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const source = {};
  let shown: SyncState | null = null;
  function Probe({ status }: { status: RoomStatus }): null {
    shown = useCalmSyncState(rawSyncState(status), source);
    return null;
  }
  const feed = (status: RoomStatus): void => {
    act(() => root.render(<Probe status={status} />));
  };
  feed(initial);
  return {
    shown: () => shown,
    feed,
    wait: (ms) => act(() => void vi.advanceTimersByTime(ms)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("the sync indicator only draws a state that has persisted", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles busy at 400ms and quiet at 300ms, and offline at once", () => {
    // The literal table. Every boundary below is one of these numbers spelled
    // out again, so changing one here does not silently move the others.
    expect(SETTLE_MS).toEqual({ offline: 0, syncing: 400, synced: 300 });
  });

  it("shows nothing at all while someone types", () => {
    const view = probe(room());
    // Ten keystrokes' worth of the real thing: one message unacknowledged for a
    // few milliseconds, acknowledged, unacknowledged again. No window is 400ms
    // long, so the indicator never leaves "synced" — not one flash, let alone
    // ten.
    for (let key = 0; key < 10; key += 1) {
      view.feed(UNACKED);
      view.wait(40);
      view.feed(room());
      view.wait(60);
      expect(view.shown()).toBe("synced");
    }
    view.unmount();
  });

  it("bounds a new room's blank slot even while its reading oscillates", () => {
    const view = scopedProbe(UNACKED);
    expect(view.shown()).toBeNull();

    // Neither state persists for its own window, but the first-reading deadline
    // belongs to the source, not to those transitions. At 400ms the slot earns
    // the latest reading instead of staying blank for the whole typing burst.
    view.wait(100);
    view.feed(room());
    view.wait(100);
    view.feed(UNACKED);
    view.wait(100);
    view.feed(room());
    view.wait(99);
    expect(view.shown()).toBeNull();
    view.wait(1);
    expect(view.shown()).toBe("synced");

    view.unmount();
  });

  it("crosses to busy at 400ms, and back to synced at 300ms of quiet", () => {
    const view = probe(room());

    view.feed(UNACKED);
    view.wait(399);
    expect(view.shown()).toBe("synced");
    view.wait(1);
    expect(view.shown()).toBe("syncing");

    view.feed(room());
    view.wait(299);
    expect(view.shown()).toBe("syncing");
    view.wait(1);
    expect(view.shown()).toBe("synced");

    view.unmount();
  });

  /**
   * The one the calm treatment could have swallowed. `provider.isSynced` is
   * raised by the initial handshake and never lowered again, so a room whose
   * writes are piling up unacknowledged still reports `synced: true` — and the
   * status line suppresses the backlog badge while it reads "synced". Left to
   * the flag alone, the indicator would sit there claiming everything was fine.
   */
  it("goes busy on a climbing backlog even while the provider still says synced", () => {
    const view = probe(room());

    // The backlog grows; `synced` stays true throughout, as the provider leaves
    // it. The count changing must not restart the window either — the spinner
    // is due 400ms after the backlog began, not 400ms after the last message.
    view.feed(room({ unsyncedChanges: 1 }));
    view.wait(150);
    view.feed(room({ unsyncedChanges: 2 }));
    view.wait(150);
    view.feed(room({ unsyncedChanges: 7 }));
    view.wait(99);
    expect(view.shown()).toBe("synced");
    view.wait(1);
    expect(view.shown()).toBe("syncing");

    // And it stays busy for as long as the backlog does.
    view.feed(room({ unsyncedChanges: 12 }));
    view.wait(60_000);
    expect(view.shown()).toBe("syncing");

    view.unmount();
  });

  it("does not bounce back when typing resumes inside the quiet window", () => {
    const view = probe(room());
    view.feed(UNACKED);
    view.wait(400);
    expect(view.shown()).toBe("syncing");

    // Typing pauses, then resumes before the quiet window is up: one settled
    // busy state, not two transitions.
    view.feed(room());
    view.wait(250);
    view.feed(UNACKED);
    view.wait(10_000);
    expect(view.shown()).toBe("syncing");

    view.unmount();
  });

  it("never delays a disconnect", () => {
    const view = probe(room());
    view.feed(OFFLINE);
    // No timer advanced: offline is on screen as soon as it is reported, which
    // is what keeps #49's "surfaces within ~5s" true.
    expect(view.shown()).toBe("offline");
    view.unmount();
  });
});
