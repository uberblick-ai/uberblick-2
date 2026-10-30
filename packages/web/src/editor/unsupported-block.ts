import { Extension, Node } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
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
        transformCopied: withoutUnsupportedBlocks,
        transformPasted: withoutUnsupportedBlocks,
      },
    })];
  },
});
