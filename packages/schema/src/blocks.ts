/**
 * Block reads and block-scoped writes.
 *
 * Every write in this module touches exactly one block. There is deliberately
 * no whole-document replace: a document-scoped write would clobber concurrent
 * human edits, which is the failure mode the whole model exists to prevent.
 *
 * On-wire shape of one block:
 *
 *   <heading id="…" level="2">Y.XmlText("Some title")</heading>
 *
 * The single Y.XmlText child holds the block's plain-text source. `code` and
 * `mermaid` are text-source blocks too — a rich block is a text block with a
 * fancy renderer, never a different storage shape.
 */

import * as Y from "yjs";
import fastDiff from "fast-diff";
import { getBlocksFragment } from "./doc.js";
import { BlockNotFoundError, StaleBlockError } from "./errors.js";
import { isBlockType } from "./types.js";
import type { Block, BlockInput, BlockType, HeadingLevel } from "./types.js";

const DIFF_DELETE = -1;
const DIFF_EQUAL = 0;
const DIFF_INSERT = 1;

function normalizeLevel(level: number | undefined): HeadingLevel {
  if (level === undefined) return 1;
  const rounded = Math.trunc(level);
  if (rounded < 1) return 1;
  if (rounded > 6) return 6;
  return rounded as HeadingLevel;
}

function elementType(element: Y.XmlElement): BlockType {
  // Unknown node names are read as paragraphs rather than throwing: a reader
  // must never be broken by a writer that knows one more block type than it.
  return isBlockType(element.nodeName) ? element.nodeName : "paragraph";
}

/**
 * The Y.XmlText holding a block's source, or null when the element has no text
 * child yet (possible for an element created by another client mid-transaction).
 */
function textOf(element: Y.XmlElement): Y.XmlText | null {
  const first = element.firstChild;
  return first instanceof Y.XmlText ? first : null;
}

/** Read a Y.XmlText as plain text, ignoring any formatting attributes. */
function readText(text: Y.XmlText | null): string {
  if (text === null) return "";
  let out = "";
  for (const op of text.toDelta() as Array<{ insert?: unknown }>) {
    if (typeof op.insert === "string") out += op.insert;
  }
  return out;
}

function elementChildren(fragment: Y.XmlFragment): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement) out.push(child);
  }
  return out;
}

function indexOfBlock(fragment: Y.XmlFragment, blockId: string): number {
  const children = fragment.toArray();
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child instanceof Y.XmlElement && child.getAttribute("id") === blockId) {
      return i;
    }
  }
  return -1;
}

/** @internal — shared with the annotations module. */
export function findBlockElement(
  ydoc: Y.Doc,
  blockId: string,
): Y.XmlElement | null {
  for (const element of elementChildren(getBlocksFragment(ydoc))) {
    if (element.getAttribute("id") === blockId) return element;
  }
  return null;
}

/** @internal — shared with the annotations module. */
export function blockTextType(element: Y.XmlElement): Y.XmlText | null {
  return textOf(element);
}

function toBlock(element: Y.XmlElement): Block {
  const type = elementType(element);
  const id = element.getAttribute("id") ?? "";
  const text = readText(textOf(element));
  if (type === "heading") {
    const raw = element.getAttribute("level");
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return {
      id,
      type,
      text,
      level: Number.isNaN(parsed) ? 1 : normalizeLevel(parsed),
    };
  }
  if (type === "code") {
    return { id, type, text, language: element.getAttribute("language") ?? "" };
  }
  return { id, type, text };
}

/** All blocks, in document order. */
export function getBlocks(ydoc: Y.Doc): Block[] {
  return elementChildren(getBlocksFragment(ydoc)).map(toBlock);
}

/** One block by id, or null when it does not exist (or was deleted). */
export function getBlock(ydoc: Y.Doc, blockId: string): Block | null {
  const element = findBlockElement(ydoc, blockId);
  return element === null ? null : toBlock(element);
}

/** One block's plain-text source. Throws {@link BlockNotFoundError} if absent. */
export function getBlockText(ydoc: Y.Doc, blockId: string): string {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  return readText(textOf(element));
}

function buildElement(id: string, input: BlockInput): Y.XmlElement {
  const element = new Y.XmlElement(input.type);
  element.setAttribute("id", id);
  if (input.type === "heading") {
    element.setAttribute("level", String(normalizeLevel(input.level)));
  }
  if (input.type === "code" && input.language !== undefined) {
    element.setAttribute("language", input.language);
  }
  element.insert(0, [new Y.XmlText(input.text ?? "")]);
  return element;
}

/**
 * Insert a block after `afterBlockId`, or at the start of the document when
 * `afterBlockId` is null. Returns the new block's stable id.
 *
 * Throws {@link BlockNotFoundError} when `afterBlockId` does not exist.
 */
export function insertBlock(
  ydoc: Y.Doc,
  afterBlockId: string | null,
  input: BlockInput,
): string {
  const fragment = getBlocksFragment(ydoc);
  const id = crypto.randomUUID();
  ydoc.transact(() => {
    let index = 0;
    if (afterBlockId !== null) {
      const found = indexOfBlock(fragment, afterBlockId);
      if (found === -1) throw new BlockNotFoundError(afterBlockId);
      index = found + 1;
    }
    fragment.insert(index, [buildElement(id, input)]);
  });
  return id;
}

/** Insert a block at the end of the document. Returns the new block's id. */
export function appendBlock(ydoc: Y.Doc, input: BlockInput): string {
  const fragment = getBlocksFragment(ydoc);
  const id = crypto.randomUUID();
  ydoc.transact(() => {
    fragment.insert(fragment.length, [buildElement(id, input)]);
  });
  return id;
}

/** Delete a block. Throws {@link BlockNotFoundError} when it is already gone. */
export function deleteBlock(ydoc: Y.Doc, blockId: string): void {
  const fragment = getBlocksFragment(ydoc);
  ydoc.transact(() => {
    const index = indexOfBlock(fragment, blockId);
    if (index === -1) throw new BlockNotFoundError(blockId);
    fragment.delete(index, 1);
  });
}

/** Set a heading's level. No-op for non-heading blocks' semantics; still stored. */
export function setBlockLevel(
  ydoc: Y.Doc,
  blockId: string,
  level: HeadingLevel,
): void {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  ydoc.transact(() => {
    element.setAttribute("level", String(normalizeLevel(level)));
  });
}

/** Set a code block's language. */
export function setBlockLanguage(
  ydoc: Y.Doc,
  blockId: string,
  language: string,
): void {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  ydoc.transact(() => {
    element.setAttribute("language", language);
  });
}

/**
 * THE core write.
 *
 * In one transaction: locate the block, verify its current text is exactly
 * `oldText`, then apply `fast-diff(oldText, newText)` as minimal
 * retain/delete/insert splices to the block's Y.XmlText.
 *
 * The minimal-splice property is what makes concurrent human+agent editing
 * safe: characters the edit did not touch are never deleted and reinserted, so
 * a concurrent edit elsewhere in the same block — or at the block's very end —
 * survives the merge instead of being clobbered.
 *
 * @throws BlockNotFoundError when the block does not exist (including when a
 * concurrent client deleted it).
 * @throws StaleBlockError when the block's text is not `oldText`. The error
 * carries `currentText` so the caller can re-read, re-diff and retry.
 */
export function editBlock(
  ydoc: Y.Doc,
  blockId: string,
  oldText: string,
  newText: string,
): void {
  ydoc.transact(() => {
    const element = findBlockElement(ydoc, blockId);
    if (element === null) throw new BlockNotFoundError(blockId);

    let text = textOf(element);
    const current = readText(text);
    if (current !== oldText) {
      throw new StaleBlockError(blockId, oldText, current);
    }
    if (oldText === newText) return;

    if (text === null) {
      // Nothing to splice into yet: materialise the text child.
      const created = new Y.XmlText();
      element.insert(0, [created]);
      text = created;
    }

    let index = 0;
    for (const [op, chunk] of fastDiff(oldText, newText)) {
      if (op === DIFF_EQUAL) {
        index += chunk.length;
      } else if (op === DIFF_DELETE) {
        text.delete(index, chunk.length);
      } else if (op === DIFF_INSERT) {
        text.insert(index, chunk);
        index += chunk.length;
      }
    }
  });
}
