/**
 * The peer strip's avatars (#494).
 *
 * The strip is the constrained surface: a circle is all a reader sees, so
 * everything a name used to carry has to be in the hover and in the
 * accessibility tree instead.
 *
 * Three things are worth a test and the rest is not. The *label* is a pure
 * function of a reading, so it is asserted as one. One live case is the
 * strip following a **late marker** — a `client`, and then a `session`, that
 * arrive after a session's first state, which `samePresence` silently discards
 * if the comparison does not know about the field. They arrive as two updates
 * on purpose: each one moves exactly one of the two new comparisons, so
 * neutralising either alone turns this case red. The other live case is the
 * strip's **first frame after a document opens**: the shell reads presence over
 * `doc ?? directory`, the stored reading lags the connection by one effect, and
 * without `usePresence`'s room guard the strip's first painted frame is the
 * directory's roster — every session in the workspace — drawn as this
 * document's. Block renumbering is
 * deliberately not re-proved here: `doc-chrome.test.tsx` owns that invariant
 * over the same `usePresence` snapshot this strip reads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useLayoutEffect } from "react";
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
import { PeerCluster } from "../src/ui/PeerCluster.js";
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
    blockId: "block-5",
    ...patch,
  };
}

describe("what an avatar says when a circle cannot", () => {
  it("names the session kind, an agent's id and where it is working", () => {
    // The three things a robot glyph cannot say. The full session id, not a
    // prefix: it is the id `sync_status` answers with, and a truncation could
    // not be matched against one.
    expect(presenceLabel(reading({}))).toBe(
      `Claude Code · agent · ${SESSION} · editing block 5`,
    );
    // Each tail part drops out on its own, so the label never trails a
    // separator into a value that is not there.
    expect(presenceLabel(reading({ block: null, blockId: null }))).toBe(
      `Claude Code · agent · ${SESSION}`,
    );
    expect(presenceLabel(reading({ session: null }))).toBe(
      "Claude Code · agent · editing block 5",
    );
    expect(
      presenceLabel(
        reading({ session: null, block: null, blockId: null }),
      ),
    ).toBe("Claude Code · agent");
    expect(
      presenceLabel(
        reading({
          kind: "human",
          name: "Ben",
          session: null,
          block: null,
          blockId: null,
        }),
      ),
    ).toBe("Ben · person");
  });
});

describe("the compact collaborator cluster", () => {
  function peers(count: number): RemotePresence[] {
    return Array.from({ length: count }, (_, index) =>
      reading({
        clientId: index + 1,
        name: `Peer ${index + 1}`,
        kind: index === 3 ? "agent" : "human",
        session: index === 3 ? SESSION : null,
        block: index + 1,
        blockId: `block-${index + 1}`,
      }),
    );
  }

  it("caps the circles at three and makes every remaining session operable", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    const activate = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<PeerCluster presence={peers(5)} onActivate={activate} />));
    try {
      const visible = host.querySelectorAll<HTMLButtonElement>(
        ".ub-peers > .ub-peer-control[data-peer-id]",
      );
      expect(visible).toHaveLength(3);
      expect(visible[0]?.getAttribute("aria-label")).toContain("Peer 1 · person");
      expect(visible[0]?.querySelector(".ub-avatar")?.textContent).toBe("P");

      const more = host.querySelector<HTMLButtonElement>(".ub-peer-more");
      expect(more?.textContent).toBe("+2");
      expect(more?.getAttribute("aria-label")).toBe(
        "2 more active collaborators",
      );
      act(() => more?.click());

      const rows = host.querySelectorAll<HTMLButtonElement>(
        ".ub-peer-overflow-row",
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain("Peer 4");
      expect(rows[0]?.textContent).toContain("agent");
      expect(rows[0]?.querySelector(".ub-avatar")?.textContent).toBe("P🤖");
      act(() => rows[0]?.click());
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 4, blockId: "block-4" }),
      );
      expect(document.activeElement).toBe(more);
      expect(host.querySelector(".ub-peer-overflow")).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("returns focus after dismissal and after live removal", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (sessions: readonly RemotePresence[]): void => {
      act(() =>
        root.render(
          <div className="ub-status">
            <button type="button" className="ub-status-sync">
              Sync details
            </button>
            <PeerCluster presence={sessions} />
          </div>,
        ),
      );
    };
    render(peers(4));
    try {
      const more = host.querySelector<HTMLButtonElement>(".ub-peer-more");
      act(() => more?.focus());
      act(() => more?.click());
      const row = host.querySelector<HTMLButtonElement>(
        '.ub-peer-overflow-row[data-peer-id="4"]',
      );
      act(() => row?.focus());
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(document.activeElement).toBe(more);

      render(peers(3));
      expect(document.activeElement).toBe(
        host.querySelector('[data-peer-id="1"]'),
      );

      render(peers(4));
      const restoredMore = host.querySelector<HTMLButtonElement>(".ub-peer-more");
      act(() => restoredMore?.click());
      const nextRow = host.querySelector<HTMLButtonElement>(
        '.ub-peer-overflow-row[data-peer-id="4"]',
      );
      act(() => nextRow?.focus());
      render([peers(4)[0]!, peers(4)[2]!, peers(4)[3]!]);
      expect(document.activeElement).toBe(
        host.querySelector('[data-peer-id="4"]'),
      );

      render([]);
      expect(document.activeElement).toBe(host.querySelector(".ub-status-sync"));
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

/**
 * The shell's own wiring, both rooms of it (`App.tsx`): presence is read once
 * over `chromeRoom = doc ?? directory` and handed to the line, which renders
 * against the *document's* connection — so the strip is exercised over exactly
 * the subscription and the room switch the app gives it, not a hand-built
 * list. `onFrame` fires from a layout effect — after the commit, before the
 * passive effects that correct a stale reading — so a test sees every frame
 * exactly as it would paint.
 */
function Shell({
  doc,
  directory,
  onFrame,
}: {
  doc: RoomConnection | null;
  directory: RoomConnection | null;
  onFrame?: () => void;
}): ReactElement | null {
  const chromeRoom = doc ?? directory;
  const presence = usePresence(chromeRoom);
  useLayoutEffect(() => {
    onFrame?.();
  });
  return doc === null ? null : (
    <StatusLine connection={doc} presence={presence} docPresent />
  );
}

/** A connected room, as `useRoom` would hand it to the shell. */
function roomFixture(room: string): {
  connection: RoomConnection;
  ydoc: Y.Doc;
  awareness: Awareness;
} {
  const ydoc = new Y.Doc();
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
    room,
    ydoc,
    provider: { awareness },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(status);
      return () => {};
    },
  } as unknown as RoomConnection;
  return { connection, ydoc, awareness };
}

/** A remote session already in the room: one state, applied as an update. */
function join(awareness: Awareness, state: Record<string, unknown>): void {
  const peerDoc = new Y.Doc();
  const peer = new Awareness(peerDoc);
  peer.setLocalState(state);
  applyAwarenessUpdate(
    awareness,
    encodeAwarenessUpdate(peer, [peerDoc.clientID]),
    "test",
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

    const { connection, ydoc, awareness } = roomFixture(
      `${WORKSPACE}/${DOC_UUID}`,
    );
    initDoc(ydoc, { uuid: DOC_UUID, title: "Presence" });
    appendBlock(ydoc, { type: "paragraph", text: "first block" });

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
    const control = (): HTMLElement | null =>
      host.querySelector<HTMLElement>(".ub-peers .ub-peer-control");
    const avatar = (): HTMLElement | null =>
      control()?.querySelector<HTMLElement>(".ub-avatar") ?? null;

    // The ordinary first instant: a `user` and no claim about what it is. Under
    // the absence test this read as an agent; it is a person until it says so.
    publish({ user: { name: "Claude Code", color: "#7b5ec7" } });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Shell doc={connection} directory={null} />));
    act(() => void vi.advanceTimersByTime(5_000));
    try {
      expect(avatar()?.textContent).toBe("C");
      expect(control()?.getAttribute("title")).toBe("Claude Code · person");

      // The marker alone, with no session id yet: the circle, its ring and both
      // accessible names follow the `kind` comparison and nothing else.
      publish({ user: { name: "Claude Code", color: "#7b5ec7" }, client: AGENT_CLIENT });
      expect(avatar()?.textContent).toBe("C🤖");
      expect(avatar()?.style.borderColor).toBe("rgb(123, 94, 199)");
      expect(control()?.getAttribute("title")).toBe("Claude Code · agent");

      // Then the session id, with the marker unchanged. Two updates rather than
      // one because `sameSession` compares the two new fields independently: a
      // single publish flipping both is still caught when only one comparison
      // survives, so it would prove neither.
      publish({
        user: { name: "Claude Code", color: "#7b5ec7" },
        client: AGENT_CLIENT,
        session: SESSION,
      });
      expect(control()?.getAttribute("title")).toBe(
        `Claude Code · agent · ${SESSION}`,
      );
      expect(control()?.getAttribute("aria-label")).toBe(
        `Claude Code · agent · ${SESSION}`,
      );

      // And a browser tab stays a person, whatever else moves.
      publish({ user: { name: "Ben", color: "#0c853d" }, client: WEB_CLIENT });
      expect(avatar()?.textContent).toBe("B");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

describe("the strip's first frame after a document opens", () => {
  it("is empty until the document's own reading lands, never the directory's roster", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;

    // The directory room every session in the workspace publishes into, and the
    // document only Zoe is reading. If the reading made in the directory's room
    // ever reaches the document's strip, three strangers appear in it.
    const directory = roomFixture(`${WORKSPACE}/_directory`);
    join(directory.awareness, { user: { name: "Alice", color: "#0c853d" } });
    join(directory.awareness, { user: { name: "Bob", color: "#0675c9" } });
    join(directory.awareness, { user: { name: "Cleo", color: "#cb26b4" } });

    const doc = roomFixture(`${WORKSPACE}/${DOC_UUID}`);
    initDoc(doc.ydoc, { uuid: DOC_UUID, title: "Presence" });
    join(doc.awareness, { user: { name: "Zoe", color: "#e30c4e" } });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const frames: string[][] = [];
    const onFrame = (): void => {
      frames.push(
        Array.from(
          host.querySelectorAll<HTMLElement>(".ub-peers .ub-peer-control"),
          (control) => control.getAttribute("title") ?? "",
        ),
      );
    };
    try {
      // The first screen of a session: no document open, the shell reading over
      // the directory. Then a document opens — the commit that first mounts the
      // strip is the one where the stored reading still belongs to the
      // directory, and it must paint as nobody rather than as everybody.
      act(() =>
        root.render(<Shell doc={null} directory={directory.connection} onFrame={onFrame} />),
      );
      act(() =>
        root.render(
          <Shell
            doc={doc.connection}
            directory={directory.connection}
            onFrame={onFrame}
          />,
        ),
      );
      expect(frames).toEqual([[], [], [], ["Zoe · person"]]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
