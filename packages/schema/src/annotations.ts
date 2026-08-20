/**
 * Annotation threads.
 *
 * A thread is plain JSON in the `annotations` Y.Map, keyed by thread id. Its
 * range is stored as two base64-encoded Yjs RelativePositions pointing into the
 * anchored block's Y.XmlText, so the range tracks the text through concurrent
 * edits instead of rotting into stale offsets.
 *
 * Association: the anchor is right-associated and the head is left-associated.
 * Consequence — text typed strictly inside the range extends it; text typed at
 * either boundary lands outside it; deleting the annotated text collapses the
 * range to a point (`collapsed: true`) rather than losing it.
 *
 * Thread bodies are replaced wholesale on write (last-write-wins per thread).
 * That is the right granularity: threads are small and append-mostly, and it
 * keeps annotation state readable as JSON by every consumer.
 */

import * as Y from "yjs";
import { getAnnotationsMap } from "./doc.js";
import { BlockNotFoundError } from "./errors.js";
import { blockTextType, findBlockElement } from "./blocks.js";
import type { Annotation, AnnotationRange } from "./types.js";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodePosition(position: Y.RelativePosition): string {
  return toBase64(Y.encodeRelativePosition(position));
}

function decodePosition(encoded: string): Y.RelativePosition {
  return Y.decodeRelativePosition(fromBase64(encoded));
}

function isAnnotation(value: unknown): value is Annotation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Annotation>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.blockId === "string" &&
    typeof candidate.anchor === "string" &&
    typeof candidate.head === "string" &&
    Array.isArray(candidate.comments)
  );
}

/**
 * Create an annotation thread over `[startIndex, endIndex)` of a block's text.
 *
 * Indices are clamped to the block's text length and swapped if reversed.
 *
 * @throws BlockNotFoundError when the block does not exist.
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

  let ytext = blockTextType(element);
  if (ytext === null) {
    ydoc.transact(() => {
      element.insert(0, [new Y.XmlText()]);
    });
    ytext = blockTextType(element);
    if (ytext === null) throw new BlockNotFoundError(blockId);
  }

  const length = ytext.length;
  const lo = Math.max(0, Math.min(length, Math.min(startIndex, endIndex)));
  const hi = Math.max(0, Math.min(length, Math.max(startIndex, endIndex)));

  // Right-associated anchor, left-associated head: the range holds the text it
  // was created over and does not swallow typing at its boundaries.
  const annotation: Annotation = {
    id: crypto.randomUUID(),
    blockId,
    anchor: encodePosition(Y.createRelativePositionFromTypeIndex(ytext, lo, 0)),
    head: encodePosition(Y.createRelativePositionFromTypeIndex(ytext, hi, -1)),
    comments: [{ author, text, createdAt: new Date().toISOString() }],
  };

  const annotations = getAnnotationsMap(ydoc);
  ydoc.transact(() => {
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
 * Resolve a thread's stored relative positions back to absolute indices in its
 * block's current text.
 *
 * Returns null when the thread is unknown, when its block has been deleted, or
 * when the positions no longer point into that block's live text. Returns a
 * range with `collapsed: true` when the annotated text itself was deleted but
 * the block survives — the thread still has a meaningful insertion point.
 */
export function resolveAnnotationRange(
  ydoc: Y.Doc,
  threadId: string,
): AnnotationRange | null {
  const annotation = getAnnotation(ydoc, threadId);
  if (annotation === null) return null;

  const element = findBlockElement(ydoc, annotation.blockId);
  if (element === null) return null;
  const ytext = blockTextType(element);
  if (ytext === null) return null;

  const anchor = Y.createAbsolutePositionFromRelativePosition(
    decodePosition(annotation.anchor),
    ydoc,
  );
  const head = Y.createAbsolutePositionFromRelativePosition(
    decodePosition(annotation.head),
    ydoc,
  );
  if (anchor === null || head === null) return null;
  // A deleted block can still yield a position on a detached type; require the
  // resolved type to be this block's live text.
  if (anchor.type !== ytext || head.type !== ytext) return null;

  const start = Math.min(anchor.index, head.index);
  const end = Math.max(anchor.index, head.index);
  return { start, end, collapsed: start === end };
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

/** Mark a thread resolved or unresolved. Returns the updated thread. */
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

/** Remove a thread entirely. Returns true when something was removed. */
export function deleteAnnotation(ydoc: Y.Doc, threadId: string): boolean {
  const annotations = getAnnotationsMap(ydoc);
  if (!annotations.has(threadId)) return false;
  ydoc.transact(() => {
    annotations.delete(threadId);
  });
  return true;
}
