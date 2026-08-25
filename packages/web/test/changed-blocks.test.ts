/**
 * Changed-block indicators (#120).
 *
 * Four properties, all read out of a real Y.Doc with a second replica wired the
 * way the hub wires one — because "remote" is a property of the transaction
 * that delivered a change, and a fixture of the UI's own making cannot have
 * one.
 *
 * 1. **Somebody else's edit marks; yours never does.** Whichever way you make
 *    it — through the editor, or straight into the document.
 * 2. **The document arriving is not a change.** Hydration from the local
 *    replica and the hub's first sync leave nothing marked; the edit after
 *    them does.
 * 3. **Reading clears.** Fully on screen for the delay clears the mark;
 *    scrolling past it does not.
 * 4. **Both halves of the signal reach the reader.** The gutter class lands on
 *    every block type including the two ProseMirror renders through a NodeView,
 *    and the outline dot lands on the entry for the section that changed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock, editBlock, getBlocks, initDoc } from "@uberblick/schema";
import {
  changedBlocks,
  trackChangedBlocks,
} from "../src/editor/changed-blocks.js";
import { clearWhenSeen } from "../src/editor/changed-marks.js";
import { outlineDots } from "../src/ui/outline.js";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { mountEditor } from "./helpers.js";

const PARAGRAPH = "The quick brown fox jumps.";
const CODE = "console.log(1)";
const MERMAID = "graph TD; a-->b";

/** Heading, paragraph, code, mermaid — one of every block type the palette has. */
function seeded(): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "doc-1", title: "Changed" });
  appendBlock(ydoc, { type: "heading", text: "Sync", level: 2 });
  appendBlock(ydoc, { type: "paragraph", text: PARAGRAPH });
  appendBlock(ydoc, { type: "code", text: CODE, language: "ts" });
  appendBlock(ydoc, { type: "mermaid", text: MERMAID });
  return ydoc;
}

/** Two replicas of one document, wired the way the hub wires them. */
function replicas(): { local: Y.Doc; remote: Y.Doc; blocks: string[] } {
  const local = seeded();
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
  return { local, remote, blocks: getBlocks(local).map((block) => block.id) };
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

    expect([...marks.ids()]).toEqual([blocks[1]!]);
  });

  it("marks a block a remote client appended", () => {
    const { local, remote } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();

    const fresh = appendBlock(remote, { type: "paragraph", text: "New." });

    expect([...marks.ids()]).toEqual([fresh]);
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

      expect([...marks.ids()]).toEqual([]);
    } finally {
      editor.destroy();
    }
  });
});

/** The parts of a room connection the tracker's arming actually reads. */
function fakeConnection(ydoc: Y.Doc): {
  connection: RoomConnection;
  replicaLoaded: () => void;
  hubSynced: () => void;
} {
  let resolveLocal: () => void = () => {};
  const whenLocalReplicaLoaded = new Promise<void>((resolve) => {
    resolveLocal = resolve;
  });
  const status: RoomStatus = {
    connected: true,
    synced: false,
    unsyncedChanges: 0,
    localReplicaLoaded: false,
  };
  const listeners = new Set<(next: RoomStatus) => void>();
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
    hubSynced: () => {
      status.synced = true;
      for (const listener of listeners) listener({ ...status });
    },
  };
}

describe("the document arriving is not a change", () => {
  it("marks nothing through hydration and the hub's first sync, then marks", async () => {
    const source = seeded();
    const blocks = getBlocks(source).map((block) => block.id);
    const ydoc = new Y.Doc();
    const { connection, replicaLoaded, hubSynced } = fakeConnection(ydoc);
    const marks = changedBlocks(connection);

    // The local replica replays the document it had cached…
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source));
    replicaLoaded();
    await flush();

    // …and then the hub's first sync brings whatever changed while this reader
    // was away. Both are the document arriving, not news about it.
    editBlock(source, blocks[0]!, "Sync", "Sync, revised");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source, Y.encodeStateVector(ydoc)));
    hubSynced();
    expect([...marks.ids()]).toEqual([]);

    // An edit after that is news.
    editBlock(source, blocks[1]!, PARAGRAPH, "Rewritten while you watched.");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source, Y.encodeStateVector(ydoc)));
    expect([...marks.ids()]).toEqual([blocks[1]!]);
  });
});

/** An IntersectionObserver the test drives, since jsdom has none. */
class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | null = null;
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
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
  /** Report `id` as `ratio` of the way into a 800px-tall viewport. */
  report(id: string, ratio: number): void {
    const target = [...this.targets].find((element) => element.id === id);
    if (target === undefined) throw new Error(`not observed: ${id}`);
    this.callback(
      [
        {
          target,
          isIntersecting: ratio > 0,
          intersectionRatio: ratio,
          intersectionRect: { height: 100 * ratio } as DOMRectReadOnly,
          rootBounds: { height: 800 } as DOMRectReadOnly,
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

  it("clears once the block has been fully on screen for the delay", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor } = mountEditor(local, { changed: marks });
    const stop = clearWhenSeen(marks, editor, { delayMs: SEEN });
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();
      const observer = FakeIntersectionObserver.latest!;

      observer.report(blocks[1]!, 1);
      vi.advanceTimersByTime(SEEN - 1);
      expect(marks.has(blocks[1]!)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(marks.has(blocks[1]!)).toBe(false);
    } finally {
      stop();
      editor.destroy();
    }
  });

  it("keeps the mark on a block that was only scrolled past", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor } = mountEditor(local, { changed: marks });
    const stop = clearWhenSeen(marks, editor, { delayMs: SEEN });
    try {
      editBlock(remote, blocks[1]!, PARAGRAPH, "Rewritten by an agent.");
      await flush();
      const observer = FakeIntersectionObserver.latest!;

      observer.report(blocks[1]!, 1);
      vi.advanceTimersByTime(SEEN - 1);
      observer.report(blocks[1]!, 0.4);
      vi.advanceTimersByTime(SEEN * 3);

      expect(marks.has(blocks[1]!)).toBe(true);
    } finally {
      stop();
      editor.destroy();
    }
  });
});

describe("the mark reaches both places a reader looks", () => {
  it("puts the gutter class on every block type, NodeViews included", async () => {
    const { local, remote, blocks } = replicas();
    const marks = trackChangedBlocks(local);
    marks.start();
    const { editor, element } = mountEditor(local, { changed: marks });
    try {
      editBlock(remote, blocks[2]!, CODE, "console.log(2)");
      editBlock(remote, blocks[3]!, MERMAID, "graph TD; a-->c");
      await flush();

      // `code` and `mermaid` render through a NodeView that owns its own DOM;
      // the decoration still lands on that element, because ProseMirror applies
      // it rather than the view.
      expect(element.querySelector("pre.ub-code.ub-changed")).not.toBeNull();
      expect(element.querySelector("div.ub-mermaid.ub-changed")).not.toBeNull();
      expect(element.querySelectorAll(".ub-changed")).toHaveLength(2);

      marks.clear(blocks[2]!);
      marks.clear(blocks[3]!);
      await flush();
      expect(element.querySelectorAll(".ub-changed")).toHaveLength(0);
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
