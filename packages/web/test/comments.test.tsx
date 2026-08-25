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
  getBlocksFragment,
  initDoc,
  listAnnotationRanges,
  listAnnotations,
  setAnnotationResolved,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { CommentComposer } from "../src/ui/CommentComposer.js";
import { ThreadsPane } from "../src/ui/ThreadsPane.js";
import { commentTargetOf } from "../src/editor/selection.js";
import { withMention } from "../src/ui/CommentForm.js";
import { resolvedHighlightCss } from "../src/ui/threads.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import { mountEditor } from "./helpers.js";

/** The workspace these stub room keys sit in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

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
  return { room: `${WORKSPACE}/doc-1`, ydoc } as unknown as RoomConnection;
}

/** The document position of `offset` characters into block `index`. */
function posIn(editor: Editor, index: number, offset: number): number {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos + offset;
}

/**
 * Select a range, the way a reader dragging over the prose does — within one
 * block, or on into a later one by naming `toBlock`. Inside `act` because the
 * composer listens to the editor: the selection is what makes it appear.
 */
function select(
  editor: Editor,
  block: number,
  from: number,
  to: number,
  toBlock = block,
): void {
  act(() => {
    editor.commands.setTextSelection({
      from: posIn(editor, block, from),
      to: posIn(editor, toBlock, to),
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
      expect(commentTargetOf(editor, ydoc)).toBeNull();

      select(editor, 1, 4, 15);
      expect(commentTargetOf(editor, ydoc)).toMatchObject({
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
   * A thread has exactly one anchor block, so a selection spanning several is
   * clamped to the first block of the range — and says so, which is what lets
   * the composer quote back exactly what it is about to mark.
   *
   * The *first block of the range*, not the block the gesture started in: the
   * target is read off `$from`, so a backwards drag clamps to where it ended.
   * One rule for both directions, and it is the one a reader can check against
   * the highlight.
   */
  it("clamps a multi-block selection to the first block of the range", () => {
    const { ydoc, blocks } = annotatedDoc();
    const { editor, element } = mountEditor(ydoc);
    try {
      // From inside the first block, on into the next one.
      select(editor, 1, 20, 6, 2);
      expect(commentTargetOf(editor, ydoc)).toMatchObject({
        blockId: blocks[1],
        start: 20,
        end: PARAGRAPH.length,
        text: "jumps.",
        clamped: true,
      });

      // The same range dragged the other way: anchor in the later block, head
      // in the earlier one.
      act(() => {
        const { state } = editor;
        editor.view.dispatch(
          state.tr.setSelection(
            TextSelection.create(state.doc, posIn(editor, 2, 6), posIn(editor, 1, 20)),
          ),
        );
      });
      expect(editor.state.selection.anchor).toBeGreaterThan(
        editor.state.selection.head,
      );
      expect(commentTargetOf(editor, ydoc)).toMatchObject({
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

  /**
   * The palette gate runs once, before the editor binds, so it cannot speak for
   * a shape that arrives afterwards — and a block element holding two Y.XmlText
   * children passes it anyway, since both children are plain text carrying
   * declared marks. ProseMirror then shows the two texts as one run while the
   * annotation API indexes only the first, so every offset read off the editor
   * would name the wrong characters. Nothing is offered on such a block.
   */
  it("refuses a block whose Y text the editor is not showing one-for-one", () => {
    const { ydoc } = annotatedDoc();
    const { editor, element: host } = mountEditor(ydoc);
    try {
      // A peer writes a second Y.XmlText into the paragraph. The editor renders
      // "…jumps.BBBB", the schema still reads only up to the full stop.
      const remote = mirrorOf(ydoc);
      act(() => {
        const extra = new Y.XmlText();
        extra.insert(0, "BBBB");
        (getBlocksFragment(remote).get(1) as Y.XmlElement).insert(1, [extra]);
      });
      expect(editor.state.doc.child(1).textContent).toBe(`${PARAGRAPH}BBBB`);
      expect(getBlocks(ydoc)[1]?.text).toBe(PARAGRAPH);

      select(editor, 1, 4, 15);
      expect(commentTargetOf(editor, ydoc)).toBeNull();
    } finally {
      editor.destroy();
      host.remove();
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

  /**
   * A refusal is not a reason to lose what someone wrote. The error names the
   * range, so it goes when the reader aims at another one, and the comment
   * itself waits in the field for the range that will take it.
   */
  it("refuses a range that already belongs to another thread, and keeps the text", () => {
    const { ydoc, blocks } = annotatedDoc();
    createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "mine");
    const view = mountComposer(ydoc, { author: "ben" });
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
      expect(view.query<HTMLTextAreaElement>(".ub-comment-input")?.value).toBe(
        "mine too",
      );

      // Aim at a free range and the refusal no longer applies…
      select(view.editor, 1, 20, 25);
      expect(view.query(".ub-comment-error")).toBeNull();
      // …and the same text, never retyped, lands there.
      view.submit();
      expect(
        listAnnotations(ydoc).find((thread) => thread.comments[0]?.author === "ben")
          ?.comments[0]?.text,
      ).toBe("mine too");
      expect(listAnnotationRanges(ydoc, blocks[1]!)).toHaveLength(2);
    } finally {
      view.unmount();
    }
  });

  /**
   * Everything on the card is derived from the selection as it stands *now*.
   * Extending a selection off the end of its first block changes neither the
   * offsets nor the quoted text — only whether the range is being clamped — so
   * a card that re-reads only when those change would go on claiming it was
   * annotating the whole gesture.
   */
  it("re-reads the target on every transaction, so the clamp shows up", () => {
    const { ydoc, blocks } = annotatedDoc();
    const view = mountComposer(ydoc);
    try {
      // "jumps." — the tail of the block, so running past it leaves start, end
      // and quoted text exactly as they were.
      select(view.editor, 1, 20, PARAGRAPH.length);
      view.open();
      expect(view.query(".ub-chip-orphaned")).toBeNull();

      select(view.editor, 1, 20, 6, 2);
      expect(view.query(".ub-chip-orphaned")?.textContent).toBe("first block only");
      expect(view.query(".ub-thread-excerpt")?.textContent).toBe("jumps.");

      view.type("the tail only");
      view.submit();
      const [thread] = listAnnotations(ydoc);
      expect(listAnnotationRanges(ydoc, blocks[1]!)).toEqual([
        { threadId: thread?.id, start: 20, end: PARAGRAPH.length },
      ]);
      // The caret goes to the end of what was marked — in the first block, not
      // in the block the selection happened to run into.
      expect(view.editor.state.selection.from).toBe(
        posIn(view.editor, 1, PARAGRAPH.length),
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
    card: (threadId: string) => HTMLElement;
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
      card: (threadId) => {
        const found = cards().find((card) => card.id === `ub-thread-${threadId}`);
        if (found === undefined) throw new Error(`no card for ${threadId}`);
        return found;
      },
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

  /** Submit the reply form open on a card — the last of its buttons. */
  function submitReply(card: HTMLElement): void {
    const buttons = [
      ...card.querySelectorAll<HTMLButtonElement>(".ub-comment-buttons button"),
    ];
    if (buttons.length === 0) throw new Error("no reply form");
    buttons.at(-1)?.click();
  }

  it("appends a reply authored by this client, live to a second client", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");
    const view = renderRail(ydoc, "loitering otter");
    try {
      await settle(() => action(view.cards()[0]!, "Reply").click());
      await view.type("because it is a pangram");
      await settle(() => submitReply(view.cards()[0]!));

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

      // Reopened by that same client: the reply was let go, not merely hidden,
      // so the form does not come back — and does not steal the caret with it.
      await settle(() => setAnnotationResolved(remote, thread.id, false));
      expect(view.cards()[0]?.querySelector(".ub-comment-input")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  /**
   * The other half of the same race. The card under the pointer is always a
   * render old, so the resolve can land in the *same task* as the click, before
   * the rail has been told to take the form away. The handler is then looking
   * at a card that still says "open" — and a reply written into a conversation
   * someone else has just closed is the kind of write nobody sees again.
   *
   * So the thread is re-read at submit and the reply refused, which is what
   * `CommentForm`'s false return means: the text stays where it was typed.
   */
  it("refuses a reply to a thread another client resolved in the same task", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const remote = mirrorOf(ydoc);
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");
    const view = renderRail(ydoc);
    try {
      await settle(() => action(view.cards()[0]!, "Reply").click());
      await view.type("because it is a pangram");

      // One task: the rail's observer only queues a microtask, so the click is
      // handled against the render that still shows an open thread.
      await settle(() => {
        setAnnotationResolved(remote, thread.id, true);
        submitReply(view.card(thread.id));
      });

      // Nothing was appended, on either replica…
      expect(getAnnotation(remote, thread.id)?.comments).toHaveLength(1);
      expect(getAnnotation(ydoc, thread.id)?.comments).toHaveLength(1);
      // …and the card says why, on the card rather than in a form that is gone.
      expect(
        view.card(thread.id).querySelector(".ub-comment-error")?.textContent,
      ).toBe("This thread was resolved while you wrote — reopen it to reply.");
      expect(view.card(thread.id).querySelector(".ub-comment-input")).toBeNull();

      // The message is about a thread that reads as resolved, and whoever
      // settled it can reopen it from anywhere. Nobody clicks anything here:
      // the reopen arrives from the other replica and the message goes with the
      // state that justified it.
      await settle(() => setAnnotationResolved(remote, thread.id, false));
      expect(view.card(thread.id).querySelector(".ub-comment-error")).toBeNull();
      await settle(() => action(view.card(thread.id), "Reply").click());
      await view.type("because it is a pangram");
      await settle(() => submitReply(view.card(thread.id)));
      expect(getAnnotation(remote, thread.id)?.comments).toHaveLength(2);
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
   * That a `comment` mark survives a block split is the schema package's own
   * property, pinned by its own tests. What is this rail's business is that a
   * resolve it wrote lands on a thread whose anchor moved underneath it: the
   * state reaches the other replica, and the card is still in the rail.
   */
  it("survives a remote block split landing on a thread being resolved", async () => {
    const { ydoc, blocks } = annotatedDoc();
    const thread = createAnnotation(ydoc, blocks[1]!, 4, 15, "agent-a", "why?");

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

      expect(getAnnotation(remote, thread.id)?.resolved).toBe(true);
      // …and the rail still finds it, anchored to the first half.
      expect(view.cards()).toHaveLength(1);
      expect(view.count()).toBe("0");
    } finally {
      view.unmount();
      editor.destroy();
      element.remove();
    }
  });

  /**
   * A thread id is a key in a Y.Map, so any client can make one up — including
   * one that would close the CSS string the fade rule puts it in. An id outside
   * the shape the schema package generates gets no rule at all: its highlight
   * stays amber, which is loud rather than dangerous.
   */
  it("writes no stylesheet rule for a thread id it cannot vouch for", () => {
    const hostile = '"]{}\n*{display:none}';
    expect(resolvedHighlightCss([hostile])).toBe("");
    expect(resolvedHighlightCss([hostile, "b3d1f0e2-4c5a-11ee-be56-0242ac120002"]))
      .toBe(
        '[data-comment-thread="b3d1f0e2-4c5a-11ee-be56-0242ac120002"]{background:transparent;border-bottom:1px dotted var(--muted-foreground);}',
      );
    // Harmless characters, hostile size: a uuid is 36 characters, and an id
    // that goes on for a megabyte is a megabyte of selector on every render.
    expect(resolvedHighlightCss(["a".repeat(100_000)])).toBe("");
  });
});
