/**
 * The prose selection, as the annotation API wants it.
 *
 * `createAnnotation` anchors a thread in ONE block at character offsets into
 * that block's text, while a ProseMirror selection is a pair of document
 * positions. Translating between them is this module's whole job.
 *
 * Two facts make the translation exact rather than approximate:
 *
 * 1. The supported comment targets are flat text blocks (see editor/nodes.ts), so an
 *    inline position always resolves at depth 1 and `parentOffset` is already
 *    the offset into the block's text. Structured tables are refused until
 *    table-cell anchoring supplies its own index space.
 * 2. The palette has no inline nodes other than text, so a ProseMirror content
 *    offset counts the same characters a Y.XmlText index does. An inline node
 *    would count as one position and two indices would drift apart — which is
 *    why the palette gate (palette.ts) refusing foreign content also protects
 *    this mapping.
 *
 * A selection spanning more than one block is **clamped to the first block of
 * the selected range**, and says so. First in document order — the range's
 * `$from`, whichever way the drag went, so a backwards drag clamps to the block
 * it ended in rather than the one it started in. A thread has exactly one
 * anchor block, so the honest choices are clamping or refusing; clamping keeps
 * the gesture working, and the composer quotes the clamped text back so nothing
 * is annotated unseen.
 *
 * Fact 2 above is checked rather than assumed, because the palette gate does
 * not cover every way the two index spaces drift apart. That gate refuses
 * foreign content before binding *and* unbinds the editor when a transaction
 * delivers some (see guarded-binding.ts) — but a block element carrying two
 * Y.XmlText children is not foreign to it: both children are plain text with
 * declared marks, so every question the gate asks answers "fine". One can
 * arrive from a peer at any moment, and ProseMirror then shows the two texts
 * concatenated while `createAnnotation` indexes only the first, so an offset
 * read off the editor would mark the wrong characters — or none.
 *
 * So the block's Y index space is measured on every read and the target refused
 * unless it agrees with ProseMirror's: the same character count, with nothing
 * in it but string insertions. Length alone is not enough — an embed occupies
 * one Y index and has no ProseMirror representation at all, so a block holding
 * one can agree on length while the two sides count different characters. That
 * half is defence in depth: as things stand an embed never reaches this
 * function — the gate unbinds the editor on the transaction that delivers one,
 * and y-prosemirror empties the whole block rather than rendering a text run it
 * cannot build, which the length alone would catch. Both are somebody else's
 * implementation detail, and this read is cheap enough not to rest on either.
 */

import * as Y from "yjs";
import { BLOCK_TYPES, getBlocksFragment } from "@uberblick/schema";
import type { BlockType } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { ResolvedPos } from "@tiptap/pm/model";

/** A formatting range in one cell; it is deliberately not an annotation target. */
export interface CellTextTarget {
  kind: "cell";
  blockId: string;
  /** Cell position relative to its table, distinguishing equal offsets in cells. */
  cellPos: number;
  start: number;
  end: number;
  text: string;
  contentStart: number;
  blockType: "table";
  blockIndex: number;
  clamped: false;
}

function cellDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 1; depth -= 1) {
    if (["cell", "header_cell"].includes($pos.node(depth).type.spec.tableRole ?? "")) return depth;
  }
  return null;
}

/** Both text endpoints, or the actual CellSelection coverage, must name one cell. */
export function cellTextTargetOf(editor: Editor): CellTextTarget | null {
  const { selection, doc } = editor.state;
  let from = selection.from;
  let to = selection.to;
  if (selection instanceof CellSelection) {
    // CellSelection's ordinary endpoints describe only its head cell, even
    // when dragging or Shift+Arrow selected several cells.
    if (selection.$anchorCell.pos !== selection.$headCell.pos) return null;
    const cell = selection.$anchorCell.nodeAfter;
    if (cell === null || cell.childCount !== 1 || !cell.firstChild?.isTextblock) return null;
    from = selection.$anchorCell.pos + 2;
    to = from + cell.firstChild.content.size;
  } else if (!(selection instanceof TextSelection)) return null;
  if (to <= from) return null;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  const depth = cellDepth($from);
  const endDepth = cellDepth($to);
  if (depth === null || endDepth === null || $from.before(depth) !== $to.before(endDepth)) return null;
  const cell = $from.node(depth);
  // The shipped cell vocabulary is exactly one flat paragraph. Refuse any
  // different structure rather than projecting an ambiguous range.
  if (cell.childCount !== 1 || !cell.firstChild?.isTextblock || $from.parent !== $to.parent) return null;
  const table = $from.node(1);
  if (table.type.name !== "table" || typeof table.attrs.id !== "string" || table.attrs.id === "") return null;
  const contentStart = $from.before(depth) + 2;
  const start = from - contentStart;
  const end = to - contentStart;
  if (start < 0 || end > cell.firstChild.content.size) return null;
  return {
    kind: "cell", blockId: table.attrs.id,
    cellPos: $from.before(depth) - $from.before(1),
    start, end, text: doc.textBetween(from, to), contentStart,
    blockType: "table", blockIndex: $from.index(0), clamped: false,
  };
}

/** A range the annotation API can anchor a thread to. */
export interface CommentTarget {
  blockId: string;
  /** Character offsets into the block's text, `[start, end)`. */
  start: number;
  end: number;
  /** Exactly the text the `comment` mark would cover. */
  text: string;
  blockType: BlockType;
  /** The block's position in the document, for a human-readable reference. */
  blockIndex: number;
  /** The selection reached outside this block; only this block is annotated. */
  clamped: boolean;
  /**
   * Document position of the block's first character, so the caret can be put
   * back at `contentStart + end` — the end of the range actually marked, which
   * for a clamped selection is not where the selection ended.
   */
  contentStart: number;
}

/**
 * A block's FIRST Y.XmlText — the only one the schema package reads or marks —
 * or null when the block is not in the fragment or has no text child yet.
 *
 * The first element to claim an id is the visible block, so the walk stops at
 * the first match, the same rule the schema package's own walk follows. Sibling
 * by sibling rather than over `toArray()`, which would materialise every block
 * in the document before the first one could be looked at.
 */
function anchorText(ydoc: Y.Doc, blockId: string): Y.XmlText | null {
  // `!= null` and not `!== null`: a Y.XmlHook has no `nextSibling` at all, so
  // an exact comparison would spin on `undefined`.
  for (
    let child = getBlocksFragment(ydoc).firstChild;
    child != null;
    child = child.nextSibling
  ) {
    if (!(child instanceof Y.XmlElement)) continue;
    if ((child.getAttribute("id") ?? "") !== blockId) continue;
    const text = child.firstChild;
    return text instanceof Y.XmlText ? text : null;
  }
  return null;
}

/**
 * The length of a block's text in the index space `createAnnotation` uses,
 * counted over the insertions of {@link anchorText}. Null when there is no such
 * text, or when it inserts anything but strings: an embed is one Y index and no
 * ProseMirror position at all, so a block holding one can match ProseMirror's
 * length while the two sides count different characters.
 */
function anchorTextLength(ydoc: Y.Doc, blockId: string): number | null {
  const text = anchorText(ydoc, blockId);
  if (text === null) return null;
  let length = 0;
  for (const op of text.toDelta() as Array<{ insert?: unknown }>) {
    if (typeof op.insert !== "string") return null;
    length += op.insert.length;
  }
  return length;
}

/**
 * The current selection as a comment target, or null when there is nothing to
 * annotate: an empty selection, a selection over a whole node rather than
 * inside one, a block with no id (a block the editor has not yet stamped — see
 * block-ids.ts — cannot be named by a thread), or a block whose Y text the
 * editor is not showing one-for-one.
 *
 * The composer runs this on every editor transaction, so the order of the
 * checks is the cost: every ProseMirror-side question is answered first, off
 * state already in memory, and the Yjs walk happens only once all of them have
 * passed. Typing with a collapsed caret — the overwhelmingly common
 * transaction — returns at the first line and reads no Y type at all; the walk
 * is O(blocks up to the anchor) and only while a real selection stands.
 */
export function commentTargetOf(editor: Editor, ydoc: Y.Doc): CommentTarget | null {
  const { selection, doc } = editor.state;
  if (selection.empty) return null;

  // `$from`, not `$anchor`: the anchor block is the first block of the *range*,
  // so a backwards drag clamps to where it ended. Direction is a gesture, and
  // "the earlier of the two ends" is the description a reader can check against
  // the highlight.
  const $from = selection.$from;
  if ($from.depth < 1) return null;
  const blockPos = $from.before(1);
  const block = doc.nodeAt(blockPos);
  if (block === null) return null;

  const type = block.type.name;
  if (type === "table") return null;
  if (!(BLOCK_TYPES as readonly string[]).includes(type)) return null;
  const blockId = block.attrs.id;
  if (typeof blockId !== "string" || blockId === "") return null;

  // The block's content spans (blockPos + 1) … (blockPos + nodeSize - 1).
  const contentStart = blockPos + 1;
  const contentEnd = blockPos + block.nodeSize - 1;

  // The one Y-side read in this function, and last for that reason: an offset
  // is only meaningful if both sides count the same characters, and a second
  // Y.XmlText child — or an embed the editor cannot render — means they do not.
  // Every offset below would then name the wrong text.
  if (anchorTextLength(ydoc, blockId) !== block.content.size) return null;

  const start = $from.parentOffset;
  const end = Math.min(selection.to, contentEnd) - contentStart;
  if (end <= start) return null;

  return {
    blockId,
    start,
    end,
    text: block.textBetween(start, end),
    blockType: type as BlockType,
    blockIndex: $from.index(0),
    clamped: selection.to > contentEnd,
    contentStart,
  };
}
