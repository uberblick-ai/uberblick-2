/**
 * Annotation threads, anchored by formatting marks.
 *
 * A thread is one Y.Map in the `annotations` Y.Map, keyed by thread id, and it
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
 * ## Why a thread is a Y.Map and its conversation a nested Y.Array
 *
 * A thread's anchor block and its resolved flag are genuinely last-write-wins
 * data — whichever replica wrote last is the answer — so they are ordinary keys
 * on the thread's map. Its comments are not: while the conversation was an
 * array *inside* one replaced JSON value, two replicas each appending to one
 * thread converged to whichever write landed last and the other reply vanished
 * with no conflict and no error (#461).
 *
 * So the comments are a Y.Array nested under the thread's own `comments` key. A
 * Y.Map value may itself be a Y type, and content inside a nested type is not
 * last-write-wins — only a second `set` of the same key is. Two replies are
 * then two inserts, which Yjs merges, and a reply and a `resolved` write touch
 * different keys, so resolving cannot drop a reply either.
 *
 * Nesting rather than a second document root is also what makes deletion safe:
 * `deleteAnnotation` removes the thread's key, and its conversation goes with
 * it as one subtree. A conversation kept beside the thread instead — in a root
 * of its own — can be emptied by a delete while a concurrent resolve
 * resurrects the thread it belonged to, which loses the conversation exactly
 * the way #461 did.
 *
 * Comment order is the converged Yjs array order, and that IS the deterministic
 * order — every replica reads the same sequence without agreeing on anything
 * first. Nothing sorts by `createdAt`: clock skew can float a reply above the
 * comment it answers. `sidebar.ts` states the same rule for the same reason —
 * the winner is a position, not a timestamp.
 */

import * as Y from "yjs";
import { getAnnotationsMap } from "./doc.js";
import { AnnotationRangeError, BlockNotFoundError } from "./errors.js";
import { findBlockElement, requireBlockText } from "./blocks.js";
import { COMMENT_MARK, isCommentMark } from "./types.js";
import type {
  Annotation,
  AnnotationComment,
  AnnotationRange,
  CommentMark,
} from "./types.js";

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

/** The `comments` key on a thread's map: its conversation, in stored order. */
const COMMENTS_FIELD = "comments";

/** One thread as stored: its own Y.Map under its id in the annotations map. */
type ThreadMap = Y.Map<unknown>;

/**
 * A usable thread value. Any client can write into the annotations map, so a
 * value that is not this shape is skipped on read rather than trusted.
 */
function isThreadMap(value: unknown): value is ThreadMap {
  return (
    value instanceof Y.Map &&
    typeof value.get("id") === "string" &&
    typeof value.get("blockId") === "string" &&
    value.get(COMMENTS_FIELD) instanceof Y.Array
  );
}

/** A thread's comment rows. `isThreadMap` has already proved this is there. */
function commentRows(thread: ThreadMap): Y.Array<unknown> {
  return thread.get(COMMENTS_FIELD) as Y.Array<unknown>;
}

function isComment(value: unknown): value is AnnotationComment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AnnotationComment>;
  return (
    typeof candidate.author === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.createdAt === "string"
  );
}

/** A stored thread as a reader sees it: metadata joined with its comments. */
function readThread(thread: ThreadMap): Annotation {
  const comments: AnnotationComment[] = [];
  for (const value of commentRows(thread).toArray()) {
    if (!isComment(value)) continue;
    const { author, text, createdAt } = value;
    comments.push({ author, text, createdAt });
  }
  const resolved = thread.get("resolved");
  return {
    id: thread.get("id") as string,
    blockId: thread.get("blockId") as string,
    ...(typeof resolved === "boolean" ? { resolved } : {}),
    comments,
  };
}

function threadMap(ydoc: Y.Doc, threadId: string): ThreadMap | null {
  const value = getAnnotationsMap(ydoc).get(threadId);
  return isThreadMap(value) ? value : null;
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

  const id = crypto.randomUUID();
  const opening: AnnotationComment = {
    author,
    text,
    createdAt: new Date().toISOString(),
  };
  const mark: CommentMark = { threadId: id };
  const annotations = getAnnotationsMap(ydoc);
  const thread: ThreadMap = new Y.Map<unknown>();
  const comments = new Y.Array<unknown>();
  ydoc.transact(() => {
    ytext.format(lo, hi - lo, { [COMMENT_MARK]: mark });
    annotations.set(id, thread);
    thread.set("id", id);
    thread.set("blockId", blockId);
    thread.set(COMMENTS_FIELD, comments);
    comments.push([opening]);
  });
  return { id, blockId, comments: [opening] };
}

export function getAnnotation(ydoc: Y.Doc, threadId: string): Annotation | null {
  const thread = threadMap(ydoc, threadId);
  return thread === null ? null : readThread(thread);
}

/** All annotation threads. Order is by thread id, for deterministic output. */
export function listAnnotations(ydoc: Y.Doc): Annotation[] {
  const out: Annotation[] = [];
  for (const value of getAnnotationsMap(ydoc).values()) {
    if (isThreadMap(value)) out.push(readThread(value));
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Threads anchored to one block. */
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
 * Returns marks as they exist in the text — including any whose thread is
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
 * deleted. The thread itself is never removed by any of those cases.
 */
export function resolveAnnotationRange(
  ydoc: Y.Doc,
  threadId: string,
): AnnotationRange | null {
  // The stored map, not `getAnnotation`: a range needs the anchor block and
  // nothing else, and this runs once per thread on every rail recompute.
  const thread = threadMap(ydoc, threadId);
  if (thread === null) return null;

  const runs = listAnnotationRanges(ydoc, thread.get("blockId") as string).filter(
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

/**
 * Append a comment to an existing thread. Returns the updated thread.
 *
 * One insert into the thread's own comments array and nothing else. Its
 * metadata key is not rewritten, so a reply cannot clobber a concurrent
 * `setAnnotationResolved` — and, the way round this exists to fix, two
 * concurrent replies are two inserts that both survive the merge.
 */
export function addComment(
  ydoc: Y.Doc,
  threadId: string,
  author: string,
  text: string,
): Annotation | null {
  const thread = threadMap(ydoc, threadId);
  if (thread === null) return null;
  const comment: AnnotationComment = {
    author,
    text,
    createdAt: new Date().toISOString(),
  };
  ydoc.transact(() => {
    commentRows(thread).push([comment]);
  });
  return readThread(thread);
}

/**
 * Mark a thread resolved or unresolved. The `comment` mark stays in the text —
 * a resolved thread is still anchored, so the editor can show it in place.
 *
 * Writes the one `resolved` key, not the whole thread, so resolving drops no
 * reply a concurrent replica was writing.
 */
export function setAnnotationResolved(
  ydoc: Y.Doc,
  threadId: string,
  resolved: boolean,
): Annotation | null {
  const thread = threadMap(ydoc, threadId);
  if (thread === null) return null;
  ydoc.transact(() => {
    thread.set("resolved", resolved);
  });
  return readThread(thread);
}

/**
 * Remove a thread: clear its `comment` mark from the text and drop the thread.
 * Returns true when something was removed.
 *
 * Dropping the key takes the conversation with it, as one subtree — which is
 * why a delete racing a concurrent reply or resolve cannot leave a thread
 * standing with its comments destroyed.
 *
 * Marks are cleared run by run, never as one span, so a foreign writer's
 * interleaved mark inside the range is left untouched.
 */
export function deleteAnnotation(ydoc: Y.Doc, threadId: string): boolean {
  const annotations = getAnnotationsMap(ydoc);
  const thread = threadMap(ydoc, threadId);
  if (thread === null) {
    if (!annotations.has(threadId)) return false;
    ydoc.transact(() => {
      annotations.delete(threadId);
    });
    return true;
  }

  const element = findBlockElement(ydoc, thread.get("blockId") as string);
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
