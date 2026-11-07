/** The SVG is derived chrome; ProseMirror owns the ordinary code source. */
import { Extension } from "@tiptap/core";
import type { Editor, NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, Selection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import type { Diagnostic, FontOptions, TextStyle, Timeline } from "@uberblick/ablauf";
import type { PlaybackMount } from "@uberblick/ablauf/playback";
import { openViewer as viewDrawing } from "@uberblick/ablauf/viewer";
import type { Viewer, ViewerAction } from "@uberblick/ablauf/viewer";
import {
  blockCaption, carriesComment, chromeFilters, codeBlockChrome, lazyRenderer, openSource,
  selectedBlock, showDiagnostics, showFailure, sourceButton, sourceEditingPlugin,
} from "./source-chrome.js";
import { figureHistory } from "./figure-history.js";
import playbackUrl from "./ablauf-playback-url.js";
import rendererUrl from "./ablauf-renderer-url.js";
import { DRAW_ATTRIBUTES, dataRevision, recordDraw } from "./render-state.js";
import "../ui/figure-viewer.css";

const renderers = lazyRenderer(() => import("@uberblick/ablauf"), rendererUrl);
const playbacks = lazyRenderer(() => import("@uberblick/ablauf/playback"), playbackUrl);
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

function expandButton(): HTMLButtonElement {
  const expand = document.createElement("button");
  expand.type = "button";
  expand.textContent = "Expand";
  expand.setAttribute("aria-label", "Expand ablauf diagram");
  expand.disabled = true;
  return expand;
}

function diagnosticList(className: string): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = className;
  list.hidden = true;
  return list;
}

export function ablaufBlockView(comparison?: { source: string; side: "before" | "after" }): NodeViewRenderer {
  return (props) => ablaufNodeView(props, comparison);
}

function renderDrawing(text: string, idPrefix: string, mono: FontOptions): {
  svg: SVGSVGElement; width: number; height: number; diagnostics: Diagnostic[]; timelines: Timeline[];
} {
  const renderer = renderers.current();
  if (renderer === null) throw new Error("Renderer is unavailable");
  const result = renderer.render(text, { idPrefix, fonts: { mono } });
  // Source-derived text and attributes are escaped by the renderer. Parse
  // as SVG, then adopt its nodes; never interpret the source as HTML.
  const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
  const svg = parsed.querySelector("svg");
  if (svg === null || parsed.documentElement.localName !== "svg") throw new Error("Renderer returned invalid SVG");
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new Error("Renderer returned invalid dimensions");
  return { svg: document.importNode(svg, true), width, height, diagnostics: result.diagnostics, timelines: result.timelines };
}

function ablaufViewer(viewport: HTMLElement, shadow: ShadowRoot, options: {
  drawing: () => { svg: SVGSVGElement | null; mount: PlaybackMount | null; source: string };
  editable: () => boolean;
  source: () => void;
  failure: (cause: unknown) => void;
  comparison?: { side: "before" | "after"; draw: () => ReturnType<typeof renderDrawing> & { source: string } };
}) {
  let viewer: Viewer | undefined;
  let history: ReturnType<typeof figureHistory> | undefined;
  let other = false;
  let editable = options.editable();
  let replacing = false;
  let destroyed = false;
  let version = 0;
  let closing = false;
  let pendingOpen: (() => void) | undefined;
  const counterpart = () => {
    try { return options.comparison?.draw(); }
    catch { return undefined; }
  };
  const closeForReplacement = (): void => {
    replacing = true;
    viewer?.close();
    replacing = false;
  };
  const open = (opposite = false, focus?: HTMLElement): void => {
    const current = options.drawing();
    if (destroyed || current.svg === null || viewer !== undefined) return;
    if (closing) { pendingOpen = () => open(opposite, focus); return; }
    const compared = counterpart();
    if (opposite && compared === undefined) return;
    if (opposite && compared !== undefined && compared.timelines.length > 0 && playbacks.current() === null) {
      const pendingHistory = history;
      const request = version;
      void playbacks.load().then(() => {
        if (version === request && history === pendingHistory) open(opposite, focus);
      }, cause => {
        if (!destroyed && version === request && history === pendingHistory) {
          options.failure(cause);
          history?.close();
        }
      });
      return;
    }
    const holder = opposite ? document.createElement("div") : null;
    let otherMount: PlaybackMount | undefined;
    const shown = opposite && compared !== undefined ? compared.svg : current.svg;
    if (holder !== null && compared !== undefined) {
      shadow.append(holder);
      holder.append(shown);
      otherMount = playbacks.current()?.mountPlayback(holder, shown, compared.timelines);
    }
    other = opposite;
    editable = options.editable();
    const actions: ViewerAction[] = [];
    if (editable) actions.push({ label: "Source", onClick: handle => {
      handle.close();
      if (options.editable()) options.source();
    } });
    if (compared !== undefined) actions.push({
      label: opposite === (options.comparison?.side === "before") ? "Before" : "After",
      onClick: () => { closeForReplacement(); open(!opposite); },
    });
    viewport.focus({ preventScroll: true });
    const settings = {
      source: opposite && compared !== undefined ? compared.source : current.source,
      actions,
      onClose: () => {
        viewer = undefined;
        otherMount?.destroy();
        holder?.remove();
        if (!replacing) {
          version += 1;
          viewport.focus({ preventScroll: true });
          closing = history !== undefined;
          history?.close();
        }
      },
    };
    viewer = (opposite ? otherMount : current.mount)?.expand(settings) ?? viewDrawing(shown, settings);
    history ??= figureHistory(() => {
      version += 1;
      history = undefined;
      closing = false;
      viewer?.close();
      const next = pendingOpen;
      pendingOpen = undefined;
      next?.();
    });
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  };
  return {
    open: (): void => { version += 1; open(); },
    redraw: (): (() => void) => {
      if (viewer === undefined) return () => {};
      const side = other;
      const entry = history;
      const request = version;
      const focus = shadow.activeElement instanceof HTMLElement ? shadow.activeElement : undefined;
      // Copy captures source at open; replace the viewer together with the drawing.
      closeForReplacement();
      return () => { if (version === request && history === entry) open(side, focus); };
    },
    sync: (): void => {
      if (viewer === undefined || editable === options.editable()) return;
      editable = options.editable();
      closeForReplacement();
      open(other);
    },
    destroy: (): void => { destroyed = true; version += 1; pendingOpen = undefined; viewer?.close(); },
  };
}

function bindPlayback(shadow: ShadowRoot, diagnostics: HTMLElement) {
  let mount: PlaybackMount | null = null;
  let generation = 0;
  return {
    current: () => mount,
    redraw(svg: SVGSVGElement, timelines: Timeline[], reopen: () => void, beforeBind: () => () => void): void {
      const drawn = ++generation;
      const bind = (module: typeof import("@uberblick/ablauf/playback")): void => {
        if (drawn !== generation) return;
        const resume = beforeBind();
        if (mount === null) mount = module.mountPlayback(shadow, svg, timelines);
        else {
          mount.update(svg, timelines);
          mount.player.seek(-1);
        }
        reopen();
        resume();
      };
      showDiagnostics(diagnostics, []);
      const module = playbacks.current();
      if (module !== null && (mount !== null || timelines.length > 0)) bind(module);
      else if (timelines.length > 0) void playbacks.load().then(bind, (cause: unknown) => {
        if (drawn !== generation) return;
        showFailure(diagnostics, "Playback cannot be loaded", cause);
        reopen();
      });
      else reopen();
    },
    destroy: (): void => { generation += 1; mount?.destroy(); },
  };
}

function ablaufNodeView({ node, editor, getPos }: NodeViewRendererProps,
  comparison?: { source: string; side: "before" | "after" }): NodeView {
  let current: PMNode = node;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let hasDrawing = false;
  let fontsReady = false;
  let naturalWidth = 0;
  let svg: SVGSVGElement | null = null;
  let drawnSource = "";
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
  const hostStyle = document.createElement("style");
  hostStyle.textContent = '.ab { display: block; width: 100%; height: auto; max-width: var(--ub-ablauf-natural); margin-inline: auto; background: var(--ab-bg); }';
  shadow.append(hostStyle);
  viewport.append(drawing);
  const showSource = (): void => openSource(editor, getPos, true)(new Event("source"));
  const source = sourceButton("Open ablauf source", toggleSource(editor, getPos, viewport));
  const expand = expandButton();
  const toolbar = document.createElement("div");
  toolbar.className = "ub-figure-toolbar";
  toolbar.contentEditable = "false";
  toolbar.append(source, expand);
  expand.addEventListener("mousedown", (event) => event.preventDefault());
  expand.addEventListener("click", () => viewer.open());
  viewport.addEventListener("click", (event) => {
    if (svg !== null && event.composedPath().includes(svg)
      && ((event instanceof PointerEvent && event.pointerType === "touch")
      || matchMedia("(pointer: coarse)").matches || viewport.dataset.zoomable === "true")) viewer.open();
  });
  const resized = (): void => {
    panel.style.setProperty("--ub-ablauf-column", `${dom.getBoundingClientRect().width}px`);
    viewport.dataset.zoomable = String(naturalWidth > 0 && viewport.getBoundingClientRect().width / naturalWidth < 0.75);
  };
  const resize = new ResizeObserver(resized);
  resize.observe(viewport);
  resize.observe(dom);
  const stale = document.createElement("p");
  stale.className = "ub-ablauf-stale";
  stale.textContent = "Preview is stale";
  stale.hidden = true;
  const diagnostics = diagnosticList("ub-ablauf-diagnostics");
  const playbackDiagnostics = diagnosticList("ub-ablauf-playback-diagnostics");
  panel.append(viewport, toolbar, stale, diagnostics, playbackDiagnostics);
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
  const playback = bindPlayback(shadow, playbackDiagnostics);
  const viewer = ablaufViewer(viewport, shadow, {
    drawing: () => ({ svg, mount: playback.current(), source: drawnSource }),
    editable: () => editor.isEditable,
    source: showSource,
    failure: cause => showFailure(playbackDiagnostics, "Playback cannot be loaded", cause),
    ...(comparison === undefined ? {} : { comparison: {
      side: comparison.side,
      draw: () => ({ ...renderDrawing(comparison.source, `${idPrefix}-other`, { family: monoFamily(), measureText }), source: comparison.source }),
    } }),
  });
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
      const result = renderDrawing(current.textContent, idPrefix, { family: monoFamily(), measureText });
      const { width } = result;
      const reopen = viewer.redraw();
      if (svg === null) shadow.append(result.svg);
      else svg.replaceWith(result.svg);
      svg = result.svg;
      drawnSource = current.textContent;
      playback.redraw(svg, result.timelines, reopen, viewer.redraw);
      naturalWidth = width;
      panel.style.setProperty("--ub-ablauf-natural", `${width}px`);
      panel.style.width = result.timelines.length > 0
        ? `min(100%, max(${width}px, min(22rem, var(--ub-ablauf-column, 100%))))` : `min(100%, ${width}px)`;
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
    viewer.sync();
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
      viewer.destroy();
      playback.destroy();
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
