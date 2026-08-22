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
import { BLOCK_TYPES } from "@uberblick/schema";
import type { BlockType, HeadingLevel } from "@uberblick/schema";

export interface RetypeAttrs {
  /** Heading level, 1–6. Ignored for other types. */
  level?: HeadingLevel;
  /** Code language. Ignored for other types. */
  language?: string;
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
 * Re-type the block containing the selection. Returns false when there is
 * nothing to re-type, when the block is already that type with those attrs, or
 * when the target type cannot hold the block's content.
 *
 * That last case is prose with inline marks going to `code` or `mermaid`, which
 * hold source text and allow only the `comment` mark. `setNodeMarkup` would
 * *throw* there — `validContent` checks marks as well as node types — and this is
 * a click handler, so the refusal is a `false`, not an exception. The schema
 * package refuses the same transition with a typed error; neither side strips
 * marks to force it through.
 */
export function retypeSelectedBlock(
  editor: Editor,
  type: BlockType,
  attrs: RetypeAttrs = {},
): boolean {
  const current = selectedBlock(editor);
  if (current === null) return false;

  const nodeType = editor.state.schema.nodes[type];
  if (nodeType === undefined) return false;

  // Attributes are strings, matching what the schema package stores — see
  // editor/nodes.ts. The id is carried over, never regenerated.
  const next: Record<string, unknown> = { id: current.attrs.id };
  if (type === "heading") {
    next.level = String(
      attrs.level ??
        (current.type === "heading" ? attrString(current.attrs.level) ?? "1" : "1"),
    );
  }
  if (type === "code") {
    next.language =
      attrs.language ??
      (current.type === "code" ? attrString(current.attrs.language) : null);
  }

  // Both sides normalised to `string | null`: an absent attribute reads as
  // `undefined` on a ProseMirror node but `null` in `next`, and comparing those
  // directly would make every no-op look like a change.
  const unchanged =
    current.type === type &&
    (next.level ?? null) === attrString(current.attrs.level) &&
    (next.language ?? null) === attrString(current.attrs.language);
  if (unchanged) return false;

  const node = editor.state.doc.nodeAt(current.pos);
  if (node === null || !nodeType.validContent(node.content)) return false;

  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(current.pos, nodeType, next),
  );
  return true;
}
