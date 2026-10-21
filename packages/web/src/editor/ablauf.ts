/** The SVG is derived chrome; ProseMirror owns the ordinary code source. */
import { Extension } from "@tiptap/core";
import type { Editor, NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, Selection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import type { TextStyle } from "@uberblick/ablauf";
import {
  blockCaption, carriesComment, chromeFilters, codeBlockChrome, lazyRenderer, openSource,
  selectedBlock, showDiagnostics, showFailure, sourceButton, sourceEditingPlugin,
} from "./source-chrome.js";
import { openAblaufViewer } from "./ablauf-viewer.js";
import rendererUrl from "./ablauf-renderer-url.js";
import { DRAW_ATTRIBUTES, dataRevision, recordDraw } from "./render-state.js";

const renderers = lazyRenderer(() => import("@uberblick/ablauf"), rendererUrl);
let nextId = 0;

function toggleSource(editor: Editor, getPos: () => number | undefined, viewport: HTMLElement): (event: Event) => void {
  return (event) => {
    event.preventDefault();
    if (!editor.isEditable) return;
    const pos = getPos();
    if (pos === undefined) return;
    if (selectedBlock(editor.state, "code")?.pos !== pos) { openSource(editor, getPos, true)(event); return; }
    // Move outside the source without editing the document. A document containing
    // only this block has no text cursor outside it, so use its whole selection.
    const doc = editor.state.doc;
    const node = doc.nodeAt(pos);
    if (node === null) return;
    const selection = Selection.findFrom(doc.resolve(pos + node.nodeSize), 1, true)
      ?? Selection.findFrom(doc.resolve(pos), -1, true) ?? new AllSelection(doc);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    viewport.focus();
  };
}

function languageCaption(): HTMLElement {
  const caption = document.createElement("span");
  caption.className = "ub-code-caption";
  const label = document.createElement("span");
  label.className = "ub-code-caption-text";
  label.textContent = "Ablauf";
  caption.append(label);
  return caption;
}

export function ablaufBlockView(): NodeViewRenderer {
  return ablaufNodeView;
}

function ablaufNodeView({ node, editor, getPos }: NodeViewRendererProps): NodeView {
  let current: PMNode = node;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let hasDrawing = false;
  let fontsReady = false;
  let naturalWidth = 0;
  let naturalHeight = 0;
  let viewer: ReturnType<typeof openAblaufViewer> | undefined;
  const idPrefix = `ub-ablauf-${++nextId}`;
  const dom = document.createElement("div");
  dom.className = "ub-code ub-ablauf";
  const header = blockCaption("");
  header.label.append(languageCaption());
  const sourceFrame = document.createElement("div");
  sourceFrame.className = "ub-ablauf-source-frame ub-block-frame";
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
  const showSource = (): void => openSource(editor, getPos, true)(new Event("source"));
  const source = sourceButton("Open ablauf source", toggleSource(editor, getPos, viewport));
  const expand = document.createElement("button");
  expand.type = "button";
  expand.textContent = "Expand";
  expand.setAttribute("aria-label", "Expand ablauf diagram");
  expand.disabled = true;
  const toolbar = document.createElement("div");
  toolbar.className = "ub-figure-toolbar";
  toolbar.contentEditable = "false";
  toolbar.append(source, expand);
  const openViewer = (): void => {
    if (!hasDrawing || destroyed) return;
    viewer?.close();
    const fullDrawing = document.createElement("div");
    fullDrawing.className = "ub-ablauf-drawing";
    fullDrawing.attachShadow({ mode: "open" }).replaceChildren(...Array.from(shadow.childNodes, (child) => child.cloneNode(true)));
    viewer = openAblaufViewer({
      drawing: fullDrawing, width: naturalWidth, height: naturalHeight,
      source: () => current.textContent, editable: editor.isEditable, openSource: showSource, returnFocus: viewport,
    });
  };
  expand.addEventListener("mousedown", (event) => event.preventDefault());
  expand.addEventListener("click", openViewer);
  viewport.addEventListener("click", (event) => {
    if ((event instanceof PointerEvent && event.pointerType === "touch")
      || matchMedia("(pointer: coarse)").matches || viewport.dataset.zoomable === "true") openViewer();
  });
  const resized = (): void => {
    viewport.dataset.zoomable = String(naturalWidth > 0 && viewport.getBoundingClientRect().width / naturalWidth < 0.75);
  };
  const resize = new ResizeObserver(resized);
  resize.observe(viewport);
  const stale = document.createElement("p");
  stale.className = "ub-ablauf-stale";
  stale.textContent = "Preview is stale";
  stale.hidden = true;
  const diagnostics = document.createElement("ul");
  diagnostics.className = "ub-ablauf-diagnostics";
  diagnostics.hidden = true;
  panel.append(viewport, toolbar, stale, diagnostics);
  const contentDOM = document.createElement("pre");
  contentDOM.className = "ub-ablauf-source";
  sourceFrame.append(header.row, contentDOM);
  dom.append(panel, sourceFrame);
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
      const height = Number(svg.getAttribute("height"));
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new Error("Renderer returned invalid dimensions");
      const hostStyle = document.createElement("style");
      // Fan-out ignores fonts options. Its mono role still uses the host face.
      hostStyle.textContent = '.ab { display: block; width: 100%; height: auto; background: var(--ab-bg); } .ab .m, .ab .cap { font-family: var(--font-mono); }';
      shadow.replaceChildren(document.importNode(svg, true), hostStyle);
      naturalWidth = width;
      naturalHeight = height;
      panel.style.width = `min(100%, ${width}px)`;
      hasDrawing = true;
      viewport.hidden = false;
      expand.disabled = false;
      resized();
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
    viewer?.setEditable(editor.isEditable);
    dom.dataset.annotated = String(carriesComment(current));
    source.setAttribute("aria-expanded", String(selectedBlock(editor.state, "code")?.pos === getPos() || carriesComment(current)));
  };
  editor.on("transaction", sync);
  editor.on("update", sync);
  document.fonts.addEventListener("loadingdone", fontsLoaded);
  sync();
  draw();
  return {
    dom, contentDOM,
    update(updated: PMNode): boolean {
      if (updated.type !== current.type || updated.attrs.language !== "ablauf" || contentDOM.parentNode !== sourceFrame) return false;
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
      viewer?.close();
      resize.disconnect();
      if (pending !== null) clearTimeout(pending);
      document.fonts.removeEventListener("loadingdone", fontsLoaded);
      editor.off("transaction", sync);
      editor.off("update", sync);
    },
  };
}

export const AblaufBlocks = Extension.create({
  name: "uberblickAblaufBlocks",
  addProseMirrorPlugins() { return [sourceEditingPlugin("code", "ub-ablauf-editing")]; },
});
