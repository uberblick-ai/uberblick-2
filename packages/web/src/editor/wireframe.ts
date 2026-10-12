/** The drawing is derived chrome; ProseMirror owns the ordinary code source. */
import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import { COMMENT_MARK } from "@uberblick/schema";
import { parseWireframe, renderWireframe, summarizeWireframe } from "@uberblick/wireframe";
import { codeBlockChrome, copyButton, sourceEditingPlugin } from "./source-chrome.js";

export function wireframeBlockView(): NodeViewRenderer {
  return ({ node, editor, getPos }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;
    let hasDrawing = false;
    const dom = document.createElement("div");
    dom.className = "ub-code ub-wireframe";
    const header = document.createElement("div");
    header.className = "ub-wireframe-header";
    header.contentEditable = "false";
    const caption = document.createElement("span");
    caption.className = "ub-code-caption";
    const label = document.createElement("span");
    label.className = "ub-code-caption-text";
    label.textContent = "wireframe";
    caption.append(label);
    const actions = document.createElement("div");
    actions.className = "ub-wireframe-actions";
    const source = document.createElement("button");
    source.type = "button";
    source.textContent = "Source";
    source.setAttribute("aria-label", "Open wireframe source");
    const copy = copyButton(() => current.textContent);
    copy.element.textContent = "Copy";
    actions.append(copy.element, source);
    header.append(caption, actions);
    const panel = document.createElement("div");
    panel.className = "ub-wireframe-panel";
    panel.contentEditable = "false";
    const viewport = document.createElement("div");
    viewport.className = "ub-wireframe-viewport";
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", "Wireframe preview");
    const fit = document.createElement("div");
    fit.className = "ub-wireframe-fit";
    const drawing = document.createElement("div");
    drawing.className = "ub-wireframe-drawing";
    drawing.setAttribute("role", "img");
    fit.append(drawing);
    viewport.append(fit);
    const stale = document.createElement("p");
    stale.className = "ub-wireframe-stale";
    stale.textContent = "Preview is stale";
    stale.hidden = true;
    const diagnostics = document.createElement("ul");
    diagnostics.className = "ub-wireframe-diagnostics";
    diagnostics.hidden = true;
    panel.append(viewport, stale, diagnostics);
    const contentDOM = document.createElement("pre");
    contentDOM.className = "ub-wireframe-source";
    dom.append(header, panel, contentDOM);

    const resize = (): void => {
      if (destroyed || !hasDrawing || viewport.clientWidth === 0) return;
      // Measure unscaled content at the column width first. Package rows can
      // overflow that width; let them fit before applying the 0.6 floor.
      const available = viewport.clientWidth;
      drawing.style.width = `${available}px`;
      const natural = Math.max(available, drawing.scrollWidth);
      const scale = Math.max(0.6, Math.min(1, available / natural));
      drawing.style.width = `${natural}px`;
      drawing.style.transform = `scale(${scale})`;
      fit.style.width = `${natural * scale}px`;
      fit.style.height = `${drawing.offsetHeight * scale}px`;
    };
    const draw = (): void => {
      pending = null;
      if (destroyed) return;
      const result = parseWireframe(current.textContent);
      const rendered = renderWireframe(result, document);
      if (rendered !== null) {
        drawing.replaceChildren(rendered);
        drawing.setAttribute("aria-label", summarizeWireframe(result));
        hasDrawing = true;
      }
      viewport.hidden = !hasDrawing;
      stale.hidden = rendered !== null || !hasDrawing;
      diagnostics.replaceChildren(...result.diagnostics.map(diagnostic => {
        const item = document.createElement("li");
        item.textContent = `Line ${diagnostic.line}: ${diagnostic.severity}: ${diagnostic.message}`;
        return item;
      }));
      diagnostics.hidden = result.diagnostics.length === 0;
      resize();
    };
    const schedule = (): void => {
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(draw, 200);
    };
    const open = (event: Event): void => {
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))));
      editor.view.focus();
    };
    source.addEventListener("mousedown", event => event.preventDefault());
    source.addEventListener("click", open);
    const sync = (): void => {
      codeBlockChrome.sync(current, dom);
      let annotated = false;
      current.forEach(child => {
        if (child.marks.some(mark => mark.type.name === COMMENT_MARK)) annotated = true;
      });
      dom.dataset.annotated = String(annotated);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(viewport);
    void document.fonts?.ready.then(resize);
    sync();
    draw();
    return {
      dom, contentDOM,
      update(updated: PMNode): boolean {
        if (updated.type !== current.type || updated.attrs.language !== "wireframe" || contentDOM.parentNode !== dom) return false;
        const changed = updated.textContent !== current.textContent;
        current = updated;
        sync();
        if (changed) schedule();
        return true;
      },
      stopEvent: event => event.target instanceof Node &&
        (header.contains(event.target) || panel.contains(event.target)),
      ignoreMutation: mutation => header.contains(mutation.target) || panel.contains(mutation.target) ||
        (mutation.type === "attributes" && mutation.target === dom &&
          ["id", "data-language", "data-annotated"].includes(mutation.attributeName ?? "")),
      destroy: () => {
        destroyed = true;
        if (pending !== null) clearTimeout(pending);
        observer?.disconnect();
        source.removeEventListener("click", open);
      },
    };
  };
}

export const WireframeBlocks = Extension.create({
  name: "uberblickWireframeBlocks",
  addProseMirrorPlugins() { return [sourceEditingPlugin("code", "ub-wireframe-editing")]; },
});
