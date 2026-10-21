import { Extension, Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { normalizeFigmaLink, parseFigmaHeight } from "@uberblick/schema";
import { blockShapeGuard, isPlainPart } from "./blocks.js";
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
  const caption = node.firstChild;
  return node.childCount === 1 && caption?.type.name === "figmaCaption" && isPlainPart(caption);
}

export const FigmaBlocks = Extension.create({
  name: "uberblickFigmaBlocks", priority: 1100,
  addProseMirrorPlugins() {
    return [blockShapeGuard("figma", supportedFigma), new Plugin({
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
