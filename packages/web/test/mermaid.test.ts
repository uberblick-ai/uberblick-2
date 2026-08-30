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
 * 6. **A diagram past the size budget** — the freeze it prevents belongs to
 *    every reader of the document, not to whoever pasted the block.
 * 7. **An unexpected throw out of the renderer.** `snap` throws a bare `Error`
 *    on its own invariants, and a throw escaping the NodeView bricks the editor
 *    for every client of the document, permanently. The block degrades instead.
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
import { mountEditor } from "./helpers.js";

/**
 * `snap` made to fail the way ablauf's own code can (`dist/layout/snap.js:238`
 * throws a bare `Error`, which no `instanceof` in the binding can name). The
 * flag is off for every test but the one that turns it on.
 */
const ablauf = vi.hoisted(() => ({ snapThrows: false }));

vi.mock("@uberblick/ablauf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@uberblick/ablauf")>();
  return {
    ...actual,
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

/** A chain of `n` boxes: `n` nodes, `n - 1` arrows, and nothing else. */
function chain(n: number): string {
  const lines = ["flowchart TD"];
  for (let i = 1; i < n; i += 1) lines.push(`  n${i - 1} --> n${i}`);
  return lines.join("\n");
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
      // The labels the source names, drawn — not an empty canvas.
      expect(svg?.textContent).toContain("Request");
      expect(svg?.textContent).toContain("401");
      // The picture's alternative text is the source it was drawn from: with
      // the `<pre>` hidden, it is the only statement of the relationships left
      // in the accessibility tree.
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
    ["a flowchart using subgraph", SUBGRAPH],
    ["source that is not a diagram yet", "flow"],
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
      expect(diagram(editor)?.textContent).toContain("401");

      editBlock(ydoc, id, FLOWCHART, FLOWCHART.replace("401", "Unauthorized"));

      expect(diagram(editor)?.textContent).toContain("Unauthorized");
      expect(diagram(editor)?.textContent).not.toContain("401");
      // One block, one text: the drawing added nothing to the document.
      expect(getBlocks(ydoc)).toHaveLength(2);
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
   * One picture serves both appearances. The colours are ablauf's two palettes
   * written as `light-dark()`, which the browser resolves from `color-scheme` —
   * so no diagram subscribes to anything, and flipping appearance costs no
   * layout pass at all. (That the resolved colours really do change is a fact
   * only a CSS engine can state: `e2e/mermaid.spec.ts`.)
   */
  it("draws one appearance-independent picture", () => {
    const { ydoc } = docWithMermaid(FLOWCHART);
    document.documentElement.setAttribute("data-theme", "light");
    const { editor } = mountEditor(ydoc);
    try {
      const light = diagram(editor)?.outerHTML;
      expect(light).toContain("light-dark(");

      document.documentElement.setAttribute("data-theme", "dark");
      caret(editor, 1);

      expect(diagram(editor)?.outerHTML).toBe(light);
    } finally {
      editor.destroy();
    }
  });

  /**
   * The budget, at its boundary. `snap` is superlinear in both boxes and
   * arrows, so both are capped, and the refusal is visible: a reader whose
   * diagram stopped drawing is owed the reason and a way out.
   */
  it.each([
    ["64 boxes", chain(64), true],
    ["65 boxes", chain(65), false],
    ["512 arrows", grid(16, 32), true],
    ["1024 arrows over 64 boxes", grid(32, 32), false],
  ])("draws %s: %o", (_name, text, expected) => {
    const { ydoc } = docWithMermaid(text);
    const { editor } = mountEditor(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe(String(expected));
      if (expected) {
        expect(note(editor)).toBeNull();
      } else {
        expect(note(editor)).toContain("Too large to draw");
        // The text is what it always was, and the reader can still read it.
        expect(block(editor)?.querySelector("pre")?.textContent).toBe(text);
        expect(getBlocks(ydoc)[0]?.text).toBe(text);
      }
    } finally {
      editor.destroy();
    }
  });

  /**
   * The failure this catch exists for. ablauf declares `ParseError` and
   * `RenderError`, but `snap` throws a bare `Error` on its own invariants — and
   * a throw out of a NodeView escapes through y-prosemirror *after* the Y.Doc
   * has taken the text, so every client that opens the document afterwards
   * fails to mount the editor at all. Degrade the block, never the editor.
   */
  it("degrades the block, not the editor, when the renderer throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ablauf.snapThrows = true;
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
