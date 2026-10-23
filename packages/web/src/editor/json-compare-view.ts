/**
 * A changed json-tree block in the side-by-side comparison: one block across
 * both columns, with a before cell and an after cell in every grid row so the
 * two panes stay aligned even when a value wraps.
 */
import { Node as TiptapNode } from "@tiptap/core";
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { jsonComparePanel } from "./json-compare-panel.js";
import { openJsonCompareViewer } from "./json-compare-viewer.js";
import type { JsonCompareViewerHandle } from "./json-compare-viewer.js";

function expandButton(): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "ub-figure-viewer-action";
  element.textContent = "Expand";
  element.setAttribute("aria-label", "Expand JSON comparison");
  return element;
}

function jsonCompareView({ node }: NodeViewRendererProps): NodeView {
  let current: PMNode = node;
  let viewer: JsonCompareViewerHandle | null = null;
  const dom = document.createElement("div");
  dom.className = "ub-json-compare";
  dom.contentEditable = "false";
  // Folding resizes the block; the ruler and change navigation measure on resize, and this covers a fold that keeps the height.
  const panel = jsonComparePanel(String(node.attrs.key), () => {
    dom.dispatchEvent(new CustomEvent("ub-json-compare-render", { bubbles: true }));
  });
  const bar = document.createElement("div");
  bar.className = "ub-json-compare-bar";
  const expand = expandButton();
  bar.append(panel.collapse, expand);
  dom.append(bar, panel.grid);
  const show = (): void => { panel.show(String(current.attrs.before), String(current.attrs.after)); };
  expand.addEventListener("click", () => {
    viewer = openJsonCompareViewer({
      key: String(current.attrs.key), before: String(current.attrs.before), after: String(current.attrs.after),
      closed: () => {
        viewer = null;
        panel.render();
        if (!dom.isConnected) return;
        expand.focus({ preventScroll: true });
      },
    });
  });
  show();

  return {
    dom,
    update(updated: PMNode): boolean {
      if (updated.type !== current.type) return false;
      const changed = updated.attrs.before !== current.attrs.before || updated.attrs.after !== current.attrs.after;
      current = updated;
      if (changed) show();
      return true;
    },
    stopEvent: () => true,
    ignoreMutation: () => true,
    destroy: () => { viewer?.close(); },
  };
}

/** The spanning comparison's node, after the side-by-side's placeholder on the left. */
export const RevisionJsonCompare = TiptapNode.create({
  name: "revisionJsonCompare",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes: () => ({ before: { default: "" }, after: { default: "" }, key: { default: "" } }),
  parseHTML: () => [],
  renderHTML: () => ["div", { class: "ub-json-compare" }],
  addNodeView: () => jsonCompareView,
});

/** The empty left cell under the spanning comparison; the aligner gives it its height. */
export const RevisionJsonPlaceholder = TiptapNode.create({
  name: "revisionJsonPlaceholder",
  group: "block",
  atom: true,
  selectable: false,
  parseHTML: () => [],
  renderHTML: () => ["div", { class: "ub-json-compare-placeholder", "aria-hidden": "true" }],
});
