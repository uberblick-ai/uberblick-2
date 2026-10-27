/**
 * Each thread is a Y.Map under its id in `annotations`, with no stored offsets.
 * Its `comment: { threadId }` text mark survives edits, splits and flat re-types;
 * the attribute shape is also the editor mark's attrs.
 */

import * as Y from "yjs";
import { getAnnotationsMap, getBlocksFragment } from "./doc.js";
import { AnnotationCellError, AnnotationRangeError, BlockNotFoundError, CardAnnotationError, FigmaAnnotationError, InvalidCardError, InvalidFigmaError, InvalidTableError } from "./errors.js";
import { findBlockElement } from "./blocks.js";
import { tableCellTexts, tableRows } from "./table.js";
import { CARD_PARTS, cardPartTexts } from "./card.js";
import type { CardPart } from "./card.js";
import { figmaCaptionTexts } from "./figma.js";
import { structuredInlineParts } from "./inline-parts.js";
import { isGithubUsername } from "./github-identity.js";
import { isUuid } from "./workspace.js";
import { COMMENT_MARK, isCommentMark } from "./types.js";
import type {
  Annotation,
  AnnotationComment,
  AnnotationRange,
  CommentAttribution,
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

/** One visible location in the offset space of its block, cell or part. */
export interface AnnotationAnchor {
  blockId: string;
  range: AnnotationRange;
  text: string;
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
  value: CommentMark | null,
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
  if (element.nodeName === "table" || element.nodeName === "card" || element.nodeName === "figma") {
    return structuredInlineParts(element).map((part) => part.kind === "table"
      ? { texts: part.texts, row: part.row, column: part.column }
      : { texts: part.texts, part: part.part });
  }
  return element.firstChild instanceof Y.XmlText ? [{ texts: [element.firstChild] }] : [];
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

function isComment(value: unknown): value is Pick<AnnotationComment, "author" | "text" | "createdAt"> & Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AnnotationComment>;
  return (
    typeof candidate.author === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.createdAt === "string"
  );
}

type StoredComment = Pick<AnnotationComment, "author" | "text" | "createdAt"> & Record<string, unknown>;
type CommentRow = {
  id: string;
  value: StoredComment;
  indices: [number, ...number[]];
  item: { client: number; clock: number };
};

function isEditTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  if (!Number.isFinite(Date.parse(value))) return false;
  // Date parsing normalizes impossible dates, which must not become edit times.
  return new Date(`${value.slice(0, 19)}Z`).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** The original Yjs item identifies even legacy comments with equal contents. */
function rowIdentity(rows: Y.Array<unknown>, index: number): { client: number; clock: number } {
  const item = Y.createRelativePositionFromTypeIndex(rows, index).item;
  if (item === null) throw new Error("Comment row has no Yjs identity");
  return item;
}

function commentIdentity(row: StoredComment, item: { client: number; clock: number }): string {
  return typeof row.commentId === "string" && /^\d+:\d+$/.test(row.commentId)
    ? row.commentId : `${item.client}:${item.clock}`;
}

/** Collapse replacement rows without sorting the converged reply sequence. */
function readCommentRows(rows: Y.Array<unknown>): CommentRow[] {
  const comments = new Map<string, CommentRow>();
  rows.toArray().forEach((value, index) => {
    if (!isComment(value)) return;
    const item = rowIdentity(rows, index);
    const id = commentIdentity(value, item);
    const prior = comments.get(id);
    if (prior === undefined) {
      comments.set(id, { id, value, indices: [index], item });
      return;
    }
    prior.indices.push(index);
    const time = isEditTime(value.editedAt) ? Date.parse(value.editedAt) : -Infinity;
    const priorTime = isEditTime(prior.value.editedAt) ? Date.parse(prior.value.editedAt) : -Infinity;
    if (time > priorTime || (time === priorTime &&
        (item.client > prior.item.client || (item.client === prior.item.client && item.clock > prior.item.clock)))) {
      prior.value = value;
      prior.item = item;
    }
  });
  return [...comments.values()];
}

/** Stable identity at the shared reader's index, including after edit collapse. */
export function getAnnotationCommentId(ydoc: Y.Doc, threadId: string, index: number): string | null {
  return getAnnotationCommentIds(ydoc, threadId)[index] ?? null;
}

/** Comment identities in the same order and with the same collapse as readers. */
export function getAnnotationCommentIds(ydoc: Y.Doc, threadId: string): string[] {
  const thread = threadMap(ydoc, threadId);
  return thread === null ? [] : readCommentRows(commentRows(thread)).map((comment) => comment.id);
}

/** A stored thread as a reader sees it: metadata joined with its comments. */
function readThread(thread: ThreadMap): Annotation {
  const comments: AnnotationComment[] = [];
  for (const { value } of readCommentRows(commentRows(thread))) {
    const { author, text, createdAt, account, agent, principalId, kind, editedAt } = value;
    comments.push({
      author,
      text,
      createdAt,
      ...(isGithubUsername(account) ? { account } : {}),
      ...(agent === "claude" || agent === "codex" ? { agent } : {}),
      ...(isUuid(principalId) ? { principalId } : {}),
      ...(kind === "person" || kind === "agent" ? { kind } : {}),
      ...(isEditTime(editedAt) ? { editedAt } : {}),
    });
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
function annotationRange(
  ydoc: Y.Doc,
  blockId: string,
  startIndex: number,
  endIndex: number,
  target?: { row: number; column: number } | { part: CardPart | "caption" },
  ownThreadId?: string,
): { texts: Y.XmlText[]; lo: number; hi: number } {
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
    texts = element.firstChild instanceof Y.XmlText ? [element.firstChild] : [];
  }
  const length = texts.reduce((total, value) => total + value.length, 0);
  const lo = Math.max(0, Math.min(length, Math.min(startIndex, endIndex)));
  const hi = Math.max(0, Math.min(length, Math.max(startIndex, endIndex)));
  if (lo === hi) throw new AnnotationRangeError("empty", blockId);

  const clash = commentRuns(texts).find((run) => run.threadId !== ownThreadId && run.start < hi && lo < run.end);
  if (clash !== undefined) {
    throw new AnnotationRangeError("overlap", blockId, clash.threadId);
  }
  return { texts, lo, hi };
}

export function createAnnotation(
  ydoc: Y.Doc,
  blockId: string,
  startIndex: number,
  endIndex: number,
  author: string,
  text: string,
  target?: { row: number; column: number } | { part: CardPart | "caption" },
  attribution?: CommentAttribution,
): Annotation {
  const { texts, lo, hi } = annotationRange(ydoc, blockId, startIndex, endIndex, target);

  const id = crypto.randomUUID();
  const opening: AnnotationComment = {
    author,
    text,
    createdAt: new Date().toISOString(),
    ...attribution,
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

/** Move every old anchor to one validated range, keeping the thread and replies. */
export function moveAnnotation(
  ydoc: Y.Doc,
  threadId: string,
  blockId: string,
  startIndex: number,
  endIndex: number,
  author: string,
  text: string,
  target?: { row: number; column: number } | { part: CardPart | "caption" },
  attribution?: CommentAttribution,
): Annotation | null {
  const thread = threadMap(ydoc, threadId);
  if (thread === null) return null;
  const { texts, lo, hi } = annotationRange(ydoc, blockId, startIndex, endIndex, target, threadId);
  ydoc.transact(() => {
    // Clear shadowed copies too so a later repair cannot restore an old anchor.
    for (const child of getBlocksFragment(ydoc).toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      for (const { texts: oldTexts } of annotationTexts(child)) {
        for (const run of commentRuns(oldTexts)) {
          if (run.threadId === threadId) formatRange(oldTexts, run.start, run.end, null);
        }
      }
    }
    formatRange(texts, lo, hi, { threadId });
    thread.set("blockId", blockId);
    commentRows(thread).push([{ author, text, createdAt: new Date().toISOString(), ...attribution }]);
  });
  return readThread(thread);
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

function* visibleAnnotationParts(ydoc: Y.Doc) {
  const claimed = new Set<string>();
  for (const child of getBlocksFragment(ydoc).toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const blockId = child.getAttribute("id") ?? "";
    if (blockId === "" || claimed.has(blockId)) continue;
    claimed.add(blockId);
    for (const part of annotationTexts(child)) yield { blockId, ...part };
  }
}

function annotationPlainText(texts: readonly Y.XmlText[]): string {
  // Foreign embeds occupy one Yjs offset even without displayed text.
  return texts.flatMap(value => value.toDelta() as Array<{ insert?: unknown }>)
    .map(op => typeof op.insert === "string" ? op.insert : op.insert === undefined ? "" : "\uFFFC").join("");
}

/** Anchored text across visible blocks, independent of a thread's recorded block. */
export function annotationAnchors(ydoc: Y.Doc): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const { texts } of visibleAnnotationParts(ydoc)) {
    const plain = annotationPlainText(texts);
    for (const run of commentRuns(texts)) {
      const prior = anchors.get(run.threadId);
      const text = plain.slice(run.start, run.end);
      anchors.set(run.threadId, prior === undefined ? text : `${prior} … ${text}`);
    }
  }
  return anchors;
}

/**
 * Prefer the recorded block while marked; otherwise use the first visible
 * marked block. Each anchor spans the first to last mark in its first part.
 */
export function resolveAnnotationAnchors(ydoc: Y.Doc): Map<string, AnnotationAnchor> {
  const recordedBlocks = new Map<string, string>();
  for (const [id, value] of getAnnotationsMap(ydoc)) {
    if (isThreadMap(value)) recordedBlocks.set(id, value.get("blockId") as string);
  }
  const anchors = new Map<string, AnnotationAnchor>();
  if (recordedBlocks.size === 0) return anchors;
  for (const { blockId, texts, ...coordinates } of visibleAnnotationParts(ydoc)) {
    const spans = new Map<string, { start: number; end: number }>();
    for (const run of commentRuns(texts)) {
      if (!recordedBlocks.has(run.threadId)) continue;
      const span = spans.get(run.threadId);
      if (span === undefined) spans.set(run.threadId, { start: run.start, end: run.end });
      else span.end = run.end;
    }
    if (spans.size === 0) continue;
    const plain = annotationPlainText(texts);
    for (const [threadId, span] of spans) {
      const prior = anchors.get(threadId);
      if (prior !== undefined && (blockId !== recordedBlocks.get(threadId) || prior.blockId === blockId)) continue;
      anchors.set(threadId, {
        blockId,
        range: { ...coordinates, ...span, collapsed: span.start === span.end },
        text: plain.slice(span.start, span.end),
      });
    }
  }
  return anchors;
}

/** Losing every visible mark leaves the stored thread intact and unanchored. */
export function resolveAnnotationRange(
  ydoc: Y.Doc,
  threadId: string,
): AnnotationRange | null {
  return resolveAnnotationAnchors(ydoc).get(threadId)?.range ?? null;
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
  attribution?: CommentAttribution,
): Annotation | null {
  const thread = threadMap(ydoc, threadId);
  if (thread === null) return null;
  const comment: AnnotationComment = {
    author,
    text,
    createdAt: new Date().toISOString(),
    ...attribution,
  };
  ydoc.transact(() => {
    commentRows(thread).push([comment]);
  });
  return readThread(thread);
}

/** Replace only this account's comment, retaining attribution and array position. */
export function editComment(
  ydoc: Y.Doc,
  threadId: string,
  commentId: string,
  account: string,
  text: string,
): Annotation | null {
  const thread = threadMap(ydoc, threadId);
  if (thread === null || thread.get("resolved") === true || !isGithubUsername(account) || text.trim() === "") return null;
  const rows = commentRows(thread);
  const comment = readCommentRows(rows).find((entry) => entry.id === commentId);
  if (comment === undefined || !isGithubUsername(comment.value.account) ||
      comment.value.account.toLowerCase() !== account.toLowerCase()) return null;
  const replacement = { ...comment.value, text, commentId, editedAt: new Date().toISOString() };
  ydoc.transact(() => {
    for (const index of [...comment.indices].reverse()) rows.delete(index, 1);
    rows.insert(comment.indices[0], [replacement]);
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
