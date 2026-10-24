/** The drawing is derived chrome; ProseMirror owns the ordinary code source. */
import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import {
  blockCaption, carriesComment, chromeFilters, codeBlockChrome, copyButton, lazyRenderer, openSource,
  showDiagnostics, showFailure, sourceButton, sourceEditingPlugin,
} from "./source-chrome.js";
import rendererUrl from "./wireframe-renderer-url.js";
import { DRAW_ATTRIBUTES, dataRevision, recordDraw } from "./render-state.js";

// The renderer carries the full icon catalog, about half the app's script.
// Load it when the first wireframe mounts; later drawings stay synchronous.
const renderers = lazyRenderer(() => import("@uberblick/wireframe"), rendererUrl);

export function wireframeBlockView(): NodeViewRenderer {
  return ({ node, editor, getPos }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;
    let hasDrawing = false;
    let pageWidth = 0;
    const dom = document.createElement("div");
    dom.className = "ub-code ub-wireframe ub-block-frame";
    const header = blockCaption("");
    const caption = document.createElement("span");
    caption.className = "ub-code-caption";
    const label = document.createElement("span");
    label.className = "ub-code-caption-text";
    label.textContent = "Wireframe";
    caption.append(label);
    const source = sourceButton("Open wireframe source", openSource(editor, getPos));
    const copy = copyButton(() => current.textContent);
    header.actions.append(copy.element, source);
    header.label.append(caption);
    const panel = document.createElement("div");
    panel.className = "ub-wireframe-panel";
    panel.contentEditable = "false";
    const viewport = document.createElement("div");
    viewport.className = "ub-wireframe-viewport";
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", "Wireframe preview");
    viewport.hidden = true;
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
    dom.append(header.row, panel, contentDOM);
    const settled = (succeeded: boolean): void => {
      recordDraw(dom, { type: "code", language: "wireframe", text: current.textContent }, dataRevision(null), succeeded);
    };
    const unavailable = (prefix: string, cause: unknown): void => {
      showFailure(diagnostics, prefix, cause);
      stale.hidden = !hasDrawing;
      settled(false);
    };

    const resize = (): void => {
      if (destroyed || !hasDrawing || viewport.clientWidth === 0) return;
      const available = viewport.clientWidth;
      let measured = available;
      if (pageWidth > available && drawing.firstElementChild !== null) {
        // The page's width is capped by the renderer root's content box.
        const style = getComputedStyle(drawing.firstElementChild);
        measured = pageWidth + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      }
      drawing.style.width = `${measured}px`;
      const natural = Math.max(measured, drawing.scrollWidth);
      const scale = Math.max(0.6, Math.min(1, available / natural));
      drawing.style.width = `${natural}px`;
      drawing.style.transform = `scale(${scale})`;
      fit.style.width = `${natural * scale}px`;
      fit.style.height = `${drawing.offsetHeight * scale}px`;
    };
    const draw = (): void => {
      pending = null;
      if (destroyed) return;
      const renderer = renderers.current();
      if (renderer === null) {
        renderers.load().then(() => { if (pending === null) draw(); }, (cause: unknown) => {
          if (destroyed || pending !== null) return;
          unavailable("Preview cannot be loaded", cause);
        });
        return;
      }
      try {
        const result = renderer.parseWireframe(current.textContent);
        const rendered = renderer.renderWireframe(result, document);
        if (rendered !== null) {
          drawing.replaceChildren(rendered);
          drawing.setAttribute("aria-label", renderer.summarizeWireframe(result));
          const first = result.nodes[0];
          const width = first?.kind === "page" ? first.attributes.find(attribute => attribute.key === "width")?.value : undefined;
          const pixels = Number(width);
          // Match the renderer's width rule, and retain it with the last good drawing.
          pageWidth = width !== undefined && /^[0-9]+$/.test(width) && pixels >= 1 && pixels <= 9999 ? pixels : 0;
          hasDrawing = true;
        }
        viewport.hidden = !hasDrawing;
        stale.hidden = rendered !== null || !hasDrawing;
        showDiagnostics(diagnostics, result.diagnostics);
        resize();
        settled(rendered !== null);
      } catch (cause) {
        unavailable("Preview cannot be drawn", cause);
      }
    };
    const schedule = (): void => {
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(draw, 200);
    };
    const sync = (): void => {
      codeBlockChrome.sync(current, dom);
      dom.dataset.annotated = String(carriesComment(current));
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
      ...chromeFilters(dom, [header.row, panel], ["id", "data-language", "data-annotated", ...DRAW_ATTRIBUTES]),
      destroy: () => {
        destroyed = true;
        if (pending !== null) clearTimeout(pending);
        observer?.disconnect();
      },
    };
  };
}

export const WireframeBlocks = Extension.create({
  name: "uberblickWireframeBlocks",
  addProseMirrorPlugins() { return [sourceEditingPlugin("code", "ub-wireframe-editing")]; },
});
