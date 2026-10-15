import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, editBlock, getBlocks, getBlocksFragment, initDoc, isSupportedFigma } from "@uberblick/schema";
import {
  commitFigmaDraft, currentFigmaDraft, discardFigmaDraft, pasteFigmaLink, startFigmaDraft,
} from "../src/editor/figma-creation.js";
import { slashTriggerAt } from "../src/editor/block-menu.js";
import { mountEditor } from "./helpers.js";
import { onTestCleanup } from "./test-cleanup.js";

const LINK = "https://figma.com/design/abc123/File-name?node-id=2-3&t=tracking";
const NORMALIZED = "https://www.figma.com/design/abc123/File-name?node-id=2-3";

function documentWith(text = ""): { ydoc: Y.Doc; id: string } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "figma-creation", title: "Figma creation" });
  const id = appendBlock(ydoc, { type: "paragraph", text });
  onTestCleanup(() => ydoc.destroy());
  return { ydoc, id };
}

describe("Figma creation", () => {
  it("converts an accepted bare paste after a separate link undo step", () => {
    const { ydoc, id } = documentWith();
    const { editor } = mountEditor(ydoc);
    const shapes: boolean[] = [];
    ydoc.on("update", () => {
      const block = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
      shapes.push(block.nodeName !== "figma" || isSupportedFigma(block));
    });
    editor.commands.setTextSelection(1);
    expect(pasteFigmaLink(editor, LINK)).toBe(true);
    expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "figma", text: `url: ${NORMALIZED}\n\n` });
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes.every(Boolean)).toBe(true);
    editor.commands.keyboardShortcut("Mod-z");
    expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "paragraph", text: LINK });
    expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe("link");
    editor.commands.keyboardShortcut("Mod-z");
    expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "paragraph", text: "" });
  });

  it("leaves inline, selected, refused and non-bare links to ordinary paste", () => {
    const { ydoc } = documentWith("Before ");
    const { editor } = mountEditor(ydoc);
    editor.commands.setTextSelection(8);
    expect(pasteFigmaLink(editor, LINK)).toBe(false);
    expect(getBlocks(ydoc)[0]?.text).toBe("Before ");
    editor.commands.setTextSelection({ from: 1, to: 8 });
    expect(pasteFigmaLink(editor, LINK)).toBe(false);
    editor.commands.deleteSelection();
    expect(pasteFigmaLink(editor, "https://figma.com/deck/abc123")).toBe(false);
    expect(pasteFigmaLink(editor, `${LINK} words`)).toBe(false);
    expect(pasteFigmaLink(editor, "https://example.com/design/abc123")).toBe(false);
    expect(getBlocks(ydoc)[0]?.text).toBe("");
  });

  it("keeps a gutter draft outside the document until its valid link commits", () => {
    const { ydoc, id } = documentWith("Above");
    const { editor } = mountEditor(ydoc);
    const before = Y.encodeStateAsUpdate(ydoc);
    expect(startFigmaDraft(editor, id)).toBe(true);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(editor.view.dom.querySelector('[data-figma-draft="true"]')).not.toBeNull();
    expect(getBlocks(ydoc)).toHaveLength(1);
    const draft = currentFigmaDraft(editor)!;
    expect(commitFigmaDraft(editor, draft, { url: LINK, title: null, height: null })).toBe(true);
    expect(getBlocks(ydoc).map((block) => block.type)).toEqual(["paragraph", "figma"]);
    expect(getBlocks(ydoc)[1]?.text).toBe(`url: ${NORMALIZED}\n\n`);
    expect(currentFigmaDraft(editor)).toBeNull();
    expect(editor.view.dom.querySelector('[data-figma-draft="true"]')).toBeNull();
  });

  it("consumes the slash into an empty paragraph and discards an uncommitted draft", () => {
    const { ydoc, id } = documentWith("/figma");
    const { editor } = mountEditor(ydoc);
    editor.commands.setTextSelection(7);
    expect(startFigmaDraft(editor, id, slashTriggerAt(editor)!)).toBe(true);
    expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "paragraph", text: "" });
    discardFigmaDraft(editor);
    expect(currentFigmaDraft(editor)).toBeNull();
    expect(getBlocks(ydoc)[0]).toMatchObject({ id, type: "paragraph", text: "" });
    expect(getBlocks(ydoc)).toHaveLength(1);
  });

  it("re-resolves a gutter anchor after shared edits and closes a replaced slash anchor", () => {
    const { ydoc, id } = documentWith("/figma");
    const { editor } = mountEditor(ydoc);
    editor.commands.setTextSelection(7);
    startFigmaDraft(editor, id, slashTriggerAt(editor)!);
    const stale = currentFigmaDraft(editor)!;
    editBlock(ydoc, id, "", "Peer text");
    expect(currentFigmaDraft(editor)).toBeNull();
    expect(commitFigmaDraft(editor, stale, { url: LINK, title: null, height: null })).toBe(false);
    expect(getBlocks(ydoc)[0]?.text).toBe("Peer text");
    expect(startFigmaDraft(editor, id)).toBe(true);
    const draft = currentFigmaDraft(editor)!;
    appendBlock(ydoc, { type: "paragraph", text: "Following" });
    expect(commitFigmaDraft(editor, draft, { url: LINK, title: null, height: null })).toBe(true);
    expect(getBlocks(ydoc).map((block) => block.type)).toEqual(["paragraph", "figma", "paragraph"]);
  });
});
