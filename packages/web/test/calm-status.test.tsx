/**
 * The sync indicator's timing contract (#76).
 *
 * The status line used to redraw once per keystroke, because that is how often
 * the provider actually goes unsynced and back. `useCalmSyncState` is the whole
 * fix, so this pins the three numbers that define it: busy has to persist
 * before it is drawn, good news has to hold before it is believed, and bad news
 * is never delayed at all — the last one is where a debounce could quietly undo
 * #49's truthfulness, so it is asserted, not assumed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SETTLE_MS, useCalmSyncState } from "../src/ui/calm.js";
import type { SyncState } from "../src/ui/calm.js";

/** A component that is nothing but the hook, so the test can drive it directly. */
function probe(initial: SyncState): {
  shown: () => SyncState;
  feed: (raw: SyncState) => void;
  wait: (ms: number) => void;
  unmount: () => void;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let shown: SyncState = initial;
  function Probe({ raw }: { raw: SyncState }): null {
    shown = useCalmSyncState(raw);
    return null;
  }
  const feed = (raw: SyncState): void => {
    act(() => root.render(<Probe raw={raw} />));
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

  it("shows nothing at all while someone types", () => {
    const view = probe("synced");
    // Ten keystrokes' worth of the real thing: unsynced for a few milliseconds,
    // acknowledged, unsynced again. None of those windows is 400ms long, so the
    // indicator never leaves "synced" — not one flash, let alone ten.
    for (let key = 0; key < 10; key += 1) {
      view.feed("syncing");
      view.wait(40);
      view.feed("synced");
      view.wait(60);
      expect(view.shown()).toBe("synced");
    }
    view.unmount();
  });

  it("crosses to busy once the backlog outlasts the window, and back once it is quiet", () => {
    const view = probe("synced");

    view.feed("syncing");
    view.wait(SETTLE_MS.syncing - 1);
    expect(view.shown()).toBe("synced");
    view.wait(1);
    expect(view.shown()).toBe("syncing");

    view.feed("synced");
    view.wait(SETTLE_MS.synced - 1);
    expect(view.shown()).toBe("syncing");
    view.wait(1);
    expect(view.shown()).toBe("synced");

    view.unmount();
  });

  it("does not bounce back when typing resumes inside the quiet window", () => {
    const view = probe("synced");
    view.feed("syncing");
    view.wait(SETTLE_MS.syncing);
    expect(view.shown()).toBe("syncing");

    // Typing pauses, then resumes before the quiet window is up: one settled
    // busy state, not two transitions.
    view.feed("synced");
    view.wait(SETTLE_MS.synced - 50);
    view.feed("syncing");
    view.wait(10_000);
    expect(view.shown()).toBe("syncing");

    view.unmount();
  });

  it("never delays a disconnect", () => {
    expect(SETTLE_MS.offline).toBe(0);
    const view = probe("synced");
    view.feed("offline");
    // No timer advanced: offline is on screen as soon as it is reported, which
    // is what keeps #49's "surfaces within ~5s" true.
    expect(view.shown()).toBe("offline");
    view.unmount();
  });
});
