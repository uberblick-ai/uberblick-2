/**
 * The mermaid block: source that draws itself, when ablauf can read it (#495).
 *
 * `nodes.ts` used to say a live renderer was out of scope because "rendering
 * the diagram would mean a second representation of the block's text". That
 * premise does not hold here. The SVG is derived on every paint from the
 * block's own Y.XmlText and from nothing else — no layout is stored, no
 * attribute is written, no transaction is dispatched — so the text stays the
 * only representation of what the diagram *means*. What a reader sees is
 * presentation over state that is already true, exactly as the `table` block's
 * drawing is (table.ts), and this follows that block's shape deliberately:
 *
 * - the NodeView holds both representations at once, and which one shows is
 *   CSS keyed off a class;
 * - `sourceEditingPlugin` (source-chrome.ts) puts that class on the block the
 *   selection is in, so the diagram is what a reader sees and the source is
 *   what they get the moment their caret is in the block;
 * - the copy button stays, because mermaid source is still text people take
 *   away.
 *
 * **Degradation is the load-bearing part.** ablauf reads a strict subset of
 * mermaid's flowchart grammar and refuses everything else with a `ParseError`
 * rather than half-drawing it. A `sequenceDiagram`, a `subgraph`, a `;`
 * separator — anything outside the subset — renders exactly as it did before
 * this module existed: the source block, chrome intact. That refusal is caught
 * by type and never by a bare `catch`, so a bug in this binding surfaces as a
 * bug instead of quietly looking like an unsupported diagram.
 *
 * Rendering is deterministic: same text, same theme, byte-identical SVG on
 * every replica. Nothing about the picture travels between clients, because
 * nothing about the picture is stored.
 */

import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Plugin } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import {
  DARK_THEME,
  DEFAULT_THEME,
  ParseError,
  RenderError,
  parse,
  snap,
  toSvg,
} from "@uberblick/ablauf";
import {
  copyButton,
  mermaidChrome,
  sourceEditingPlugin,
} from "./source-chrome.js";

/** On the mermaid block whose source the reader is editing. */
export const EDITING_CLASS = "ub-mermaid-editing";

/* ---------------------------------------------------------------- appearance */

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The OS scheme query, or null where the environment has no `matchMedia`. */
function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY)
    : null;
}

/**
 * Which half of the palette to draw with, as the yes/no answer ablauf needs.
 *
 * `styles.css` never has to ask this question — `light-dark()` and
 * `color-scheme` answer it for CSS. A renderer that emits colours in an SVG
 * string has no such luxury, so it resolves `data-theme` itself: the attribute
 * is the reader's explicit choice (ui/theme.ts), and its absence is "system",
 * which is the only case where the OS gets a say.
 */
export function drawingDark(): boolean {
  const chosen = document.documentElement.getAttribute("data-theme");
  if (chosen === "dark") return true;
  if (chosen === "light") return false;
  return darkQuery()?.matches ?? false;
}

/**
 * Call `changed` whenever the answer {@link drawingDark} gives could have
 * moved: the reader picking an appearance, and the OS scheme changing under
 * "system". Returns the release, which every caller owes its `destroy`.
 *
 * A NodeView's own `update` fires for node changes and would never hear either
 * of these.
 */
function onAppearanceChange(changed: () => void): () => void {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const query = darkQuery();
  // jsdom's MediaQueryList is the deprecated `addListener` shape in some
  // versions; a diagram that cannot subscribe still draws and still redraws on
  // the attribute, which is the path a reader's own choice takes.
  const listening = typeof query?.addEventListener === "function";
  if (listening) query?.addEventListener("change", changed);
  return () => {
    observer.disconnect();
    if (listening) query?.removeEventListener("change", changed);
  };
}

/* ------------------------------------------------------------------ drawing */

/**
 * Draw `source` into `target` as a diagram, and answer whether it drew one.
 *
 * With no stored layout, `snap` places every node by ablauf's deterministic
 * fallback rule — the same text gives the same coordinates on every replica,
 * which is what makes the SVG comparable at all.
 */
function drawDiagram(target: HTMLElement, source: string, dark: boolean): boolean {
  let svg: string;
  try {
    const graph = parse(source);
    svg = toSvg(graph, snap(graph).positions, {
      theme: dark ? DARK_THEME : DEFAULT_THEME,
    });
  } catch (error) {
    // Exactly the two refusals ablauf declares. A bare `catch` here would make
    // every bug in this binding look like an unsupported diagram, and the
    // block would silently stay source for ever.
    if (error instanceof ParseError || error instanceof RenderError) {
      target.replaceChildren();
      return false;
    }
    throw error;
  }
  // Parsed as SVG rather than assigned as markup: the picture is a foreign
  // document, and this is the one path that puts it in the right namespace
  // without an HTML parser's opinions in between.
  const drawn = new DOMParser().parseFromString(svg, "image/svg+xml");
  target.replaceChildren(document.importNode(drawn.documentElement, true));
  return true;
}

/* ----------------------------------------------------------------- nodeview */

/**
 * `<div class="ub-mermaid" data-block-type="mermaid" data-rendered="…">`
 * holding the drawn diagram, the copy button, and the source both came from.
 *
 * `data-rendered="false"` is what keeps the source visible for everything
 * ablauf will not draw — the reader of a `sequenceDiagram` must not be shown an
 * empty box with their text hidden inside it.
 */
export const mermaidBlockView: NodeViewRenderer = ({
  node,
  editor,
  getPos,
}: NodeViewRendererProps): NodeView => {
  let current: ProseMirrorNode = node;
  let dark = drawingDark();

  const dom = mermaidChrome.root();
  const contentDOM = mermaidChrome.content();

  const rendered = document.createElement("div");
  rendered.className = "ub-mermaid-render";
  // The attribute rather than the IDL property: the attribute is what the
  // browser's editing engine and ProseMirror both read, and it is the one a
  // test can see.
  rendered.setAttribute("contenteditable", "false");

  const button = copyButton(() => current.textContent);
  dom.append(rendered, button.element, contentDOM);

  const draw = (): void => {
    dom.setAttribute(
      "data-rendered",
      String(drawDiagram(rendered, current.textContent, dark)),
    );
    mermaidChrome.sync(current, dom);
  };
  draw();

  const repaint = (): void => {
    const next = drawingDark();
    if (next === dark) return;
    dark = next;
    draw();
  };
  const release = onAppearanceChange(repaint);

  // Clicking the diagram is how a reader opens the source, and the caret has to
  // be put there explicitly — see the same comment in table.ts.
  const open = (event: Event): void => {
    event.preventDefault();
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined) return;
    const { view } = editor;
    const inside = view.state.doc.resolve(pos + 1);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(inside)));
    view.focus();
  };
  rendered.addEventListener("mousedown", open);

  return {
    dom,
    contentDOM,
    update(updated: ProseMirrorNode): boolean {
      if (updated.type !== current.type) return false;
      // See source-chrome.ts: a contentDOM the browser's editing engine has
      // taken out of the tree cannot be patched in place.
      if (contentDOM.parentNode !== dom) return false;
      current = updated;
      draw();
      return true;
    },
    // The diagram's own mousedown and the button's own events. Everything else
    // — a click in the source, the padding around it — must reach ProseMirror
    // and place the caret.
    stopEvent: (event: Event): boolean => {
      if (!(event.target instanceof Node)) return false;
      if (button.element.contains(event.target)) return true;
      return event.type === "mousedown" && rendered.contains(event.target);
    },
    // Ours, both of them: the diagram is redrawn from the document on every
    // update and the button rewrites its own label. Mutations inside the source
    // are ProseMirror's and are deliberately not ignored — see the warning in
    // source-chrome.ts.
    ignoreMutation: (mutation: { target: Node }): boolean =>
      rendered.contains(mutation.target) ||
      button.element.contains(mutation.target),
    destroy: () => {
      release();
      button.destroy();
      rendered.removeEventListener("mousedown", open);
    },
  };
};

/** Tiptap wrapper around the mermaid block's one plugin. */
export const MermaidBlocks = Extension.create({
  name: "uberblickMermaidBlocks",
  addProseMirrorPlugins(): Plugin[] {
    return [sourceEditingPlugin("mermaid", EDITING_CLASS)];
  },
});
