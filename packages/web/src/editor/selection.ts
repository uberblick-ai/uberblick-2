/**
 * Translate PM positions to visible character offsets for one block or cell.
 * Clamp cross-block/cell selections to the first target in document order and
 * quote only that range. Flat text preserves PM/Yjs offsets; inline nodes do not.
 *
 * Verify string-only Y text and matching lengths on every read. A block with
 * multiple text children passes the palette gate but PM concatenates them while
 * prose annotation APIs address the first. Embeds can share the same length
 * while counting different characters, so length alone is insufficient.
 */

import * as Y from "yjs";
import { BLOCK_TYPES, CARD_PARTS, cardPartTexts, figmaCaptionTexts, getBlocksFragment, tableCellTexts, tableRows } from "@uberblick/schema";
import type { BlockType, CardPart } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { ResolvedPos } from "@tiptap/pm/model";

/** A range in one cell, using that cell's visible character offsets. */
export interface CellTextTarget {
  kind: "cell";
  blockId: string;
  /** Cell position relative to its table, distinguishing equal offsets in cells. */
  cellPos: number;
  row: number;
  column: number;
  start: number;
  end: number;
  text: string;
  contentStart: number;
  blockType: "table";
  blockIndex: number;
  clamped: boolean;
}

/** Character offsets are scoped to one of the card's four paragraphs. */
export interface CardTextTarget extends Omit<CellTextTarget, "kind" | "cellPos" | "row" | "column" | "blockType"> {
  kind: "card";
  part: CardPart;
  blockType: "card";
}

/** Character offsets are scoped to the Figma block's caption paragraph. */
export interface FigmaTextTarget extends Omit<CardTextTarget, "kind" | "part" | "blockType"> {
  kind: "figma";
  part: "caption";
  blockType: "figma";
}

function partCommentTargetOf(editor: Editor, ydoc: Y.Doc): CardTextTarget | FigmaTextTarget | null {
  const { selection, doc } = editor.state;
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  const { $from } = selection;
  if ($from.depth !== 3) return null;
  const block = $from.node(1);
  if (block.type.name !== "card" && block.type.name !== "figma") return null;
  const part = block.type.name === "figma" ? "caption" : CARD_PARTS[$from.index(1)];
  if (part === undefined || typeof block.attrs.id !== "string" || block.attrs.id === "") return null;
  const contentStart = $from.start(3);
  const contentEnd = contentStart + $from.parent.content.size;
  const to = Math.min(selection.to, contentEnd);
  if (to <= selection.from) return null;
  let length = 0;
  let matched = false;
  for (const child of getBlocksFragment(ydoc).toArray()) {
    if (!(child instanceof Y.XmlElement) || child.getAttribute("id") !== block.attrs.id) continue;
    const texts = part === "caption" ? figmaCaptionTexts(child) : cardPartTexts(child, part);
    for (const text of texts) {
      for (const op of text.toDelta() as Array<{ insert?: unknown }>) {
        if (typeof op.insert !== "string") return null;
        length += op.insert.length;
      }
    }
    matched = true;
    break;
  }
  if (!matched || length !== $from.parent.content.size) return null;
  const target = {
    blockId: block.attrs.id, start: selection.from - contentStart,
    end: to - contentStart, text: doc.textBetween(selection.from, to), contentStart,
    blockIndex: $from.index(0), clamped: selection.to > contentEnd,
  };
  return part === "caption"
    ? { ...target, kind: "figma", part, blockType: "figma" }
    : { ...target, kind: "card", part, blockType: "card" };
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
    row: $from.index(1), column: $from.index(2),
    start, end, text: doc.textBetween(from, to), contentStart,
    blockType: "table", blockIndex: $from.index(0), clamped: false,
  };
}

/** Clamp a text drag or rectangular cell selection to its first cell. */
function cellCommentTargetOf(editor: Editor, ydoc: Y.Doc): CellTextTarget | null {
  const { selection, doc } = editor.state;
  let from = selection.from;
  let to = selection.to;
  let clamped = false;
  if (selection instanceof CellSelection) {
    let first = Number.MAX_SAFE_INTEGER;
    let count = 0;
    selection.forEachCell((_cell, pos) => { first = Math.min(first, pos); count += 1; });
    const cell = doc.nodeAt(first);
    if (cell === null || cell.childCount !== 1 || !cell.firstChild?.isTextblock) return null;
    from = first + 2;
    to = from + cell.firstChild.content.size;
    clamped = count > 1;
  } else if (!(selection instanceof TextSelection)) return null;
  if (to <= from) return null;
  const $from = doc.resolve(from);
  const depth = cellDepth($from);
  if (depth === null) return null;
  const cell = $from.node(depth);
  if (cell.childCount !== 1 || !cell.firstChild?.isTextblock) return null;
  const table = $from.node(1);
  if (table.type.name !== "table" || typeof table.attrs.id !== "string" || table.attrs.id === "") return null;
  const contentStart = $from.before(depth) + 2;
  const contentEnd = contentStart + cell.firstChild.content.size;
  clamped ||= to > contentEnd;
  to = Math.min(to, contentEnd);
  const start = from - contentStart;
  const end = to - contentStart;
  if (start < 0 || end <= start) return null;
  const row = $from.index(1);
  const column = $from.index(2);
  // Concurrent first writes can leave several Y texts in one paragraph. The
  // schema and editor concatenate them; reject embeds or a mismatched count.
  let length = 0;
  let matched = false;
  for (const element of getBlocksFragment(ydoc).toArray()) {
    if (!(element instanceof Y.XmlElement) || element.getAttribute("id") !== table.attrs.id) continue;
    const storedCell = tableRows(element)[row]?.[column];
    if (storedCell === undefined) return null;
    for (const text of tableCellTexts(storedCell)) {
      for (const op of text.toDelta() as Array<{ insert?: unknown }>) {
        if (typeof op.insert !== "string") return null;
        length += op.insert.length;
      }
    }
    matched = true;
    break;
  }
  if (!matched || length !== cell.firstChild.content.size) return null;
  return {
    kind: "cell", blockId: table.attrs.id,
    cellPos: $from.before(depth) - $from.before(1), row, column,
    start, end, text: doc.textBetween(from, to), contentStart,
    blockType: "table", blockIndex: $from.index(0), clamped,
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
   * Restore the caret at contentStart + end, including for clamped selections.
   */
  contentStart: number;
}

/**
 * Use the first matching block and its first Y.XmlText, matching prose annotation
 * APIs. Walk siblings so finding an early block does not materialize the fragment.
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
 * Count only string inserts in the annotation API's text. An embed counts one
 * Y index with no PM position and must refuse even if total lengths agree.
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
 * Reject empty/node selections, unnamed blocks and PM/Y text mismatches.
 * Run cheap PM checks first; collapsed typing must not walk the Yjs fragment.
 */
export function commentTargetOf(editor: Editor, ydoc: Y.Doc): CommentTarget | CellTextTarget | CardTextTarget | FigmaTextTarget | null {
  const { selection, doc } = editor.state;
  if (selection.empty) return null;

  // Use $from so backward drags also clamp to the first block in document order.
  const $from = selection.$from;
  if ($from.depth < 1) return null;
  const blockPos = $from.before(1);
  const block = doc.nodeAt(blockPos);
  if (block === null) return null;

  const type = block.type.name;
  if (type === "table") return cellCommentTargetOf(editor, ydoc);
  if (type === "card" || type === "figma") return partCommentTargetOf(editor, ydoc);
  if (!(BLOCK_TYPES as readonly string[]).includes(type)) return null;
  const blockId = block.attrs.id;
  if (typeof blockId !== "string" || blockId === "") return null;

  // The block's content spans (blockPos + 1) … (blockPos + nodeSize - 1).
  const contentStart = blockPos + 1;
  const contentEnd = blockPos + block.nodeSize - 1;

  // Read Yjs last; mismatched text/embeds would make these offsets mark wrong characters.
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
