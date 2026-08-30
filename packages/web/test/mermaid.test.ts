/**
 * The mermaid block: source that draws itself (#495).
 *
 * Two families of contract, and both are about the fact that the *source is
 * still the storage*.
 *
 * What the block draws:
 *
 * 1. **Drawing writes nothing.** A block that renders has the same text and the
 *    same stored `rev` afterwards as before — the picture is derived on every
 *    paint, so there is no second copy of the diagram anywhere in the document.
 * 2. **Everything ablauf will not draw stays exactly as it was.** A
 *    `sequenceDiagram`, a `subgraph`, a `;` separator: the source block with
 *    its copy button, unchanged. This is the case that must not regress
 *    silently, because a diagram that quietly stops drawing looks like nothing
 *    at all.
 * 3. **The caret opens the source**, which is the whole editing model, and it
 *    is the same gesture the table block has.
 * 4. **The drawing follows the document, live.** An agent's `edit_block`
 *    arrives as an ordinary update and the diagram a reader is looking at
 *    redraws — and while that reader is *editing* the block instead, it does
 *    not, because the stylesheet has the picture hidden and the layout pass is
 *    superlinear.
 * 5. **Two replicas draw the same picture**, and now so do two appearances:
 *    the palette is `light-dark()` in the SVG, so nothing about the picture
 *    depends on who is looking at it. Nothing about layout travels, because
 *    nothing about layout is stored.
 *
 * What the block refuses to draw, and how it refuses (#514's review round).
 * Every one of these leaves the reader's text on screen:
 *
 * 6. **A diagram past the size budget** — on any of its three axes, and the
 *    freeze it prevents belongs to every reader of the document, not to whoever
 *    pasted the block. The source-length axis is the one checked before
 *    `parse`, because building the graph is itself the cost.
 * 7. **An unexpected throw anywhere in the update path.** `snap` throws a bare
 *    `Error` on its own invariants, `DOMParser` and `importNode` are browser
 *    primitives only a docstring promised would never throw, and the block's
 *    chrome is mirrored outside the renderer altogether. A throw escaping the
 *    NodeView bricks the editor for every client of the document, permanently.
 *    The block degrades instead.
 * 8. **A block carrying an annotation**, because a drawn diagram hides the text
 *    the annotation is anchored in.
 *
 * Read back through the schema package, as everywhere: the document is the
 * deliverable, the DOM is what a reader happens to see.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  editBlock,
  getBlockRev,
  getBlocks,
  initDoc,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { parse } from "@uberblick/ablauf";
import { mermaidChrome } from "../src/editor/source-chrome.js";
import { mountEditor } from "./helpers.js";

/**
 * `snap` made to fail the way ablauf's own code can (`dist/layout/snap.js:238`
 * throws a bare `Error`, which no `instanceof` in the binding can name). The
 * flag is off for every test but the one that turns it on.
 */
const ablauf = vi.hoisted(() => ({ snapThrows: false, parsed: 0 }));

vi.mock("@uberblick/ablauf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@uberblick/ablauf")>();
  return {
    ...actual,
    // Counted, not replaced: whether a graph was built at all is the contract
    // the pre-parse arrow bound exists to keep (#514 review, G-3).
    parse: (...args: Parameters<typeof actual.parse>) => {
      ablauf.parsed += 1;
      return actual.parse(...args);
    },
    snap: (...args: Parameters<typeof actual.snap>) => {
      if (ablauf.snapThrows) {
        throw new Error('ablauf: no free position for "a" within 512 grid steps of (0, 0)');
      }
      return actual.snap(...args);
    },
  };
});

const FLOWCHART = "flowchart TD\n  start([Request]) --> check{Valid?}\n  check -->|no| deny[401]";
const SEQUENCE = "sequenceDiagram\n  alice->>bob: hello";
const SUBGRAPH = "flowchart TD\n  subgraph one\n    a --> b\n  end";

/**
 * A sequence diagram whose 600 `-->>` messages read as 600 arrow tokens ablauf
 * will never parse. Big enough that a pre-`parse` refusal on the *document
 * total* claims it is "too large" and tells the reader to split it — the false
 * note #514's review caught (H-2) — while the per-line bound passes it through
 * to its ordinary `ParseError` and today's silent source view. The tiny
 * fixtures above cannot see the difference.
 */
const SEQUENCE_600 = `sequenceDiagram\n${Array.from({ length: 600 }, (_, i) => `  a-->>b: m${i}`).join("\n")}`;

/**
 * The same diagram past the source cap — 44,505 characters. The per-line arrow
 * bound was not the only gate that could answer before the `ParseError`: the
 * byte cap did it one step earlier, and told a diagram nothing would have laid
 * out that it was too large and should split itself (#514 review, F-1).
 */
const SEQUENCE_BIG = `sequenceDiagram\n${Array.from({ length: 1_200 }, (_, i) => `  alpha-->>bravo: message number ${i}`).join("\n")}`;

/**
 * `n` disconnected maximum-width decision boxes — the shape the box cap is
 * calibrated against, because cost at a given box count spans 550x with shape
 * and this is the expensive end (#514 review, F-C). The same 64 boxes as a
 * chain draw in under a millisecond.
 */
function diamonds(n: number): string {
  const lines = ["flowchart TD"];
  for (let i = 0; i < n; i += 1) lines.push(`  n${i}{${"A".repeat(26)}}`);
  return lines.join("\n");
}

/** One box whose label fills the source to exactly `chars` characters. */
function padded(chars: number): string {
  const head = "flowchart TD\n  a[";
  return `${head}${"A".repeat(chars - head.length - 1)}]`;
}

/**
 * `left * right` arrows over `left + right` boxes — mermaid's `&` groups, which
 * is how a few hundred bytes of valid source becomes tens of thousands of edges.
 */
function grid(left: number, right: number): string {
  const l = Array.from({ length: left }, (_, i) => `l${i}`).join(" & ");
  const r = Array.from({ length: right }, (_, i) => `r${i}`).join(" & ");
  return `flowchart TD\n  ${l} --> ${r}`;
}

/**
 * `terms²` arrows over two boxes: the same one-character id repeated on both
 * sides of one arrow, so the source stays small while the graph does not. 2,046
 * a side is 16,382 characters — inside the source cap, and 4.2M edges and
 * ~290 MB the moment anything parses it (#514 review, G-3).
 */
function expansion(terms: number): string {
  const left = Array.from({ length: terms }, () => "a").join(" & ");
  const right = Array.from({ length: terms }, () => "b").join(" & ");
  return `flowchart TD\n  ${left} --> ${right}`;
}

function docWithMermaid(text: string): { ydoc: Y.Doc; id: string } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "mermaid-doc", title: "Diagrams" });
  const id = appendBlock(ydoc, { type: "mermaid", text });
  appendBlock(ydoc, { type: "paragraph", text: "elsewhere" });
  return { ydoc, id };
}

function block(editor: Editor): Element | null {
  return editor.view.dom.querySelector(".ub-mermaid");
}

function diagram(editor: Editor): SVGElement | null {
  return editor.view.dom.querySelector(".ub-mermaid-render svg");
}

/**
 * The text actually drawn into the picture, and the only honest evidence that
 * anything was: `toSvg` is called with `title: source`, so the SVG's own
 * `textContent` carries the whole block source even when nothing was laid out
 * — an empty canvas satisfies every label assertion made against it (#514
 * review, G-2).
 */
function glyphs(editor: Editor): string {
  const svg = diagram(editor);
  if (svg === null) return "";
  return [...svg.querySelectorAll("text")].map((text) => text.textContent).join("\n");
}

/** The visible explanation for a block that is not a picture, if there is one. */
function note(editor: Editor): string | null {
  const element = editor.view.dom.querySelector<HTMLElement>(".ub-mermaid-note");
  return element === null || element.hidden ? null : element.textContent;
}

/** Put the caret at the start of the block at `index`. */
function caret(editor: Editor, index: number): void {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  editor.commands.setTextSelection(pos);
}

afterEach(() => {
  ablauf.snapThrows = false;
  ablauf.parsed = 0;
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("the mermaid block", () => {
  it("draws a flowchart ablauf can read, and writes nothing doing it", () => {
    const { ydoc, id } = docWithMermaid(FLOWCHART);
    const before = getBlocks(ydoc);
    const revBefore = getBlockRev(ydoc, id);
    const { editor } = mountEditor(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe("true");
      const svg = diagram(editor);
      expect(svg).not.toBeNull();
      // The labels the source names, drawn as glyphs — not an empty canvas
      // with the source in its `<title>`.
      expect(glyphs(editor)).toContain("Request");
      expect(glyphs(editor)).toContain("401");
      // The picture carries the source it was drawn from. It is not what a
      // screen reader announces — that is the wrapper's `aria-label`, and the
      // wrapper is the control that opens the source (mermaid.ts) — but it is
      // what a reader of the raw SVG, saved or copied out, gets with it.
      expect(svg?.querySelector("title")?.textContent).toBe(FLOWCHART);

      // The document is untouched: same text, same stored rev, same blocks.
      expect(getBlocks(ydoc)).toEqual(before);
      expect(getBlockRev(ydoc, id)).toBe(revBefore);

      // Inert: the drawing is chrome, not content.
      const rendered = editor.view.dom.querySelector(".ub-mermaid-render");
      expect(rendered?.getAttribute("contenteditable")).toBe("false");
    } finally {
      editor.destroy();
    }
  });

  /**
   * ablauf reads a subset and refuses the rest with a `ParseError` rather than
   * half-drawing it. Every refusal has to land on today's view — and say
   * nothing extra, because a `sequenceDiagram` is not a failure.
   */
  it.each([
    ["a sequence diagram", SEQUENCE],
    // 600 arrow tokens in aggregate, never more than one per line: the size
    // cap must not answer before the ParseError does (#514 review, H-2).
    ["a sequence diagram with 600 messages", SEQUENCE_600],
    // Past MAX_SOURCE as well: the byte cap must not answer either (F-1).
    ["a sequence diagram past MAX_SOURCE", SEQUENCE_BIG],
    ["a flowchart using subgraph", SUBGRAPH],
    ["source that is not a diagram yet", "flow"],
    // A clean parse with nothing in it: ablauf draws an empty 40x40 SVG for a
    // header alone, and calling that drawn hides the text of the block the
    // reader is halfway through typing (#514 review, G-1).
    ["a header with nothing under it yet", "flowchart TD"],
    ["a header and a comment", "flowchart TD\n  %% coming back to this"],
  ])("leaves %s as the source block it was", (_name, text) => {
    const { ydoc } = docWithMermaid(text);
    const { editor } = mountEditor(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe("false");
      expect(diagram(editor)).toBeNull();
      expect(note(editor)).toBeNull();
      // Chrome intact: the source is visible in the block, copy button and all.
      expect(block(editor)?.querySelector("pre")?.textContent).toBe(text);
      expect(block(editor)?.querySelector(".ub-copy")).not.toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe(text);
    } finally {
      editor.destroy();
    }
  });

  /**
   * Opening the source is the whole editing model, so it is a real control:
   * reachable with a pointer and with the keyboard alike. The NodeView has to
   * place the caret itself either way, because a `contenteditable="false"`
   * drawing would otherwise only get itself selected.
   */
  it.each([
    ["a click", (): Event => new MouseEvent("mousedown", { bubbles: true, cancelable: true })],
    [
      "Enter",
      (): Event => new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ],
  ])("shows the diagram until %s on it opens the source", (_name, gesture) => {
    const { ydoc } = docWithMermaid(FLOWCHART);
    const { editor } = mountEditor(ydoc);
    try {
      // The caret is in the paragraph after it: it is a diagram.
      caret(editor, 1);
      expect(block(editor)?.classList.contains("ub-mermaid-editing")).toBe(false);

      editor.view.dom.querySelector(".ub-mermaid-render")?.dispatchEvent(gesture());

      expect(editor.state.selection.$head.parent.type.name).toBe("mermaid");
      expect(block(editor)?.classList.contains("ub-mermaid-editing")).toBe(true);
      // Still drawn — which representation shows is CSS, and the diagram is
      // there to come back to the moment the caret leaves.
      expect(block(editor)?.getAttribute("data-rendered")).toBe("true");
    } finally {
      editor.destroy();
    }
  });

  it("redraws when an agent edits the source a reader is looking at", () => {
    const { ydoc, id } = docWithMermaid(FLOWCHART);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 1);
      expect(glyphs(editor)).toContain("401");

      editBlock(ydoc, id, FLOWCHART, FLOWCHART.replace("401", "Unauthorized"));

      expect(glyphs(editor)).toContain("Unauthorized");
      expect(glyphs(editor)).not.toContain("401");
    } finally {
      editor.destroy();
    }
  });

  /**
   * The layout pass is superlinear and synchronous, and the stylesheet hides
   * the picture for exactly as long as the caret is in the block — so a redraw
   * per keystroke is a cost with no reader. The picture catches up in one draw
   * when the caret leaves.
   */
  it("does not redraw while the caret is in the block, and catches up when it leaves", () => {
    const { ydoc, id } = docWithMermaid(FLOWCHART);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 0);
      editBlock(ydoc, id, FLOWCHART, FLOWCHART.replace("401", "Unauthorized"));
      expect(diagram(editor)?.textContent).toContain("401");

      caret(editor, 1);
      expect(diagram(editor)?.textContent).toContain("Unauthorized");
    } finally {
      editor.destroy();
    }
  });

  it("draws the same bytes on two replicas of the same document", () => {
    const { ydoc } = docWithMermaid(FLOWCHART);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc));

    const first = mountEditor(ydoc);
    const second = mountEditor(replica);
    try {
      const one = diagram(first.editor)?.outerHTML;
      const two = diagram(second.editor)?.outerHTML;
      expect(one).toBeDefined();
      expect(one).toBe(two);
    } finally {
      first.editor.destroy();
      second.editor.destroy();
    }
  });

  /**
   * The budget, at each of its three boundaries, and the refusal naming only
   * the axis that was passed — a reader told their 64 arrows are "past 512"
   * learns nothing. The box rows use the expensive shape rather than a chain,
   * because that is what the cap is calibrated on.
   *
   * Source length is capped before `parse` runs: the counts can only refuse a
   * graph that already exists, and with `&` groups building it costs quadratic
   * memory — past ~48 kB it aborts the renderer outright, which no `catch` in
   * the binding can see.
   */
  it.each([
    ["48 boxes", diamonds(48), null],
    ["49 boxes", diamonds(49), "49 boxes past this block's 48"],
    ["512 arrows", grid(16, 32), null],
    ["576 arrows over 48 boxes", grid(24, 24), "576 arrows past this block's 512"],
    ["16,384 characters of source", padded(16_384), null],
    [
      "16,385 characters of source",
      padded(16_385),
      "16385 characters of source past this block's 16384",
    ],
  ])("draws %s: %o", (_name, text, refusal) => {
    const { ydoc } = docWithMermaid(text);
    const { editor } = mountEditor(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe(String(refusal === null));
      if (refusal === null) {
        expect(note(editor)).toBeNull();
      } else {
        // Only the limit that was actually passed, and nothing else.
        expect(note(editor)?.startsWith(`Too large to draw: ${refusal}.`)).toBe(true);
        // The text is what it always was, and the reader can still read it.
        expect(block(editor)?.querySelector("pre")?.textContent).toBe(text);
        expect(getBlocks(ydoc)[0]?.text).toBe(text);
      }
    } finally {
      editor.destroy();
    }
  });

  /**
   * The arrow cap, applied to the text instead of to the graph. `&` groups
   * expand multiplicatively, so the graph the count cap would refuse costs its
   * memory while it is being built — which on a small heap is the renderer
   * dying, not an exception anything here can catch (#514 review, G-3).
   */
  it("refuses an `&` expansion from the source, without ever building it", () => {
    const text = expansion(2_046);
    expect(text.length).toBeLessThanOrEqual(16_384);
    const { ydoc } = docWithMermaid(text);
    const { editor } = mountEditor(ydoc);
    try {
      // 2,046 terms a side, and the count cap never gets to see one of them.
      expect(note(editor)).toContain("Too large to draw: 4186116 arrows past this block's 512.");
      expect(ablauf.parsed).toBe(0);
      expect(block(editor)?.querySelector("pre")?.textContent).toBe(text);
    } finally {
      editor.destroy();
    }
  });

  /**
   * Reading the arrows off the text rather than the graph carries exactly one
   * risk: disagreeing with ablauf about what the text says. Under-counting
   * would let the expansion above through; over-counting would refuse a diagram
   * the caps admit. Both are checked against ablauf itself, on the constructs
   * that can hide an `&` or an arrow inside a label.
   */
  it.each([
    ["an `&` inside a node label", "flowchart TD\n  a[Fish & Chips] --> b"],
    ["an arrow inside a node label", "flowchart TD\n  a[from x --> y] --> b"],
    ["an `&` inside a pipe label", "flowchart TD\n  a -->|there & back| b"],
    ["an `&` inside a mid-arrow label", "flowchart TD\n  a -- there & back --> b"],
    ["a quoted label holding both", 'flowchart TD\n  a["x & y --> z"] --> b'],
    ["a comment that reads like a statement", "flowchart TD\n  %% a & b --> c\n  a --> b"],
    ["a chain of groups", "flowchart TD\n  a & b --> c & d --> e"],
    ["the largest grid both caps admit", grid(16, 32)],
  ])("draws %s exactly when ablauf's own counts allow it", (_name, text) => {
    const graph = parse(text);
    const drawable = graph.nodes.length > 0 && graph.nodes.length <= 48 && graph.edges.length <= 512;
    const { ydoc } = docWithMermaid(text);
    const { editor } = mountEditor(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe(String(drawable));
    } finally {
      editor.destroy();
    }
  });

  /**
   * The failure this guard exists for, at each place a throw can come from. A
   * throw out of a NodeView escapes through y-prosemirror *after* the Y.Doc has
   * taken the text, so every client that opens the document afterwards fails to
   * mount the editor at all. Degrade the block, never the editor.
   *
   * Three sources, because the guard has to cover all of them: ablauf's own
   * `snap` throws a bare `Error` on its internal invariants; `DOMParser` and
   * `importNode` are browser primitives that a docstring — not the code — used
   * to promise would never throw (#514 review, F-A); and the block's chrome is
   * mirrored outside the renderer entirely.
   */
  it.each([
    [
      "the layout throws",
      (): void => {
        ablauf.snapThrows = true;
      },
    ],
    [
      "adopting the drawn SVG throws",
      (): void => {
        vi.spyOn(document, "importNode").mockImplementation(() => {
          throw new Error("importNode: not today");
        });
      },
    ],
    [
      "mirroring the block's chrome throws",
      (): void => {
        vi.spyOn(mermaidChrome, "sync").mockImplementation(() => {
          throw new Error("sync: not today");
        });
      },
    ],
  ])("degrades the block, not the editor, when %s", (_name, breakIt) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    breakIt();
    const { ydoc, id } = docWithMermaid(FLOWCHART);

    const { editor } = mountEditor(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe("false");
      expect(note(editor)).toContain("Could not be drawn");
      expect(block(editor)?.querySelector("pre")?.textContent).toBe(FLOWCHART);

      // The editor is alive: an edit lands and the document is intact.
      editBlock(ydoc, id, FLOWCHART, `${FLOWCHART}\n  deny --> end1[Done]`);
      expect(getBlocks(ydoc)[0]?.text).toContain("Done");
      expect(editor.state.doc.childCount).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  /**
   * The other way the renderer fails without throwing: ablauf escapes
   * `& < > " '` and passes XML-illegal characters through, so a control
   * character pasted into a label produces a string `DOMParser` answers with a
   * `parsererror` document. Adopting that would put a browser error box where
   * the reader's text should be — the one state this NodeView must never reach.
   */
  it("degrades when the renderer draws an SVG the browser cannot parse", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // U+000B, a vertical tab: legal in a mermaid label, illegal in XML.
    const text = "flowchart TD\n  a[Start\u000Bhere] --> b[Ok]";
    const { ydoc } = docWithMermaid(text);
    const { editor } = mountEditor(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe("false");
      expect(editor.view.dom.querySelector("parsererror")).toBeNull();
      expect(note(editor)).toContain("Could not be drawn");
      expect(block(editor)?.querySelector("pre")?.textContent).toBe(text);
    } finally {
      editor.destroy();
    }
  });

  /**
   * The schema lets an annotation anchor in a mermaid block's text, and a drawn
   * diagram hides that text. Rendering must not swallow an annotation, so a
   * commented block stays source (owner decision, #514).
   */
  it("stays source while it carries an annotation", () => {
    const { ydoc, id } = docWithMermaid(FLOWCHART);
    const { editor } = mountEditor(ydoc);
    try {
      caret(editor, 1);
      expect(block(editor)?.getAttribute("data-rendered")).toBe("true");

      createAnnotation(ydoc, id, 0, 12, "reader", "why a stadium here?");

      expect(block(editor)?.getAttribute("data-rendered")).toBe("false");
      expect(diagram(editor)).toBeNull();
      expect(note(editor)).toContain("carries a comment");
      // The anchor is still in the text a reader can now see.
      expect(block(editor)?.querySelector("[data-comment-thread]")).not.toBeNull();
    } finally {
      editor.destroy();
    }
  });
});
