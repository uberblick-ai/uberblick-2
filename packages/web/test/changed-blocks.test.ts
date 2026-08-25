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
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { undo } from "y-prosemirror";
import {
  appendBlock,
  deleteBlock,
  editBlock,
  getBlocks,
  initDoc,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import {
  changedBlocks,
  trackChangedBlocks,
} from "../src/editor/changed-blocks.js";
import type { ChangedBlocks } from "../src/editor/changed-blocks.js";
import {
  changedBlocksPluginKey,
  clearWhenSeen,
} from "../src/editor/changed-marks.js";
import { retypeSelectedBlock } from "../src/editor/retype.js";
import { outlineDots } from "../src/ui/outline.js";
import {
  CHANGED_SECTION_LABEL,
  OutlinePane,
} from "../src/ui/OutlinePane.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { mountEditor } from "./helpers.js";

/** Put the caret in the block with this id. */
function caretIn(editor: Editor, blockId: string): void {
  let start = 0;
  editor.state.doc.forEach((node, offset) => {
    if (node.attrs.id === blockId) start = offset;
  });
  editor.commands.setTextSelection(start + 1);
}

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
  listenerCount: () => number;
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
    listenerCount: () => listeners.size,
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

  it("stops listening to the room once the document has arrived", async () => {
    const ydoc = new Y.Doc();
    const room = fakeConnection(ydoc, { connected: true });
    changedBlocks(room.connection);
    expect(room.listenerCount()).toBe(1);

    room.replicaLoaded();
    await flush();
    room.hubSynced();

    // Every later status change asks the same question and gets the same
    // answer, for the life of the room.
    expect(room.listenerCount()).toBe(0);
  });
});

/** Pretend this element has been laid out `height` pixels tall. */
function stubHeight(element: Element, height: number): void {
  element.getBoundingClientRect = () =>
    ({ height, top: 0, bottom: height, left: 0, right: 0, width: 0 }) as DOMRect;
}

/**
 * An IntersectionObserver the test drives, faithful about **thresholds** —
 * which is the property under test.
 *
 * A real observer calls back only when a listed threshold is crossed, and it
 * calls back *at* the crossing. So the geometry a callback ever sees is the
 * geometry at some listed threshold, never the best geometry the block reached
 * in between. Handing the callback the true ratio directly, as this fake used
 * to, is exactly what hid the bug this models: a block that tops out at 0.333
 * with hundredth thresholds is only ever reported at 0.33.
 *
 * Heights come from the elements themselves, the same way the code under test
 * measures them, so a test cannot describe geometry the code disagrees with.
 */
class FakeIntersectionObserver {
  static live: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  readonly root: Element | Document | null;
  readonly thresholds: number[];
  constructor(
    private readonly callback: IntersectionObserverCallback,
    init?: IntersectionObserverInit,
  ) {
    this.root = init?.root ?? null;
    const threshold = init?.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? [...threshold] : [threshold];
    FakeIntersectionObserver.live.push(this);
  }

  /** The live observer watching `id`. */
  static watching(id: string): FakeIntersectionObserver {
    const found = FakeIntersectionObserver.live.find((observer) =>
      [...observer.targets].some((element) => element.id === id),
    );
    if (found === undefined) throw new Error(`not observed: ${id}`);
    return found;
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

  /** Scroll so that `covered` pixels of `id` sit inside the root box. */
  cover(id: string, covered: number): void {
    const target = [...this.targets].find((element) => element.id === id);
    if (target === undefined) throw new Error(`not observed: ${id}`);
    const blockHeight = target.getBoundingClientRect().height;
    const rootHeight =
      this.root instanceof Element ? this.root.getBoundingClientRect().height : 0;
    const trueRatio =
      blockHeight === 0 ? 0 : Math.min(1, Math.max(0, covered / blockHeight));
    const crossed = Math.max(
      ...this.thresholds.filter((step) => step <= trueRatio),
    );
    // At the 0 threshold an observer reports wherever the block actually is —
    // that callback is "it entered", not "it reached a fraction".
    const ratio = crossed > 0 ? crossed : trueRatio;
    this.callback(
      [
        {
          target,
          isIntersecting: trueRatio > 0,
          intersectionRatio: ratio,
          intersectionRect: { height: ratio * blockHeight } as DOMRectReadOnly,
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
    FakeIntersectionObserver.live = [];
    vi.useRealTimers();
  });

  /** The pane is 800px tall; every block is 100px unless a test says otherwise. */
  const PANE_HEIGHT = 800;
  const BLOCK_HEIGHT = 100;

  /**
   * A mounted editor inside a scrolling pane, with real heights on both — the
   * thresholds the code asks for are derived from them, so a test that did not
   * lay anything out would be testing the fallback rather than the rule.
   */
  function watching(heights: Record<number, number> = {}): {
    marks: ChangedBlocks;
    remote: Y.Doc;
    blocks: string[];
    seeing: (id: string) => FakeIntersectionObserver;
    stop: () => void;
  } {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor, element } = mountEditor(local, { changed: marks });
    const pane = document.createElement("div");
    pane.style.overflowY = "auto";
    document.body.appendChild(pane);
    pane.appendChild(element);
    stubHeight(pane, PANE_HEIGHT);
    blocks.forEach((id, index) => {
      const block = document.getElementById(id);
      if (block !== null) stubHeight(block, heights[index] ?? BLOCK_HEIGHT);
    });
    const release = clearWhenSeen(marks, editor, { delayMs: SEEN });
    return {
      marks,
      remote,
      blocks,
      seeing: (id) => FakeIntersectionObserver.watching(id),
      stop: () => {
        release();
        editor.destroy();
        pane.remove();
      },
    };
  }

  it("clears once the block has been fully on screen for the delay", async () => {
    const { marks, remote, blocks, seeing, stop } = watching();
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();

      seeing(blocks[1]!).cover(blocks[1]!, BLOCK_HEIGHT);
      vi.advanceTimersByTime(SEEN - 1);
      expect(marks.has(blocks[1]!)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(marks.has(blocks[1]!)).toBe(false);
    } finally {
      stop();
    }
  });

  it("keeps the mark on a block that was only scrolled past", async () => {
    const { marks, remote, blocks, seeing, stop } = watching();
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();

      seeing(blocks[1]!).cover(blocks[1]!, BLOCK_HEIGHT);
      vi.advanceTimersByTime(SEEN - 1);
      seeing(blocks[1]!).cover(blocks[1]!, BLOCK_HEIGHT * 0.4);
      vi.advanceTimersByTime(SEEN * 3);

      expect(marks.has(blocks[1]!)).toBe(true);
    } finally {
      stop();
    }
  });

  it("clears a block taller than the pane once it fills the pane", async () => {
    // Three panes tall: it tops out at a ratio of 0.333 and can never be
    // "fully" visible, so covering the pane has to count — and the observer has
    // to be *asked* at that geometry, which a fixed threshold ladder cannot
    // promise. The fake only calls back at thresholds the code listed, so this
    // fails unless the threshold was computed from this block's own height.
    const { marks, remote, blocks, seeing, stop } = watching({
      2: PANE_HEIGHT * 3,
    });
    try {
      editBlock(remote, blocks[2]!, CODE, "console.log(2)");
      await flush();

      seeing(blocks[2]!).cover(blocks[2]!, PANE_HEIGHT);
      vi.advanceTimersByTime(SEEN);

      expect(marks.has(blocks[2]!)).toBe(false);
    } finally {
      stop();
    }
  });

  it("starts the read window over when the block changes again", async () => {
    const { marks, remote, blocks, seeing, stop } = watching();
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "First rewrite.");
      await flush();
      seeing(blocks[1]!).cover(blocks[1]!, BLOCK_HEIGHT);
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

  it("measures against the pane the prose scrolls in, not the window", async () => {
    const { remote, blocks, seeing, stop } = watching();
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();
      // A block below the fold of `.ub-pane` is still inside the window's
      // rectangle, so rooting on the window would clear marks nobody saw.
      const pane = document.querySelector<HTMLElement>("div[style*='overflow']");
      expect(seeing(blocks[1]!).root).toBe(pane);
    } finally {
      stop();
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

  it("keeps the marker when this reader re-types the marked block", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor, element } = mountEditor(local, { changed: marks });
    const drawn = (id: string): Element | null =>
      element.querySelector(`[id="${id}"].ub-changed`);
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      editBlock(remote, blocks[2]!, CODE, "console.log(2)");
      await flush();
      expect(drawn(blocks[1]!)).not.toBeNull();

      // A re-type is local, keeps the block id and keeps the block count, so it
      // moves neither the tracker nor anything else this plugin watches — but
      // it replaces the block's markup, which deletes the decoration's own
      // positions. The marker used to vanish here while the outline dot stayed.
      caretIn(editor, blocks[1]!);
      retypeSelectedBlock(editor, "heading", { level: 2 });
      await flush();
      expect(marks.has(blocks[1]!)).toBe(true);
      expect(drawn(blocks[1]!)).not.toBeNull();

      // Same shape, one attribute: setting a code block's language.
      caretIn(editor, blocks[2]!);
      retypeSelectedBlock(editor, "code", { language: "js" });
      await flush();
      expect(marks.has(blocks[2]!)).toBe(true);
      expect(drawn(blocks[2]!)).not.toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it("brings the marker back when a deleted marked block is undone", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor, element } = mountEditor(local, { changed: marks });
    const drawn = (): Element | null =>
      element.querySelector(`[id="${blocks[1]!}"].ub-changed`);
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();
      expect(drawn()).not.toBeNull();

      // Delete it. The tracker still holds the mark — nothing was read — but
      // there is no block left to draw it on, which is correct.
      let start = 0;
      let size = 0;
      editor.state.doc.forEach((node, offset) => {
        if (node.attrs.id === blocks[1]!) {
          start = offset;
          size = node.nodeSize;
        }
      });
      editor.commands.deleteRange({ from: start, to: start + size });
      await flush();
      expect(drawn()).toBeNull();
      expect(marks.has(blocks[1]!)).toBe(true);
      // The set knows it is short of one, which is what buys the recovery
      // below — and what a *remote* deletion deliberately does not leave behind.
      expect(changedBlocksPluginKey.getState(editor.state)?.missing).toBe(1);

      // Undo brings the block back with no decoration to map and nothing for
      // `onRemove` to report — the marker used to stay gone while the tracker
      // and the outline dot went on saying "changed".
      undo(editor.state);
      await flush();
      expect(marks.has(blocks[1]!)).toBe(true);
      expect(drawn()).not.toBeNull();
      expect(changedBlocksPluginKey.getState(editor.state)?.missing).toBe(0);
    } finally {
      editor.destroy();
    }
  });

  it("keeps knowing it is short of a block while the reader types", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor } = mountEditor(local, { changed: marks });
    const missing = (): number | undefined =>
      changedBlocksPluginKey.getState(editor.state)?.missing;
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();
      let start = 0;
      let size = 0;
      editor.state.doc.forEach((node, offset) => {
        if (node.attrs.id === blocks[1]!) {
          start = offset;
          size = node.nodeSize;
        }
      });
      editor.commands.deleteRange({ from: start, to: start + size });
      await flush();
      expect(missing()).toBe(1);

      // Typing cannot put a block back, so it is deliberately taken off the
      // rebuild path — but the set is still short of one, and forgetting that
      // would strand the marker when the delete is undone.
      editor.commands.insertContentAt(1, "typing");
      await flush();
      expect(missing()).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it("drops the mark when somebody else deletes the block", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor } = mountEditor(local, { changed: marks });
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();
      expect(marks.has(blocks[1]!)).toBe(true);

      // Nothing remains to read, so no amount of looking could ever clear this
      // mark. Left tracked it would strand the decoration set one short of
      // itself for the rest of the session.
      deleteBlock(remote, blocks[1]!);
      await flush();

      expect(marks.has(blocks[1]!)).toBe(false);
      expect(marked(marks)).toEqual([]);
      expect(changedBlocksPluginKey.getState(editor.state)?.missing).toBe(0);
    } finally {
      editor.destroy();
    }
  });

  it("leaves the other marks alone when a remote deletion arrives", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor } = mountEditor(local, { changed: marks });
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      editBlock(remote, blocks[2]!, CODE, "console.log(2)");
      await flush();

      deleteBlock(remote, blocks[1]!);
      await flush();

      expect(marked(marks)).toEqual([blocks[2]!]);
      expect(changedBlocksPluginKey.getState(editor.state)?.missing).toBe(0);
    } finally {
      editor.destroy();
    }
  });

  it("names the dot in the outline entry, not only in a tooltip", async () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "doc-3", title: "Rail" });
    appendBlock(ydoc, { type: "heading", text: "Quiet", level: 2 });
    appendBlock(ydoc, { type: "heading", text: "Loud", level: 2 });
    const headings = blockIds(ydoc);

    const room = fakeConnection(ydoc, { connected: false });
    const marks = changedBlocks(room.connection);
    room.replicaLoaded();
    await flush();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    editBlock(peer, headings[1]!, "Loud", "Loud, rewritten");
    relay(peer, ydoc);
    expect(marks.has(headings[1]!)).toBe(true);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(createElement(OutlinePane, { connection: room.connection }));
      });
      const buttons = [...host.querySelectorAll("button")];
      expect(buttons).toHaveLength(2);
      // A colour has no accessible name; the words are in the entry's own text.
      expect(buttons[0]?.textContent).not.toContain(CHANGED_SECTION_LABEL);
      expect(buttons[1]?.textContent).toContain(CHANGED_SECTION_LABEL);
      expect(buttons[1]?.textContent).toContain("Loud, rewritten");
    } finally {
      await act(async () => root.unmount());
      host.remove();
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
