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
import { within } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import * as Y from "yjs";
import {
  addComment,
  appendBlock,
  COMMENT_MARK,
  createAnnotation,
  deleteBlock,
  deleteComment,
  editBlock,
  editComment,
  getAnnotation,
  getAnnotationCommentId,
  getBlock,
  getBlocks,
  initDoc,
  getBlocksFragment,
  normalizeLegacyTables,
  setAnnotationResolved,
  tableCellText,
  tableRows,
} from "@uberblick/schema";
import { ThreadsPane } from "../src/ui/comments/ThreadsPane.js";
import {
  blockRefLabel,
  commentTimestamp,
  focusThread,
  observeThreads,
  threadIdFromTarget,
  threadsFromDoc,
  flashThreadHighlight,
  selectedHighlightCss,
} from "../src/ui/comments/threads.js";
import type { ThreadFocus, ThreadView } from "../src/ui/comments/threads.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { mountEditor } from "./helpers.js";
import { useThreads } from "../src/ui/hooks.js";

/**
 * `ThreadsPane` over a live document — the wiring the app shell provides.
 *
 * The pane takes its threads as a prop (the shell observes them once, for
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
  it("names chart-table threads consistently and tolerates incomplete source", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "table-view-threads", title: "View comments" });
    const source = '{"version":1,"type":"table","collection":"records","columns":[{"field":"value"}]}';
    const id = appendBlock(ydoc, { type: "chart", text: source });
    createAnnotation(ydoc, id, 0, 1, "Reader", "Table mapping");
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ blockRef: "Data table 1" });
    expect(blockRefLabel("chart", 0, source)).toBe("Data table 1");
    expect(blockRefLabel("chart", 0, '{"type":"line"}')).toBe("Line chart 1");
    expect(blockRefLabel("chart", 0, '{"type":')).toBe("Line chart 1");
    expect(blockRefLabel("table", 0, source)).toBe("Table 1");
    editBlock(ydoc, id, source, source.replace('"table"', '"line"'));
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ blockRef: "Line chart 1" });
    ydoc.destroy();
  });

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

  it("leaves a returned mark for a deleted conversation as ordinary text that accepts a new comment", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "Reader", "Remove me", undefined, { account: "reader", kind: "person" });
    const { editor, element } = mountEditor(ydoc);
    try {
      const commentId = getAnnotationCommentId(ydoc, thread.id, 0)!;
      await act(async () => deleteComment(ydoc, thread.id, commentId, "reader"));
      const block = getBlocksFragment(ydoc).get(1) as Y.XmlElement;
      const text = block.firstChild as Y.XmlText;
      await act(async () => text.format(4, 11, { [COMMENT_MARK]: { threadId: thread.id } }));
      const stale = element.querySelector<HTMLElement>(`[data-comment-thread="${thread.id}"]`)!;
      expect(stale).not.toBeNull();
      expect(stale.classList.contains("ub-comment")).toBe(false);
      expect(stale.hasAttribute("tabindex")).toBe(false);
      expect(stale.hasAttribute("role")).toBe(false);
      expect(threadIdFromTarget(stale)).toBeNull();
      flashThreadHighlight(thread.id);
      expect(stale.classList.contains("ub-comment-flash")).toBe(false);
      const selectedSelector = selectedHighlightCss(thread.id).split("{")[0]!;
      expect(stale.matches(selectedSelector)).toBe(false);
      expect(threadsFromDoc(ydoc)).toEqual([]);
      let replacement = "";
      await act(async () => { replacement = createAnnotation(ydoc, blocks[1]!, 4, 15, "Reader", "New conversation").id; });
      expect(element.querySelector(`.ub-comment[data-comment-thread="${replacement}"]`)).not.toBeNull();
    } finally { editor.destroy(); ydoc.destroy(); }
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

  it("keeps the recorded anchor ahead of pasted marks, then follows the first surviving block", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "pasted-thread", title: "Pasted anchor" });
    const earlier = appendBlock(ydoc, { type: "paragraph", text: "Pasted words" });
    const middle = appendBlock(ydoc, { type: "paragraph", text: "Middle words" });
    const recorded = appendBlock(ydoc, { type: "paragraph", text: "Recorded words" });
    const thread = createAnnotation(ydoc, recorded, 0, 8, "Reader", "Original conversation");
    const other = createAnnotation(ydoc, middle, 0, 6, "Reader", "Middle conversation");
    const fragment = getBlocksFragment(ydoc);
    const pastedText = (fragment.get(0) as Y.XmlElement).firstChild as Y.XmlText;
    const recordedText = (fragment.get(2) as Y.XmlElement).firstChild as Y.XmlText;
    pastedText.format(0, 6, { [COMMENT_MARK]: { threadId: thread.id } });
    expect(threadsFromDoc(ydoc).map(({ id, excerpt, anchorBlockId }) => [id, excerpt, anchorBlockId])).toEqual([
      [other.id, "Middle", middle], [thread.id, "Recorded", recorded],
    ]);

    recordedText.format(0, 8, { [COMMENT_MARK]: null });
    expect(threadsFromDoc(ydoc).map(({ id, excerpt, anchorBlockId }) => [id, excerpt, anchorBlockId])).toEqual([
      [thread.id, "Pasted", earlier], [other.id, "Middle", middle],
    ]);
    expect(getAnnotation(ydoc, thread.id)?.blockId).toBe(recorded);
    pastedText.format(0, 6, { [COMMENT_MARK]: null });
    expect(threadsFromDoc(ydoc).find(({ id }) => id === thread.id)).toMatchObject({
      blockId: recorded, anchorBlockId: null, orphaned: true, excerpt: "", blockRef: "Paragraph 3",
    });
    ydoc.destroy();
  });

  it("quotes the first-to-last marked span with embeds occupying their offset positions", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "span-thread", title: "Span excerpts" });
    const id = appendBlock(ydoc, { type: "paragraph", text: "alpha gap omega" });
    const thread = createAnnotation(ydoc, id, 0, 5, "Reader", "Separated marks");
    const text = (getBlocksFragment(ydoc).get(0) as Y.XmlElement).firstChild as Y.XmlText;
    text.format(10, 5, { [COMMENT_MARK]: { threadId: thread.id } });
    text.insertEmbed(6, { kind: "gap" }, {});
    text.insertEmbed(0, { kind: "prefix" }, {});
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({ excerpt: "alpha \uFFFCgap omega", orphaned: false });
    ydoc.destroy();
  });

  it("follows text moved into a different table's first marked cell", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "moved-cell-thread", title: "Moved cells" });
    const recorded = appendBlock(ydoc, { type: "table", text: "| Header |\n| --- |\n| Original |" });
    const destination = appendBlock(ydoc, { type: "table", text: "| First | Second |\n| --- | --- |\n| Last | Body |" });
    const thread = createAnnotation(ydoc, recorded, 0, 8, "Reader", "Moved cell", { row: 1, column: 0 });
    const fragment = getBlocksFragment(ydoc);
    const originalCell = tableCellText(tableRows(fragment.get(0) as Y.XmlElement)[1]![0]!)!;
    const cells = tableRows(fragment.get(1) as Y.XmlElement);
    const mark = { [COMMENT_MARK]: { threadId: thread.id } };
    tableCellText(cells[0]![1]!)!.format(0, 6, mark);
    tableCellText(cells[1]![0]!)!.format(0, 4, mark);
    originalCell.delete(0, originalCell.length);
    expect(threadsFromDoc(ydoc)[0]).toMatchObject({
      blockId: recorded, anchorBlockId: destination, blockRef: "Table 2", excerpt: "Second", orphaned: false,
    });
    ydoc.destroy();
  });

  it("keeps an Enter-split thread beside its new block without changing its record", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "split-thread", title: "Split paragraph" });
    const recorded = appendBlock(ydoc, { type: "paragraph", text: "Hello brave world" });
    const thread = createAnnotation(ydoc, recorded, 6, 11, "Reader", "Surviving split");
    const { editor } = mountEditor(ydoc);
    try {
      editor.commands.setTextSelection(7);
      editor.commands.keyboardShortcut("Enter");
      const blocks = getBlocks(ydoc);
      expect(blocks.map(({ text }) => text)).toEqual(["Hello ", "brave world"]);
      expect(blocks[1]!.id).not.toBe(recorded);
      expect(threadsFromDoc(ydoc)[0]).toMatchObject({
        id: thread.id, blockId: recorded, anchorBlockId: blocks[1]!.id,
        blockRef: "Paragraph 2", excerpt: "brave", orphaned: false,
      });
      expect(getAnnotation(ydoc, thread.id)?.blockId).toBe(recorded);
    } finally { editor.destroy(); ydoc.destroy(); }
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
    editBlock(ydoc, paragraph, getBlock(ydoc, paragraph)!.text, "The fox jumps.");

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

    editBlock(remote, paragraph, getBlock(remote, paragraph)!.text, "The fox jumps.");
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
        onFocus={(threadId) => { if (threadId !== null) focus.push(threadId); }}
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

  function cards(host: HTMLElement): HTMLElement[] {
    return within(within(host).getByRole("region", { name: "Comments" }))
      .getAllByRole("group", { name: "Comment" });
  }

  function text(card: HTMLElement, value: string | RegExp): string | null {
    return within(card).queryByText(value)?.textContent ?? null;
  }

  /** Each comment's time scopes its author and body, including unexpected comments. */
  function commentTexts(card: HTMLElement, expected: RegExp): (string | null)[] {
    return Array.from(card.querySelectorAll(".ub-thread-comment")).map((comment) =>
      within(comment as HTMLElement).getByText(expected).textContent,
    );
  }

  it("shows the opening comment and reply count, expanding the selected conversation without anchor chrome", () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why quick?");
    addComment(ydoc, thread.id, "agent-a", "no idea");

    const view = renderRail(ydoc);
    const card = cards(view.host)[0];
    expect(card).toBeDefined();
    expect(text(card!, "quick brown")).toBeNull();
    expect(text(card!, "Paragraph 2")).toBeNull();
    expect(commentTexts(card!, /^(ben|agent-a)$/)).toEqual(["ben"]);
    expect(commentTexts(card!, /^(why quick\?|no idea)$/)).toEqual(["why quick?"]);
    expect(text(card!, "1 reply")).toBe("1 reply");
    view.refocus(focusThread(null, thread.id));
    expect(
      commentTexts(card!, /^(ben|agent-a)$/),
    ).toEqual(["ben", "agent-a"]);
    expect(
      commentTexts(card!, /^(why quick\?|no idea)$/),
    ).toEqual(["why quick?", "no idea"]);
    expect(text(card!, "1 reply")).toBeNull();
    expect(within(card!).queryByText("orphaned")).toBeNull();
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

      const rail = renderRail(ydoc, focusThread(null, thread.id));
      try {
        const labels = (): string[] =>
          within(cards(rail.host)[0]!).getAllByRole("time").map(
            (time) => time.textContent ?? "",
          );
        expect(labels()).toEqual(["Updated just now", "just now"]);
        expect(
          within(cards(rail.host)[0]!).getAllByRole("time").every(
            (time) =>
              time.getAttribute("dateTime") !== null &&
              time.getAttribute("title") !== null,
          ),
        ).toBe(true);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(labels()).toEqual(["Updated 1 minute ago", "1 minute ago"]);
      } finally {
        rail.unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates the opener from an earlier comment's edit time and keeps the comment key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime("2026-10-27T10:00:00Z");
      const { ydoc, blocks } = annotatedDoc();
      const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "Ben", "Opening", undefined, { kind: "person", account: "bk-one" });
      vi.setSystemTime("2026-10-27T10:05:00Z");
      addComment(ydoc, thread.id, "Peer", "Reply");
      const priorKey = threadsFromDoc(ydoc)[0]!.comments[0]!.key;
      vi.setSystemTime("2026-10-27T10:10:00Z");
      const view = renderRail(ydoc, focusThread(null, thread.id));
      try {
        expect(within(view.host).getAllByRole("time")[0]!.getAttribute("dateTime")).toBe("2026-10-27T10:05:00.000Z");
        await act(async () => editComment(ydoc, thread.id, getAnnotationCommentId(ydoc, thread.id, 0)!, "bk-one", "Revised opening"));
        expect(threadsFromDoc(ydoc)[0]!.comments[0]!.key).toBe(priorKey);
        expect(within(view.host).getAllByRole("time")[0]!.getAttribute("dateTime")).toBe("2026-10-27T10:10:00.000Z");
        expect(within(view.host).getByText("(edited)")).toBeDefined();
        expect(view.host.querySelectorAll(".ub-comment-edited")).toHaveLength(1);
      } finally { view.unmount(); ydoc.destroy(); }
    } finally { vi.useRealTimers(); }
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
    const view = renderRail(local, focusThread(null, thread.id));
    expect(
      commentTexts(cards(view.host)[0]!, /^why quick\?$/),
    ).toEqual(["why quick?"]);

    await act(async () => {
      addComment(remote, thread.id, "agent-a", "no idea");
      // Let the observer's coalescing microtask run before React reads back.
      await Promise.resolve();
    });

    const card = cards(view.host)[0];
    expect(
      commentTexts(card!, /^(why quick\?|no idea)$/),
    ).toEqual(["why quick?", "no idea"]);
    expect(text(card!, "1 reply")).toBeNull();
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
    const card = cards(view.host)[0]!;
    expect(card).not.toBeNull();
    expect(scrolled).toEqual([]);

    const first = focusThread(null, thread.id);
    view.refocus(first);
    expect(scrolled).toEqual([card.closest("li")]);

    view.refocus(focusThread(first, thread.id));
    expect(scrolled).toEqual([card.closest("li"), card.closest("li")]);
    view.unmount();
  });

  it.each([false, true])("waits for a newly selected card to arrive before revealing it (keyboard: %s)", (viaKeyboard) => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    const { ydoc, blocks } = annotatedDoc();
    createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "Existing card");
    const previousThreads = threadsFromDoc(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 20, 25, "ben", "New card");
    const connection = stubConnection(ydoc);
    const focused = focusThread(null, thread.id, { viaKeyboard });
    const tree = (threads: ThreadView[]): ReactElement => <ThreadsPane
      connection={connection} threads={threads} focused={focused} author="ben" onFocus={() => {}}
    />;
    const view = render(tree(previousThreads));
    try {
      // Selection arrives before the observer's thread list; the old rail
      // still renders, but the requested card cannot be scrolled or focused.
      expect(scrolled).toEqual([]);
      view.rerender(tree(threadsFromDoc(ydoc)));
      const control = cards(view.container).find((card) => card.textContent?.includes("New card"))!;
      const card = control.closest("li")!;
      expect(card).not.toBeNull();
      expect(scrolled).toEqual([card]);
      if (viaKeyboard) expect(document.activeElement).toBe(control.querySelector(".ub-thread-select"));
      addComment(ydoc, thread.id, "Reader", "Later reply");
      view.rerender(tree(threadsFromDoc(ydoc)));
      expect(scrolled).toEqual([card]);
    } finally { view.unmount(); ydoc.destroy(); }
  });

  it("explains removed text without a state chip and keeps its comment", () => {
    const { ydoc, blocks } = annotatedDoc();
    const paragraph = blocks[1]!;
    createAnnotation(ydoc, paragraph, 4, 15, "ben", "why quick?");
    editBlock(ydoc, paragraph, getBlock(ydoc, paragraph)!.text, "The fox jumps.");

    const view = renderRail(ydoc);
    const card = cards(view.host)[0];
    expect(text(card!, "orphaned")).toBeNull();
    expect(text(card!, "why quick?")).toBe("why quick?");
    // No quote to show, and the card says where the range was instead.
    expect(within(card!).queryByText("quick brown")).toBeNull();
    expect(text(card!, /text removed/)).toContain("text removed");
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
      expect(threadIdFromTarget(within(element).getByRole("heading", { name: "Sync" }))).toBeNull();
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
        connection={{ room: `${WORKSPACE}/doc-1`, ydoc, status: { writable: true } } as unknown as RoomConnection}
        focused={null}
        author="ben"
        onFocus={(threadId) => { if (threadId !== null) focus.push(threadId); }}
      />,
    );
    const host = view.container;
    try {
      // The orphaned-case absence below uses this same mark-contract query.
      expect(element.querySelector("[data-comment-thread]")).not.toBeNull();
      act(() => within(host).getByRole<HTMLElement>("group", { name: "Comment" }).click());

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
    editBlock(ydoc, paragraph, getBlock(ydoc, paragraph)!.text, "The fox jumps.");
    const { editor, element } = mountEditor(ydoc);
    const view = render(
      <LiveThreadsPane
        connection={{ room: `${WORKSPACE}/doc-1`, ydoc, status: { writable: true } } as unknown as RoomConnection}
        focused={null}
        author="ben"
        onFocus={() => {}}
      />,
    );
    const host = view.container;
    try {
      act(() => within(host).getByRole<HTMLElement>("group", { name: "Comment" }).click());

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
