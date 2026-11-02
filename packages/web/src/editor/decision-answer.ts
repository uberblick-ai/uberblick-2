import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { decisionAnswerShapeFailure, getBlocksFragment } from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import * as Y from "yjs";
import { ySyncPluginKey } from "y-prosemirror";

type AnswerBlock = Pick<BlockInput, "type">;

function answerBlockCount(blocks: readonly AnswerBlock[]): number {
  return blocks.filter((block, index) => block.type !== "list-item" || blocks[index - 1]?.type !== "list-item").length;
}

/** Concurrent additions may exceed the limit; allow repairs without growing it. */
export function decisionAnswerEditAllowed(before: readonly AnswerBlock[], after: readonly AnswerBlock[]): boolean {
  if (decisionAnswerShapeFailure(after) === null) return true;
  if (answerBlockCount(after) > Math.max(3, answerBlockCount(before))) return false;
  const unsupported = (blocks: readonly AnswerBlock[]): string[] => blocks
    .filter((block) => decisionAnswerShapeFailure([block]) === "decision_block_unsupported")
    .map((block) => block.type);
  const remaining = unsupported(before);
  return unsupported(after).every((type) => {
    const index = remaining.indexOf(type);
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

/** Count physical blocks: undo can restore a same-id copy before id repair. */
export function decisionAnswerDocEditAllowed(before: Y.Doc, after: Y.Doc): boolean {
  const blocks = (doc: Y.Doc): AnswerBlock[] => getBlocksFragment(doc).toArray().map((node) => ({
    type: (node instanceof Y.XmlElement ? node.nodeName : "#text") as BlockInput["type"],
  }));
  return decisionAnswerEditAllowed(blocks(before), blocks(after));
}

function answerBlocks(doc: ProseMirrorNode): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  doc.forEach((node) => { blocks.push({ type: node.type.name as BlockInput["type"] }); });
  return blocks;
}

/** Check every local content transaction, including stale editor-control callbacks. */
export const ContentGuard = Extension.create<{
  canEdit: () => boolean;
  decisionAnswer: () => boolean;
}>({
  name: "contentGuard",
  addOptions: () => ({ canEdit: () => true, decisionAnswer: () => false }),
  addProseMirrorPlugins() {
    const { canEdit, decisionAnswer } = this.options;
    return [new Plugin({
      filterTransaction(transaction, state) {
        if (!transaction.docChanged) return true;
        // Sync transactions mirror content already received from Yjs. Undo is
        // checked before its UndoManager mutates Yjs, in guarded-undo.ts.
        if (transaction.getMeta(ySyncPluginKey)?.isChangeOrigin === true) return true;
        return canEdit() && (!decisionAnswer() || decisionAnswerEditAllowed(answerBlocks(state.doc), answerBlocks(transaction.doc)));
      },
    })];
  },
});
