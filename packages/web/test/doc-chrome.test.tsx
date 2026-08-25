/**
 * The doc chrome (#69): the breadcrumb, the two pills, and the identity line.
 *
 * Everything here is a *reading* of state the system already keeps, so the test
 * stubs that state and nothing else — a Y.Doc with tags and blocks, a real
 * Awareness carrying one foreign session, and a connection that only reports
 * status. No hub, no provider, no editor.
 *
 * What is worth pinning is the derivation, not the markup: which group a
 * document belongs to, which block a foreign caret is in, that the caret going
 * away takes the pill with it, that the connection pill settles on the truth,
 * and that the rev moves when the content does.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import {
  appendBlock,
  editBlock,
  getBlocksFragment,
  getMeta,
  initDoc,
  insertBlock,
  setTags,
} from "@uberblick/schema";
import { DocChrome, DocMetaLine } from "../src/ui/DocChrome.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const DOC_UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";

/** The foreign client id standing in for an agent session. */
const AGENT_CLIENT = 424_242;

interface Fixture {
  ydoc: Y.Doc;
  awareness: Awareness;
  connection: RoomConnection;
  blockIds: string[];
}

function fixture(status: Partial<RoomStatus> = {}): Fixture {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: DOC_UUID, title: "Sync and offline" });
  setTags(ydoc, ["needs-love", "feature"]);
  const blockIds = [
    appendBlock(ydoc, { type: "paragraph", text: "first block" }),
    appendBlock(ydoc, { type: "paragraph", text: "second block" }),
  ];
  const awareness = new Awareness(ydoc);
  const full: RoomStatus = {
    connected: true,
    synced: true,
    unsyncedChanges: 0,
    // The chrome says nothing about the local replica — the status line owns
    // those words — so both flags are off and the pills are read on their own.
    localReplicaLoaded: false,
    hasLocalCache: false,
    ...status,
  };
  const connection = {
    room: `main/${DOC_UUID}`,
    ydoc,
    provider: { awareness },
    status: full,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(full);
      return () => {};
    },
  } as unknown as RoomConnection;
  return { ydoc, awareness, connection, blockIds };
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
 * Publish a foreign session with a caret in `blockIndex`, in the wire format an
 * MCP session uses: relative-position JSON under `cursor`, `user` beside it.
 */
function publishAgentCursor(fix: Fixture, blockIndex: number): void {
  const anchor = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(blockText(fix.ydoc, blockIndex), 3),
  );
  fix.awareness.states.set(
    AGENT_CLIENT,
    JSON.parse(
      JSON.stringify({
        user: { name: "Claude · demo agent", color: "#7b5ec7" },
        cursor: { anchor, head: anchor },
      }),
    ) as Record<string, unknown>,
  );
}

function mount(fix: Fixture): { host: HTMLElement; root: Root } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <>
        <DocChrome
          connection={fix.connection}
          meta={getMeta(fix.ydoc)}
          threads={[]}
          threadsOpen={false}
          onToggleThreads={() => {}}
        />
        <DocMetaLine
          connection={fix.connection}
          meta={getMeta(fix.ydoc)}
          knownTags={["reference"]}
          archived={false}
        />
      </>,
    ),
  );
  // Past every settle window, so the connection pill shows what a reader sees
  // rather than the "offline" every mount starts from.
  act(() => void vi.advanceTimersByTime(5_000));
  return { host, root };
}

function text(host: HTMLElement, selector: string): string | null {
  const found = host.querySelector(selector);
  return found === null ? null : (found.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("the doc chrome reads the document, the awareness and the status", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the group and the title, the caret's block, the state and the rev", () => {
    vi.useFakeTimers();
    const fix = fixture();
    publishAgentCursor(fix, 1);
    const { host, root } = mount(fix);
    try {
      // The breadcrumb: the *first canonical* tag, not the document's own tag
      // order — "needs-love" is not a group, "feature" is.
      expect(text(host, ".ub-crumb-group")).toBe("Features");
      expect(text(host, ".ub-crumb-title")).toBe("Sync and offline");

      // The session with a caret, the block it is in, drawn in its own colour.
      expect(text(host, ".ub-pill-agent")).toBe(
        "Claude · demo agent editing block 2",
      );
      expect(
        host.querySelector<HTMLElement>(".ub-pill-agent")?.style.borderColor,
      ).not.toBe("");

      // The connection pill, settled on the truth this status reports.
      expect(text(host, ".ub-pill-synced")).toBe("synced");
      expect(host.querySelector(".ub-pill-synced .ub-dot-live")).not.toBeNull();

      // The identity line: the group again, the shortened uuid, and a rev.
      expect(text(host, ".ub-badge")).toBe("Features");
      expect(text(host, ".ub-doc-ids")).toMatch(
        /^uuid 9f3c1a2b · rev [0-9a-f]{8}$/,
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("renumbers the caret's block when the document moves under it", () => {
    vi.useFakeTimers();
    const fix = fixture();
    publishAgentCursor(fix, 1);
    const { host, root } = mount(fix);
    try {
      expect(text(host, ".ub-pill-agent")).toBe(
        "Claude · demo agent editing block 2",
      );
      // A block inserted above an idle caret: the caret did not move, its
      // *number* did. Awareness is silent about this, so the pill would go on
      // naming a block the reader is no longer looking at.
      act(() => {
        insertBlock(fix.ydoc, null, { type: "paragraph", text: "a new first" });
      });
      expect(text(host, ".ub-pill-agent")).toBe(
        "Claude · demo agent editing block 3",
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("counts blocks the way a reader sees them, shadowed duplicates aside", () => {
    vi.useFakeTimers();
    const fix = fixture();
    // A losing copy of the first block, left between the two by concurrent
    // re-types: it carries block one's id, so no reader resolves it and
    // `getBlocks` does not return it. Counting it would put the caret in the
    // third block of a document whose second block it is sitting in.
    const duplicate = new Y.XmlElement("paragraph");
    duplicate.setAttribute("id", fix.blockIds[0] ?? "");
    duplicate.insert(0, [new Y.XmlText("a losing copy")]);
    getBlocksFragment(fix.ydoc).insert(1, [duplicate]);
    // Physically third, visibly second.
    publishAgentCursor(fix, 2);
    const { host, root } = mount(fix);
    try {
      expect(text(host, ".ub-pill-agent")).toBe(
        "Claude · demo agent editing block 2",
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("drops the activity pill when the session leaves", () => {
    vi.useFakeTimers();
    const fix = fixture();
    publishAgentCursor(fix, 0);
    const { host, root } = mount(fix);
    try {
      expect(text(host, ".ub-pill-agent")).toBe(
        "Claude · demo agent editing block 1",
      );
      act(() => {
        removeAwarenessStates(fix.awareness, [AGENT_CLIENT], "test");
      });
      expect(host.querySelector(".ub-pill-agent")).toBeNull();
      // The connection pill is untouched by any of it.
      expect(text(host, ".ub-pill-synced")).toBe("synced");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("says offline when the provider is not connected", () => {
    vi.useFakeTimers();
    const fix = fixture({ connected: false, synced: false });
    const { host, root } = mount(fix);
    try {
      expect(text(host, ".ub-pill-offline")).toBe("offline");
      expect(host.querySelector(".ub-pill-offline .ub-dot-off")).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("moves the rev when a block's content changes", () => {
    vi.useFakeTimers();
    const fix = fixture();
    const { host, root } = mount(fix);
    try {
      const before = text(host, ".ub-doc-ids");
      act(() => {
        editBlock(fix.ydoc, fix.blockIds[0] ?? "", "first block", "first block!");
      });
      const after = text(host, ".ub-doc-ids");
      expect(after).not.toBe(before);
      expect(after).toMatch(/^uuid 9f3c1a2b · rev [0-9a-f]{8}$/);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
