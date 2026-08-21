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
 * declare (`underline`, say) loses the whole text node.
 *
 * A mark the schema *does* declare but the enclosing block may not hold is
 * foreign too, and fails more quietly. `schema.text` never validates marks
 * against the parent node, so nothing throws and nothing is deleted — the editor
 * just holds an invalid document until the next write normalises the mark out of
 * it. An inline mark inside a `code` or `mermaid` block is exactly that: those
 * nodes hold source text, so `comment` is the only mark they allow.
 *
 * A Y.XmlText's *content* is the third case, and the quietest one.
 * `createTextNodesFromYText` only ever calls `schema.text(delta.insert, marks)`,
 * so a delta op whose `insert` is not a string (an embed, written with
 * `insertEmbed`) has no ProseMirror representation at all. Nothing throws and
 * nothing is deleted at bind time — but the embed is absent from the editor
 * state, so the next keystroke round-trips the block's text back onto the
 * Y.XmlText without it. That is silent data loss on a later mutation rather than
 * on binding, which makes it worse, not better. A block is safe to bind only
 * when its children are all Y.XmlText, those texts insert nothing but strings,
 * and those strings carry nothing but marks the block itself allows.
 */

import * as Y from "yjs";
import { BLOCK_TYPES, isBlockType } from "@uberblick/schema";
import { uberblickSchema } from "./create-editor.js";

/** The node names the editor may render. Identical to the schema's block types. */
export const BLOCK_NODE_NAMES: readonly string[] = BLOCK_TYPES;

/** Content in the `blocks` fragment that the palette cannot render. */
export interface ForeignBlock {
  /** Position of the *top-level* element in the fragment, in document order. */
  index: number;
  /**
   * What the palette cannot represent: an unknown node name, `#text`/`#hook`
   * for a stray non-element, `#mark:<name>` for an undeclared mark, or
   * `#embed` for a non-string delta insertion.
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

/** Whether `blockName`'s node type allows `mark`, read off the editor's schema. */
function blockAllowsMark(blockName: string, mark: string): boolean {
  const node = uberblickSchema.nodes[blockName];
  const type = uberblickSchema.marks[mark];
  return node !== undefined && type !== undefined && node.allowsMarkType(type);
}

/**
 * What inside an otherwise-renderable block the palette cannot represent, or
 * `null` when the child is fine. A block's children must be Y.XmlText, and a
 * Y.XmlText may only insert strings, carrying only marks that block allows.
 */
function foreignInsideBlock(
  blockName: string,
  child: Y.XmlElement | Y.XmlText | Y.XmlHook,
): string | null {
  if (child instanceof Y.XmlElement) return child.nodeName;
  if (!(child instanceof Y.XmlText)) return "#hook";
  for (const op of child.toDelta() as Array<{
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }>) {
    // Embeds have no ProseMirror equivalent, so binding drops them from the
    // editor state and the next edit writes the text back without them.
    if (typeof op.insert !== "string") return "#embed";
    for (const mark of Object.keys(op.attributes ?? {})) {
      if (!blockAllowsMark(blockName, mark)) return `#mark:${mark}`;
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
      const nodeName = foreignInsideBlock(child.nodeName, inner);
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
