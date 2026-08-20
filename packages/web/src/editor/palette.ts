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
 */

import * as Y from "yjs";
import { BLOCK_TYPES, COMMENT_MARK, isBlockType } from "@uberblick/schema";

/** The node names the editor may render. Identical to the schema's block types. */
export const BLOCK_NODE_NAMES: readonly string[] = BLOCK_TYPES;

/** The only mark type in the editor schema. Anchors annotation threads. */
export const MARK_NAMES: readonly string[] = [COMMENT_MARK];

/** A top-level element in the `blocks` fragment that the palette cannot render. */
export interface ForeignBlock {
  /** Position of the element in the fragment, in document order. */
  index: number;
  /** The Y.XmlElement nodeName, or a description for non-element children. */
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
 * Every top-level child of the `blocks` fragment the editor palette cannot
 * represent. Empty array means the fragment is safe to bind.
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
    if (!isBlockType(child.nodeName)) {
      foreign.push({
        index,
        nodeName: child.nodeName,
        id: child.getAttribute("id") ?? null,
        preview: previewOf(child),
      });
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
