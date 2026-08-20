/**
 * The restricted block palette, and the gate that keeps foreign content out.
 *
 * The editor's ProseMirror schema declares exactly the four schema-owned block
 * types and exactly one mark. That is deliberate: y-prosemirror serialises a
 * ProseMirror node straight onto the `blocks` Y.XmlFragment, and its
 * `updateYFragment` removes any Yjs attribute the ProseMirror node spec does
 * not declare. A wider palette means the web client can write shapes the schema
 * package cannot read; an under-declared attribute set means the web client
 * silently deletes attributes an agent wrote.
 *
 * ## Why a gate exists at all
 *
 * y-prosemirror's `createNodeFromYElement` calls `schema.node(el.nodeName, …)`
 * and, when that throws — which is exactly what happens for a node name the
 * schema does not know — its catch block **deletes the Y.XmlElement from the
 * document**. Unknown blocks would not merely fail to render: they would be
 * destroyed in the CRDT and the deletion would replicate to every peer.
 *
 * So binding is gated. `findForeignBlocks` scans the fragment before an editor
 * is created; when it finds anything outside the palette the app refuses to
 * bind ProseMirror and renders a loud read-only fallback instead (see
 * `ui/EditorPane.tsx`). Loud, and nothing is dropped — the foreign elements
 * stay in the document untouched, which is the whole point.
 *
 * A ProseMirror schema cannot have a catch-all node type, so there is no
 * in-editor placeholder that would let us bind safely; refusing to bind is the
 * only option that preserves the data.
 *
 * ## The scan is recursive, because the hazard is
 *
 * The same catch-and-delete sits one level down. `createNodeFromYElement`
 * recurses into a block's children, and `createTextNodesFromYText` builds every
 * mark with `schema.mark(name, attrs)`; either throwing deletes the offending
 * Y type. So a *known* block name is not enough: a `<paragraph>` holding a
 * `<callout>` loses the callout, and a Y.XmlText carrying a mark the schema does not
 * declare (`bold`, say) loses the whole text node. A block is safe to bind only
 * when its children are all Y.XmlText and those texts carry nothing but the
 * marks in {@link MARK_NAMES}.
 */

import * as Y from "yjs";
import { BLOCK_TYPES, isBlockType } from "@uberblick/schema";
import { uberblickSchema } from "./create-editor.js";

/** The node names the editor may render. Identical to the schema's block types. */
export const BLOCK_NODE_NAMES: readonly string[] = BLOCK_TYPES;

/**
 * The mark keys the editor's ProseMirror schema actually registers — read off
 * the schema rather than restated, so the gate cannot drift from the palette.
 */
export const MARK_NAMES: readonly string[] = Object.keys(uberblickSchema.marks);

/** Content in the `blocks` fragment that the palette cannot render. */
export interface ForeignBlock {
  /** Position of the *top-level* element in the fragment, in document order. */
  index: number;
  /**
   * What the palette cannot represent: an unknown node name, `#text`/`#hook`
   * for a stray non-element, or `#mark:<name>` for an undeclared mark.
   */
  nodeName: string;
  /** The element's `id` attribute, when it has one. */
  id: string | null;
  /** First 80 characters of the element's text, for the loud placeholder. */
  preview: string;
}

function previewOf(child: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  const text = child instanceof Y.XmlElement ? child.toString() : String(child);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * What inside an otherwise-renderable block the palette cannot represent, or
 * `null` when the child is fine. A block's children must be Y.XmlText, and a
 * Y.XmlText may only carry marks the editor schema declares.
 */
function foreignInsideBlock(
  child: Y.XmlElement | Y.XmlText | Y.XmlHook,
): string | null {
  if (child instanceof Y.XmlElement) return child.nodeName;
  if (!(child instanceof Y.XmlText)) return "#hook";
  for (const op of child.toDelta() as Array<{
    attributes?: Record<string, unknown>;
  }>) {
    for (const mark of Object.keys(op.attributes ?? {})) {
      if (!MARK_NAMES.includes(mark)) return `#mark:${mark}`;
    }
  }
  return null;
}

/**
 * Everything in the `blocks` fragment the editor palette cannot represent, one
 * entry per offending top-level block. Empty array means the fragment is safe
 * to bind.
 *
 * Non-element children (a bare Y.XmlText directly under the fragment, which the
 * schema package never writes) count as foreign too: the editor's `doc` node is
 * `block+`, so inline content at the top level has nowhere to go.
 */
export function findForeignBlocks(fragment: Y.XmlFragment): ForeignBlock[] {
  const foreign: ForeignBlock[] = [];
  const children = fragment.toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    if (!(child instanceof Y.XmlElement)) {
      foreign.push({
        index,
        nodeName: child instanceof Y.XmlText ? "#text" : "#hook",
        id: null,
        preview: previewOf(child),
      });
      continue;
    }
    const id = child.getAttribute("id") ?? null;
    if (!isBlockType(child.nodeName)) {
      foreign.push({ index, nodeName: child.nodeName, id, preview: previewOf(child) });
      continue;
    }
    for (const inner of child.toArray()) {
      const nodeName = foreignInsideBlock(inner);
      if (nodeName === null) continue;
      // One entry per block: the count in the banner is a block count.
      foreign.push({ index, nodeName, id, preview: previewOf(child) });
      break;
    }
  }
  return foreign;
}

/** A single-line, human-readable summary for the loud placeholder. */
export function describeForeignBlocks(foreign: ForeignBlock[]): string {
  if (foreign.length === 0) return "";
  const names = [...new Set(foreign.map((block) => block.nodeName))].join(", ");
  const count = foreign.length;
  return `${count} block${count === 1 ? "" : "s"} of unsupported type (${names}) — editing is disabled so nothing gets destroyed.`;
}
