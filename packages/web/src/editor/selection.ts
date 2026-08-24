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
 *
 * Fact 2 above is checked rather than assumed, because the palette gate only
 * runs *before* an editor is bound. A block element carrying two Y.XmlText
 * children passes that gate (both children are plain text), and one can arrive
 * at any moment from a peer: ProseMirror then shows the two texts concatenated
 * while `createAnnotation` indexes only the first, so an offset read off the
 * editor would mark the wrong characters — or none. The block's Y index space
 * is measured on every read and the target refused when it disagrees with
 * ProseMirror's.
 */

import * as Y from "yjs";
import { BLOCK_TYPES, getBlocksFragment } from "@uberblick/schema";
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
  /**
   * Document position of the block's first character, so the caret can be put
   * back at `contentStart + end` — the end of the range actually marked, which
   * for a clamped selection is not where the selection ended.
   */
  contentStart: number;
}

/**
 * The length of a block's text in the index space `createAnnotation` uses: the
 * block element's FIRST Y.XmlText, which is the only one the schema package
 * reads or marks. Null when the block is not in the fragment or has no text
 * child yet.
 *
 * The first element to claim an id is the visible block, so the scan stops at
 * the first match — the same rule the schema package's own walk follows.
 */
function anchorTextLength(ydoc: Y.Doc, blockId: string): number | null {
  for (const child of getBlocksFragment(ydoc).toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if ((child.getAttribute("id") ?? "") !== blockId) continue;
    const text = child.firstChild;
    return text instanceof Y.XmlText ? text.length : null;
  }
  return null;
}

/**
 * The current selection as a comment target, or null when there is nothing to
 * annotate: an empty selection, a selection over a whole node rather than
 * inside one, a block with no id (a block the editor has not yet stamped — see
 * block-ids.ts — cannot be named by a thread), or a block whose Y text the
 * editor is not showing one-for-one.
 */
export function commentTargetOf(editor: Editor, ydoc: Y.Doc): CommentTarget | null {
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
  const contentStart = blockPos + 1;
  const contentEnd = blockPos + block.nodeSize - 1;

  // An offset is only meaningful if both sides count the same characters. A
  // second Y.XmlText child (or an embed the editor cannot render) makes the two
  // lengths disagree, and every offset below would name the wrong text.
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
