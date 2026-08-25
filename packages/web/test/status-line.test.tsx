/**
 * The status line's sync-backlog label.
 *
 * `sync_status` reports a count of unsynced *rooms*; this reports a count of
 * provider sync *messages* awaiting acknowledgement. Both used to read
 * "pending", which made two correct numbers look like a contradiction during an
 * outage. The rendered wording is the fix, so it is what the test pins — down to
 * the unit, because the honest unit here is messages and not updates.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { StatusLine } from "../src/ui/EditorPane.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

/** The workspace these stub room keys sit in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

/** A connection that only reports status — no socket, no awareness, no peers. */
function stubConnection(
  unsyncedChanges: number,
  patch: Partial<RoomStatus> = {},
): RoomConnection {
  const status: RoomStatus = {
    connected: false,
    synced: false,
    unsyncedChanges,
    localReplicaLoaded: false,
    hasLocalCache: false,
    ...patch,
  };
  return {
    room: `${WORKSPACE}/doc`,
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(status);
      return () => {};
    },
  } as unknown as RoomConnection;
}

function label(
  unsyncedChanges: number,
  patch: Partial<RoomStatus> = {},
): string | null {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <StatusLine
        connection={stubConnection(unsyncedChanges, patch)}
        segment={WORKSPACE}
      />,
    ),
  );
  const text = host.querySelector(".ub-pending")?.textContent ?? null;
  act(() => root.unmount());
  host.remove();
  return text?.replace(/\s+/g, " ").trim() ?? null;
}

describe("the status line names the unit of its backlog count", () => {
  it("reads in sync messages, not the bare word pending", () => {
    expect(label(38)).toBe("38 sync messages unacked");
    expect(label(1)).toBe("1 sync message unacked");
  });

  it("says nothing when everything is acknowledged", () => {
    expect(label(0)).toBeNull();
  });

});

/** Whether the line claims a local cache, for a room in the given state. */
function claimsCache(patch: Partial<RoomStatus>): boolean {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <StatusLine connection={stubConnection(0, patch)} segment={WORKSPACE} />,
    ),
  );
  const claimed = host.querySelector(".ub-status .ub-muted")?.textContent === "local cache";
  act(() => root.unmount());
  host.remove();
  return claimed;
}

describe("the line promises a local cache only where one exists", () => {
  it("does not read the promise off the end of the local read", () => {
    // `localReplicaLoaded` means the read is *over*, and it is over instantly
    // where there is no IndexedDB to read or it refused to open — environments
    // with no cache at all. Telling a reader their document survives a reload
    // there would be a promise the browser cannot keep.
    expect(claimsCache({ localReplicaLoaded: true, hasLocalCache: false })).toBe(false);
    expect(claimsCache({ localReplicaLoaded: true, hasLocalCache: true })).toBe(true);
  });
});

/**
 * The badge is hidden while the indicator reads "synced" (#76), which is only
 * safe because a backlog is itself what stops the state being `synced`. The trap
 * is `provider.isSynced`: the initial handshake raises it and nothing ever
 * lowers it, so a room with writes stranded at the hub keeps reporting
 * `synced: true` — and reading that flag alone would leave the line showing a
 * green dot and no badge for as long as the outage lasted.
 *
 * This has to be asserted on the *settled* line. Every mount starts at
 * "offline" and debounces towards the truth, so a line read before the window
 * is up shows the badge whatever the derivation does — which is exactly how a
 * broken derivation slips past an unsettled assertion.
 */
describe("a backlog is delayed by the calm treatment, never hidden by it", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function settledLine(status: Partial<RoomStatus>): {
    word: string | null;
    badge: string | null;
  } {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <StatusLine connection={stubConnection(4, status)} segment={WORKSPACE} />,
      ),
    );
    // Past every settle window, so what is on screen is what the reader sees.
    act(() => void vi.advanceTimersByTime(5_000));
    const read = {
      word: host.querySelector(".ub-status-word")?.textContent ?? null,
      badge:
        host.querySelector(".ub-pending")?.textContent?.replace(/\s+/g, " ").trim() ??
        null,
    };
    act(() => root.unmount());
    host.remove();
    return read;
  }

  it("reports a backlog the provider's synced flag has stopped tracking", () => {
    expect(settledLine({ connected: true, synced: true })).toEqual({
      word: "syncing…",
      badge: "4 sync messages unacked",
    });
  });

  it("says synced, with no badge, once the backlog is actually empty", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <StatusLine
          connection={stubConnection(0, { connected: true, synced: true })}
          segment={WORKSPACE}
        />,
      ),
    );
    act(() => void vi.advanceTimersByTime(5_000));
    expect(host.querySelector(".ub-status-word")?.textContent).toBe("synced");
    expect(host.querySelector(".ub-pending")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
