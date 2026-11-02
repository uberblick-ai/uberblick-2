import { Extension, Node } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";

export const UNSUPPORTED_BLOCK = "unsupportedBlock";

/** View-only identity anchors: the sync binding never serializes these nodes. */
// known limit: comments inside unsupported blocks have no highlight; revisit when their content can render.
export const UnsupportedBlock = Node.create({
  name: UNSUPPORTED_BLOCK,
  group: "block",
  atom: true,
  isolating: true,
  selectable: false,
  draggable: false,
  marks: "",
  parseHTML() {
    return [{ tag: "div[data-unsupported-block]", ignore: true }];
  },
  renderHTML() {
    return ["div", {
      class: "ub-unsupported-block",
      "data-unsupported-block": "",
      contenteditable: "false",
    }, "This block needs a newer version."];
  },
  renderText() { return ""; },
});

function withoutUnsupported(content: Fragment): Fragment {
  const kept: ProseMirrorNode[] = [];
  content.forEach((node) => {
    if (node.type.name === UNSUPPORTED_BLOCK) return;
    kept.push(node.isLeaf ? node : node.copy(withoutUnsupported(node.content)));
  });
  return Fragment.fromArray(kept);
}

/** Copies and drags contain supported content only, with no placeholder text. */
export function withoutUnsupportedBlocks(slice: Slice): Slice {
  return new Slice(withoutUnsupported(slice.content), slice.openStart, slice.openEnd);
}

function stepPastUnsupported(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" ||
    event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || view.composing ||
    !view.editable || !view.hasFocus() || !(view.state.selection instanceof TextSelection)) return false;
  const native = view.dom.ownerDocument.getSelection();
  if (native?.rangeCount !== 1 || !native.isCollapsed || native.focusNode === null ||
    !view.dom.contains(native.focusNode)) return false;
  for (let element = native.focusNode.nodeType === 1 ? native.focusNode as HTMLElement : native.focusNode.parentElement;
    element !== null && element !== view.dom; element = element.parentElement) {
    if (element.contentEditable === "false") return false;
  }
  // End can move the native caret before selectionchange updates editor state.
  const $head = view.state.doc.resolve(view.posAtDOM(native.focusNode, native.focusOffset));
  if ($head.depth !== 1 || !$head.parent.isTextblock) return false;
  const atStart = $head.parentOffset === 0;
  const atEnd = $head.parentOffset === $head.parent.content.size;
  if (!atStart && !atEnd) return false;
  const block = view.nodeDOM($head.before());
  if (!(block instanceof HTMLElement)) return false;
  const forward = atEnd && (!atStart || (event.key === "ArrowRight") !== (getComputedStyle(block).direction === "rtl"));
  const direction = forward ? 1 : -1;
  let position = forward ? $head.after() : $head.before();
  let skipped = false;
  for (;;) {
    const $position = view.state.doc.resolve(position);
    const neighbor = forward ? $position.nodeAfter : $position.nodeBefore;
    if (neighbor?.type.name !== UNSUPPORTED_BLOCK) break;
    const placeholder = view.nodeDOM(forward ? position : position - neighbor.nodeSize);
    if (!(placeholder instanceof HTMLElement) || placeholder.getClientRects().length === 0) return false;
    position += direction * neighbor.nodeSize;
    skipped = true;
  }
  if (!skipped) return false;
  const current = TextSelection.create(view.state.doc, $head.pos);
  if (!current.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(current));
  // The framework checks visual edges too, including mixed-direction text.
  if (!view.endOfTextblock(event.key === "ArrowRight" ? "right" : "left")) return false;
  const next = Selection.findFrom(view.state.doc.resolve(position), direction);
  if (!(next instanceof TextSelection)) return false;
  // Commit the move before focus reconciliation can restore the old selection.
  view.dispatch(view.state.tr.setSelection(next).scrollIntoView());
  return true;
}

export const UnsupportedBlockProtection = Extension.create({
  name: "unsupportedBlockProtection",
  extendNodeSchema(extension) {
    return extension.name === UNSUPPORTED_BLOCK ? { yOpaque: true } : {};
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction(transaction, state) {
        if (!transaction.docChanged) return true;
        const sync = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
        if (sync?.isChangeOrigin === true) return true;
        const expected = new Set<ProseMirrorNode>();
        let valid = true;
        state.doc.forEach((node, pos) => {
          if (node.type.name !== UNSUPPORTED_BLOCK) return;
          expected.add(node);
          const mapped = transaction.mapping.mapResult(pos, 1);
          if (mapped.deleted || transaction.doc.nodeAt(mapped.pos) !== node) valid = false;
        });
        transaction.doc.descendants((node, pos, parent) => {
          if (node.type.name !== UNSUPPORTED_BLOCK) return;
          if (parent !== transaction.doc || !expected.delete(node) || transaction.doc.nodeAt(pos) !== node) valid = false;
        });
        return valid && expected.size === 0;
      },
      props: {
        handleKeyDown: stepPastUnsupported,
        transformCopied: withoutUnsupportedBlocks,
        transformPasted: withoutUnsupportedBlocks,
      },
    })];
  },
});
