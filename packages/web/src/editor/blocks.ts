/** Top-level block lookups and transaction rules shared by the editor's block extensions. */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import { INLINE_PART_MARKS } from "@uberblick/schema";

/** The top-level block carrying `id`, with its current position. */
export function findBlockById(
  doc: ProseMirrorNode,
  id: string,
): { pos: number; node: ProseMirrorNode } | null {
  let pos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const node = doc.child(index);
    if (node.attrs.id === id) return { pos, node };
    pos += node.nodeSize;
  }
  return null;
}

/**
 * Close Yjs's capture interval so the next change is its own undo step. A
 * conversion otherwise coalesces with the typing that triggered it, and undo
 * would restore the empty paragraph rather than the typed trigger.
 */
export function endUndoCapture(state: EditorState): void {
  const undo = yUndoPluginKey.getState(state) as
    | { undoManager?: { stopCapturing: () => void } }
    | undefined;
  undo?.undoManager?.stopCapturing();
}

/** Whether `transaction` is a remote change, an undo or a redo — not typing. */
function isChangeFromElsewhere(transaction: Transaction): boolean {
  const sync = transaction.getMeta(ySyncPluginKey) as
    | { isChangeOrigin?: boolean }
    | undefined;
  return sync?.isChangeOrigin === true;
}

/**
 * Only local typing may open a picker. Yjs undo/redo returns through ySync with
 * isChangeOrigin, just like remote edits; paste, drop and cut also stay prose.
 */
export function isTypedHere(transaction: Transaction): boolean {
  if (!transaction.docChanged) return false;
  if (isChangeFromElsewhere(transaction)) return false;
  const uiEvent = transaction.getMeta("uiEvent");
  return uiEvent !== "paste" && uiEvent !== "drop" && uiEvent !== "cut";
}

/**
 * Refuse a local transaction that leaves any `typeName` block in a shape
 * `supported` rejects. Remote edits, undo and redo arrive through ySync and
 * always pass: they mirror Yjs state that already exists.
 */
export function blockShapeGuard(
  typeName: string,
  supported: (node: ProseMirrorNode, before: EditorState) => boolean,
): Plugin {
  return new Plugin({
    filterTransaction(tr, state) {
      if (!tr.docChanged || isChangeFromElsewhere(tr)) return true;
      let valid = true;
      tr.doc.forEach((node) => {
        if (valid && node.type.name === typeName && !supported(node, state)) valid = false;
      });
      return valid;
    },
  });
}

const PART_MARKS = new Set<string>(INLINE_PART_MARKS);

/**
 * Whether a table cell, card part or Figma caption holds what the schema
 * stores: one paragraph without an id, of text carrying inline-part marks only.
 */
export function isPlainPart(part: ProseMirrorNode): boolean {
  const paragraph = part.firstChild;
  if (part.childCount !== 1 || paragraph?.type.name !== "paragraph" || paragraph.attrs.id !== null) return false;
  let plain = true;
  paragraph.forEach((text) => {
    if (!text.isText || text.marks.some((mark) => !PART_MARKS.has(mark.type.name))) plain = false;
  });
  return plain;
}
