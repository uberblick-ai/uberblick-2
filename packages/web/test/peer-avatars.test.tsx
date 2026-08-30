/**
 * The peer strip's avatars (#494).
 *
 * The strip is the constrained surface: a circle is all a reader sees, so
 * everything a name used to carry has to be in the hover and in the
 * accessibility tree instead. What is worth pinning is therefore the *reading*
 * — which circle a session gets, and what it says — plus the two ways that
 * reading can silently stop following the room: a field that changes after a
 * session's first state, and a block number that changes without the caret
 * moving.
 *
 * No hub, no provider, no editor: a Y.Doc, a real Awareness, and a connection
 * that only reports status.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { appendBlock, getBlocksFragment, initDoc, insertBlock } from "@uberblick/schema";
import { StatusLine } from "../src/ui/EditorPane.js";
import { AGENT_CLIENT, WEB_CLIENT } from "../src/collab/rooms.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const DOC_UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";

/** The foreign client ids standing in for an agent and a second browser tab. */
const AGENT = 424_242;
const HUMAN = 515_151;

/** The session id an MCP server publishes — `agent-<uuid>`, as `ub` mints it. */
const SESSION = "agent-7e8de6c1-2f44-4a90-9b31-0c5a7d2e6f83";

interface Fixture {
  ydoc: Y.Doc;
  awareness: Awareness;
  connection: RoomConnection;
}

function fixture(): Fixture {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC_UUID, title: "Presence" });
  appendBlock(ydoc, { type: "paragraph", text: "first block" });
  appendBlock(ydoc, { type: "paragraph", text: "second block" });
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
  return { ydoc, awareness, connection };
}

/** The Y.XmlText of one block — what a caret is anchored in. */
function blockText(ydoc: Y.Doc, index: number): Y.XmlText {
  const element = getBlocksFragment(ydoc).get(index);
  if (!(element instanceof Y.XmlElement)) throw new Error("no such block");
  const text = element.firstChild;
  if (!(text instanceof Y.XmlText)) throw new Error("block has no text");
  return text;
}

/**
 * Publish a foreign session, through a real Awareness of its own.
 *
 * The round trip matters for the late-marker case: a second publish for the
 * same client id has to arrive as an *update* to a session already in the map,
 * which is the path that a missing comparison in `samePresence` swallows. The
 * peer's client id is pinned so the strip's order is the test's order.
 */
const peers = new Map<number, Awareness>();

function publish(
  fix: Fixture,
  clientId: number,
  state: {
    user: { name: string; color: string };
    client?: string;
    session?: string;
    blockIndex?: number;
  },
): void {
  let peer = peers.get(clientId);
  if (peer === undefined) {
    const doc = new Y.Doc();
    doc.clientID = clientId;
    peer = new Awareness(doc);
    peers.set(clientId, peer);
  }
  const { blockIndex, ...fields } = state;
  const cursor =
    blockIndex === undefined
      ? null
      : (() => {
          const anchor = Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(blockText(fix.ydoc, blockIndex), 2),
          );
          return { anchor, head: anchor };
        })();
  peer.setLocalState(
    JSON.parse(JSON.stringify({ ...fields, cursor })) as Record<string, unknown>,
  );
  act(() =>
    applyAwarenessUpdate(
      fix.awareness,
      encodeAwarenessUpdate(peer, [clientId]),
      "test",
    ),
  );
}

function mount(fix: Fixture): { host: HTMLElement; root: Root } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<StatusLine connection={fix.connection} segment={WORKSPACE} />));
  act(() => void vi.advanceTimersByTime(5_000));
  return { host, root };
}

/** The strip, one entry per session: its glyph, its ring, and what it says. */
function strip(host: HTMLElement): Array<{
  glyph: string;
  ring: string;
  label: string | null;
  aria: string | null;
}> {
  return [...host.querySelectorAll<HTMLElement>(".ub-peers .ub-avatar")].map(
    (avatar) => ({
      glyph: avatar.textContent ?? "",
      ring: avatar.style.borderColor,
      label: avatar.getAttribute("title"),
      aria: avatar.getAttribute("aria-label"),
    }),
  );
}

describe("the peer strip draws sessions as circles", () => {
  afterEach(() => {
    peers.clear();
    vi.useRealTimers();
  });

  it("gives an agent a robot and a person their initial", () => {
    vi.useFakeTimers();
    const fix = fixture();
    publish(fix, AGENT, {
      user: { name: "Claude Code", color: "#7b5ec7" },
      client: AGENT_CLIENT,
      session: SESSION,
      blockIndex: 1,
    });
    publish(fix, HUMAN, {
      user: { name: "Ben", color: "#0c853d" },
      client: WEB_CLIENT,
    });
    const { host, root } = mount(fix);
    try {
      expect(strip(host)).toEqual([
        {
          glyph: "🤖",
          ring: "rgb(123, 94, 199)",
          // Name, which session, and where it is working — the three things a
          // robot glyph cannot say. The full session id, not a prefix: it is
          // the id `sync_status` answers with, and a truncation could not be
          // matched against one.
          label: `Claude Code · ${SESSION} · editing block 2`,
          aria: `Claude Code · ${SESSION} · editing block 2`,
        },
        {
          // A person is their own initial, upper-cased, in their colour. No
          // session id and no block: a human hover is the name and nothing
          // else, because that is all a reader asked for.
          glyph: "B",
          ring: "rgb(12, 133, 61)",
          label: "Ben",
          aria: "Ben",
        },
      ]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("drops the parts it cannot say rather than trailing a separator", () => {
    vi.useFakeTimers();
    const fix = fixture();
    // An agent with no caret anchored, on a build that publishes no session id.
    publish(fix, AGENT, {
      user: { name: "Codex", color: "#7b5ec7" },
      client: AGENT_CLIENT,
    });
    const { host, root } = mount(fix);
    try {
      expect(strip(host)).toEqual([
        { glyph: "🤖", ring: "rgb(123, 94, 199)", label: "Codex", aria: "Codex" },
      ]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  /**
   * The two ways a strip stops following the room while still looking right.
   *
   * `usePresence` stores a reading only when it differs from the last one, and
   * "differs" is a field-by-field comparison. A field the projection gained but
   * the comparison did not is invisible for as long as the session stays — and
   * a block *number* can go stale with no awareness event at all.
   */
  it("follows a marker that arrives late, and a caret that is renumbered under it", () => {
    vi.useFakeTimers();
    const fix = fixture();
    // A first state with neither marker nor id — the ordinary case for the
    // instant between joining a room and publishing what you are.
    publish(fix, AGENT, { user: { name: "Claude Code", color: "#7b5ec7" }, blockIndex: 1 });
    const { host, root } = mount(fix);
    try {
      expect(strip(host)[0]).toMatchObject({ glyph: "C", label: "Claude Code" });

      publish(fix, AGENT, {
        user: { name: "Claude Code", color: "#7b5ec7" },
        client: AGENT_CLIENT,
        session: SESSION,
        blockIndex: 1,
      });
      expect(strip(host)[0]).toMatchObject({
        glyph: "🤖",
        label: `Claude Code · ${SESSION} · editing block 2`,
      });

      // Nobody touched awareness: a block inserted above an idle caret moves
      // the number the hover names, and the only event is on the fragment.
      act(() => {
        insertBlock(fix.ydoc, null, { type: "paragraph", text: "a new first block" });
      });
      expect(strip(host)[0]).toMatchObject({
        label: `Claude Code · ${SESSION} · editing block 3`,
      });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
