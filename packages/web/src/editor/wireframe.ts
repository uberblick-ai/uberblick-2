/**
 * SPIKE: a live preview for code blocks whose language is `wireframe`.
 *
 * No new block type. The block stays a `code` node with `language:
 * "wireframe"`, so storage, Markdown import/export (```wireframe fences),
 * MCP and older clients see an ordinary code block. Only this NodeView
 * differs: it draws the source as a wireframe in chrome that is
 * `contenteditable="false"`, exactly like the chart block (chart.ts) — the
 * preview is derived, never content, and nothing here dispatches a content
 * transaction.
 *
 * Which representation shows follows the selection (sourceEditingPlugin's
 * rule): caret in the block → live preview with the source below it; caret elsewhere →
 * preview only. A comment on the source keeps the source visible beside the
 * preview rather than hiding the preview (chart hides it; see the spike
 * report for why a wireframe should not).
 *
 * Fit policy: fluid frames fill the column; fixed-width frames (phones,
 * `w=`) sit side by side and the whole board scales down with CSS `zoom`
 * (layout height stays exact) to a floor of {@link MIN_SCALE}; below that
 * the viewport scrolls sideways. "full size" opens an unscaled copy.
 */
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NodeView } from "@tiptap/pm/view";
import { COMMENT_MARK } from "@uberblick/schema";
import { copyButton, selectedBlock } from "./source-chrome.js";
import { parseWireframe, renderWireframe, wireframeSummary } from "./wireframe-render.js";

export const WIREFRAME_LANGUAGE = "wireframe";
export const MIN_SCALE = 0.6;
/** Pause after the last text change before the preview redraws. */
export const REDRAW_PAUSE_MS = 120;

export function isWireframe(node: PMNode): boolean {
  return node.type.name === "code" && node.attrs.language === WIREFRAME_LANGUAGE;
}

/** Scale `root` inside `viewport` per the fit policy. Returns the scale used. */
export function fitWireframe(viewport: HTMLElement, root: HTMLElement): number {
  const available = viewport.clientWidth;
  if (available <= 0) return 1;
  root.style.zoom = "1";
  root.style.width = `${available}px`;
  const board = root.firstElementChild as HTMLElement | null;
  const natural = Math.max(available, board?.scrollWidth ?? available);
  const scale = Math.max(MIN_SCALE, Math.min(1, available / natural));
  root.style.width = scale > MIN_SCALE ? `${available / scale}px` : `${natural}px`;
  root.style.zoom = String(scale);
  viewport.dataset.scale = scale.toFixed(2);
  viewport.dataset.scrolls = String(natural * scale > available + 1);
  return scale;
}

function openFullSize(source: string): void {
  const dialog = document.createElement("dialog");
  dialog.className = "ub-wireframe-dialog";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ub-wireframe-close";
  close.textContent = "close";
  close.addEventListener("click", () => dialog.close());
  const body = document.createElement("div");
  body.className = "ub-wireframe-dialog-body";
  body.append(renderWireframe(parseWireframe(source)));
  dialog.append(close, body);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
}

export function wireframeBlockView(): NodeViewRenderer {
  return ({ node, editor, getPos }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    let frame = 0;
    let rendered: HTMLElement | null = null;
    let destroyed = false;

    const dom = document.createElement("div");
    dom.className = "ub-wireframe";
    dom.setAttribute("data-block-type", "code");
    dom.setAttribute("data-language", WIREFRAME_LANGUAGE);

    const panel = document.createElement("div");
    panel.className = "ub-wireframe-panel";
    panel.contentEditable = "false";
    const tools = document.createElement("div");
    tools.className = "ub-wireframe-tools";
    const sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.textContent = "source";
    sourceButton.setAttribute("aria-label", "Edit wireframe source");
    const fullButton = document.createElement("button");
    fullButton.type = "button";
    fullButton.textContent = "full size";
    fullButton.setAttribute("aria-label", "Open wireframe at full size");
    tools.append(sourceButton, fullButton);
    const viewport = document.createElement("div");
    viewport.className = "ub-wireframe-viewport";
    viewport.setAttribute("role", "img");
    const diagnostics = document.createElement("ul");
    diagnostics.className = "ub-wireframe-diagnostics";
    diagnostics.hidden = true;
    panel.append(tools, viewport, diagnostics);

    // The source keeps the ordinary code-block chrome: caption (the language
    // picker mounts here), copy, and the scrolling `code` that is contentDOM.
    const pre = document.createElement("pre");
    pre.className = "ub-code ub-wireframe-source";
    pre.setAttribute("data-language", WIREFRAME_LANGUAGE);
    const caption = document.createElement("span");
    caption.className = "ub-code-caption";
    caption.contentEditable = "false";
    const captionText = document.createElement("span");
    captionText.className = "ub-code-caption-text";
    captionText.textContent = WIREFRAME_LANGUAGE;
    caption.append(captionText);
    const copy = copyButton(() => current.textContent);
    const contentDOM = document.createElement("code");
    pre.append(caption, copy.element, contentDOM);
    dom.append(panel, pre);

    const draw = (): void => {
      frame = 0;
      if (destroyed) return;
      const started = performance.now();
      const parse = parseWireframe(current.textContent);
      if (parse.overLimit !== null) {
        // Keep the last good preview, marked stale, and say why.
        viewport.dataset.stale = "true";
        diagnostics.replaceChildren(Object.assign(document.createElement("li"), { textContent: parse.overLimit }));
        diagnostics.hidden = false;
        return;
      }
      delete viewport.dataset.stale;
      const next = renderWireframe(parse);
      if (rendered === null) viewport.append(next);
      else rendered.replaceWith(next);
      rendered = next;
      viewport.setAttribute("aria-label", wireframeSummary(parse));
      fitWireframe(viewport, next);
      diagnostics.replaceChildren(...parse.diagnostics.slice(0, 5).map(item =>
        Object.assign(document.createElement("li"), { textContent: `Line ${item.line}: ${item.message}` })));
      diagnostics.hidden = parse.diagnostics.length === 0;
      viewport.dataset.renderMs = (performance.now() - started).toFixed(1);
    };
    // First paint on the next frame. Text changes redraw after a short pause,
    // so a redraw (and the layout it forces) never sits in a keystroke's path.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (!destroyed && frame === 0) frame = requestAnimationFrame(draw);
    };
    const scheduleEdit = (): void => {
      if (destroyed) return;
      clearTimeout(timer);
      timer = setTimeout(schedule, REDRAW_PAUSE_MS);
    };
    const resize = new ResizeObserver(() => { if (rendered !== null) fitWireframe(viewport, rendered); });
    resize.observe(viewport);
    void document.fonts?.ready.then(() => { if (!destroyed && rendered !== null) fitWireframe(viewport, rendered); });

    const openSource = (event: Event): void => {
      event.preventDefault();
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (pos === undefined) return;
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))));
      editor.view.focus();
    };
    for (const button of [sourceButton, fullButton]) button.addEventListener("mousedown", event => event.preventDefault());
    sourceButton.addEventListener("click", openSource);
    fullButton.addEventListener("click", () => openFullSize(current.textContent));
    viewport.addEventListener("dblclick", openSource);

    const sync = (): void => {
      if (typeof current.attrs.id === "string") dom.id = current.attrs.id;
      else dom.removeAttribute("id");
      let annotated = false;
      current.forEach(child => { if (child.marks.some(mark => mark.type.name === COMMENT_MARK)) annotated = true; });
      dom.setAttribute("data-annotated", String(annotated));
    };
    sync();
    schedule();

    return {
      dom,
      contentDOM,
      update(updated: PMNode): boolean {
        if (!isWireframe(updated) || contentDOM.parentNode !== pre) return false;
        const changed = updated.textContent !== current.textContent;
        current = updated;
        sync();
        if (changed) scheduleEdit();
        return true;
      },
      stopEvent: (event: Event): boolean => event.target instanceof Node &&
        (panel.contains(event.target) || caption.contains(event.target) || copy.element.contains(event.target)),
      ignoreMutation: (mutation): boolean =>
        (mutation.type === "attributes" && mutation.target === dom) ||
        panel.contains(mutation.target) || caption.contains(mutation.target) || copy.element.contains(mutation.target),
      destroy: () => {
        destroyed = true;
        if (frame !== 0) cancelAnimationFrame(frame);
        clearTimeout(timer);
        resize.disconnect();
      },
    };
  };
}

/** `ub-wireframe-editing` on the wireframe code block holding the caret. */
function wireframeEditingPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state: EditorState): DecorationSet | null {
        const block = selectedBlock(state, "code");
        if (block === null || block.node.attrs.language !== WIREFRAME_LANGUAGE) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(block.pos, block.pos + block.node.nodeSize, { class: "ub-wireframe-editing" }),
        ]);
      },
    },
  });
}

export const WireframeBlocks = Extension.create({
  name: "uberblickWireframeBlocks",
  addProseMirrorPlugins() { return [wireframeEditingPlugin()]; },
});
