/**
 * The prose selection, as the annotation API wants it.
 *
 * `createAnnotation` anchors a thread in ONE block at character offsets into
 * that block's text, while a ProseMirror selection is a pair of document
 * positions. Translating between them is this module's whole job.
 *
 * Two facts make the translation exact rather than approximate:
 *
 * 1. The document is a flat sequence of blocks (see editor/nodes.ts), so an
 *    inline position always resolves at depth 1 and `parentOffset` is already
 *    the offset into the block's text.
 * 2. The palette has no inline nodes other than text, so a ProseMirror content
 *    offset counts the same characters a Y.XmlText index does. An inline node
 *    would count as one position and two indices would drift apart — which is
 *    why the palette gate (palette.ts) refusing foreign content also protects
 *    this mapping.
 *
 * A selection running past the end of its first block is **clamped to that
 * block**, and says so. A thread has exactly one anchor block, so the honest
 * choices are clamping or refusing; clamping keeps the gesture working, and the
 * composer quotes the clamped text back so nothing is annotated unseen.
 */

import { BLOCK_TYPES } from "@uberblick/schema";
import type { BlockType } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";

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
  /** The selection ran past this block; only this block is annotated. */
  clamped: boolean;
}

/**
 * The current selection as a comment target, or null when there is nothing to
 * annotate: an empty selection, a selection over a whole node rather than
 * inside one, or a block with no id (a block the editor has not yet stamped —
 * see block-ids.ts — cannot be named by a thread).
 */
export function commentTargetOf(editor: Editor): CommentTarget | null {
  const { selection, doc } = editor.state;
  if (selection.empty) return null;

  const $from = selection.$from;
  if ($from.depth < 1) return null;
  const blockPos = $from.before(1);
  const block = doc.nodeAt(blockPos);
  if (block === null) return null;

  const type = block.type.name;
  if (!(BLOCK_TYPES as readonly string[]).includes(type)) return null;
  const blockId = block.attrs.id;
  if (typeof blockId !== "string" || blockId === "") return null;

  // The block's content spans (blockPos + 1) … (blockPos + nodeSize - 1).
  const contentEnd = blockPos + block.nodeSize - 1;
  const start = $from.parentOffset;
  const end = Math.min(selection.to, contentEnd) - (blockPos + 1);
  if (end <= start) return null;

  return {
    blockId,
    start,
    end,
    text: block.textBetween(start, end),
    blockType: type as BlockType,
    blockIndex: $from.index(0),
    clamped: selection.to > contentEnd,
  };
}
