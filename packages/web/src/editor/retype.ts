/**
 * Changing a block's type from the editor.
 *
 * The invariant (CLAUDE.md): a block-type change preserves the block id and the
 * text delta, marks included. Never delete-and-reinsert, which churns ids and
 * orphans annotation anchors.
 *
 * `setNodeMarkup` is the ProseMirror move that satisfies it: it swaps the node
 * type in place and leaves the content untouched, and the new attributes are
 * built from the old node's, so the id carries over verbatim.
 *
 * What y-prosemirror then does with it is worth knowing. `updateYFragment`
 * compares node names, so a re-typed block does not match its Y.XmlElement and
 * gets replaced: a new element with the same id and a rebuilt Y.XmlText (marks
 * included, via `marksToAttributes`). The block keeps its identity, its text and
 * its annotations, but the CRDT items behind the text are new — so a *concurrent*
 * edit to the same block loses its characters. That is the same trade-off the
 * schema package documents for `setBlockType`, arrived at from the other side.
 */

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { BLOCK_TYPES } from "@uberblick/schema";
import type { BlockType, HeadingLevel, ListStyle } from "@uberblick/schema";
import { renderableIndent } from "./nodes.js";

export interface RetypeAttrs {
  /** Heading level, 1–6. Ignored for other types. */
  level?: HeadingLevel;
  /** Code language. Ignored for other types. */
  language?: string;
  /** List marker. Ignored for other types. */
  list?: ListStyle;
  /** List depth, 0–3. Ignored for other types. */
  indent?: number;
}

function attrString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The top-level block containing the selection head, with its position. */
export function selectedBlock(
  editor: Editor,
): { pos: number; type: BlockType; attrs: Record<string, unknown> } | null {
  const { $head } = editor.state.selection;
  if ($head.depth < 1) return null;
  const pos = $head.before(1);
  const node = editor.state.doc.nodeAt(pos);
  if (node === null) return null;
  const name = node.type.name;
  if (!(BLOCK_TYPES as readonly string[]).includes(name)) return null;
  return { pos, type: name as BlockType, attrs: node.attrs };
}

/**
 * Re-type the block at `pos` by adding a `setNodeMarkup` step to `tr`. Returns
 * false — leaving `tr` untouched — when there is no block there, when it is
 * already that type with those attrs, or when the target type cannot hold the
 * block's content.
 *
 * That last case is prose with inline marks going to `code` or `mermaid`, which
 * hold source text and allow only the `comment` mark. `setNodeMarkup` would
 * *throw* there — `validContent` checks marks as well as node types — and the
 * callers are UI handlers, so the refusal is a `false`, not an exception. The
 * schema package refuses the same transition with a typed error; neither side
 * strips marks to force it through.
 *
 * A transaction rather than a dispatch, because the block menu composes the
 * re-type with the step that consumes its typed `/query`: both belong to one
 * gesture, so both belong in one transaction and therefore one undo step. The
 * block is read off `tr.doc`, so an earlier step in the same transaction is what
 * `validContent` sees.
 */
export function retypeBlockInTransaction(
  tr: Transaction,
  pos: number,
  type: BlockType,
  attrs: RetypeAttrs = {},
): boolean {
  const node = tr.doc.nodeAt(pos);
  if (node === null) return false;
  const currentType = node.type.name;
  if (!(BLOCK_TYPES as readonly string[]).includes(currentType)) return false;

  const nodeType = tr.doc.type.schema.nodes[type];
  if (nodeType === undefined) return false;

  // Attributes are strings, matching what the schema package stores — see
  // editor/nodes.ts. The id is carried over, never regenerated.
  const next: Record<string, unknown> = { id: node.attrs.id };
  if (type === "heading") {
    next.level = String(
      attrs.level ??
        (currentType === "heading" ? attrString(node.attrs.level) ?? "1" : "1"),
    );
  }
  if (type === "code") {
    next.language =
      attrs.language ??
      (currentType === "code" ? attrString(node.attrs.language) : null);
  }
  if (type === "list-item") {
    const wasItem = currentType === "list-item";
    next.list =
      attrs.list ?? (wasItem ? attrString(node.attrs.list) ?? "bullet" : "bullet");
    next.indent = String(
      attrs.indent ?? (wasItem ? renderableIndent(node.attrs.indent) : 0),
    );
  }

  // Both sides normalised to `string | null`: an absent attribute reads as
  // `undefined` on a ProseMirror node but `null` in `next`, and comparing those
  // directly would make every no-op look like a change.
  const unchanged =
    currentType === type &&
    (next.level ?? null) === attrString(node.attrs.level) &&
    (next.language ?? null) === attrString(node.attrs.language) &&
    (next.list ?? null) === attrString(node.attrs.list) &&
    (next.indent ?? null) === attrString(node.attrs.indent);
  if (unchanged) return false;

  if (!nodeType.validContent(node.content)) return false;

  tr.setNodeMarkup(pos, nodeType, next);
  return true;
}

/**
 * Re-type the block containing the selection, in a transaction of its own.
 * Returns what {@link retypeBlockInTransaction} answered — nothing is dispatched
 * when the re-type is refused or is a no-op.
 */
export function retypeSelectedBlock(
  editor: Editor,
  type: BlockType,
  attrs: RetypeAttrs = {},
): boolean {
  const current = selectedBlock(editor);
  if (current === null) return false;

  const tr = editor.state.tr;
  if (!retypeBlockInTransaction(tr, current.pos, type, attrs)) return false;

  editor.view.dispatch(tr);
  return true;
}
