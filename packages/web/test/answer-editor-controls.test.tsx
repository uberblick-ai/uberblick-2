import { describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import * as Y from "yjs";
import { appendBlock, getBlocks, getBlocksFragment, initDoc, listAnnotations } from "@uberblick/schema";
import { DECISION_ANSWER_MENU_ENTRIES } from "../src/editor/block-menu.js";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { BlockMenu } from "../src/ui/editor-controls/BlockMenu.js";
import { EditorControlsHost } from "../src/ui/editor-controls/EditorControlsHost.js";
import { CommentComposer } from "../src/ui/comments/CommentComposer.js";
import { typeText } from "./helpers.js";
import { act, render } from "./react-render.js";
import { onTestCleanup } from "./test-cleanup.js";

function fixture(text = "") {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "draft", title: "Answer draft" });
  appendBlock(ydoc, { type: "paragraph", text });
  const boundary = document.createElement("div");
  const element = document.createElement("div");
  const controls = document.createElement("div");
  boundary.append(element, controls);
  document.body.append(boundary);
  const editor = createUberblickEditor({
    element,
    fragment: getBlocksFragment(ydoc),
    blockMenuEntries: DECISION_ANSWER_MENU_ENTRIES,
  });
  onTestCleanup(() => { editor.destroy(); boundary.remove(); ydoc.destroy(); });
  return { ydoc, editor, boundary, controls };
}

describe("decision answer editor controls", () => {
  it.each(["# ", "## ", "### ", "> "])("keeps excluded Markdown prefix %s as prose", (prefix) => {
    const { ydoc, editor } = fixture();
    editor.commands.setTextSelection(1);
    typeText(editor, prefix);
    expect(getBlocks(ydoc)).toMatchObject([{ type: "paragraph", text: prefix }]);
  });

  it.each([
    { prefix: "- ", type: "list-item", list: "bullet" },
    { prefix: "1. ", type: "list-item", list: "ordered" },
    { prefix: "```", type: "code" },
  ])("converts allowed $prefix shortcut", ({ prefix, type, list }) => {
    const { ydoc, editor } = fixture();
    editor.commands.setTextSelection(1);
    typeText(editor, prefix);
    expect(getBlocks(ydoc)).toMatchObject([{ type, text: "", ...(list ? { list } : {}) }]);
  });

  it("offers only the answer block choices and portals them inside the supplied host", () => {
    const fix = fixture();
    render(<EditorControlsHost value={{ portalContainer: fix.boundary, boundary: fix.boundary }}>
      <BlockMenu editor={fix.editor} host={{ current: fix.boundary }} entries={DECISION_ANSWER_MENU_ENTRIES} />
    </EditorControlsHost>, { container: fix.controls });
    act(() => {
      fix.editor.commands.setTextSelection(1);
      typeText(fix.editor, "/");
    });
    const menu = screen.getByRole("listbox", { name: "Block types" });
    expect(fix.boundary.contains(menu)).toBe(true);
    expect(within(menu).getAllByRole("option").map((option) => option.getAttribute("aria-label")))
      .toEqual(["Paragraph", "Bullet list", "Numbered list", "Code", "Table"]);
    act(() => within(menu).getByRole("option", { name: "Code" }).click());
    expect(getBlocks(fix.ydoc)).toMatchObject([{ type: "code", text: "" }]);
  });

  it("formats selected draft text inside the host without exposing a comment action", () => {
    const fix = fixture("Current answer");
    render(<EditorControlsHost value={{ portalContainer: fix.boundary, boundary: fix.boundary }}>
      <CommentComposer editor={fix.editor} ydoc={fix.ydoc} author="Ben" mentions={[]}
        host={{ current: fix.boundary }} onCreated={() => { throw new Error("Draft comments are unavailable"); }}
        formattingOnly />
    </EditorControlsHost>, { container: fix.controls });
    act(() => fix.editor.commands.setTextSelection({ from: 1, to: 8 }));
    const toolbar = screen.getByRole("toolbar", { name: "Text formatting" });
    expect(fix.boundary.contains(toolbar)).toBe(true);
    expect(within(toolbar).getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["Bold", "Italic", "Strikethrough", "Inline code", "External link"]);
    act(() => within(toolbar).getByRole("button", { name: "Bold" }).click());
    expect(fix.editor.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toContain("bold");
    expect(listAnnotations(fix.ydoc)).toEqual([]);
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it.each(["Escape", "Cancel"])("returns focus to the draft after dismissing the external link field with %s", (dismissal) => {
    const fix = fixture("Current answer");
    render(<EditorControlsHost value={{ portalContainer: fix.boundary, boundary: fix.boundary }}>
      <CommentComposer editor={fix.editor} ydoc={fix.ydoc} author="Ben" mentions={[]}
        host={{ current: fix.boundary }} onCreated={() => { throw new Error("Draft comments are unavailable"); }}
        formattingOnly />
    </EditorControlsHost>, { container: fix.controls });
    act(() => fix.editor.commands.setTextSelection({ from: 1, to: 8 }));
    const before = fix.editor.getJSON();
    act(() => screen.getByRole("button", { name: "External link" }).click());
    const field = screen.getByRole("textbox", { name: "External link URL" });
    expect(document.activeElement).toBe(field);
    act(() => {
      fireEvent.change(field, { target: { value: "https://example.com/discarded" } });
      if (dismissal === "Escape") fireEvent.keyDown(field, { key: "Escape" });
      else screen.getByRole("button", { name: "Cancel" }).click();
    });
    expect(screen.queryByRole("textbox", { name: "External link URL" })).toBeNull();
    expect(document.activeElement).toBe(fix.editor.view.dom);
    expect(fix.editor.getJSON()).toEqual(before);
    expect(listAnnotations(fix.ydoc)).toEqual([]);
    expect(fix.editor.state.selection.from).toBe(1);
    expect(fix.editor.state.selection.to).toBe(8);
  });
});
