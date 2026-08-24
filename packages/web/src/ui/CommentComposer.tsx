/**
 * Starting a thread from the prose: select a range, and a card appears next to
 * it offering to comment on exactly that range.
 *
 * Two steps, not one. A composer that opened and grabbed focus the moment a
 * selection existed would break the commonest gesture there is — select, then
 * type over it — so the selection first raises a small "Comment" affordance,
 * and only clicking that opens the field. Nothing here touches focus until the
 * reader has asked for it.
 *
 * The write goes through `createAnnotation`, which marks the range and stores
 * the thread in one transaction. This module hand-rolls no Yjs at all; what it
 * owns is the translation from a ProseMirror selection to the block-and-offsets
 * that API takes (see editor/selection.ts) and the refusals it can answer with.
 */

import { useEffect, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type * as Y from "yjs";
import { AnnotationRangeError, createAnnotation } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { commentTargetOf } from "../editor/selection.js";
import type { CommentTarget } from "../editor/selection.js";
import { CommentForm } from "./CommentForm.js";
import { blockRefLabel } from "./threads.js";

/** Where the card sits, in pixels inside the editor host. */
interface Point {
  top: number;
  left: number;
}

interface Draft extends Point {
  /** Identity of the target range, so a re-render for the same one is a no-op. */
  key: string;
  target: CommentTarget;
}

/** The gap between the selection and the card, in pixels. */
const OFFSET = 6;

/**
 * The card's position: below the start of the selection, in the host's own
 * coordinates.
 *
 * ProseMirror measures through the live layout, which a headless DOM does not
 * have — every fallback here is that case, and a card at the host's origin is
 * fine there because nothing is looking at it.
 */
function pointAt(editor: Editor, host: HTMLElement | null): Point {
  if (host === null) return { top: 0, left: 0 };
  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    const rect = host.getBoundingClientRect();
    const top = coords.bottom - rect.top + OFFSET;
    const left = coords.left - rect.left;
    if (!Number.isFinite(top) || !Number.isFinite(left)) return { top: 0, left: 0 };
    return { top, left: Math.max(0, left) };
  } catch {
    return { top: 0, left: 0 };
  }
}

/** What went wrong, in the reader's terms rather than the API's. */
function refusal(error: unknown): string {
  if (error instanceof AnnotationRangeError) {
    return error.reason === "overlap"
      ? "That range is already part of another thread. Comments cannot overlap — pick a range beside it."
      : "Select some text to comment on.";
  }
  return "Could not start the thread. Re-select the range and try again.";
}

export function CommentComposer({
  editor,
  ydoc,
  author,
  mentions,
  host,
  onCreated,
}: {
  editor: Editor;
  ydoc: Y.Doc;
  /** The awareness name this client publishes — the comment's author. */
  author: string;
  /** Peer names offered as `@name` chips. */
  mentions: string[];
  /** The positioned element the card is placed inside. */
  host: RefObject<HTMLElement | null>;
  /** The new thread, so the rail can focus its card. */
  onCreated: (threadId: string) => void;
}): ReactElement | null {
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The draft the field is open for; anything else shows the affordance. */
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every transaction, not just `selectionUpdate`: text arriving under the
  // selection moves the range that would be annotated, and the card quotes it.
  useEffect(() => {
    const read = (): void => {
      const target = commentTargetOf(editor);
      setDraft((previous) => {
        if (target === null) return null;
        const key = `${target.blockId}:${target.start}:${target.end}:${target.text}`;
        // Same range, same card: keeping the object identity keeps the open
        // field mounted (and its half-written text with it).
        if (previous !== null && previous.key === key) return previous;
        return { key, target, ...pointAt(editor, host.current) };
      });
    };
    read();
    editor.on("transaction", read);
    return () => {
      editor.off("transaction", read);
    };
  }, [editor, host]);

  if (draft === null) return null;
  const open = openFor === draft.key;
  const { target } = draft;
  const blockRef = blockRefLabel(target.blockType, target.blockIndex);

  const close = (): void => {
    setOpenFor(null);
    setError(null);
  };

  const create = (text: string): void => {
    try {
      const thread = createAnnotation(
        ydoc,
        target.blockId,
        target.start,
        target.end,
        author,
        text,
      );
      close();
      onCreated(thread.id);
      // Back to the prose, with the caret at the end of the new highlight
      // rather than still selecting it — a standing selection would re-offer to
      // comment on a range that now belongs to this thread.
      editor.commands.focus(editor.state.selection.to);
    } catch (failure) {
      setError(refusal(failure));
    }
  };

  return (
    <div
      className="ub-composer"
      style={{ top: `${draft.top}px`, left: `${draft.left}px` }}
    >
      {open ? (
        <>
          <p className="ub-composer-head">
            <span className="ub-thread-ref">{blockRef}</span>
            {target.clamped && (
              <span className="ub-chip ub-chip-orphaned">first block only</span>
            )}
          </p>
          {/* Exactly what the mark will cover — the whole point of showing it is
              that a clamped selection annotates less than the reader dragged. */}
          <p className="ub-thread-excerpt">{target.text}</p>
          <CommentForm
            placeholder={`Comment as ${author}…`}
            submitLabel="Comment"
            mentions={mentions}
            error={error}
            onSubmit={create}
            onCancel={close}
          />
        </>
      ) : (
        <button
          type="button"
          className="ub-tool ub-composer-open"
          // Opening must not disturb the selection the thread will anchor to.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setError(null);
            setOpenFor(draft.key);
          }}
        >
          Comment on {blockRef}
        </button>
      )}
    </div>
  );
}
