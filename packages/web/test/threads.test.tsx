/**
 * The Threads rail, read side.
 *
 * Three properties are worth pinning, and every one of them is read out of a
 * real Y.Doc built with the schema package — the rail is a join of two things
 * the document already stores, so a fixture of the UI's own making would prove
 * nothing.
 *
 * 1. **A thread is a card.** Quoted range, the block it sits in, every comment
 *    with its author, and the reply count — in reading order, not thread-id
 *    order.
 * 2. **A thread whose range is gone is orphaned, never dropped.** Deleting every
 *    annotated character removes the mark; the conversation survives, the card
 *    dims, and it still names the block the range lived in.
 * 3. **The two ends find each other.** A click inside a highlight resolves to its
 *    thread id, and a click on a card flashes the highlight — except when there
 *    is no highlight left to flash.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "./react-render.js";
import type { ComponentProps, ReactElement } from "react";
import * as Y from "yjs";
import {
  addComment,
  appendBlock,
  createAnnotation,
  deleteBlock,
  editBlock,
  getAnnotation,
  getBlockText,
  getBlocks,
  initDoc,
  getBlocksFragment,
  normalizeLegacyTables,
  setAnnotationResolved,
  tableCellText,
  tableRows,
} from "@uberblick/schema";
import { ThreadsPane } from "../src/ui/ThreadsPane.js";
import {
  commentTimestamp,
  focusThread,
  observeThreads,
  threadCardId,
  threadIdFromTarget,
  threadsFromDoc,
} from "../src/ui/threads.js";
import type { ThreadFocus, ThreadView } from "../src/ui/threads.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { mountEditor } from "./helpers.js";
import { useThreads } from "../src/ui/hooks.js";

/**
 * `ThreadsPane` over a live document — the wiring the app shell provides.
 *
 * The pane takes its threads as a prop now (the shell observes them once, for
 * the rail and the pane-edge handle together), so a test that mutates the
 * document under a mounted rail has to supply the same subscription. This is
 * that subscription, and it is the app's own hook doing it.
 */
function LiveThreadsPane(
  props: Omit<ComponentProps<typeof ThreadsPane>, "threads">,
): ReactElement | null {
  return <ThreadsPane {...props} threads={useThreads(props.connection)} />;
}


/** The workspace these stub room keys sit in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

/** Indices used below: "quick brown" is [4, 15), "jumps" is [20, 25). */
const PARAGRAPH = "The quick brown fox jumps.";

/** A document with a heading and two paragraphs, and the ids of its blocks. */
function annotatedDoc(): { ydoc: Y.Doc; blocks: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "doc-1", title: "Annotated" });
  appendBlock(ydoc, { type: "heading", text: "Sync", level: 2 });
  appendBlock(ydoc, { type: "paragraph", text: PARAGRAPH });
  appendBlock(ydoc, { type: "paragraph", text: "Second paragraph." });
  return { ydoc, blocks: getBlocks(ydoc).map((block) => block.id) };
}

/** Two replicas of one document, wired the way the hub wires them. */
function replicas(): { local: Y.Doc; remote: Y.Doc; blocks: string[] } {
  const { ydoc: local, blocks } = annotatedDoc();
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
  return { local, remote, blocks };
}

describe("a thread over a marked range becomes a card", () => {
  it("quotes cell characters and orders threads by table, row, column and offset", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "cell-threads", title: "Table comments" });
    const id = appendBlock(ydoc, { type: "table", text: "| Alpha beta | Second |\n| --- | --- |\n| Gamma delta | Body |" });
    const body = createAnnotation(ydoc, id, 0, 5, "Reader", "Body", { row: 1, column: 0 });
    const right = createAnnotation(ydoc, id, 0, 6, "Reader", "Right", { row: 0, column: 1 });
    const later = createAnnotation(ydoc, id, 6, 10, "Reader", "Later", { row: 0, column: 0 });
    const first = createAnnotation(ydoc, id, 0, 5, "Reader", "First", { row: 0, column: 0 });
    expect(threadsFromDoc(ydoc).map((thread) => [thread.id, thread.excerpt, thread.orphaned])).toEqual([
      [first.id, "Alpha", false], [later.id, "beta", false], [right.id, "Second", false], [body.id, "Gamma", false],
    ]);
    const { editor, element } = mountEditor(ydoc);
    try {
      const highlight = element.querySelector(`[data-comment-thread="${body.id}"]`)!;
      expect(highlight.closest("td")).not.toBeNull();
      expect(threadIdFromTarget(highlight)).toBe(body.id);
      expect(highlight.textContent).toBe("Gamma");
    } finally { editor.destroy(); ydoc.destroy(); }
  });

  it.each(["characters", "row", "column"])("orphans a cell conversation when its marked %s are deleted and keeps replies", (removed) => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "cell-orphan", title: "Table comments" });
    const id = appendBlock(ydoc, { type: "table", text: "| Header | Second |\n| --- | --- |\n| Alpha | Beta |" });
    const thread = createAnnotation(ydoc, id, 0, 5, "Reader", "Keep conversation", { row: 1, column: 0 });
    const table = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
    const cell = tableRows(table)[1]![0]!;
    ydoc.transact(() => {
      if (removed === "characters") tableCellText(cell)!.delete(0, 5);
      else if (removed === "row") table.delete(1, 1);
      else (table.get(1) as Y.XmlElement).delete(0, 1);
    });
    addComment(ydoc, thread.id, "Reader", "Still here");
    setAnnotationResolved(ydoc, thread.id, true);
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ id: thread.id, blockRef: "Table 1", excerpt: "", orphaned: true, replyCount: 1, resolved: true });
    setAnnotationResolved(ydoc, thread.id, false);
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ orphaned: true, resolved: false });
    ydoc.destroy();
  });

  it("keeps a legacy table conversation as an orphan that can be replied to, resolved and reopened", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "legacy-thread", title: "Tables" });
    const id = appendBlock(ydoc, { type: "paragraph", text: "| Name |\n| --- |\n| Alpha |" });
    const thread = createAnnotation(ydoc, id, 2, 6, "Reader", "Keep this conversation");
    const fragment = getBlocksFragment(ydoc);
    const paragraph = fragment.get(0) as Y.XmlElement;
    const table = new Y.XmlElement("table"); table.setAttribute("id", id);
    table.insert(0, [(paragraph.firstChild as Y.XmlText).clone()]);
    ydoc.transact(() => { fragment.insert(0, [table]); fragment.delete(1, 1); });
    normalizeLegacyTables(ydoc);
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ id: thread.id, blockRef: "Table 1", orphaned: true });
    addComment(ydoc, thread.id, "Reader", "Still replyable");
    setAnnotationResolved(ydoc, thread.id, true);
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ replyCount: 1, resolved: true });
    setAnnotationResolved(ydoc, thread.id, false);
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ replyCount: 1, resolved: false, orphaned: true });
    ydoc.destroy();
  });

  it("carries the quoted range, its block, and every comment", () => {
    const { ydoc, blocks } = annotatedDoc();
    const paragraph = blocks[1]!;
    const thread = createAnnotation(
      ydoc,
      paragraph,
      4,
      15,
      "ben",
      "is this the pangram?",
    );
    addComment(ydoc, thread.id, "agent-a", "close enough");

    const threads = threadsFromDoc(ydoc);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: thread.id,
      blockId: paragraph,
      anchorBlockId: paragraph,
      // The reference is a position, not a uuid: the second block is the
      // document's first paragraph.
      blockRef: "Paragraph 2",
      excerpt: "quick brown",
      orphaned: false,
      resolved: false,
      replyCount: 1,
    });
    expect(threads[0]!.comments.map((comment) => comment.author)).toEqual([
      "ben",
      "agent-a",
    ]);
  });

  it("renders the range as a highlight in the prose", () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why?");
    const { editor, element } = mountEditor(ydoc);
    try {
      const highlight = element.querySelector<HTMLElement>(
        `[data-comment-thread="${thread.id}"]`,
      );
      expect(highlight).not.toBeNull();
      expect(highlight?.classList.contains("ub-comment")).toBe(true);
      expect(highlight?.textContent).toBe("quick brown");
    } finally {
      editor.destroy();
    }
  });

  it("lists threads in reading order, not thread-id order", () => {
    const { ydoc, blocks } = annotatedDoc();
    const later = createAnnotation(ydoc, blocks[2]!, 0, 6, "ben", "next block");
    const first = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "first");
    const second = createAnnotation(ydoc, blocks[1]!, 20, 25, "ben", "second");
    expect(threadsFromDoc(ydoc).map((thread) => thread.id)).toEqual([
      first.id,
      second.id,
      later.id,
    ]);
  });
});

describe("a thread whose range is deleted is orphaned, not dropped", () => {
  it("keeps its text and says which block the range lived in", () => {
    const { ydoc, blocks } = annotatedDoc();
    const paragraph = blocks[1]!;
    const thread = createAnnotation(ydoc, paragraph, 4, 15, "ben", "why quick?");
    addComment(ydoc, thread.id, "agent-a", "no idea");

    // Delete every annotated character, the way an editor keystroke or an
    // agent's `edit_block` does: the mark goes with the text.
    editBlock(ydoc, paragraph, getBlockText(ydoc, paragraph), "The fox jumps.");

    const [card] = threadsFromDoc(ydoc);
    expect(card).toMatchObject({
      id: thread.id,
      orphaned: true,
      anchorBlockId: null,
      excerpt: "",
      blockRef: "Paragraph 2",
      replyCount: 1,
    });
    expect(card?.comments.map((comment) => comment.text)).toEqual([
      "why quick?",
      "no idea",
    ]);
    // The thread record is untouched — nothing cascade-deletes it.
    expect(getAnnotation(ydoc, thread.id)).not.toBeNull();
  });

  it("survives its whole block being deleted", () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why quick?");
    deleteBlock(ydoc, blocks[1]!);

    const [card] = threadsFromDoc(ydoc);
    expect(card).toMatchObject({
      id: thread.id,
      orphaned: true,
      blockRef: "deleted block",
    });
    expect(card?.comments).toHaveLength(1);
  });
});

describe("the rail follows the document", () => {
  /**
   * The observer coalesces its two subscriptions onto a microtask, so a
   * transaction that touches both the annotations map and the text recomputes
   * the rail once. Reading it back therefore means letting that microtask run.
   */
  const flush = (): Promise<void> => Promise.resolve();

  /** The latest rail an observer has seen, and how many times it was told. */
  function watch(ydoc: Y.Doc): {
    latest: () => ThreadView[];
    reads: () => number;
    stop: () => void;
  } {
    let seen: ThreadView[] = [];
    let reads = 0;
    const stop = observeThreads(ydoc, (threads) => {
      seen = threads;
      reads += 1;
    });
    return { latest: () => seen, reads: () => reads, stop };
  }

  /**
   * Every remote change the rail has to notice, on one watcher, in sequence.
   * The three are deliberately different shapes: a thread arriving touches both
   * the annotations map and the text; a reply touches a Y.Array nested one level
   * below that map, and none of its keys; and an orphaning touches a *format*
   * one level below the blocks fragment — which is why one shallow subscription
   * could never cover all three.
   */
  it("sees a remote thread, a remote reply and a remote orphaning", async () => {
    const { local, remote, blocks } = replicas();
    const watcher = watch(local);
    expect(watcher.latest()).toEqual([]);

    const paragraph = blocks[1]!;
    const thread = createAnnotation(remote, paragraph, 4, 15, "agent-a", "why?");
    await flush();
    expect(watcher.latest().map((view) => view.excerpt)).toEqual(["quick brown"]);
    // One recompute, not two: creating a thread writes the map and the mark.
    expect(watcher.reads()).toBe(2);

    addComment(remote, thread.id, "ben", "historical accident");
    await flush();
    expect(watcher.latest()[0]?.replyCount).toBe(1);

    editBlock(remote, paragraph, getBlockText(remote, paragraph), "The fox jumps.");
    await flush();
    expect(watcher.latest()[0]).toMatchObject({
      orphaned: true,
      excerpt: "",
      replyCount: 1,
    });

    watcher.stop();
  });

  it("stops reporting once unsubscribed, including a recompute already queued", async () => {
    const { local, remote, blocks } = replicas();
    const watcher = watch(local);
    createAnnotation(remote, blocks[1]!, 4, 15, "agent-a", "why?");
    // Unsubscribing between the change and the microtask that would read it.
    watcher.stop();
    await flush();
    expect(watcher.latest()).toEqual([]);
    expect(watcher.reads()).toBe(1);
  });
});

describe("the rail renders its cards", () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView, and the rail scrolls a focused
    // card into view.
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  });

  /** Only the document matters to the rail: it reads the Y.Doc and nothing else. */
  function stubConnection(ydoc: Y.Doc): RoomConnection {
    return {
      room: `${WORKSPACE}/doc-1`,
      ydoc,
      status: { writable: true },
    } as unknown as RoomConnection;
  }

  function renderRail(
    ydoc: Y.Doc,
    focused: ThreadFocus | null = null,
  ): {
    host: HTMLElement;
    focus: string[];
    refocus: (next: ThreadFocus | null) => void;
    unmount: () => void;
  } {
    const focus: string[] = [];
    // Refocusing keeps the same room source; it does not replace the connection.
    const connection = stubConnection(ydoc);
    const tree = (next: ThreadFocus | null): ReactElement => (
      <LiveThreadsPane
        connection={connection}
        focused={next}
        author="ben"
        onFocus={(threadId) => focus.push(threadId)}
      />
    );
    const view = render(tree(focused));
    return {
      host: view.container,
      focus,
      refocus: (next) => view.rerender(tree(next)),
      unmount: view.unmount,
    };
  }

  function cards(host: HTMLElement): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>(".ub-thread")];
  }

  function text(card: Element, selector: string): string | null {
    return card.querySelector(selector)?.textContent ?? null;
  }

  it("shows the excerpt, the block reference, the comments and the reply count", () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why quick?");
    addComment(ydoc, thread.id, "agent-a", "no idea");

    const view = renderRail(ydoc);
    const card = cards(view.host)[0];
    expect(card).toBeDefined();
    expect(text(card!, ".ub-thread-excerpt")).toBe("quick brown");
    expect(text(card!, ".ub-thread-ref")).toBe("Paragraph 2");
    expect(
      [...card!.querySelectorAll(".ub-thread-author")].map((el) => el.textContent),
    ).toEqual(["ben", "agent-a"]);
    expect(
      [...card!.querySelectorAll(".ub-thread-text")].map((el) => el.textContent),
    ).toEqual(["why quick?", "no idea"]);
    expect(text(card!, ".ub-thread-replies")).toBe("1 reply");
    expect(card!.querySelector(".ub-chip-orphaned")).toBeNull();
    view.unmount();
  });

  it("ages comment and reply bylines with the rail's clock", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 27, 12);
    try {
      vi.setSystemTime(now - 60_000);
      const { ydoc, blocks } = annotatedDoc();
      const thread = createAnnotation(
        ydoc,
        blocks[1]!,
        4,
        15,
        "ben",
        "why quick?",
      );
      vi.setSystemTime(now);
      addComment(ydoc, thread.id, "agent-a", "no idea");

      const rail = renderRail(ydoc);
      try {
        const labels = (): string[] =>
          [...rail.host.querySelectorAll(".ub-thread-byline time")].map(
            (time) => time.textContent ?? "",
          );
        expect(labels()).toEqual(["1 minute ago", "just now"]);
        expect(
          [...rail.host.querySelectorAll(".ub-thread-byline time")].every(
            (time) =>
              time.getAttribute("dateTime") !== null &&
              time.getAttribute("title") !== null,
          ),
        ).toBe(true);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(labels()).toEqual(["2 minutes ago", "1 minute ago"]);
      } finally {
        rail.unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The reply arrives inside the thread's own nested array, which a shallow
   * observer on the annotations map does not see — so a card open on screen
   * would keep showing the conversation it was mounted with until something
   * else touched the map's keys or the text. Nothing is reopened here: the same
   * mounted rail is read again.
   */
  it("shows a reply that arrives from a remote replica, live", async () => {
    const { local, remote, blocks } = replicas();
    const thread = createAnnotation(local, blocks[1]!, 4, 15, "ben", "why quick?");
    const view = renderRail(local);
    expect(
      [...cards(view.host)[0]!.querySelectorAll(".ub-thread-text")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["why quick?"]);

    await act(async () => {
      addComment(remote, thread.id, "agent-a", "no idea");
      // Let the observer's coalescing microtask run before React reads back.
      await Promise.resolve();
    });

    const card = cards(view.host)[0];
    expect(
      [...card!.querySelectorAll(".ub-thread-text")].map((el) => el.textContent),
    ).toEqual(["why quick?", "no idea"]);
    expect(text(card!, ".ub-thread-replies")).toBe("1 reply");
    view.unmount();
  });

  it("renders nothing at all for a document with no threads", () => {
    const { ydoc } = annotatedDoc();
    const view = renderRail(ydoc);
    expect(view.host.innerHTML).toBe("");
    view.unmount();
  });

  it("marks the focused thread", () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why?");
    const view = renderRail(ydoc, focusThread(null, thread.id));
    expect(cards(view.host)[0]?.getAttribute("aria-current")).toBe("true");
    view.unmount();
  });

  /**
   * Clicking a highlight whose card is already focused still has to bring the
   * card back — the rail has scrolled since, which is exactly why the reader
   * clicked again. The card's id alone cannot express that, so the focus carries
   * a click counter.
   */
  it("scrolls the card back into view when the same thread is selected twice", () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };

    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why?");
    // Mounted with nothing focused, the way the rail is when the reader arrives.
    const view = renderRail(ydoc);
    const card = view.host.querySelector(`#${CSS.escape(threadCardId(thread.id))}`);
    expect(card).not.toBeNull();
    expect(scrolled).toEqual([]);

    const first = focusThread(null, thread.id);
    view.refocus(first);
    expect(scrolled).toEqual([card]);

    view.refocus(focusThread(first, thread.id));
    expect(scrolled).toEqual([card, card]);
    view.unmount();
  });

  it("chips an orphaned thread and keeps its text", () => {
    const { ydoc, blocks } = annotatedDoc();
    const paragraph = blocks[1]!;
    createAnnotation(ydoc, paragraph, 4, 15, "ben", "why quick?");
    editBlock(ydoc, paragraph, getBlockText(ydoc, paragraph), "The fox jumps.");

    const view = renderRail(ydoc);
    const card = cards(view.host)[0];
    expect(text(card!, ".ub-chip-orphaned")).toBe("orphaned");
    expect(text(card!, ".ub-thread-text")).toBe("why quick?");
    // No quote to show, and the card says where the range was instead.
    expect(card!.querySelector(".ub-thread-excerpt")).toBeNull();
    expect(text(card!, ".ub-thread-gone")).toContain("Paragraph 2");
    view.unmount();
  });
});

describe("a highlight and its card focus each other", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  });

  it("resolves a click inside a highlight to its thread id", () => {
    const { ydoc } = annotatedDoc();
    // Bold *inside* the annotated range, so the click target is a descendant of
    // the highlight rather than the highlight itself — which is the case
    // `closest` exists for.
    appendBlock(ydoc, {
      type: "paragraph",
      inline: [
        { text: "before ", marks: {} },
        { text: "loud", marks: { bold: true } },
        { text: " after", marks: {} },
      ],
    });
    const bolded = getBlocks(ydoc).at(-1)!.id;
    const thread = createAnnotation(ydoc, bolded, 7, 11, "ben", "shouting?");

    const { editor, element } = mountEditor(ydoc);
    try {
      const highlight = element.querySelector<HTMLElement>(
        `[data-comment-thread="${thread.id}"]`,
      );
      expect(highlight).not.toBeNull();
      const target = highlight!.querySelector("*") ?? highlight!;
      expect(threadIdFromTarget(target)).toBe(thread.id);

      // A click that landed outside every highlight focuses nothing.
      expect(threadIdFromTarget(element.querySelector(".ub-heading"))).toBeNull();
      expect(threadIdFromTarget(null)).toBeNull();
    } finally {
      editor.destroy();
      element.remove();
    }
  });

  it("flashes the prose when a card is clicked, and scrolls to it", () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };

    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why?");
    const { editor, element } = mountEditor(ydoc);
    const focus: string[] = [];
    const view = render(
      <LiveThreadsPane
        connection={{ room: `${WORKSPACE}/doc-1`, ydoc } as unknown as RoomConnection}
        focused={null}
        author="ben"
        onFocus={(threadId) => focus.push(threadId)}
      />,
    );
    const host = view.container;
    try {
      act(() => host.querySelector<HTMLButtonElement>(".ub-thread")!.click());

      expect(focus).toEqual([thread.id]);
      const highlight = element.querySelector<HTMLElement>(
        `[data-comment-thread="${thread.id}"]`,
      );
      expect(highlight?.classList.contains("ub-comment-flash")).toBe(true);
      expect(scrolled).toContain(highlight);
    } finally {
      view.unmount();
      editor.destroy();
      element.remove();
    }
  });

  it("scrolls nowhere when the clicked thread is orphaned", () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };

    const { ydoc, blocks } = annotatedDoc();
    const paragraph = blocks[1]!;
    createAnnotation(ydoc, paragraph, 4, 15, "ben", "why?");
    editBlock(ydoc, paragraph, getBlockText(ydoc, paragraph), "The fox jumps.");
    const { editor, element } = mountEditor(ydoc);
    const view = render(
      <LiveThreadsPane
        connection={{ room: `${WORKSPACE}/doc-1`, ydoc } as unknown as RoomConnection}
        focused={null}
        author="ben"
        onFocus={() => {}}
      />,
    );
    const host = view.container;
    try {
      act(() => host.querySelector<HTMLButtonElement>(".ub-thread")!.click());

      // Nothing to flash, nothing to scroll to — and no crash.
      expect(element.querySelector("[data-comment-thread]")).toBeNull();
      expect(scrolled).toEqual([]);
    } finally {
      view.unmount();
      editor.destroy();
      element.remove();
    }
  });
});

describe("a comment's timestamp fallback", () => {
  /**
   * The contract, and not the formatting: the wording is `Intl`'s and the
   * reader's locale's, so the expectation is built the same way rather than
   * hard-coding a locale's punctuation.
   */
  it("uses the shared rule, and shows anything else verbatim with no machine value", () => {
    const now = Date.UTC(2026, 7, 27, 12);
    const iso = "2026-08-21T12:00:00.000Z";
    expect(commentTimestamp(iso, now)).toEqual({
      label: "6 days ago",
      title: new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(Date.parse(iso)),
      dateTime: iso,
    });
    // Not a timestamp this reader understands: show what the document holds
    // rather than inventing a date or hiding the comment's byline — and emit no
    // `dateTime`, which an absent key is exactly how React drops the attribute.
    expect(commentTimestamp("whenever", now)).toEqual({ label: "whenever" });
  });
});
