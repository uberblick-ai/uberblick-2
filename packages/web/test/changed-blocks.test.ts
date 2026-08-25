/**
 * Changed-block indicators (#120).
 *
 * Everything here is read out of a real Y.Doc with a second replica wired the
 * way the hub wires one — because "remote" is a property of the transaction
 * that delivered a change, and a fixture of the UI's own making cannot have
 * one.
 *
 * 1. **Somebody else's edit marks; yours never does.** Whichever way you make
 *    it — through the editor, or straight into the document.
 * 2. **The document arriving is not a change, in any order.** Replica-then-hub,
 *    hub-then-replica, and an offline open whose hub turns up late: the first
 *    two mark nothing, and the third keeps what the late hub brought, because
 *    that is news rather than hydration.
 * 3. **Reading clears, and only reading.** Fully on screen for the delay
 *    clears; scrolling past does not; a block taller than the pane clears once
 *    it fills the pane; a block changed again under the reader's eyes starts
 *    its window over.
 * 4. **Both halves of the signal reach the reader.** The gutter class lands on
 *    every block type the palette has, including the two ProseMirror renders
 *    through a NodeView, and the outline dot lands on the entry for the section
 *    that changed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock, editBlock, getBlocks, initDoc } from "@uberblick/schema";
import {
  changedBlocks,
  trackChangedBlocks,
} from "../src/editor/changed-blocks.js";
import type { ChangedBlocks } from "../src/editor/changed-blocks.js";
import { clearWhenSeen } from "../src/editor/changed-marks.js";
import { outlineDots } from "../src/ui/outline.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { mountEditor } from "./helpers.js";

const HEADING = "Sync";
const PARAGRAPH = "The quick brown fox jumps.";
const CODE = "console.log(1)";
const MERMAID = "graph TD; a-->b";

/** Heading, paragraph, code, mermaid — one of every block type the palette has. */
function seeded(): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "doc-1", title: "Changed" });
  appendBlock(ydoc, { type: "heading", text: HEADING, level: 2 });
  appendBlock(ydoc, { type: "paragraph", text: PARAGRAPH });
  appendBlock(ydoc, { type: "code", text: CODE, language: "ts" });
  appendBlock(ydoc, { type: "mermaid", text: MERMAID });
  return ydoc;
}

const blockIds = (ydoc: Y.Doc): string[] =>
  getBlocks(ydoc).map((block) => block.id);

const marked = (marks: ChangedBlocks): string[] => [...marks.touched().keys()];

/** Two replicas of one document, wired the way the hub wires them. */
function replicas(): { local: Y.Doc; remote: Y.Doc; blocks: string[] } {
  const local = seeded();
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
  return { local, remote, blocks: blockIds(local) };
}

/** Hand `to` everything `from` has that it does not — one sync message. */
function relay(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

/** Let the tracker tell its subscribers — it does that on a microtask. */
async function flush(): Promise<void> {
  await Promise.resolve();
}

describe("a remote edit marks its block, a local one never does", () => {
  it("marks the block an agent rewrote, and only that block", () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();

    editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");

    expect(marked(marks)).toEqual([blocks[1]!]);
  });

  it("marks a block a remote client appended", () => {
    const { local, remote } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();

    const fresh = appendBlock(remote, { type: "paragraph", text: "New." });

    expect(marked(marks)).toEqual([fresh]);
  });

  it("leaves your own edits alone, typed or written straight into the doc", () => {
    const { local, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor } = mountEditor(local, { changed: marks });
    try {
      // Typing: y-prosemirror writes this into the Y.Doc in a local
      // transaction, and it comes back off the relay as a no-op.
      editor.commands.insertContentAt(1, "x");
      // And the same document, edited by this client without the editor.
      editBlock(local, blocks[1]!, PARAGRAPH, "Rewritten by me.");

      expect(marked(marks)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });
});

/** The parts of a room connection the tracker's arming actually reads. */
function fakeConnection(
  ydoc: Y.Doc,
  options: { connected: boolean },
): {
  connection: RoomConnection;
  replicaLoaded: () => void;
  connect: () => void;
  hubSynced: () => void;
} {
  let resolveLocal: () => void = () => {};
  const whenLocalReplicaLoaded = new Promise<void>((resolve) => {
    resolveLocal = resolve;
  });
  const status: RoomStatus = {
    connected: options.connected,
    synced: false,
    unsyncedChanges: 0,
    localReplicaLoaded: false,
  };
  const listeners = new Set<(next: RoomStatus) => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener({ ...status });
  };
  const connection = {
    room: "main/doc-1",
    ydoc,
    provider: null as unknown as RoomConnection["provider"],
    status,
    onStatusChange(listener: (next: RoomStatus) => void) {
      listeners.add(listener);
      listener({ ...status });
      return () => listeners.delete(listener);
    },
    whenLocalReplicaLoaded,
  } as RoomConnection;
  return {
    connection,
    replicaLoaded: () => {
      status.localReplicaLoaded = true;
      resolveLocal();
    },
    connect: () => {
      status.connected = true;
      emit();
    },
    hubSynced: () => {
      status.synced = true;
      emit();
    },
  };
}

describe("the document arriving is not a change, in any order", () => {
  /**
   * The hub's copy, and a cached replica holding something the hub does not —
   * work this reader did offline last time. Both are "the document arriving".
   */
  function opening(): { hub: Y.Doc; cached: Y.Doc; blocks: string[] } {
    const hub = seeded();
    const cached = new Y.Doc();
    Y.applyUpdate(cached, Y.encodeStateAsUpdate(hub));
    appendBlock(cached, { type: "paragraph", text: "Written offline." });
    return { hub, cached, blocks: blockIds(hub) };
  }

  it("marks nothing when the replica replays first and the hub syncs after", async () => {
    const { hub, cached, blocks } = opening();
    const ydoc = new Y.Doc();
    const room = fakeConnection(ydoc, { connected: true });
    const marks = changedBlocks(room.connection);

    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(cached));
    room.replicaLoaded();
    await flush();

    // The hub's copy has moved on since this replica cached it. Still arrival.
    editBlock(hub, blocks[0]!, HEADING, "Sync, revised");
    relay(hub, ydoc);
    room.hubSynced();
    expect(marked(marks)).toEqual([]);

    editBlock(hub, blocks[1]!, PARAGRAPH, "Rewritten while you watched.");
    relay(hub, ydoc);
    expect(marked(marks)).toEqual([blocks[1]!]);
  });

  it("marks nothing when the hub syncs first and the replica replays after", async () => {
    const { hub, cached, blocks } = opening();
    const ydoc = new Y.Doc();
    const room = fakeConnection(ydoc, { connected: true });
    const marks = changedBlocks(room.connection);

    relay(hub, ydoc);
    room.hubSynced();
    // The replica now replays work the hub never had — the case that used to
    // paint the whole cache, because the first sync had already opened the
    // tracker.
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(cached));
    room.replicaLoaded();
    await flush();
    expect(marked(marks)).toEqual([]);

    editBlock(hub, blocks[1]!, PARAGRAPH, "Rewritten while you watched.");
    relay(hub, ydoc);
    expect(marked(marks)).toEqual([blocks[1]!]);
  });

  it("keeps what a late hub brings to a document opened offline", async () => {
    const { hub, cached, blocks } = opening();
    const ydoc = new Y.Doc();
    const room = fakeConnection(ydoc, { connected: false });
    const marks = changedBlocks(room.connection);

    // Offline: the replica is the whole document, and nothing is owed.
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(cached));
    room.replicaLoaded();
    await flush();

    // The hub turns up later carrying what changed while this reader was away.
    // That is news, and used to be wiped by the first-sync reset.
    room.connect();
    editBlock(hub, blocks[1]!, PARAGRAPH, "Changed while you were offline.");
    relay(hub, ydoc);
    room.hubSynced();

    expect(marked(marks)).toEqual([blocks[1]!]);
  });
});

/** An IntersectionObserver the test drives, since jsdom has none. */
class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | null = null;
  readonly targets = new Set<Element>();
  readonly root: Element | Document | null;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    init?: IntersectionObserverInit,
  ) {
    this.root = init?.root ?? null;
    FakeIntersectionObserver.latest = this;
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Report how much of `id` is inside the root box. */
  report(
    id: string,
    seen: { ratio: number; height?: number; rootHeight?: number },
  ): void {
    const target = [...this.targets].find((element) => element.id === id);
    if (target === undefined) throw new Error(`not observed: ${id}`);
    const rootHeight = seen.rootHeight ?? 800;
    this.callback(
      [
        {
          target,
          isIntersecting: seen.ratio > 0,
          intersectionRatio: seen.ratio,
          intersectionRect: {
            height: seen.height ?? rootHeight * seen.ratio,
          } as DOMRectReadOnly,
          rootBounds: { height: rootHeight } as DOMRectReadOnly,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

describe("a block that has been read stops being marked", () => {
  const SEEN = 2_000;
  let restore: typeof globalThis.IntersectionObserver | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restore = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    globalThis.IntersectionObserver = restore as typeof IntersectionObserver;
    FakeIntersectionObserver.latest = null;
    vi.useRealTimers();
  });

  /** A marked paragraph, a mounted editor, and the watcher running over both. */
  function watching(): {
    marks: ChangedBlocks;
    remote: Y.Doc;
    blocks: string[];
    observer: () => FakeIntersectionObserver;
    stop: () => void;
  } {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor } = mountEditor(local, { changed: marks });
    const release = clearWhenSeen(marks, editor, { delayMs: SEEN });
    return {
      marks,
      remote,
      blocks,
      observer: () => FakeIntersectionObserver.latest!,
      stop: () => {
        release();
        editor.destroy();
      },
    };
  }

  it("clears once the block has been fully on screen for the delay", async () => {
    const { marks, remote, blocks, observer, stop } = watching();
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();

      observer().report(blocks[1]!, { ratio: 1 });
      vi.advanceTimersByTime(SEEN - 1);
      expect(marks.has(blocks[1]!)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(marks.has(blocks[1]!)).toBe(false);
    } finally {
      stop();
    }
  });

  it("keeps the mark on a block that was only scrolled past", async () => {
    const { marks, remote, blocks, observer, stop } = watching();
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();

      observer().report(blocks[1]!, { ratio: 1 });
      vi.advanceTimersByTime(SEEN - 1);
      observer().report(blocks[1]!, { ratio: 0.4 });
      vi.advanceTimersByTime(SEEN * 3);

      expect(marks.has(blocks[1]!)).toBe(true);
    } finally {
      stop();
    }
  });

  it("clears a block taller than the pane once it fills the pane", async () => {
    const { marks, remote, blocks, observer, stop } = watching();
    try {
      editBlock(remote, blocks[2]!, CODE, "console.log(2)");
      await flush();

      // A ratio of 1 is unreachable for a 2400px block in an 800px pane, so
      // filling the pane has to count — otherwise its mark is permanent.
      observer().report(blocks[2]!, {
        ratio: 800 / 2400,
        height: 800,
        rootHeight: 800,
      });
      vi.advanceTimersByTime(SEEN);

      expect(marks.has(blocks[2]!)).toBe(false);
    } finally {
      stop();
    }
  });

  it("starts the read window over when the block changes again", async () => {
    const { marks, remote, blocks, observer, stop } = watching();
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "First rewrite.");
      await flush();
      observer().report(blocks[1]!, { ratio: 1 });
      vi.advanceTimersByTime(SEEN - 500);

      // Changed again under the reader's eyes: what they have been looking at
      // for the last 1.5s is not what is there now.
      editBlock(remote, blocks[1]!, "First rewrite.", "Second rewrite.");
      await flush();

      vi.advanceTimersByTime(600);
      expect(marks.has(blocks[1]!)).toBe(true);
      vi.advanceTimersByTime(SEEN);
      expect(marks.has(blocks[1]!)).toBe(false);
    } finally {
      stop();
    }
  });

  it("measures against the pane the prose scrolls in, not the window", () => {
    const { local } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor, element } = mountEditor(local, { changed: marks });
    const pane = document.createElement("div");
    pane.style.overflowY = "auto";
    document.body.appendChild(pane);
    pane.appendChild(element);
    const release = clearWhenSeen(marks, editor, { delayMs: SEEN });
    try {
      // A block below the fold of `.ub-pane` is still inside the window's
      // rectangle, so rooting on the window would clear marks nobody saw.
      expect(FakeIntersectionObserver.latest!.root).toBe(pane);
    } finally {
      release();
      editor.destroy();
      pane.remove();
    }
  });
});

describe("the mark reaches both places a reader looks", () => {
  it("puts the gutter class on all four palette block types, NodeViews included", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor, element } = mountEditor(local, { changed: marks });
    try {
      // The palette is these four; there is no table block in this schema, so
      // "every block type" is exactly this list (#59 would add to it, and
      // nothing here is per-type).
      editBlock(remote, blocks[0]!, HEADING, "Sync, revised");
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten.");
      editBlock(remote, blocks[2]!, CODE, "console.log(2)");
      editBlock(remote, blocks[3]!, MERMAID, "graph TD; a-->c");
      await flush();

      expect(element.querySelector("h2.ub-heading.ub-changed")).not.toBeNull();
      expect(element.querySelector("p.ub-paragraph.ub-changed")).not.toBeNull();
      // `code` and `mermaid` render through a NodeView that owns its own DOM;
      // the decoration still lands on that element, because ProseMirror applies
      // it rather than the view.
      expect(element.querySelector("pre.ub-code.ub-changed")).not.toBeNull();
      expect(element.querySelector("div.ub-mermaid.ub-changed")).not.toBeNull();
      expect(element.querySelectorAll(".ub-changed")).toHaveLength(4);

      for (const id of blocks) marks.clear(id);
      await flush();
      expect(element.querySelectorAll(".ub-changed")).toHaveLength(0);
    } finally {
      editor.destroy();
    }
  });

  it("keeps a mark drawn while the reader edits around and inside it", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor, element } = mountEditor(local, { changed: marks });
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();

      const stillMarked = (): Element | null =>
        element.querySelector(`[id="${blocks[1]!}"].ub-changed`);

      // The decoration set is cached and mapped rather than rebuilt per
      // keystroke, so this is the assertion that mapping keeps it on the block.
      editor.commands.insertContentAt(1, "typing");
      await flush();
      expect(stillMarked()).not.toBeNull();

      // Splitting the marked block itself is what mapping alone cannot survive:
      // the decoration would come out spanning both halves and so drawing on
      // neither. The first half keeps the id (block-ids.ts), so it keeps the
      // mark.
      let start = 0;
      editor.state.doc.forEach((node, offset) => {
        if (node.attrs.id === blocks[1]!) start = offset;
      });
      editor.commands.setTextSelection(start + 4);
      editor.commands.splitBlock();
      await flush();
      expect(stillMarked()).not.toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it("dots the outline entry of the section a changed block sits in", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "doc-2", title: "Sections" });
    const preamble = appendBlock(ydoc, { type: "paragraph", text: "Before." });
    const first = appendBlock(ydoc, { type: "heading", text: "One", level: 1 });
    const under = appendBlock(ydoc, { type: "paragraph", text: "Under one." });
    const second = appendBlock(ydoc, { type: "heading", text: "Two", level: 2 });
    const deep = appendBlock(ydoc, { type: "heading", text: "Deep", level: 5 });
    const buried = appendBlock(ydoc, { type: "code", text: "x" });

    // A changed body block dots its section; a changed heading dots itself.
    expect(outlineDots(ydoc, new Set([under]))).toEqual(new Set([first]));
    expect(outlineDots(ydoc, new Set([second]))).toEqual(new Set([second]));
    // A heading too deep to be listed is not an entry, so its blocks fall back
    // to the nearest entry above it.
    expect(outlineDots(ydoc, new Set([buried, deep]))).toEqual(new Set([second]));
    // Nothing above it to dot: the gutter line is the whole signal there.
    expect(outlineDots(ydoc, new Set([preamble]))).toEqual(new Set());
  });
});
