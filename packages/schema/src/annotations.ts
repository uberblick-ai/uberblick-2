/**
 * Each thread is a Y.Map under its id in `annotations`, with no stored offsets.
 * Its `comment: { threadId }` text mark survives edits, splits and flat re-types;
 * the attribute shape is also the editor mark's attrs.
 */

import * as Y from "yjs";
import { getAnnotationsMap } from "./doc.js";
import { AnnotationCellError, AnnotationRangeError, BlockNotFoundError, CardAnnotationError, FigmaAnnotationError, InvalidCardError, InvalidFigmaError, InvalidTableError } from "./errors.js";
import { findBlockElement, requireBlockText } from "./blocks.js";
import { tableCellTexts, tableRows } from "./table.js";
import { CARD_PARTS, cardPartTexts } from "./card.js";
import type { CardPart } from "./card.js";
import { figmaCaptionTexts } from "./figma.js";
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
  /** Table projection coordinates; absent for a block-level text range. */
  row?: number;
  column?: number;
  part?: CardPart | "caption";
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
function commentRuns(texts: readonly Y.XmlText[]): CommentRun[] {
  const runs: CommentRun[] = [];
  let index = 0;
  for (const op of texts.flatMap((text) => text.toDelta()) as Array<{
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

/**
 * Cell offsets concatenate adjacent texts, matching the editor and GFM.
 * Insertions inside or at a marked span's end inherit its mark; insertions at
 * its start stay outside. Deletions shrink the span without deleting its thread.
 */
function formatRange(
  texts: readonly Y.XmlText[],
  start: number,
  end: number,
  value: CommentMark,
): void {
  let offset = 0;
  for (const text of texts) {
    const lo = Math.max(0, start - offset);
    const hi = Math.min(text.length, end - offset);
    if (lo < hi) text.format(lo, hi - lo, { [COMMENT_MARK]: value });
    offset += text.length;
  }
}

/** Each cell keeps its own offset space, including ragged projected padding. */
function annotationTexts(element: Y.XmlElement): Array<{
  texts: Y.XmlText[];
  row?: number;
  column?: number;
  part?: CardPart | "caption";
}> {
  if (element.nodeName === "figma") {
    return [{ texts: figmaCaptionTexts(element), part: "caption" }];
  }
  if (element.nodeName === "card") {
    return CARD_PARTS.map((part) => ({ texts: cardPartTexts(element, part), part }));
  }
  if (element.nodeName !== "table") {
    return element.firstChild instanceof Y.XmlText ? [{ texts: [element.firstChild] }] : [];
  }
  return tableRows(element).flatMap((cells, row) =>
    cells.map((cell, column) => ({ texts: tableCellTexts(cell), row, column })),
  );
}

/**
 * Nested Y.Array replies merge independently of last-write-wins thread fields.
 * Keep converged array order: createdAt sorting can invert replies under skew.
 */
const COMMENTS_FIELD = "comments";

/** One thread as stored: its own Y.Map under its id in the annotations map. */
type ThreadMap = Y.Map<unknown>;

/**
 * Skip malformed foreign values rather than trusting the annotations map.
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
 * Clamp and order a half-open range in block text or one projected table cell.
 * Empty ranges and overlaps are refused: Yjs and editor marks allow one thread
 * per character, so another thread's anchor would be overwritten.
 */
export function createAnnotation(
  ydoc: Y.Doc,
  blockId: string,
  startIndex: number,
  endIndex: number,
  author: string,
  text: string,
  target?: { row: number; column: number } | { part: CardPart | "caption" },
): Annotation {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  let texts: Y.XmlText[];
  if (element.nodeName === "table") {
    if (target === undefined || !("row" in target)) throw new AnnotationCellError("missing", blockId);
    const cell = target;
    const rows = tableRows(element);
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!Number.isSafeInteger(cell.row) || !Number.isSafeInteger(cell.column) ||
      cell.row < 0 || cell.row >= rows.length || cell.column < 0 || cell.column >= width) {
      throw new AnnotationCellError("out-of-bounds", blockId);
    }
    const targetCell = rows[cell.row]?.[cell.column];
    texts = targetCell === undefined ? [] : tableCellTexts(targetCell);
    // Embeds consume Yjs indices but are absent from the cell's displayed text
    // projection. Refuse rather than mark a different character than requested.
    if (texts.some((value) => (value.toDelta() as Array<{ insert?: unknown }>).some((op) => typeof op.insert !== "string"))) {
      throw new InvalidTableError();
    }
  } else if (element.nodeName === "figma") {
    if (target === undefined || !("part" in target) || target.part !== "caption") throw new FigmaAnnotationError(blockId);
    texts = figmaCaptionTexts(element);
    if (texts.some((value) => (value.toDelta() as Array<{ insert?: unknown }>).some((op) => typeof op.insert !== "string"))) {
      throw new InvalidFigmaError("The caption contains unsupported embedded content");
    }
  } else if (element.nodeName === "card") {
    if (target === undefined || !("part" in target) || target.part === "caption" || !CARD_PARTS.includes(target.part)) throw new CardAnnotationError(blockId);
    texts = cardPartTexts(element, target.part);
    if (texts.some((value) => (value.toDelta() as Array<{ insert?: unknown }>).some((op) => typeof op.insert !== "string"))) {
      throw new InvalidCardError("The card part contains unsupported embedded content");
    }
  } else {
    if (target !== undefined) throw new AnnotationCellError("not-table", blockId);
    texts = [requireBlockText(ydoc, element, blockId)];
  }
  const length = texts.reduce((total, value) => total + value.length, 0);
  const lo = Math.max(0, Math.min(length, Math.min(startIndex, endIndex)));
  const hi = Math.max(0, Math.min(length, Math.max(startIndex, endIndex)));
  if (lo === hi) throw new AnnotationRangeError("empty", blockId);

  const clash = commentRuns(texts).find((run) => run.start < hi && lo < run.end);
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
    formatRange(texts, lo, hi, mark);
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

/**
 * One scan returns document-order marks, including marks whose thread is gone.
 * Resolve all ranges together to avoid rescanning once per thread.
 */
export function listAnnotationRanges(
  ydoc: Y.Doc,
  blockId: string,
): CommentRun[] {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) return [];
  return annotationTexts(element).flatMap(({ texts, ...coordinates }) =>
    commentRuns(texts).map((run) => ({ ...run, ...coordinates })),
  );
}

/**
 * Resolve current block or cell offsets. Unknown threads, deleted blocks and
 * fully deleted spans return null; losing an anchor never deletes the thread.
 */
export function resolveAnnotationRange(
  ydoc: Y.Doc,
  threadId: string,
): AnnotationRange | null {
  // Range resolution needs no conversation materialization on each rail update.
  const thread = threadMap(ydoc, threadId);
  if (thread === null) return null;

  const runs = listAnnotationRanges(ydoc, thread.get("blockId") as string).filter(
    (run) => run.threadId === threadId,
  );
  const first = runs[0];
  if (first === undefined) return null;
  // Foreign writers can copy marks into other cells. A cell thread still has
  // one cell's offset space, so resolve the first marked cell in reading order.
  const sameCell = runs.filter((run) => run.row === first.row && run.column === first.column && run.part === first.part);
  const last = sameCell[sameCell.length - 1];
  if (last === undefined) return null;

  return {
    ...(first.row === undefined || first.column === undefined ? {} : { row: first.row, column: first.column }),
    ...(first.part === undefined ? {} : { part: first.part }),
    start: first.start,
    end: last.end,
    collapsed: first.start === last.end,
  };
}

/**
 * Insert only into the nested array: concurrent replies survive, and a reply
 * cannot overwrite a concurrent resolved flag. Returns the updated thread.
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
 * Write only the resolved flag so concurrent replies survive. Keep the text
 * mark so resolved threads remain anchored in the editor.
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
