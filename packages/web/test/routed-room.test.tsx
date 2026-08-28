/**
 * `useRoom` never hands back a connection to a room other than the one asked
 * for.
 *
 * The hook keeps its connection in state, so it lags its `room` argument by one
 * effect: on the render right after a caller switches rooms, the state still
 * holds the previous connection. Returning it is not a cosmetic slip — every
 * consumer in the app reads the *document* off that connection, so for that
 * render the editor, the outline and the threads rail would all draw the
 * document the reader just navigated away from, under the new document's URL,
 * and a keystroke landing in that window would be written into the wrong Y.Doc.
 *
 * Asserted as an invariant over every render rather than at one moment, because
 * the offending render is the one in the middle: `act` flushes effects, so a
 * before-and-after check is exactly the check that cannot see the bug.
 *
 * `acquireRoom` is mocked. The real one opens a websocket to the hub, and the
 * pairing being tested is a property of the hook, not of the transport — see
 * `reconnect.test.ts` for the connection behaviour that does need a real socket.
 */

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import * as Y from "yjs";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

/** The workspace these stub room keys sit in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  unsyncedChanges: 0,
  localReplicaLoaded: false,
  hasLocalCache: false,
  protocolMismatch: null,
  authFailed: false,
};

/** Rooms open instantly and never talk to anything. */
vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (room: string) => ({
    connection: {
      room,
      ydoc: new Y.Doc(),
      provider: { awareness: null },
      status: OFFLINE,
      onStatusChange: (listener: (next: RoomStatus) => void) => {
        listener(OFFLINE);
        return () => {};
      },
      whenLocalReplicaLoaded: Promise.resolve(),
    } as unknown as RoomConnection,
    release: () => {},
  }),
}));

const { useRoom } = await import("../src/ui/hooks.js");

const IDENTITY = { name: "tester", color: "#888888" };

describe("a room connection is paired with the room it was asked for", () => {
  it("never reports another room's connection, not even for one render", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;

    /** Every (asked for, handed back) pair, one per render. */
    const seen: Array<[string | null, string | null]> = [];

    function Probe({ room }: { room: string | null }): ReactElement | null {
      const connection = useRoom(room, IDENTITY);
      seen.push([room, connection?.room ?? null]);
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => root.render(<Probe room={`${WORKSPACE}/alpha`} />));
    expect(seen.at(-1)).toEqual([`${WORKSPACE}/alpha`, `${WORKSPACE}/alpha`]);

    // The navigation. Somewhere in here is a render where the state still holds
    // alpha while the caller has already asked for beta.
    act(() => root.render(<Probe room={`${WORKSPACE}/beta`} />));
    expect(seen.at(-1)).toEqual([`${WORKSPACE}/beta`, `${WORKSPACE}/beta`]);

    // …and leaving the document entirely.
    act(() => root.render(<Probe room={null} />));
    expect(seen.at(-1)).toEqual([null, null]);

    const mismatched = seen.filter(([asked, got]) => got !== null && got !== asked);
    expect(mismatched).toEqual([]);
    // The invariant is only meaningful if the middle render actually happened.
    expect(seen.length).toBeGreaterThan(3);

    act(() => root.unmount());
    host.remove();
  });
});
