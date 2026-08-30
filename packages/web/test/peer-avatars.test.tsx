/**
 * The peer strip's avatars (#494).
 *
 * The strip is the constrained surface: a circle is all a reader sees, so
 * everything a name used to carry has to be in the hover and in the
 * accessibility tree instead.
 *
 * Two things are worth a test and the rest is not. The *label* is a pure
 * function of a reading, so it is asserted as one. The one live case is the
 * strip following a **late marker** — a `client`, and then a `session`, that
 * arrive after a session's first state, which `samePresence` silently discards
 * if the comparison does not know about the field. They arrive as two updates
 * on purpose: each one moves exactly one of the two new comparisons, so
 * neutralising either alone turns this case red. Block renumbering is
 * deliberately not re-proved here: `doc-chrome.test.tsx` owns that invariant
 * over the same `usePresence` snapshot this strip reads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { appendBlock, initDoc } from "@uberblick/schema";
import type { ReactElement } from "react";
import { StatusLine } from "../src/ui/EditorPane.js";
import { usePresence } from "../src/ui/hooks.js";
import { presenceLabel } from "../src/ui/doc-chrome.js";
import type { RemotePresence } from "../src/ui/doc-chrome.js";
import { AGENT_CLIENT, WEB_CLIENT } from "../src/collab/identity.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DOC_UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";

/** The session id an MCP server publishes — `agent-<uuid>`, as `ub` mints it. */
const SESSION = "agent-7e8de6c1-2f44-4a90-9b31-0c5a7d2e6f83";

function reading(patch: Partial<RemotePresence>): RemotePresence {
  return {
    clientId: 1,
    name: "Claude Code",
    color: "#7b5ec7",
    kind: "agent",
    session: SESSION,
    block: 5,
    ...patch,
  };
}

describe("what an avatar says when a circle cannot", () => {
  it("names an agent's session and where it is working, and a person only", () => {
    // The three things a robot glyph cannot say. The full session id, not a
    // prefix: it is the id `sync_status` answers with, and a truncation could
    // not be matched against one.
    expect(presenceLabel(reading({}))).toBe(
      `Claude Code · ${SESSION} · editing block 5`,
    );
    // Each tail part drops out on its own, so the label never trails a
    // separator into a value that is not there.
    expect(presenceLabel(reading({ block: null }))).toBe(`Claude Code · ${SESSION}`);
    expect(presenceLabel(reading({ session: null }))).toBe(
      "Claude Code · editing block 5",
    );
    expect(presenceLabel(reading({ session: null, block: null }))).toBe("Claude Code");
    // A person is named and nothing else — a session id and a block number are
    // not what a reader asked for by hovering someone's initial.
    expect(presenceLabel(reading({ kind: "human", name: "Ben" }))).toBe("Ben");
  });
});

/**
 * The shell's own wiring for one room: the presence reading is made once and
 * handed to the line (`App.tsx`), so the strip is exercised over exactly the
 * subscription the app gives it rather than over a hand-built list.
 */
function Shell({ connection }: { connection: RoomConnection }): ReactElement {
  return (
    <StatusLine
      connection={connection}
      segment={WORKSPACE}
      presence={usePresence(connection)}
    />
  );
}

describe("the strip follows a marker that arrives late", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("redraws the circle and its hover when a session says what it is", () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;

    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: DOC_UUID, title: "Presence" });
    appendBlock(ydoc, { type: "paragraph", text: "first block" });
    const awareness = new Awareness(ydoc);
    const status: RoomStatus = {
      connected: true,
      synced: true,
      unsyncedChanges: 0,
      localReplicaLoaded: true,
      hasLocalCache: false,
      protocolMismatch: null,
      authFailed: false,
      tokenMissing: false,
    };
    const connection = {
      room: `${WORKSPACE}/${DOC_UUID}`,
      ydoc,
      provider: { awareness },
      status,
      onStatusChange: (listener: (next: RoomStatus) => void) => {
        listener(status);
        return () => {};
      },
    } as unknown as RoomConnection;

    // A real remote session, so a second publish arrives as an update to a
    // state already in the map rather than as a new one.
    const peerDoc = new Y.Doc();
    const peer = new Awareness(peerDoc);
    const publish = (state: Record<string, unknown>): void => {
      peer.setLocalState(state);
      act(() =>
        applyAwarenessUpdate(
          awareness,
          encodeAwarenessUpdate(peer, [peerDoc.clientID]),
          "test",
        ),
      );
    };
    const avatar = (): HTMLElement | null =>
      host.querySelector<HTMLElement>(".ub-peers .ub-avatar");

    // The ordinary first instant: a `user` and no claim about what it is. Under
    // the absence test this read as an agent; it is a person until it says so.
    publish({ user: { name: "Claude Code", color: "#7b5ec7" } });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Shell connection={connection} />));
    act(() => void vi.advanceTimersByTime(5_000));
    try {
      expect(avatar()?.textContent).toBe("C");
      expect(avatar()?.getAttribute("title")).toBe("Claude Code");

      // The marker alone, with no session id yet: the circle, its ring and both
      // accessible names follow the `kind` comparison and nothing else.
      publish({ user: { name: "Claude Code", color: "#7b5ec7" }, client: AGENT_CLIENT });
      expect(avatar()?.textContent).toBe("🤖");
      expect(avatar()?.style.borderColor).toBe("rgb(123, 94, 199)");
      expect(avatar()?.getAttribute("title")).toBe("Claude Code");

      // Then the session id, with the marker unchanged. Two updates rather than
      // one because `sameSession` compares the two new fields independently: a
      // single publish flipping both is still caught when only one comparison
      // survives, so it would prove neither.
      publish({
        user: { name: "Claude Code", color: "#7b5ec7" },
        client: AGENT_CLIENT,
        session: SESSION,
      });
      expect(avatar()?.getAttribute("title")).toBe(`Claude Code · ${SESSION}`);
      expect(avatar()?.getAttribute("aria-label")).toBe(`Claude Code · ${SESSION}`);

      // And a browser tab stays a person, whatever else moves.
      publish({ user: { name: "Ben", color: "#0c853d" }, client: WEB_CLIENT });
      expect(avatar()?.textContent).toBe("B");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
