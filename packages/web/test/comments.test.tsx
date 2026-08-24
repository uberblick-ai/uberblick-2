/**
 * Comment threads, write side: starting one from a selection, replying to one,
 * and resolving one.
 *
 * Everything is read back out of a real Y.Doc through the schema package, and
 * the second replica is the one that matters — a comment nobody else can see is
 * not a comment. The UI's own state is asserted only where it *is* the contract:
 * the rail's open count, and the resolved range fading in the prose.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  editBlock,
  getAnnotation,
  getBlocks,
  initDoc,
  listAnnotationRanges,
  listAnnotations,
  setAnnotationResolved,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { CommentComposer } from "../src/ui/CommentComposer.js";
import { ThreadsPane } from "../src/ui/ThreadsPane.js";
import { commentTargetOf } from "../src/editor/selection.js";
import { withMention } from "../src/ui/CommentForm.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { mountEditor } from "./helpers.js";

/** Offsets used below: "quick brown" is [4, 15), "jumps" is [20, 25). */
const PARAGRAPH = "The quick brown fox jumps.";

function annotatedDoc(): { ydoc: Y.Doc; blocks: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "doc-1", title: "Annotated" });
  appendBlock(ydoc, { type: "heading", text: "Sync", level: 2 });
  appendBlock(ydoc, { type: "paragraph", text: PARAGRAPH });
  appendBlock(ydoc, { type: "paragraph", text: "Second paragraph." });
  return { ydoc, blocks: getBlocks(ydoc).map((block) => block.id) };
}

/** A second replica, connected the way the hub connects two clients. */
function mirrorOf(local: Y.Doc): Y.Doc {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
  return remote;
}

/** Exchange state between two replicas that have been editing apart. */
function syncDocs(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/** The rail reads the Y.Doc and nothing else. */
function stubConnection(ydoc: Y.Doc): RoomConnection {
  return { room: "main/doc-1", ydoc } as unknown as RoomConnection;
}

/** The document position of `offset` characters into block `index`. */
function posIn(editor: Editor, index: number, offset: number): number {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos + offset;
}

/**
 * Select a range, the way a reader dragging over the prose does. Inside `act`
 * because the composer listens to the editor: the selection is what makes it
 * appear.
 */
function select(editor: Editor, block: number, from: number, to: number): void {
  act(() => {
    editor.commands.setTextSelection({
      from: posIn(editor, block, from),
      to: posIn(editor, block, to),
    });
  });
}

/**
 * Run a gesture and let the rail catch up. The rail's observer coalesces onto a
 * microtask — one recompute per transaction, however many things it touched —
 * so a write is on screen only after that microtask has run.
 */
async function settle(gesture: () => void): Promise<void> {
  await act(async () => {
    gesture();
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

/** Mount the composer over a mounted editor, and drive it the way a reader does. */
function mountComposer(
  ydoc: Y.Doc,
  options: { author?: string; mentions?: string[] } = {},
): {
  editor: Editor;
  created: string[];
  open: () => void;
  type: (text: string) => void;
  submit: () => void;
  query: <T extends Element>(selector: string) => T | null;
  unmount: () => void;
} {
  const { editor, element } = mountEditor(ydoc);
  const created: string[] = [];
  const frame = document.createElement("div");
  document.body.appendChild(frame);
  const root = createRoot(frame);
  const draw = (): void => {
    act(() => {
      root.render(
        <CommentComposer
          editor={editor}
          ydoc={ydoc}
          author={options.author ?? "ben"}
          mentions={options.mentions ?? []}
          host={{ current: frame }}
          onCreated={(threadId) => created.push(threadId)}
        />,
      );
    });
  };
  draw();
  const query = <T extends Element>(selector: string): T | null =>
    frame.querySelector<T>(selector);
  return {
    editor,
    created,
    open: () => act(() => query<HTMLButtonElement>(".ub-composer-open")?.click()),
    type: (text: string) => {
      const field = query<HTMLTextAreaElement>(".ub-comment-input");
      if (field === null) throw new Error("no composer field");
      act(() => {
        // React listens for `input`, and setting `.value` skips its tracker.
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    submit: () =>
      act(() => {
        const buttons = [
          ...frame.querySelectorAll<HTMLButtonElement>(".ub-comment-buttons button"),
        ];
        buttons.at(-1)?.click();
      }),
    query,
    unmount: () => {
      act(() => root.unmount());
      frame.remove();
      editor.destroy();
      element.remove();
    },
  };
}

describe("the selection a thread anchors to", () => {
  it("is the block and the character offsets the annotation API takes", () => {
    const { ydoc, blocks } = annotatedDoc();
    const { editor, element } = mountEditor(ydoc);
    try {
      expect(commentTargetOf(editor)).toBeNull();

      select(editor, 1, 4, 15);
      expect(commentTargetOf(editor)).toMatchObject({
        blockId: blocks[1],
        start: 4,
        end: 15,
        text: "quick brown",
        blockType: "paragraph",
        blockIndex: 1,
        clamped: false,
      });
    } finally {
      editor.destroy();
      element.remove();
    }
  });

  /**
   * A thread has exactly one anchor block, so a selection running past the end
   * of its first block is clamped to that block — and says so, which is what
   * lets the composer quote back exactly what it is about to mark.
   */
  it("clamps a selection that runs past its first block", () => {
    const { ydoc, blocks } = annotatedDoc();
    const { editor, element } = mountEditor(ydoc);
    try {
      select(editor, 1, 20, PARAGRAPH.length);
      // …and on into the next block.
      editor.commands.setTextSelection({
        from: posIn(editor, 1, 20),
        to: posIn(editor, 2, 6),
      });
      expect(commentTargetOf(editor)).toMatchObject({
        blockId: blocks[1],
        start: 20,
        end: PARAGRAPH.length,
        text: "jumps.",
        clamped: true,
      });
    } finally {
      editor.destroy();
      element.remove();
    }
  });
});

describe("starting a thread from the prose", () => {
  it("marks the selected range and shows the thread to a second client", () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const view = mountComposer(ydoc, { author: "ben" });
    try {
      // No selection, no composer.
      expect(view.query(".ub-composer")).toBeNull();

      select(view.editor, 1, 4, 15);
      expect(view.query(".ub-composer-open")?.textContent).toBe(
        "Comment on Paragraph 2",
      );

      view.open();
      // The card quotes exactly the range the mark will cover.
      expect(view.query(".ub-thread-excerpt")?.textContent).toBe("quick brown");
      view.type("why quick?");
      view.submit();

      const [thread] = listAnnotations(ydoc);
      expect(thread).toMatchObject({ blockId: blocks[1] });
      expect(thread?.comments).toEqual([
        { author: "ben", text: "why quick?", createdAt: expect.any(String) },
      ]);
      expect(view.created).toEqual([thread?.id]);

      // The mark is on the range, and the second replica has both halves of it.
      expect(listAnnotationRanges(remote, blocks[1]!)).toEqual([
        { threadId: thread?.id, start: 4, end: 15 },
      ]);
      expect(getAnnotation(remote, thread!.id)?.comments).toHaveLength(1);
    } finally {
      view.unmount();
    }
  });

  it("refuses a range that already belongs to another thread, and says why", () => {
    const { ydoc, blocks } = annotatedDoc();
    createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "mine");
    const view = mountComposer(ydoc);
    try {
      // Overlapping the existing thread by a single character is enough.
      select(view.editor, 1, 10, 19);
      view.open();
      view.type("mine too");
      view.submit();

      expect(listAnnotations(ydoc)).toHaveLength(1);
      expect(view.query(".ub-comment-error")?.textContent).toContain(
        "already part of another thread",
      );
    } finally {
      view.unmount();
    }
  });

  /**
   * The card follows the moving range: a remote edit above the selection shifts
   * every offset in it, which is a *new* target for the same open field. What
   * must not happen is the field closing and taking half a written comment with
   * it — the commonest way to lose a comment nobody typed twice.
   */
  it("keeps a half-written comment while a remote edit moves the range", () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const view = mountComposer(ydoc, { author: "ben" });
    try {
      select(view.editor, 1, 4, 15);
      view.open();
      view.type("why quick?");

      // A second client prepends to the same block: every offset shifts by 10.
      act(() => {
        editBlock(remote, blocks[1]!, PARAGRAPH, `Actually, ${PARAGRAPH}`);
      });

      // Still open, still holding what was typed…
      expect(view.query<HTMLTextAreaElement>(".ub-comment-input")?.value).toBe(
        "why quick?",
      );
      // …and quoting the same words at their new offsets.
      expect(view.query(".ub-thread-excerpt")?.textContent).toBe("quick brown");

      view.submit();
      const [thread] = listAnnotations(ydoc);
      expect(thread?.comments[0]?.text).toBe("why quick?");
      expect(listAnnotationRanges(remote, blocks[1]!)).toEqual([
        { threadId: thread?.id, start: 14, end: 25 },
      ]);
    } finally {
      view.unmount();
    }
  });

  it("types a mention as plain text into the comment", () => {
    const { ydoc } = annotatedDoc();
    const view = mountComposer(ydoc, { mentions: ["agent-a"] });
    try {
      select(view.editor, 1, 4, 15);
      view.open();
      view.type("look at this");
      act(() => view.query<HTMLButtonElement>(".ub-mention")?.click());
      view.submit();

      expect(listAnnotations(ydoc)[0]?.comments[0]?.text).toBe(
        "look at this @agent-a",
      );
    } finally {
      view.unmount();
    }
    // The convention, in one place: a separating space where one is needed.
    expect(withMention("", "a")).toBe("@a ");
    expect(withMention("hi ", "a")).toBe("hi @a ");
  });
});

describe("the rail writes back", () => {
  function renderRail(
    ydoc: Y.Doc,
    author = "ben",
  ): {
    cards: () => HTMLElement[];
    count: () => string | null;
    resolvedCss: () => string;
    type: (text: string) => Promise<void>;
    unmount: () => void;
  } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ThreadsPane
          connection={stubConnection(ydoc)}
          focused={null}
          author={author}
          onFocus={() => {}}
        />,
      );
    });
    const cards = (): HTMLElement[] => [
      ...host.querySelectorAll<HTMLElement>(".ub-thread-card"),
    ];
    return {
      cards,
      count: () => host.querySelector(".ub-rail-head .ub-muted")?.textContent ?? null,
      resolvedCss: () =>
        host.querySelector("[data-resolved-highlights]")?.textContent ?? "",
      type: (text) =>
        settle(() => {
          const field = host.querySelector<HTMLTextAreaElement>(".ub-comment-input");
          if (field === null) throw new Error("no reply field");
          // React listens for `input`, and setting `.value` skips its tracker.
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set?.call(field, text);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }),
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  /** The button in a card's action row whose label is `label`. */
  function action(card: HTMLElement, label: string): HTMLButtonElement {
    const found = [
      ...card.querySelectorAll<HTMLButtonElement>(".ub-thread-actions button"),
    ].find((button) => button.textContent === label);
    if (found === undefined) throw new Error(`no ${label} button`);
    return found;
  }

  it("appends a reply authored by this client, live to a second client", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");
    const view = renderRail(ydoc, "loitering otter");
    try {
      await settle(() => action(view.cards()[0]!, "Reply").click());
      await view.type("because it is a pangram");
      await settle(() => {
        const buttons = [
          ...view
            .cards()[0]!
            .querySelectorAll<HTMLButtonElement>(".ub-comment-buttons button"),
        ];
        buttons.at(-1)?.click();
      });

      expect(getAnnotation(remote, thread.id)?.comments).toEqual([
        { author: "agent-a", text: "why?", createdAt: expect.any(String) },
        {
          author: "loitering otter",
          text: "because it is a pangram",
          createdAt: expect.any(String),
        },
      ]);
      // The form closes, and the card shows the reply it just wrote.
      expect(view.cards()[0]?.querySelector(".ub-comment-input")).toBeNull();
      expect(
        [...view.cards()[0]!.querySelectorAll(".ub-thread-text")].map(
          (element) => element.textContent,
        ),
      ).toEqual(["why?", "because it is a pangram"]);
    } finally {
      view.unmount();
    }
  });

  /**
   * A reply form open on a thread another client then resolves. The reply
   * belongs to a conversation that is over, so the form goes — and expanding
   * the resolved card to read it back must not quietly offer it again.
   */
  it("takes back an open reply form when another client resolves the thread", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");
    const view = renderRail(ydoc);
    try {
      await settle(() => action(view.cards()[0]!, "Reply").click());
      expect(view.cards()[0]?.querySelector(".ub-comment-input")).not.toBeNull();

      await settle(() => setAnnotationResolved(remote, thread.id, true));
      expect(view.cards()[0]?.querySelector(".ub-comment-input")).toBeNull();

      // Expanding the resolved card shows the conversation, and no form.
      await settle(() =>
        view.cards()[0]?.querySelector<HTMLButtonElement>(".ub-thread")?.click(),
      );
      expect(view.cards()[0]?.querySelector(".ub-thread-text")?.textContent).toBe(
        "why?",
      );
      expect(view.cards()[0]?.querySelector(".ub-comment-input")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("resolves a thread: out of the count, still in the rail, faded in the prose", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "ben", "why?");
    createAnnotation(ydoc, blocks[2]!, 0, 6, "ben", "and this");
    const { editor, element } = mountEditor(ydoc);
    const view = renderRail(ydoc);
    try {
      expect(view.count()).toBe("2");

      await settle(() => action(view.cards()[0]!, "Resolve").click());

      // The document, as a second client reads it.
      expect(getAnnotation(remote, thread.id)?.resolved).toBe(true);
      // The mark stays: a resolved thread is still anchored to its range.
      expect(listAnnotationRanges(remote, blocks[1]!)).toEqual([
        { threadId: thread.id, start: 4, end: 15 },
      ]);

      // One open thread left, and the resolved one is still on screen.
      expect(view.count()).toBe("1");
      expect(view.cards()).toHaveLength(2);
      const resolved = view
        .cards()
        .find((card) => card.querySelector(".ub-thread-resolved"));
      expect(resolved?.querySelector(".ub-chip")?.textContent).toBe("resolved");
      // Collapsed, but expandable — the conversation is not lost.
      expect(resolved?.querySelector(".ub-thread-text")).toBeNull();
      await settle(() =>
        resolved?.querySelector<HTMLButtonElement>(".ub-thread")?.click(),
      );
      expect(
        view
          .cards()
          .find((card) => card.querySelector(".ub-thread-resolved"))
          ?.querySelector(".ub-thread-text")?.textContent,
      ).toBe("why?");

      // The highlight in the prose fades: still there, no amber ground.
      expect(
        element.querySelector(`[data-comment-thread="${thread.id}"]`),
      ).not.toBeNull();
      expect(view.resolvedCss()).toContain(`[data-comment-thread="${thread.id}"]`);
      expect(view.resolvedCss()).toContain("background:transparent");

      // …and reopening puts it back in the count.
      const reopen = view
        .cards()
        .find((card) => card.querySelector(".ub-thread-resolved"))!;
      await settle(() => action(reopen, "Reopen").click());
      expect(getAnnotation(remote, thread.id)?.resolved).toBe(false);
      expect(view.count()).toBe("2");
      expect(view.resolvedCss()).toBe("");
    } finally {
      view.unmount();
      editor.destroy();
      element.remove();
    }
  });

  /**
   * The one concurrency case this change introduces that the schema package's
   * own tests do not: a resolve written from the rail while another client
   * splits the marked block underneath it. The schema tests pin that a mark
   * survives a split; what is new here is that the thread's *state* is written
   * on one replica while its anchor moves on the other.
   */
  it("survives a remote block split landing on a thread being resolved", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const paragraph = blocks[1]!;
    const thread = createAnnotation(ydoc, paragraph, 4, 15, "agent-a", "why?");

    // A second replica, editing apart: no updates flow until syncDocs below.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    const { editor, element } = mountEditor(remote, {
      newBlockId: () => "split-1",
    });
    const view = renderRail(ydoc);
    try {
      // Remote: Enter inside the annotated range, splitting "quick| brown".
      editor.commands.setTextSelection(posIn(editor, 1, 9));
      editor.commands.splitBlock();
      // Local, concurrently: resolve the thread.
      await settle(() => action(view.cards()[0]!, "Resolve").click());

      await settle(() => syncDocs(ydoc, remote));

      for (const replica of [ydoc, remote]) {
        expect(getAnnotation(replica, thread.id)?.resolved).toBe(true);
        expect(getAnnotation(replica, thread.id)?.comments).toHaveLength(1);
        // The mark went with the text: half in each block, uncorrupted.
        expect(listAnnotationRanges(replica, paragraph)).toEqual([
          { threadId: thread.id, start: 4, end: 9 },
        ]);
        expect(listAnnotationRanges(replica, "split-1")).toEqual([
          { threadId: thread.id, start: 0, end: 6 },
        ]);
      }
      // …and the rail still finds it, anchored to the first half.
      expect(view.cards()).toHaveLength(1);
      expect(view.count()).toBe("0");
    } finally {
      view.unmount();
      editor.destroy();
      element.remove();
    }
  });
});
