/**
 * The status line's sync-backlog label.
 *
 * `sync_status` reports a count of unsynced *rooms*; this reports a count of
 * provider sync *messages* awaiting acknowledgement. Both used to read
 * "pending", which made two correct numbers look like a contradiction during an
 * outage. The rendered wording is the fix, so it is what the test pins — down to
 * the unit, because the honest unit here is messages and not updates.
 */

import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { StatusLine } from "../src/ui/EditorPane.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

/** A connection that only reports status — no socket, no awareness, no peers. */
function stubConnection(unsyncedChanges: number): RoomConnection {
  const status: RoomStatus = {
    connected: false,
    synced: false,
    unsyncedChanges,
    localReplicaLoaded: false,
  };
  return {
    room: "main/doc",
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(status);
      return () => {};
    },
  } as unknown as RoomConnection;
}

function label(unsyncedChanges: number): string | null {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<StatusLine connection={stubConnection(unsyncedChanges)} />));
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
