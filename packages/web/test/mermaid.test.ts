/**
 * The mermaid block: source that draws itself (#495).
 *
 * Five contracts, and every one of them is about the fact that the *source is
 * still the storage*:
 *
 * 1. **Drawing writes nothing.** A block that renders has the same text and the
 *    same `rev` afterwards as before — the picture is derived on every paint,
 *    so there is no second copy of the diagram anywhere in the document.
 * 2. **Everything ablauf will not draw stays exactly as it was.** A
 *    `sequenceDiagram`, a `subgraph`, a `;` separator: the source block with
 *    its copy button, unchanged. This is the case that must not regress
 *    silently, because a diagram that quietly stops drawing looks like nothing
 *    at all.
 * 3. **The caret opens the source**, which is the whole editing model, and it
 *    is the same gesture the table block has.
 * 4. **The drawing follows the document, live.** An agent's `edit_block`
 *    arrives as an ordinary update and the diagram redraws.
 * 5. **Two replicas draw the same picture.** Same text, same appearance,
 *    byte-identical SVG — nothing about layout travels, because nothing about
 *    layout is stored.
 *
 * Plus the one thing that is not about the document: the appearance in force
 * decides the palette, and a mounted diagram has to hear it change.
 *
 * Read back through the schema package, as everywhere: the document is the
 * deliverable, the DOM is what a reader happens to see.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, blockRev, editBlock, getBlocks, initDoc } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor } from "./helpers.js";

const FLOWCHART = "flowchart TD\n  start([Request]) --> check{Valid?}\n  check -->|no| deny[401]";
const SEQUENCE = "sequenceDiagram\n  alice->>bob: hello";
const SUBGRAPH = "flowchart TD\n  subgraph one\n    a --> b\n  end";

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

/** Put the caret at the start of the block at `index`. */
function caret(editor: Editor, index: number): void {
  let pos = 1;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  editor.commands.setTextSelection(pos);
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("the mermaid block", () => {
  it("draws a flowchart ablauf can read, and writes nothing doing it", () => {
    const { ydoc } = docWithMermaid(FLOWCHART);
    const before = getBlocks(ydoc);
    const { editor } = mountEditor(ydoc);
    try {
      expect(block(editor)?.getAttribute("data-rendered")).toBe("true");
      const svg = diagram(editor);
      expect(svg).not.toBeNull();
      // The labels the source names, drawn — not an empty canvas.
      expect(svg?.textContent).toContain("Request");
      expect(svg?.textContent).toContain("401");

      // The document is untouched: same text, same rev, same block count.
      const after = getBlocks(ydoc);
      expect(after).toEqual(before);
      const source = after[0];
      expect(source?.text).toBe(FLOWCHART);
      expect(blockRev({ type: "mermaid", text: source?.text ?? "" })).toBe(
        blockRev({ type: "mermaid", text: FLOWCHART }),
      );

      // Inert: the drawing is chrome, not content.
      const rendered = editor.view.dom.querySelector(".ub-mermaid-render");
      expect(rendered?.getAttribute("contenteditable")).toBe("false");
    } finally {
      editor.destroy();
    }
  });

  /**
   * ablauf reads a subset and refuses the rest with a `ParseError` rather than
   * half-drawing it. Every refusal has to land on today's view.
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
      // Chrome intact: the source is visible in the block, copy button and all.
      expect(block(editor)?.querySelector("pre")?.textContent).toBe(text);
      expect(block(editor)?.querySelector(".ub-copy")).not.toBeNull();
      expect(getBlocks(ydoc)[0]?.text).toBe(text);
    } finally {
      editor.destroy();
    }
  });

  it("shows the source under the caret, and the diagram everywhere else", () => {
    const { ydoc } = docWithMermaid(FLOWCHART);
    const { editor } = mountEditor(ydoc);
    try {
      // The caret is in the paragraph after it: it is a diagram.
      caret(editor, 1);
      expect(block(editor)?.classList.contains("ub-mermaid-editing")).toBe(false);

      // Clicking the drawing is what opens the source — the NodeView puts the
      // caret in the block, because a `contenteditable="false"` drawing would
      // otherwise only get itself selected.
      editor.view.dom
        .querySelector(".ub-mermaid-render")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

      expect(editor.state.selection.$head.parent.type.name).toBe("mermaid");
      expect(block(editor)?.classList.contains("ub-mermaid-editing")).toBe(true);
      // Still drawn — which representation shows is CSS, and the diagram is
      // there to come back to the moment the caret leaves.
      expect(block(editor)?.getAttribute("data-rendered")).toBe("true");
    } finally {
      editor.destroy();
    }
  });

  it("redraws when an agent edits the source", () => {
    const { ydoc, id } = docWithMermaid(FLOWCHART);
    const { editor } = mountEditor(ydoc);
    try {
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
   * The one thing the NodeView's own `update` would never hear: `update` fires
   * for node changes, and an appearance is not one. ablauf writes colours into
   * the SVG string, so the picture has to be drawn again rather than restyled.
   */
  it("repaints when the reader changes appearance", async () => {
    const { ydoc } = docWithMermaid(FLOWCHART);
    document.documentElement.setAttribute("data-theme", "light");
    const { editor } = mountEditor(ydoc);
    try {
      const light = diagram(editor)?.outerHTML;

      document.documentElement.setAttribute("data-theme", "dark");
      // MutationObserver delivers on a microtask.
      await Promise.resolve();

      const dark = diagram(editor)?.outerHTML;
      expect(dark).toBeDefined();
      expect(dark).not.toBe(light);
      // Same picture, different palette: the labels did not move.
      expect(diagram(editor)?.textContent).toContain("Request");
    } finally {
      editor.destroy();
    }
  });
});
