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
 * **Degradation is the load-bearing part, and it is the block that degrades,
 * never the editor.** Four things stop a picture being drawn, and every one of
 * them leaves the source on screen with its chrome intact:
 *
 * 1. ablauf reads a strict subset of mermaid's flowchart grammar and refuses
 *    everything else with a `ParseError` — a `sequenceDiagram`, a `subgraph`, a
 *    `;` separator. That is not a failure and says nothing extra: the block
 *    renders exactly as it did before this module existed.
 * 2. The diagram is past {@link MAX_NODES} / {@link MAX_EDGES}, and the reader
 *    is told so.
 * 3. The block carries a `comment` mark. The schema lets annotations anchor in
 *    this block's text (CLAUDE.md), and a drawn diagram hides the text they are
 *    anchored in — so an annotated block stays source rather than swallowing
 *    the annotation.
 * 4. Anything else at all. The catch is total on purpose: `snap` throws a bare
 *    `Error` at two internal-invariant sites, and a throw escaping this
 *    NodeView takes the whole editor down for every client of the document —
 *    see {@link drawDiagram}.
 *
 * Rendering is deterministic: same text, byte-identical SVG on every replica —
 * and now on every appearance too, because the palette is `light-dark()` rather
 * than a colour chosen in JS. Nothing about the picture travels between
 * clients, because nothing about the picture is stored.
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
import type { Theme } from "@uberblick/ablauf";
import { COMMENT_MARK } from "@uberblick/schema";
import {
  copyButton,
  mermaidChrome,
  selectedBlock,
  sourceEditingPlugin,
} from "./source-chrome.js";

/** On the mermaid block whose source the reader is editing. */
const EDITING_CLASS = "ub-mermaid-editing";

/* ---------------------------------------------------------------- appearance */

/**
 * ablauf's two palettes as one: every colour token is `light-dark(light, dark)`
 * and every other token is the default's.
 *
 * A renderer that writes colours into an SVG string normally has to be told
 * which appearance is in force, and then told again when it changes. It does
 * not, because those strings land in presentation attributes, which are CSS —
 * so `color-scheme` on the page answers the question for the picture the same
 * way it answers it for every rule in styles.css, live, with nothing
 * subscribed and nothing drawn again. That is what lets a mounted diagram cost
 * nothing when the reader flips appearance.
 *
 * The pairing is derived rather than listed: a token is a colour exactly when
 * both halves are strings that differ, which is true of all twelve colours and
 * of none of the sizes (`fontFamily` is one string in both). A token ablauf
 * adds is therefore handled without an edit here.
 */
const THEME: Partial<Theme> = (() => {
  const merged: Record<string, string | number> = { ...DEFAULT_THEME };
  for (const [token, light] of Object.entries(DEFAULT_THEME)) {
    const dark = DARK_THEME[token as keyof Theme];
    if (typeof light === "string" && typeof dark === "string" && light !== dark) {
      merged[token] = `light-dark(${light}, ${dark})`;
    }
  }
  return merged as Partial<Theme>;
})();

/* -------------------------------------------------------------- the budget */

/**
 * The size past which this block stays source and says so.
 *
 * `snap` is superlinear in both boxes and arrows and runs on the main thread,
 * so one durable block can freeze every reader who opens the document — and
 * because the text lives in the CRDT, nobody can reload out of it. The line is
 * where a single draw stops being instant on the slowest host measured for
 * #514: 51 boxes cost 60ms of `snap` there and 102 cost 298ms, which puts the
 * 100ms mark at ~64 boxes.
 *
 * Arrows are a separate axis rather than a consequence of boxes, because
 * ablauf expands `&` groups multiplicatively: 3.3 kB of perfectly valid mermaid
 * reached 62,500 arrows and a 9 MB picture. 625 arrows measured ~22ms on the
 * faster host, ~3.5x that on the slower one, so 512 is the same 100ms mark
 * expressed in arrows.
 *
 * Deliberately not configurable: a budget a document can raise is a budget an
 * agent can raise, and the freeze it prevents is everyone's, not the author's.
 */
const MAX_NODES = 64;
const MAX_EDGES = 512;

/* ------------------------------------------------------------------ drawing */

/** What the block shows instead of a picture, and what it tells the reader. */
interface Drawing {
  /** Whether the render target now holds a picture. */
  drawn: boolean;
  /** A visible explanation, or null where the source alone is the answer. */
  note: string | null;
}

/** Source, with nothing to explain: ablauf simply does not read this text. */
const UNREADABLE: Drawing = { drawn: false, note: null };

const tooLarge = (nodes: number, edges: number): string =>
  `Too large to draw: ${nodes} boxes and ${edges} arrows, past this block's ${MAX_NODES} and ${MAX_EDGES}. Laying that out would freeze the page for everyone reading the document, so here is the source instead. Splitting it into smaller diagrams draws each of them.`;

const ANNOTATED =
  "Shown as source because this block carries a comment: comments are anchored in the text, and a drawn diagram would hide the text they point at.";

const FAILED =
  "Could not be drawn: the diagram renderer failed on this source. The source is below, unchanged; the browser console has the detail.";

/**
 * Draw `source` into `target`, and say what the block should show.
 *
 * With no stored layout, `snap` places every node by ablauf's deterministic
 * fallback rule — the same text gives the same coordinates on every replica,
 * which is what makes the SVG comparable at all.
 *
 * **The catch is total, and that is the point.** ablauf declares two refusals,
 * `ParseError` for source outside its subset and `RenderError` for a picture it
 * will not draw, and those two are still recognised by type — they are what
 * keeps an unsupported diagram distinguishable from a broken one. But they are
 * not everything ablauf throws: `snap` throws a bare `Error` at
 * `dist/layout/snap.js:238` and `:320` on its own internal invariants. A throw
 * that escapes here escapes through y-prosemirror out of `NodeView.update`,
 * *after* the Y.Doc has already taken the text — so the reader cannot type, and
 * every client that later opens the document fails to mount the editor at all,
 * permanently, recoverable only by an agent rewriting the block over MCP. One
 * block's picture is never worth that, so anything unexpected degrades this
 * block and shouts on the console.
 */
function drawDiagram(target: HTMLElement, source: string): Drawing {
  let svg: string;
  try {
    const graph = parse(source);
    const nodes = graph.nodes.length;
    const edges = graph.edges.length;
    if (nodes > MAX_NODES || edges > MAX_EDGES) {
      target.replaceChildren();
      return { drawn: false, note: tooLarge(nodes, edges) };
    }
    // The source is the only honest alternative text a diagram has, and it is
    // the one thing a reader of the drawn block cannot otherwise reach: the
    // stylesheet hides the `<pre>` while the picture shows.
    svg = toSvg(graph, snap(graph).positions, { theme: THEME, title: source });
  } catch (error) {
    target.replaceChildren();
    if (error instanceof ParseError || error instanceof RenderError) {
      return UNREADABLE;
    }
    console.error("uberblick: drawing a mermaid block failed", error);
    return { drawn: false, note: FAILED };
  }
  // Parsed as SVG rather than assigned as markup: the picture is a foreign
  // document, and this is the one path that puts it in the right namespace
  // without an HTML parser's opinions in between.
  const drawn = new DOMParser().parseFromString(svg, "image/svg+xml");
  // A malformed SVG does not throw — `DOMParser` hands back a `parsererror`
  // document instead, and adopting that would replace the reader's text with a
  // browser error box. ablauf's escaping covers `& < > " '` and passes
  // XML-illegal characters through, so a control character pasted into a label
  // reaches here today.
  if (drawn.getElementsByTagName("parsererror").length > 0) {
    target.replaceChildren();
    console.error(
      "uberblick: ablauf drew an SVG this browser could not parse",
      drawn.documentElement.textContent,
    );
    return { drawn: false, note: FAILED };
  }
  target.replaceChildren(document.importNode(drawn.documentElement, true));
  return { drawn: true, note: null };
}

/** Whether any of the block's text carries an annotation's anchor. */
function carriesComment(node: ProseMirrorNode): boolean {
  let found = false;
  node.forEach((child) => {
    if (child.marks.some((mark) => mark.type.name === COMMENT_MARK)) found = true;
  });
  return found;
}

/* ----------------------------------------------------------------- nodeview */

/**
 * `<div class="ub-mermaid" data-block-type="mermaid" data-rendered="…">`
 * holding the drawn diagram, the reason there is none, the copy button, and the
 * source all of it came from.
 *
 * `data-rendered="false"` is what keeps the source visible for everything that
 * does not draw — the reader of a `sequenceDiagram` must not be shown an empty
 * box with their text hidden inside it.
 */
export const mermaidBlockView: NodeViewRenderer = ({
  node,
  editor,
  getPos,
}: NodeViewRendererProps): NodeView => {
  let current: ProseMirrorNode = node;

  const dom = mermaidChrome.root();
  const contentDOM = mermaidChrome.content();

  const rendered = document.createElement("div");
  rendered.className = "ub-mermaid-render";
  // The attribute rather than the IDL property: the attribute is what the
  // browser's editing engine and ProseMirror both read, and it is the one a
  // test can see.
  rendered.setAttribute("contenteditable", "false");
  // Opening the source is a control, so it is reachable by the keyboard and it
  // has a name. The SVG's own `<title>` is the block's source, which is what a
  // screen reader gets for the picture itself.
  rendered.setAttribute("role", "button");
  rendered.setAttribute("tabindex", "0");
  rendered.setAttribute("aria-label", "Diagram — open its mermaid source");

  const note = document.createElement("p");
  note.className = "ub-mermaid-note";
  note.setAttribute("contenteditable", "false");
  note.hidden = true;

  const button = copyButton(() => current.textContent);
  dom.append(rendered, note, button.element, contentDOM);

  /** Whether the reader's caret is in *this* block — the same rule the CSS uses. */
  const beingEdited = (): boolean => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined) return false;
    return selectedBlock(editor.state, "mermaid")?.pos === pos;
  };

  /** What the picture on screen was drawn from, or null before the first draw. */
  let drawnFrom: { text: string; annotated: boolean } | null = null;

  const draw = (): void => {
    const text = current.textContent;
    const annotated = carriesComment(current);
    if (drawnFrom?.text === text && drawnFrom.annotated === annotated) return;
    // While the caret is in the block the stylesheet shows the source and hides
    // the picture, so a redraw per keystroke buys a picture nobody can see and
    // costs everyone the layout pass. Draw once when the caret leaves instead —
    // except on mount, where there is nothing on screen yet.
    if (drawnFrom !== null && beingEdited()) return;

    drawnFrom = { text, annotated };
    let drawing: Drawing;
    if (annotated) {
      rendered.replaceChildren();
      drawing = { drawn: false, note: ANNOTATED };
    } else {
      drawing = drawDiagram(rendered, text);
    }
    dom.setAttribute("data-rendered", String(drawing.drawn));
    note.textContent = drawing.note ?? "";
    note.hidden = drawing.note === null;
    mermaidChrome.sync(current, dom);
  };
  draw();

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
  const openByKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") open(event);
  };
  rendered.addEventListener("mousedown", open);
  rendered.addEventListener("keydown", openByKey);

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
    // The diagram's own events and the button's own events. Everything else —
    // a click in the source, the padding around it — must reach ProseMirror and
    // place the caret.
    stopEvent: (event: Event): boolean => {
      if (!(event.target instanceof Node)) return false;
      if (button.element.contains(event.target)) return true;
      if (rendered.contains(event.target)) {
        return event.type === "mousedown" || event.type === "keydown";
      }
      return false;
    },
    // Ours, all three: the diagram is redrawn from the document on every
    // update, the note is written from the same place, and the button rewrites
    // its own label. Mutations inside the source are ProseMirror's and are
    // deliberately not ignored — see the warning in source-chrome.ts.
    ignoreMutation: (mutation: { target: Node }): boolean =>
      rendered.contains(mutation.target) ||
      note.contains(mutation.target) ||
      button.element.contains(mutation.target),
    destroy: () => {
      button.destroy();
      rendered.removeEventListener("mousedown", open);
      rendered.removeEventListener("keydown", openByKey);
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
