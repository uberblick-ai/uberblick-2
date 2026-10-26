import * as Y from "yjs";
import { COMMENT_MARK, isCommentMark } from "./types.js";
import type { CommentMark } from "./types.js";

interface CommentSpan {
  mark: CommentMark;
  start: number;
  end: number;
}

function commentText(text: Y.XmlText): { value: string; spans: CommentSpan[] } {
  let value = "";
  const spans: CommentSpan[] = [];
  for (const op of text.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
    const start = value.length;
    value += typeof op.insert === "string" ? op.insert : "\uFFFC";
    const mark = op.attributes?.[COMMENT_MARK];
    if (!isCommentMark(mark)) continue;
    const last = spans.at(-1);
    if (last?.mark.threadId === mark.threadId && last.end === start) last.end = value.length;
    else spans.push({ mark, start, end: value.length });
  }
  return { value, spans };
}

/** Structured inserts inherit only a comment shared by both neighbours. */
export function interiorCommentMark(text: Y.XmlText, index: number): CommentMark | undefined {
  return commentText(text).spans.find((span) => span.start < index && index < span.end)?.mark;
}

interface CommentSnapshot {
  threadId: string;
  length: number;
  start: Y.RelativePosition;
  end: Y.RelativePosition;
}

/** Relative boundaries follow each original anchor independently through the splice. */
export function snapshotCommentAnchors(text: Y.XmlText): CommentSnapshot[] {
  const { value, spans } = commentText(text);
  return spans.map((span) => ({
    threadId: span.mark.threadId,
    length: Array.from(value.slice(span.start, span.end)).length,
    start: Y.createRelativePositionFromTypeIndex(text, span.start),
    end: Y.createRelativePositionFromTypeIndex(text, span.end, -1),
  }));
}

const words = new Intl.Segmenter("en", { granularity: "word" });

function widerRange(value: string, span: CommentSpan, spans: CommentSpan[]): { start: number; end: number } {
  let lower = 0;
  let upper = value.length;
  for (const other of spans) {
    if (other.mark.threadId === span.mark.threadId) continue;
    if (other.end <= span.start) lower = Math.max(lower, other.end);
    if (other.start >= span.end) upper = Math.min(upper, other.start);
  }
  let { start, end } = span;
  for (const word of words.segment(value)) {
    if (word.isWordLike && word.index < span.end && word.index + word.segment.length > span.start) {
      start = Math.min(start, Math.max(lower, word.index));
      end = Math.max(end, Math.min(upper, word.index + word.segment.length));
    }
  }
  // Code-point boundaries retain Yjs's UTF-16 offsets without splitting a pair.
  const boundaries = [0];
  for (const character of value) boundaries.push((boundaries.at(-1) ?? 0) + character.length);
  let first = boundaries.indexOf(start);
  let last = boundaries.indexOf(end);
  while (last - first < 3) {
    if (last + 1 < boundaries.length && (boundaries[last + 1] ?? upper + 1) <= upper) last += 1;
    else if (first > 0 && (boundaries[first - 1] ?? -1) >= lower) first -= 1;
    else break;
  }
  return { start: boundaries[first] ?? start, end: boundaries[last] ?? end };
}

/** Widen surviving shortened anchors only; a deleted anchor must remain orphaned. */
export function widenShortenedCommentAnchors(text: Y.XmlText, before: readonly CommentSnapshot[]): void {
  const doc = text.doc;
  if (doc === null || before.length === 0) return;
  const { value, spans } = commentText(text);
  const shortened = spans.filter((span) => {
    const length = Array.from(value.slice(span.start, span.end)).length;
    return length < 3 && before.some((anchor) => {
      if (anchor.threadId !== span.mark.threadId || anchor.length <= length) return false;
      const start = Y.createAbsolutePositionFromRelativePosition(anchor.start, doc);
      const end = Y.createAbsolutePositionFromRelativePosition(anchor.end, doc);
      return start !== null && end !== null && start.index < span.end && span.start < end.index && start.index < end.index;
    });
  });
  for (const span of shortened) {
    const range = widerRange(value, span, spans);
    text.format(range.start, range.end - range.start, { [COMMENT_MARK]: span.mark });
    Object.assign(span, range);
  }
}
