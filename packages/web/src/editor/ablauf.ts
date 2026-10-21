/** The SVG is derived chrome; ProseMirror owns the ordinary code source. */
import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import type { TextStyle } from "@uberblick/ablauf";
import {
  blockCaption, carriesComment, chromeFilters, codeBlockChrome, copyButton, lazyRenderer, openSource,
  showDiagnostics, showFailure, sourceButton, sourceEditingPlugin,
} from "./source-chrome.js";
import rendererUrl from "./ablauf-renderer-url.js";
import { DRAW_ATTRIBUTES, dataRevision, recordDraw } from "./render-state.js";

const renderers = lazyRenderer(() => import("@uberblick/ablauf"), rendererUrl);
let nextId = 0;

export function ablaufBlockView(): NodeViewRenderer {
  return ({ node, editor, getPos }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;
    let hasDrawing = false;
    let fontsReady = false;
    const idPrefix = `ub-ablauf-${++nextId}`;
    const dom = document.createElement("div");
    dom.className = "ub-code ub-ablauf ub-block-frame";
    const header = blockCaption("");
    const caption = document.createElement("span");
    caption.className = "ub-code-caption";
    const label = document.createElement("span");
    label.className = "ub-code-caption-text";
    label.textContent = "Ablauf";
    caption.append(label);
    // Read-only documents show only the drawing: Source is an authoring control.
    const source = sourceButton("Open ablauf source", openSource(editor, getPos, true));
    const copy = copyButton(() => current.textContent);
    header.actions.append(copy.element, source);
    header.label.append(caption);
    const panel = document.createElement("div");
    panel.className = "ub-ablauf-panel";
    panel.contentEditable = "false";
    const viewport = document.createElement("div");
    viewport.className = "ub-ablauf-viewport";
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", "Ablauf preview");
    viewport.hidden = true;
    const drawing = document.createElement("div");
    drawing.className = "ub-ablauf-drawing";
    // Each renderer emits document-wide .ab rules, with different fonts and
    // optional shape rules. A shadow tree isolates them while inheriting tokens.
    const shadow = drawing.attachShadow({ mode: "open" });
    viewport.append(drawing);
    const stale = document.createElement("p");
    stale.className = "ub-ablauf-stale";
    stale.textContent = "Preview is stale";
    stale.hidden = true;
    const diagnostics = document.createElement("ul");
    diagnostics.className = "ub-ablauf-diagnostics";
    diagnostics.hidden = true;
    panel.append(viewport, stale, diagnostics);
    const contentDOM = document.createElement("pre");
    contentDOM.className = "ub-ablauf-source";
    dom.append(header.row, panel, contentDOM);
    const settled = (succeeded: boolean): void => {
      recordDraw(dom, { type: "code", language: "ablauf", text: current.textContent }, dataRevision(null), succeeded);
    };
    const unavailable = (prefix: string, cause: unknown): void => {
      showFailure(diagnostics, prefix, cause);
      stale.hidden = !hasDrawing;
      settled(false);
    };
    const monoFamily = (): string => getComputedStyle(dom).getPropertyValue("--font-mono")
      .split(",")[0]?.trim().replace(/^["']|["']$/g, "") || "Geist Mono";
    const context = document.createElement("canvas").getContext("2d");
    const measureText = (text: string, style: TextStyle): number => {
      if (context === null) throw new Error("Text measurement is unavailable");
      context.font = `${style.fontWeight} ${style.fontSize}px "${monoFamily()}"`;
      return context.measureText(text).width;
    };
    const draw = (): void => {
      pending = null;
      if (destroyed) return;
      const renderer = renderers.current();
      if (renderer === null || !fontsReady) {
        Promise.all([renderers.load(), document.fonts.load(`13px "${monoFamily()}"`).then(() => document.fonts.ready)]).then(() => {
          fontsReady = true;
          if (pending === null) draw();
        }, (cause: unknown) => {
          if (destroyed || pending !== null) return;
          unavailable("Preview cannot be loaded", cause);
        });
        return;
      }
      try {
        const result = renderer.render(current.textContent, {
          idPrefix, fonts: { mono: { family: monoFamily(), measureText } },
        });
        // Source-derived text and attributes are escaped by the renderer. Parse
        // as SVG, then adopt its nodes; never interpret the source as HTML.
        const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
        const svg = parsed.documentElement;
        if (svg.localName !== "svg") throw new Error("Renderer returned invalid SVG");
        const width = Number(svg.getAttribute("width"));
        if (!Number.isFinite(width) || width <= 0) throw new Error("Renderer returned invalid dimensions");
        const hostStyle = document.createElement("style");
        // Fan-out ignores fonts options. Its mono role still uses the host face.
        hostStyle.textContent = '.ab { display: block; width: 100%; height: auto; background: var(--ab-bg); } .ab .m, .ab .cap { font-family: var(--font-mono); }';
        shadow.replaceChildren(document.importNode(svg, true), hostStyle);
        // Let CSS fit the SVG to the column, retaining legible size before scroll.
        drawing.style.width = `min(100%, ${width}px)`;
        drawing.style.minWidth = `${width * 0.6}px`;
        hasDrawing = true;
        viewport.hidden = false;
        stale.hidden = true;
        showDiagnostics(diagnostics, result.diagnostics);
        settled(true);
      } catch (cause) {
        unavailable("Preview cannot be drawn", cause);
      }
    };
    const schedule = (): void => {
      if (destroyed) return;
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(draw, 200);
    };
    const fontsLoaded = (): void => { if (hasDrawing) schedule(); };
    const sync = (): void => {
      codeBlockChrome.sync(current, dom);
      source.hidden = !editor.isEditable;
      dom.dataset.annotated = String(carriesComment(current));
    };
    editor.on("transaction", sync);
    editor.on("update", sync);
    document.fonts.addEventListener("loadingdone", fontsLoaded);
    sync();
    draw();
    return {
      dom, contentDOM,
      update(updated: PMNode): boolean {
        if (updated.type !== current.type || updated.attrs.language !== "ablauf" || contentDOM.parentNode !== dom) return false;
        const changed = updated.textContent !== current.textContent;
        current = updated;
        sync();
        if (changed) schedule();
        return true;
      },
      // sync also runs on editor events, outside an update, so its attributes are chrome too.
      ...chromeFilters(dom, [header.row, panel], ["id", "data-language", "data-annotated", ...DRAW_ATTRIBUTES]),
      destroy: () => {
        destroyed = true;
        if (pending !== null) clearTimeout(pending);
        document.fonts.removeEventListener("loadingdone", fontsLoaded);
        editor.off("transaction", sync);
        editor.off("update", sync);
      },
    };
  };
}

export const AblaufBlocks = Extension.create({
  name: "uberblickAblaufBlocks",
  addProseMirrorPlugins() { return [sourceEditingPlugin("code", "ub-ablauf-editing")]; },
});
