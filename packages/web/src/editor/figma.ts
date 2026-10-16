import { Extension, Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { ySyncPluginKey } from "y-prosemirror";
import { TABLE_CELL_MARKS, normalizeFigmaLink, parseFigmaHeight } from "@uberblick/schema";
import { figmaBlockView } from "./figma-view.js";

export const Figma = Node.create({
  name: "figma", group: "block", content: "figmaCaption", defining: true, isolating: true, draggable: true,
  addAttributes() {
    return Object.fromEntries(["id", "url", "title", "height"].map((name) => [name, {
      default: null, parseHTML: (element: HTMLElement) => element.getAttribute(name === "id" ? name : `data-figma-${name}`),
      renderHTML: (attrs: Record<string, unknown>) => typeof attrs[name] === "string"
        ? { [name === "id" ? name : `data-figma-${name}`]: attrs[name] } : {},
    }]));
  },
  parseHTML() { return [{ tag: "article[data-block-type=figma]" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["article", mergeAttributes({ class: "ub-figma ub-block-frame", "data-block-type": "figma" }, HTMLAttributes), 0];
  },
  addNodeView() { return figmaBlockView; },
});

export const FigmaCaption = Node.create({
  name: "figmaCaption", content: "paragraph", defining: true, isolating: true,
  parseHTML() { return [{ tag: "div[data-figma-caption]" }]; },
  renderHTML() { return ["div", { class: "ub-figma-caption", "data-figma-caption": "" }, 0]; },
});

function supportedFigma(node: PMNode): boolean {
  try {
    if (typeof node.attrs.url !== "string" || normalizeFigmaLink(node.attrs.url).url !== node.attrs.url) return false;
    if (node.attrs.height !== null) {
      if (typeof node.attrs.height !== "string") return false;
      parseFigmaHeight(node.attrs.height);
    }
    if (node.attrs.title !== null && (typeof node.attrs.title !== "string" || /[\r\n]/.test(node.attrs.title))) return false;
  } catch { return false; }
  const part = node.firstChild;
  const paragraph = part?.firstChild;
  if (node.childCount !== 1 || part?.type.name !== "figmaCaption" || part.childCount !== 1 ||
    paragraph?.type.name !== "paragraph" || paragraph.attrs.id !== null) return false;
  let valid = true;
  paragraph.forEach((child) => {
    if (!child.isText || child.marks.some((mark) => !(TABLE_CELL_MARKS as readonly string[]).includes(mark.type.name))) valid = false;
  });
  return valid;
}

export const FigmaBlocks = Extension.create({
  name: "uberblickFigmaBlocks", priority: 1100,
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction(tr) {
        if (!tr.docChanged || tr.getMeta(ySyncPluginKey)?.isChangeOrigin === true) return true;
        let valid = true;
        tr.doc.forEach((node) => { if (node.type.name === "figma" && !supportedFigma(node)) valid = false; });
        return valid;
      },
      props: {
        handleKeyDown(view, event) {
          const { $from } = view.state.selection;
          if ($from.depth !== 3 || $from.node(1).type.name !== "figma" || event.key !== "Enter" || event.isComposing) return false;
          view.dispatch(view.state.tr.insertText("\n").scrollIntoView());
          return true;
        },
        handlePaste(view, event) {
          const { $from } = view.state.selection;
          if ($from.depth !== 3 || $from.node(1).type.name !== "figma") return false;
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (!/[\r\n]/.test(text)) return false;
          view.dispatch(view.state.tr.insertText(text.replace(/\r\n?/g, "\n")).scrollIntoView());
          return true;
        },
      },
    })];
  },
});
