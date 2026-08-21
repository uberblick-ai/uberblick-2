/**
 * Annotation threads, anchored by formatting marks.
 *
 * A thread is plain JSON in the `annotations` Y.Map, keyed by thread id, and it
 * carries no positions at all. The range lives in the text itself: the block's
 * Y.XmlText carries a `comment` formatting mark whose value is
 * `{ threadId }` over exactly the annotated characters.
 *
 * Marks beat relative positions here because they are part of the text's own
 * CRDT state. They ride along through concurrent edits, through a block
 * re-type (the delta carries them — see `setBlockType`), and through a block
 * split, none of which a pair of stored positions survives. The mark value is
 * ProseMirror-shaped on purpose: y-prosemirror turns a text attribute into a
 * mark named for its key with the value as that mark's attrs, so `comment`
 * arrives in Tiptap as a `comment` mark with a `threadId` attribute, no
 * translation layer.
 *
 * Overlapping threads are rejected, not nested. A Yjs formatting key holds one
 * value per character: marking a range that already carries another thread's
 * mark does not nest, it *steals* those characters from the first thread. A
 * ProseMirror mark type has the same one-per-position rule, so there is no
 * shape that could round-trip an overlap to the editor either. Callers that
 * need overlapping discussion attach both threads to adjacent ranges, or to
 * the block.
 *
 * Consequences worth knowing, all pinned by tests:
 *   - Text typed strictly inside an annotated span joins the span; text typed
 *     at its *end* boundary also joins it (Yjs inserts inherit the formatting
 *     to their left), while text typed at its *start* boundary stays outside.
 *   - Deleting part of a span shrinks it. Deleting all of it removes the mark,
 *     and the thread then resolves to `null` — it is never cascade-deleted, so
 *     the conversation survives even when its anchor does not.
 *
 * Thread bodies are replaced wholesale on write (last-write-wins per thread).
 * That is the right granularity: threads are small and append-mostly, and it
 * keeps annotation state readable as JSON by every consumer.
 */

import * as Y from "yjs";
import { getAnnotationsMap } from "./doc.js";
import { AnnotationRangeError, BlockNotFoundError } from "./errors.js";
import { findBlockElement, requireBlockText } from "./blocks.js";
import { COMMENT_MARK, isCommentMark } from "./types.js";
import type { Annotation, AnnotationRange, CommentMark } from "./types.js";

export { COMMENT_MARK };

/** A contiguous run of one thread's `comment` mark. */
export interface CommentRun {
  threadId: string;
  start: number;
  end: number;
}

function threadIdOf(attributes: unknown): string | null {
  if (typeof attributes !== "object" || attributes === null) return null;
  const mark = (attributes as Record<string, unknown>)[COMMENT_MARK];
  return isCommentMark(mark) ? mark.threadId : null;
}

/**
 * Every `comment` run in a text, in document order, with adjacent runs of the
 * same thread merged. One delta scan.
 */
function commentRuns(text: Y.XmlText): CommentRun[] {
  const runs: CommentRun[] = [];
  let index = 0;
  for (const op of text.toDelta() as Array<{
    insert?: unknown;
    attributes?: unknown;
  }>) {
    const length =
      typeof op.insert === "string" ? op.insert.length : op.insert === undefined ? 0 : 1;
    const threadId = threadIdOf(op.attributes);
    if (threadId !== null && length > 0) {
      const last = runs[runs.length - 1];
      if (last !== undefined && last.threadId === threadId && last.end === index) {
        last.end = index + length;
      } else {
        runs.push({ threadId, start: index, end: index + length });
      }
    }
    index += length;
  }
  return runs;
}

function isAnnotation(value: unknown): value is Annotation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Annotation>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.blockId === "string" &&
    Array.isArray(candidate.comments)
  );
}

/**
 * Create an annotation thread over `[startIndex, endIndex)` of a block's text
 * and mark that range with the thread's id.
 *
 * Indices are clamped to the block's text length and swapped if reversed.
 *
 * @throws BlockNotFoundError when the block does not exist.
 * @throws AnnotationRangeError when the clamped range is empty, or when it
 * already carries another thread's mark.
 */
export function createAnnotation(
  ydoc: Y.Doc,
  blockId: string,
  startIndex: number,
  endIndex: number,
  author: string,
  text: string,
): Annotation {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);

  const ytext = requireBlockText(ydoc, element, blockId);
  const length = ytext.length;
  const lo = Math.max(0, Math.min(length, Math.min(startIndex, endIndex)));
  const hi = Math.max(0, Math.min(length, Math.max(startIndex, endIndex)));
  if (lo === hi) throw new AnnotationRangeError("empty", blockId);

  const clash = commentRuns(ytext).find((run) => run.start < hi && lo < run.end);
  if (clash !== undefined) {
    throw new AnnotationRangeError("overlap", blockId, clash.threadId);
  }

  const annotation: Annotation = {
    id: crypto.randomUUID(),
    blockId,
    comments: [{ author, text, createdAt: new Date().toISOString() }],
  };
  const mark: CommentMark = { threadId: annotation.id };
  const annotations = getAnnotationsMap(ydoc);
  ydoc.transact(() => {
    ytext.format(lo, hi - lo, { [COMMENT_MARK]: mark });
    annotations.set(annotation.id, annotation);
  });
  return annotation;
}

export function getAnnotation(ydoc: Y.Doc, threadId: string): Annotation | null {
  const value = getAnnotationsMap(ydoc).get(threadId);
  return isAnnotation(value) ? value : null;
}

/** All annotation threads. Order is by thread id, for deterministic output. */
export function listAnnotations(ydoc: Y.Doc): Annotation[] {
  const out: Annotation[] = [];
  for (const value of getAnnotationsMap(ydoc).values()) {
    if (isAnnotation(value)) out.push(value);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Threads whose JSON names one block. */
export function listAnnotationsForBlock(
  ydoc: Y.Doc,
  blockId: string,
): Annotation[] {
  return listAnnotations(ydoc).filter(
    (annotation) => annotation.blockId === blockId,
  );
}

/**
 * Every anchored range in one block, in document order, from a single delta
 * scan. This is what an editor wants: resolving threads one at a time rescans
 * the text for each.
 *
 * Returns marks as they exist in the text — including any whose thread JSON is
 * gone, which is how an orphaned mark becomes visible.
 */
export function listAnnotationRanges(
  ydoc: Y.Doc,
  blockId: string,
): CommentRun[] {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) return [];
  const ytext = element.firstChild;
  return ytext instanceof Y.XmlText ? commentRuns(ytext) : [];
}

/**
 * Resolve a thread's anchored range to absolute indices in its block's current
 * text.
 *
 * Returns null when the thread is unknown, when its block has been deleted, or
 * when its mark is no longer in the text because every annotated character was
 * deleted. The thread JSON itself is never removed by any of those cases.
 */
export function resolveAnnotationRange(
  ydoc: Y.Doc,
  threadId: string,
): AnnotationRange | null {
  const annotation = getAnnotation(ydoc, threadId);
  if (annotation === null) return null;

  const runs = listAnnotationRanges(ydoc, annotation.blockId).filter(
    (run) => run.threadId === threadId,
  );
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (first === undefined || last === undefined) return null;

  return {
    start: first.start,
    end: last.end,
    collapsed: first.start === last.end,
  };
}

/** Append a comment to an existing thread. Returns the updated thread. */
export function addComment(
  ydoc: Y.Doc,
  threadId: string,
  author: string,
  text: string,
): Annotation | null {
  const existing = getAnnotation(ydoc, threadId);
  if (existing === null) return null;
  const updated: Annotation = {
    ...existing,
    comments: [
      ...existing.comments,
      { author, text, createdAt: new Date().toISOString() },
    ],
  };
  const annotations = getAnnotationsMap(ydoc);
  ydoc.transact(() => {
    annotations.set(threadId, updated);
  });
  return updated;
}

/**
 * Mark a thread resolved or unresolved. The `comment` mark stays in the text —
 * a resolved thread is still anchored, so the editor can show it in place.
 */
export function setAnnotationResolved(
  ydoc: Y.Doc,
  threadId: string,
  resolved: boolean,
): Annotation | null {
  const existing = getAnnotation(ydoc, threadId);
  if (existing === null) return null;
  const updated: Annotation = { ...existing, resolved };
  const annotations = getAnnotationsMap(ydoc);
  ydoc.transact(() => {
    annotations.set(threadId, updated);
  });
  return updated;
}

/**
 * Remove a thread: clear its `comment` mark from the text and drop its JSON.
 * Returns true when something was removed.
 *
 * Marks are cleared run by run, never as one span, so a foreign writer's
 * interleaved mark inside the range is left untouched.
 */
export function deleteAnnotation(ydoc: Y.Doc, threadId: string): boolean {
  const annotations = getAnnotationsMap(ydoc);
  const annotation = getAnnotation(ydoc, threadId);
  if (annotation === null) {
    if (!annotations.has(threadId)) return false;
    ydoc.transact(() => {
      annotations.delete(threadId);
    });
    return true;
  }

  const element = findBlockElement(ydoc, annotation.blockId);
  const ytext = element === null ? null : element.firstChild;
  ydoc.transact(() => {
    if (ytext instanceof Y.XmlText) {
      for (const run of commentRuns(ytext).filter(
        (candidate) => candidate.threadId === threadId,
      )) {
        ytext.format(run.start, run.end - run.start, { [COMMENT_MARK]: null });
      }
    }
    annotations.delete(threadId);
  });
  return true;
}
