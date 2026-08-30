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
 *    `;` separator — or reads it and finds no boxes at all, which is what a
 *    header someone has just typed is. Neither is a failure and neither says
 *    anything extra: the block renders exactly as it did before this module
 *    existed.
 * 2. The source is past {@link MAX_SOURCE} or {@link lineEdgesAtMost} bounds
 *    one of its lines' arrows past {@link MAX_EDGES} — both read off the text
 *    — or the drawn graph is past {@link MAX_NODES} / {@link MAX_EDGES}. The
 *    reader is told which. Only those two text-read refusals may precede
 *    `parse`, because everything case 1 keeps silent has to reach its
 *    `ParseError` first.
 * 3. The block carries a `comment` mark. The schema lets annotations anchor in
 *    this block's text (CLAUDE.md), and a drawn diagram hides the text they are
 *    anchored in — so an annotated block stays source rather than swallowing
 *    the annotation.
 * 4. Anything else at all. The catch is total — it wraps the parse, the layout,
 *    the SVG *and* the DOM adoption that follows, and `draw` guards the rest of
 *    the update path around it. `snap` throws a bare `Error` at two
 *    internal-invariant sites, and a throw escaping this NodeView takes the
 *    whole editor down for every client of the document — see
 *    {@link drawDiagram}.
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
import { DARK_THEME, DEFAULT_THEME, ParseError, parse, snap, toSvg } from "@uberblick/ablauf";
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
 *
 * **An ablauf bump must re-check three things here**, all of them assumptions
 * about the library rather than about this code: that every *differing* string
 * token is still a colour — a differing non-colour string would be wrapped into
 * an invalid attribute value — that the escaping in `toSvg` still covers
 * the same vocabulary the XSS review of #514 checked it against, and that
 * {@link SHAPE_LABELS}, {@link CONNECTORS} and {@link LABELLED_CONNECTORS}
 * still match ablauf's grammar tables, because a connector spelling ablauf
 * gains that this hand-copy does not know makes {@link lineEdges}
 * *under*-count — the unsafe direction.
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
 * The size past which this block stays source and says so — three axes, all of
 * them the same 100ms line drawn in a different currency.
 *
 * `snap` is superlinear in both boxes and arrows and runs on the main thread,
 * so one durable block can freeze every reader who opens the document — and
 * because the text lives in the CRDT, nobody can reload out of it.
 *
 * **Boxes are counted against the worst shape, not the common one.** Cost at a
 * given box count spans 550x with shape, so a cap derived from a chain is not a
 * cap at all: on this host (Node 26.7.0, macOS) 64 boxes as a chain draw in
 * 0.9ms, while 64 *disconnected maximum-width decision boxes* — 2.2 kB of
 * source, no arrows at all — take 166ms. That shape is the calibration: 48 of
 * them cost 61ms here, 54 cost exactly 100ms, and 48 measured 59.5ms and 39.1ms
 * on the two other hosts #514 was reviewed on. Hence 48, not 64. Label width
 * does not move it; disconnectedness and box shape do.
 *
 * Arrows are a separate axis rather than a consequence of boxes, because
 * ablauf expands `&` groups multiplicatively: 3.3 kB of perfectly valid mermaid
 * reached 62,500 arrows and a 9 MB picture. 625 arrows measured ~22ms on the
 * faster host, ~3.5x that on the slower one, so 512 is the same mark in arrows.
 * The two caps compose at the largest shape that passes both at once — a
 * 16 & 32 grid, 48 boxes and exactly 512 arrows, 32ms here. (24 & 24 is *not*
 * that shape: 576 arrows, which the arrow cap refuses.)
 *
 * **Source length is the third axis, and it is checked before `parse`ing
 * anything at all.** The counts can only refuse a graph that already exists,
 * and building it is itself the attack: with repeated one-character ids in one
 * `&` line, edges grow as `(chars/8)²`, so 16 kB parses to 4.2M edges in 113ms
 * and 378 MB, 32 kB takes 434ms and 1.35 GB, and **48 kB aborts the process
 * with a fatal V8 out-of-memory** — which in a browser is the renderer dying,
 * and which no `catch` below can see, because it is not a JS exception.
 * {@link lineEdgesAtMost} closes that class in the currency the arrow cap
 * already counts in; this cap stays because bytes are a third thing worth
 * bounding, and it deliberately refuses some sources the counts would admit —
 * a single
 * 16,385-character label is one box and no arrows. It bounds the picture too —
 * `title: source` makes the SVG at least the source's size, and every label in
 * it comes from the source — which is what keeps a block the counts accept from
 * putting a 100 MB SVG in the DOM.
 *
 * Deliberately not configurable: a budget a document can raise is a budget an
 * agent can raise, and the freeze it prevents is everyone's, not the author's.
 */
const MAX_SOURCE = 16_384;
const MAX_NODES = 48;
const MAX_EDGES = 512;

/** ablauf's shape delimiters, longest opener first (`parse.js`'s `SHAPES`). */
const SHAPE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["([", "])"],
  ["((", "))"],
  ["[", "]"],
  ["(", ")"],
  ["{", "}"],
];
/** Connectors written whole; longest first, so `-.->` wins over `-.`. */
const CONNECTORS: readonly string[] = ["-.->", "-->", "---", "==>"];
/** The `A -- text --> B` spellings: an opener, and the arrows that close it. */
const LABELLED_CONNECTORS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["-.", [".->"]],
  ["--", ["-->", "---"]],
  ["==", ["==>"]],
];

/**
 * The arrows one statement line will contribute: the sum of (left terms x right
 * terms) over its connectors, which is exactly what `parseChain` pushes.
 */
function lineEdges(line: string): number {
  /**
   * `indexOf(needle, i)` is monotone in `i`, so a closer's last result stays
   * the answer until the scan passes it. Without this memo every `--` opener
   * whose `-->` closer is absent rescans the rest of the line, which makes the
   * pass quadratic — 208ms for 16 kB of `-- ---`, before anything is parsed
   * (#514 review, H-1). With it, each closer is searched over each region of
   * the line at most once, so the pass is linear.
   */
  const lastFound = new Map<string, number>();
  const nextIndex = (needle: string, from: number): number => {
    const cached = lastFound.get(needle);
    if (cached !== undefined && (cached < 0 || cached >= from)) return cached;
    const found = line.indexOf(needle, from);
    lastFound.set(needle, found);
    return found;
  };
  /** Past a label: its quoted form first, because that may contain the closer. */
  const skipLabel = (from: number, close: string): number => {
    let i = from;
    if (line[i] === '"') {
      const quote = line.indexOf('"', i + 1);
      if (quote < 0) return line.length;
      i = quote + 1;
    }
    const end = line.indexOf(close, i);
    return end < 0 ? line.length : end + close.length;
  };
  /** Past `-- text -->`, choosing the nearest closer as ablauf does. */
  const skipLabelled = (from: number, closers: readonly string[]): number => {
    let i = from;
    while (line[i] === " " || line[i] === "\t") i += 1;
    if (line[i] === '"') {
      const quote = line.indexOf('"', i + 1);
      if (quote < 0) return line.length;
      i = quote + 1;
    }
    let cut = -1;
    let length = 0;
    for (const closer of closers) {
      const found = nextIndex(closer, i);
      if (found >= 0 && (cut < 0 || found < cut)) {
        cut = found;
        length = closer.length;
      }
    }
    return cut < 0 ? line.length : cut + length;
  };
  /** Past a `-->|text|` label, or unmoved where the connector carries none. */
  const skipPipe = (from: number): number => {
    let i = from;
    while (line[i] === " " || line[i] === "\t") i += 1;
    if (line[i] !== "|") return from;
    return skipLabel(i + 1, "|");
  };

  const groups: number[] = [];
  let terms = 1;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "&") {
      terms += 1;
      i += 1;
      continue;
    }
    const shape = SHAPE_LABELS.find(([open]) => line.startsWith(open, i));
    if (shape !== undefined) {
      i = skipLabel(i + shape[0].length, shape[1]);
      continue;
    }
    const plain = CONNECTORS.find((connector) => line.startsWith(connector, i));
    const labelled =
      plain === undefined
        ? LABELLED_CONNECTORS.find(([open]) => line.startsWith(open, i))
        : undefined;
    if (plain !== undefined) i += plain.length;
    else if (labelled !== undefined) i = skipLabelled(i + labelled[0].length, labelled[1]);
    else {
      i += 1;
      continue;
    }
    i = skipPipe(i);
    groups.push(terms);
    terms = 1;
  }
  groups.push(terms);

  let edges = 0;
  for (let g = 1; g < groups.length; g += 1) edges += (groups[g - 1] ?? 0) * (groups[g] ?? 0);
  return edges;
}

/**
 * An upper bound on the arrows any *single statement line* asks `parse` to
 * build, read off the text alone — {@link MAX_EDGES} applied one step earlier,
 * in the currency it already counts.
 *
 * The count cap can only refuse a graph that has been built, and for `&` groups
 * building it *is* the damage: `a & a & … --> b & b & …` written to exactly
 * {@link MAX_SOURCE} characters materializes 4.2M edges and ~290 MB before any
 * count is looked at, and kills a small heap outright (#514 review, G-3). The
 * quantity that matters is knowable first, and costs one pass with no
 * allocation, because ablauf's expansion rule is local to a line: every
 * connector on it makes one edge per (term on its left x term on its right).
 *
 * **Per line, deliberately not the document total.** The damage this guard
 * exists to prevent is multiplicative expansion inside one statement line, and
 * that is all it refuses. Refusing on the *sum* pre-parse put the size note in
 * front of the `ParseError` classification, so a 600-message `sequenceDiagram`
 * — 600 counted arrow tokens ablauf will never read — was told it was "too
 * large" and to split itself, instead of staying the silent source view that
 * refusal case 1 above and the job doc promise (#514 review, H-2). A
 * multi-line total goes to `parse`, whose `ParseError` sorts the unsupported
 * out first; what it accepts is bounded to {@link MAX_EDGES} edges per
 * statement line — ~64k edges / ~5 MB at {@link MAX_SOURCE}, four orders below
 * the one-line case defended here — and the post-`parse` count check still
 * refuses it before layout.
 *
 * It bounds rather than predicts, and only ever upwards. It refuses nothing,
 * so it need not agree with ablauf about what parses: a construct ablauf
 * rejects can read as an extra term or an extra connector here, and both only
 * make the number larger. For source ablauf does parse the two agree exactly,
 * which is why this refuses nothing {@link MAX_EDGES} admits.
 */
function lineEdgesAtMost(source: string): number {
  let worst = 0;
  let headerSeen = false;
  for (const line of source.split(/\r?\n/)) {
    const statement = line.trim();
    // Blank lines and `%%` comments carry no statement; the first line that
    // does is the `flowchart` header, which declares nothing.
    if (statement === "" || statement.startsWith("%%")) continue;
    if (!headerSeen) {
      headerSeen = true;
      continue;
    }
    worst = Math.max(worst, lineEdges(statement));
  }
  return worst;
}

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

/**
 * The refusal, naming only the limit that was actually passed — a reader told
 * their 64 arrows are "past 512" learns nothing and distrusts the rest.
 */
const tooLarge = (past: string): string =>
  `Too large to draw: ${past}. Laying that out would freeze the page for everyone reading the document, so here is the source instead. Splitting it into smaller diagrams draws each of them.`;

const overCounts = (nodes: number, edges: number): string => {
  const past: string[] = [];
  if (nodes > MAX_NODES) past.push(`${nodes} boxes past this block's ${MAX_NODES}`);
  if (edges > MAX_EDGES) past.push(`${edges} arrows past this block's ${MAX_EDGES}`);
  return tooLarge(past.join(" and "));
};

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
 * **The catch is total, and that is the point.** It wraps every statement in
 * this function, `DOMParser` and `importNode` included — a `try` that stops
 * before the DOM work is not a total catch, it is a docstring (#514 review,
 * F-A). A throw that escapes here escapes through y-prosemirror out of
 * `NodeView.update`, *after* the Y.Doc has already taken the text — so the
 * reader cannot type, and every client that later opens the document fails to
 * mount the editor at all, permanently, recoverable only by an agent rewriting
 * the block over MCP. One block's picture is never worth that.
 *
 * Exactly one throw is classified rather than reported: `ParseError`, which is
 * ablauf saying "not my subset" and is the ordinary fate of a `sequenceDiagram`.
 * Its sibling `RenderError` deliberately is *not*, because ablauf raises it only
 * for arguments this binding supplied — a non-finite number, a missing position,
 * a bad `margin`, a bad numeric theme token. Every reachable `RenderError` is
 * therefore a bug here, and a bug that renders as silence is a bug nobody finds,
 * so it takes the same path as any other unexpected throw.
 */
function drawDiagram(target: HTMLElement, source: string): Drawing {
  try {
    // Both of these run before `parse`, because the counts below can only
    // refuse a graph that has already been built, and building it is itself
    // the cost — see MAX_SOURCE and lineEdgesAtMost. Only the one-line bound
    // may refuse here: anything it admits reaches `parse`, so an unsupported
    // diagram type still gets its `ParseError` and stays silent source.
    if (source.length > MAX_SOURCE) {
      target.replaceChildren();
      return {
        drawn: false,
        note: tooLarge(`${source.length} characters of source past this block's ${MAX_SOURCE}`),
      };
    }
    const bound = lineEdgesAtMost(source);
    if (bound > MAX_EDGES) {
      target.replaceChildren();
      return { drawn: false, note: tooLarge(`${bound} arrows past this block's ${MAX_EDGES}`) };
    }
    const graph = parse(source);
    // A header and nothing else parses cleanly to an empty graph, and ablauf
    // draws it as a valid 40x40 SVG with no glyphs in it. Reporting that as
    // drawn hides the reader's own text behind an empty box the moment the
    // caret leaves the block they are typing in (#514 review, G-1) — so a
    // graph with no boxes takes the same silent-source path as `flow`.
    if (graph.nodes.length === 0) {
      target.replaceChildren();
      return UNREADABLE;
    }
    const nodes = graph.nodes.length;
    const edges = graph.edges.length;
    if (nodes > MAX_NODES || edges > MAX_EDGES) {
      target.replaceChildren();
      return { drawn: false, note: overCounts(nodes, edges) };
    }
    // The source is the only honest alternative text a diagram has, and it is
    // the one thing a reader of the drawn block cannot otherwise reach: the
    // stylesheet hides the `<pre>` while the picture shows.
    const svg = toSvg(graph, snap(graph).positions, { theme: THEME, title: source });
    // Parsed as SVG rather than assigned as markup: the picture is a foreign
    // document, and this is the one path that puts it in the right namespace
    // without an HTML parser's opinions in between.
    const drawn = new DOMParser().parseFromString(svg, "image/svg+xml");
    // A malformed SVG does not throw — `DOMParser` hands back a `parsererror`
    // document instead, and adopting that would replace the reader's text with
    // a browser error box. ablauf's escaping covers `& < > " '` and passes
    // XML-illegal characters through, so a control character pasted into a
    // label reaches here today.
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
  } catch (error) {
    target.replaceChildren();
    if (error instanceof ParseError) return UNREADABLE;
    console.error("uberblick: drawing a mermaid block failed", error);
    return { drawn: false, note: FAILED };
  }
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
  // has a name — and that name is what assistive technology announces here,
  // because the `<svg>` inside carries no role of its own. Its `<title>` is the
  // block's source, reachable by opening the control, not read out in its
  // place.
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

  const redraw = (): void => {
    // Outside the memo: the chrome mirrors the block's own attributes, which
    // follow the node rather than the picture, so a node whose drawing is
    // unchanged must still take its `id` from the update it arrived in.
    mermaidChrome.sync(current, dom);
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
  };

  /**
   * The boundary. `drawDiagram` guards itself, but the work around it —
   * reading the marks, mirroring the block's chrome — runs on the same update
   * ProseMirror is in the middle of, and one throw from any of it bricks the
   * editor for every client of the document. Nothing but DOM primitives runs
   * in the catch, so the degraded state cannot itself fail.
   */
  const draw = (): void => {
    try {
      redraw();
    } catch (error) {
      console.error("uberblick: drawing a mermaid block failed", error);
      rendered.replaceChildren();
      dom.setAttribute("data-rendered", "false");
      note.textContent = FAILED;
      note.hidden = false;
    }
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
