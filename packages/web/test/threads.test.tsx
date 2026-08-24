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

import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
} from "@uberblick/schema";
import { ThreadsPane } from "../src/ui/ThreadsPane.js";
import {
  observeThreads,
  relativeTime,
  threadIdFromTarget,
  threadsFromDoc,
} from "../src/ui/threads.js";
import type { ThreadView } from "../src/ui/threads.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { mountEditor } from "./helpers.js";

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
    // The thread JSON is untouched — nothing cascade-deletes it.
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
  /** The latest rail an observer has seen. */
  function watch(ydoc: Y.Doc): { latest: () => ThreadView[]; stop: () => void } {
    let seen: ThreadView[] = [];
    const stop = observeThreads(ydoc, (threads) => {
      seen = threads;
    });
    return { latest: () => seen, stop };
  }

  /**
   * Every remote change the rail has to notice, on one watcher, in sequence.
   * The three are deliberately different shapes: a thread arriving touches both
   * the annotations map and the text, a reply touches the map alone, and an
   * orphaning touches a *format* one level below the blocks fragment — which is
   * why one subscription could never cover all three.
   */
  it("sees a remote thread, a remote reply and a remote orphaning", () => {
    const { local, remote, blocks } = replicas();
    const watcher = watch(local);
    expect(watcher.latest()).toEqual([]);

    const paragraph = blocks[1]!;
    const thread = createAnnotation(remote, paragraph, 4, 15, "agent-a", "why?");
    expect(watcher.latest().map((view) => view.excerpt)).toEqual(["quick brown"]);

    addComment(remote, thread.id, "ben", "historical accident");
    expect(watcher.latest()[0]?.replyCount).toBe(1);

    editBlock(remote, paragraph, getBlockText(remote, paragraph), "The fox jumps.");
    expect(watcher.latest()[0]).toMatchObject({
      orphaned: true,
      excerpt: "",
      replyCount: 1,
    });

    watcher.stop();
  });

  it("stops reporting once unsubscribed", () => {
    const { local, remote, blocks } = replicas();
    const watcher = watch(local);
    watcher.stop();
    createAnnotation(remote, blocks[1]!, 4, 15, "agent-a", "why?");
    expect(watcher.latest()).toEqual([]);
  });
});

describe("the rail renders its cards", () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView, and the rail scrolls a focused
    // card into view.
    Element.prototype.scrollIntoView = function scrollIntoView() {};
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  /** Only the document matters to the rail: it reads the Y.Doc and nothing else. */
  function stubConnection(ydoc: Y.Doc): RoomConnection {
    return { room: "main/doc-1", ydoc } as unknown as RoomConnection;
  }

  function renderRail(
    ydoc: Y.Doc,
    focused: string | null = null,
  ): { host: HTMLElement; focus: string[]; unmount: () => void } {
    const focus: string[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ThreadsPane
          connection={stubConnection(ydoc)}
          focused={focused}
          onFocus={(threadId) => focus.push(threadId)}
        />,
      );
    });
    return {
      host,
      focus,
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
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

  it("renders nothing at all for a document with no threads", () => {
    const { ydoc } = annotatedDoc();
    const view = renderRail(ydoc);
    expect(view.host.innerHTML).toBe("");
    view.unmount();
  });

  it("marks the focused thread", () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why?");
    const view = renderRail(ydoc, thread.id);
    expect(cards(view.host)[0]?.getAttribute("aria-current")).toBe("true");
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
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
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
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          <ThreadsPane
            connection={{ room: "main/doc-1", ydoc } as unknown as RoomConnection}
            focused={null}
            onFocus={(threadId) => focus.push(threadId)}
          />,
        );
      });
      act(() => host.querySelector<HTMLButtonElement>(".ub-thread")!.click());

      expect(focus).toEqual([thread.id]);
      const highlight = element.querySelector<HTMLElement>(
        `[data-comment-thread="${thread.id}"]`,
      );
      expect(highlight?.classList.contains("ub-comment-flash")).toBe(true);
      expect(scrolled).toContain(highlight);
    } finally {
      act(() => root.unmount());
      host.remove();
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
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          <ThreadsPane
            connection={{ room: "main/doc-1", ydoc } as unknown as RoomConnection}
            focused={null}
            onFocus={() => {}}
          />,
        );
      });
      act(() => host.querySelector<HTMLButtonElement>(".ub-thread")!.click());

      // Nothing to flash, nothing to scroll to — and no crash.
      expect(element.querySelector("[data-comment-thread]")).toBeNull();
      expect(scrolled).toEqual([]);
    } finally {
      act(() => root.unmount());
      host.remove();
      editor.destroy();
      element.remove();
    }
  });
});

describe("a comment's age", () => {
  /**
   * The unit ladder is what is worth pinning — which unit a given age picks, and
   * that it reads as past. The wording itself is `Intl`'s and the reader's
   * locale's, so the expectation is built the same way rather than hard-coding
   * English.
   */
  it("picks the right unit, and falls back to the stored string", () => {
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    expect(relativeTime("2026-08-21T11:59:30.000Z", now)).toBe(
      rtf.format(-30, "second"),
    );
    expect(relativeTime("2026-08-21T09:00:00.000Z", now)).toBe(
      rtf.format(-3, "hour"),
    );
    expect(relativeTime("2026-08-16T12:00:00.000Z", now)).toBe(rtf.format(-5, "day"));
    // Seven days rolls over to the next unit rather than reading "7 days".
    expect(relativeTime("2026-08-14T12:00:00.000Z", now)).toBe(
      rtf.format(-1, "week"),
    );
    // Not a timestamp this reader understands: show what the document holds
    // rather than inventing a date or hiding the comment's byline.
    expect(relativeTime("whenever", now)).toBe("whenever");
  });
});
