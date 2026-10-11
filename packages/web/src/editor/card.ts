/** Four prose parts share the paragraph/mark palette and one block identity. */
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";
import { CARD_NODE_NAMES, CARD_PARTS, TABLE_CELL_MARKS } from "@uberblick/schema";
import type { CardPart } from "@uberblick/schema";

const PLACEHOLDERS: Record<CardPart, string> = {
  label: "Label", title: "Title", body: "Write the body…", footer: "Footer",
};
const PART_MARKS = new Set<string>(TABLE_CELL_MARKS);

export const Card = Node.create({
  name: "card",
  group: "block",
  content: "cardLabel cardTitle cardBody cardFooter",
  defining: true,
  isolating: true,
  draggable: true,
  addAttributes() {
    return { id: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("id") } };
  },
  parseHTML() { return [{ tag: "article[data-block-type=card]" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["article", mergeAttributes({ class: "ub-card", "data-block-type": "card" }, HTMLAttributes), 0];
  },
});

export const CardParts = CARD_PARTS.map((part) => Node.create({
  name: CARD_NODE_NAMES[part],
  content: "paragraph",
  defining: true,
  isolating: true,
  parseHTML() { return [{ tag: `[data-card-part=${part}]` }]; },
  renderHTML({ HTMLAttributes }) {
    return [part === "footer" ? "footer" : "div", mergeAttributes({
      class: `ub-card-${part}`, "data-card-part": part, "data-placeholder": PLACEHOLDERS[part],
    }, HTMLAttributes), 0];
  },
}));

/** No inferred prose or generated IDs enter a menu-created card. */
export function emptyCard(schema: Schema, id: string | null): ProseMirrorNode {
  return schema.node("card", { id }, CARD_PARTS.map((part) =>
    schema.node(CARD_NODE_NAMES[part], null, schema.node("paragraph"))));
}

/** Position of the title's text, relative to the card's start. */
export function cardTitleOffset(card: ProseMirrorNode): number {
  return card.child(0).nodeSize + 3;
}

function supportedCard(node: ProseMirrorNode): boolean {
  if (node.childCount !== CARD_PARTS.length) return false;
  return CARD_PARTS.every((part, index) => {
    const child = node.child(index);
    const paragraph = child.firstChild;
    if (child.type.name !== CARD_NODE_NAMES[part] || child.childCount !== 1 ||
        paragraph?.type.name !== "paragraph" || paragraph.attrs.id !== null) return false;
    let supported = true;
    paragraph.forEach((text) => {
      if (!text.isText || text.marks.some((mark) => !PART_MARKS.has(mark.type.name))) supported = false;
    });
    return supported;
  });
}

function selectedPart(view: EditorView): CardPart | null {
  const { $from } = view.state.selection;
  if ($from.depth !== 3 || $from.node(1).type.name !== "card") return null;
  return CARD_PARTS.find((part) => CARD_NODE_NAMES[part] === $from.node(2).type.name) ?? null;
}

export const CardBlocks = Extension.create({
  name: "uberblickCardBlocks",
  priority: 1100,
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction(tr) {
        if (!tr.docChanged || tr.getMeta(ySyncPluginKey)?.isChangeOrigin === true) return true;
        let supported = true;
        tr.doc.forEach((node) => { if (node.type.name === "card" && !supportedCard(node)) supported = false; });
        return supported;
      },
      props: {
        decorations(state) {
          const decorations: Decoration[] = [];
          const selected = state.selection.$from.depth > 0 ? state.selection.$from.before(1) : -1;
          state.doc.forEach((card, pos) => {
            if (card.type.name !== "card") return;
            if (pos === selected) decorations.push(Decoration.node(pos, pos + card.nodeSize, { "data-card-focused": "true" }));
            let childPos = pos + 1;
            card.forEach((part) => {
              if (part.textContent === "") decorations.push(Decoration.node(childPos, childPos + part.nodeSize, { "data-empty": "true" }));
              childPos += part.nodeSize;
            });
          });
          return DecorationSet.create(state.doc, decorations);
        },
        handleKeyDown(view, event) {
          const part = selectedPart(view);
          if (part === null || event.key !== "Enter" || event.isComposing) return false;
          if (part === "body") view.dispatch(view.state.tr.insertText("\n").scrollIntoView());
          // A part stays one paragraph. Header values stay single-line.
          return true;
        },
        handlePaste(view, event) {
          const part = selectedPart(view);
          if (part === null) return false;
          const plain = event.clipboardData?.getData("text/plain") ?? "";
          // Let ordinary rich paste preserve marks on single-line content.
          if (!/[\r\n]/.test(plain)) return false;
          const text = part === "body" ? plain.replace(/\r\n?/g, "\n") : plain.replace(/[\r\n]+/g, " ");
          view.dispatch(view.state.tr.insertText(text).scrollIntoView());
          return true;
        },
      },
    })];
  },
});
