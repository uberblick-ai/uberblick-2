/**
 * THE ACCEPTANCE GATE.
 *
 * A document built entirely with @uberblick/schema is loaded into a real Tiptap
 * editor bound through ySyncPlugin, a real keystroke is dispatched through the
 * editor view, and afterwards the `blocks` fragment must be recognisably the
 * same document: same elements in the same order, every block id and every
 * attribute untouched, every formatting mark still anchored under its bare Yjs
 * key, and `getBlocks()` still able to parse all of it.
 *
 * This is the test that would have failed with BlockNote (foreign fragments get
 * migrated, undeclared attributes get stripped) and it is the reason the editor
 * declares custom nodes matching the schema-owned shape.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  COMMENT_MARK,
  appendBlock,
  createAnnotation,
  getBlockInline,
  getBlocks,
  getBlocksFragment,
  initDoc,
  listAnnotationRanges,
  resolveAnnotationRange,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor, sequentialIds, snapshotFragment } from "./helpers.js";

interface Built {
  ydoc: Y.Doc;
  ids: {
    heading: string;
    paragraph: string;
    code: string;
    mermaid: string;
    item: string;
    quote: string;
    table: string;
    terminal: string;
  };
  threadId: string;
}

/**
 * Every block type, known ids, one annotation and all five inline marks —
 * created by the schema package, never by the editor. The paragraph's plain text
 * is exactly "The quick brown fox jumps." whatever the marks do to it.
 */
function buildDocument(): Built {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "11111111-2222-3333-4444-555555555555", title: "Golden" });

  const heading = appendBlock(ydoc, {
    type: "heading",
    text: "Round trip",
    level: 3,
  });
  const paragraph = appendBlock(ydoc, {
    type: "paragraph",
    inline: [
      { text: "The quick ", marks: {} },
      { text: "brown", marks: { bold: true } },
      { text: " ", marks: {} },
      { text: "fox", marks: { italic: true, link: "https://example.com/fox" } },
      { text: " ", marks: {} },
      { text: "jumps", marks: { strike: true, inlineCode: true } },
      { text: ".", marks: {} },
    ],
  });
  const code = appendBlock(ydoc, {
    type: "code",
    text: "const answer = 42;\nreturn answer;",
    language: "ts",
  });
  const mermaid = appendBlock(ydoc, {
    type: "mermaid",
    text: "graph TD;\n  A-->B;",
  });
  const item = appendBlock(ydoc, {
    type: "list-item",
    text: "one point",
    list: "ordered",
    indent: 2,
  });
  const quote = appendBlock(ydoc, { type: "quote", text: "as someone said" });
  const table = appendBlock(ydoc, {
    type: "table",
    text: "| name | count |\n| --- | ---: |\n| alpha | 1 |",
  });
  const terminal = appendBlock(ydoc, {
    type: "terminal",
    text: "$ ub init\nworkspace ready",
  });

  // "quick" in the paragraph.
  const annotation = createAnnotation(ydoc, paragraph, 4, 9, "tester", "why quick?");

  return {
    ydoc,
    ids: { heading, paragraph, code, mermaid, item, quote, table, terminal },
    threadId: annotation.id,
  };
}

let editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors = [];
});

function mount(ydoc: Y.Doc, newBlockId?: () => string): Editor {
  const { editor } = mountEditor(
    ydoc,
    newBlockId === undefined ? {} : { newBlockId },
  );
  editors.push(editor);
  return editor;
}

/**
 * Type text one character at a time, the way ProseMirror's view does: through
 * `handleTextInput`, which is the hook input rules listen on. A plain
 * `insertText` would never fire a rule.
 */
function typeText(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, char, () =>
        editor.state.tr.insertText(char, from, to),
      ),
    );
    if (handled !== true) {
      editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  }
}

/**
 * Each text node of one block with its marks — text included, so a mark that
 * moved to different characters fails rather than matching the same shape.
 */
function marksOf(
  editor: Editor,
  index: number,
): Array<{ text: string | undefined; marks: Record<string, unknown> }> {
  const nodes: Array<{
    text: string | undefined;
    marks: Record<string, unknown>;
  }> = [];
  editor.state.doc.child(index).content.forEach((node) => {
    nodes.push({
      text: node.text,
      marks: Object.fromEntries(
        node.marks.map((mark) => [mark.type.name, mark.attrs]),
      ),
    });
  });
  return nodes;
}

describe("golden round trip: schema → editor → keystroke → schema", () => {
  it("loads the schema-owned fragment into ProseMirror unchanged", () => {
    const { ydoc, ids, threadId } = buildDocument();
    const editor = mount(ydoc);

    const doc = editor.state.doc;
    const indexes = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(doc.childCount).toBe(8);
    expect(indexes.map((i) => doc.child(i).type.name)).toEqual([
      "heading",
      "paragraph",
      "code",
      "mermaid",
      "list-item",
      "quote",
      "table",
      "terminal",
    ]);
    expect(indexes.map((i) => doc.child(i).attrs.id)).toEqual([
      ids.heading,
      ids.paragraph,
      ids.code,
      ids.mermaid,
      ids.item,
      ids.quote,
      ids.table,
      ids.terminal,
    ]);

    // Attributes arrive verbatim, as the strings the schema wrote.
    expect(doc.child(0).attrs.level).toBe("3");
    expect(doc.child(2).attrs.language).toBe("ts");
    expect(doc.child(4).attrs.list).toBe("ordered");
    expect(doc.child(4).attrs.indent).toBe("2");

    // Text survives, newlines included.
    expect(doc.child(2).textContent).toBe("const answer = 42;\nreturn answer;");
    expect(doc.child(3).textContent).toBe("graph TD;\n  A-->B;");
    expect(doc.child(7).textContent).toBe("$ ub init\nworkspace ready");

    // Every formatting mark becomes a ProseMirror mark, the comment carrying its
    // thread id and the link its href — one text node per run, in order.
    expect(doc.child(1).textContent).toBe("The quick brown fox jumps.");
    expect(marksOf(editor, 1)).toEqual([
      { text: "The ", marks: {} },
      { text: "quick", marks: { [COMMENT_MARK]: { threadId } } },
      { text: " ", marks: {} },
      { text: "brown", marks: { bold: {} } },
      { text: " ", marks: {} },
      {
        text: "fox",
        marks: { italic: {}, link: { href: "https://example.com/fox" } },
      },
      { text: " ", marks: {} },
      { text: "jumps", marks: { strike: {}, inlineCode: {} } },
      { text: ".", marks: {} },
    ]);

    // The code block renders monospace with its language visible: the label is a
    // CSS pseudo-element on the attribute, so the attribute reaching the DOM is
    // what makes it appear.
    const pre = editor.view.dom.querySelector("pre.ub-code");
    expect(pre?.getAttribute("data-language")).toBe("ts");
  });

  it("preserves ids, attributes and the annotation across a real keystroke", () => {
    const { ydoc, ids, threadId } = buildDocument();
    const before = snapshotFragment(ydoc);
    const editor = mount(ydoc);

    // A real text insertion, dispatched through the editor view — not a direct
    // Yjs write. Insert at the very end of the paragraph block.
    const paragraphIndex = 1;
    let position = 1; // inside the first block
    for (let i = 0; i < paragraphIndex; i += 1) {
      position += editor.state.doc.child(i).nodeSize;
    }
    const endOfParagraph =
      position + editor.state.doc.child(paragraphIndex).content.size;
    editor.view.dispatch(
      editor.state.tr.insertText(" Then it stopped.", endOfParagraph),
    );

    const after = snapshotFragment(ydoc);

    // Structure: same elements, same order, same node names.
    expect(after.map((block) => block.nodeName)).toEqual(
      before.map((block) => block.nodeName),
    );
    expect(after).toHaveLength(8);

    // Identity and attributes: byte-identical, including value *types*.
    expect(after.map((block) => block.attributes)).toEqual(
      before.map((block) => block.attributes),
    );
    expect(after[0]?.attributes).toEqual({ id: ids.heading, level: "3" });
    expect(after[1]?.attributes).toEqual({ id: ids.paragraph });
    expect(after[2]?.attributes).toEqual({ id: ids.code, language: "ts" });
    expect(after[3]?.attributes).toEqual({ id: ids.mermaid });
    expect(after[4]?.attributes).toEqual({
      id: ids.item,
      list: "ordered",
      indent: "2",
    });
    expect(after[5]?.attributes).toEqual({ id: ids.quote });
    expect(after[6]?.attributes).toEqual({ id: ids.table });
    expect(after[7]?.attributes).toEqual({ id: ids.terminal });

    // Only the edited block's text changed.
    for (const index of [0, 2, 3, 4, 5, 6, 7]) {
      expect(after[index]?.text).toBe(before[index]?.text);
    }
    expect(after[1]?.text).toBe("The quick brown fox jumps. Then it stopped.");

    // The annotation is still anchored, on the same characters.
    expect(resolveAnnotationRange(ydoc, threadId)).toEqual({
      start: 4,
      end: 9,
      collapsed: false,
    });
    expect(listAnnotationRanges(ydoc, ids.paragraph)).toEqual([
      { threadId, start: 4, end: 9 },
    ]);

    // Every mark is stored under its bare key, not a hashed variant.
    // (y-prosemirror hashes the key for marks that do not exclude themselves.)
    const paragraphDelta = after[1]?.delta ?? [];
    const attributeKeys = new Set(
      paragraphDelta.flatMap((op) =>
        Object.keys((op.attributes ?? {}) as Record<string, unknown>),
      ),
    );
    expect([...attributeKeys].sort()).toEqual(
      [COMMENT_MARK, "bold", "italic", "link", "strike", "inlineCode"].sort(),
    );

    // …and every run still covers the same text after the keystroke, with the
    // text typed at the very end staying outside the last mark.
    expect(getBlockInline(ydoc, ids.paragraph)).toEqual([
      { text: "The quick ", marks: {} },
      { text: "brown", marks: { bold: true } },
      { text: " ", marks: {} },
      { text: "fox", marks: { italic: true, link: "https://example.com/fox" } },
      { text: " ", marks: {} },
      { text: "jumps", marks: { strike: true, inlineCode: true } },
      { text: ". Then it stopped.", marks: {} },
    ]);

    // And the schema package can still read the whole document.
    const blocks = getBlocks(ydoc);
    expect(blocks.map((block) => [block.id, block.type])).toEqual([
      [ids.heading, "heading"],
      [ids.paragraph, "paragraph"],
      [ids.code, "code"],
      [ids.mermaid, "mermaid"],
      [ids.item, "list-item"],
      [ids.quote, "quote"],
      [ids.table, "table"],
      [ids.terminal, "terminal"],
    ]);
    expect(blocks[0]?.level).toBe(3);
    expect(blocks[2]?.language).toBe("ts");
    expect(blocks[2]?.text).toBe("const answer = 42;\nreturn answer;");
    expect(blocks[3]?.text).toBe("graph TD;\n  A-->B;");
    expect(blocks[4]).toMatchObject({ list: "ordered", indent: 2, text: "one point" });
    expect(blocks[5]?.text).toBe("as someone said");
    // The table's newlines are its rows: a source block keeps them exactly.
    expect(blocks[6]?.text).toBe(
      "| name | count |\n| --- | ---: |\n| alpha | 1 |",
    );
    // The transcript's newlines are its steps, and survive the same way.
    expect(blocks[7]?.text).toBe("$ ub init\nworkspace ready");
  });

  it("splits a paragraph on Enter into two valid blocks with a fresh id", () => {
    const { ydoc, ids, threadId } = buildDocument();
    const editor = mount(ydoc, sequentialIds("split"));

    // Position the caret after "The quick " in the paragraph (block index 1).
    const paragraphStart = 1 + editor.state.doc.child(0).nodeSize;
    const caret = paragraphStart + "The quick ".length;
    editor.commands.setTextSelection(caret);
    editor.commands.splitBlock();

    const blocks = getBlocks(ydoc);
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "code",
      "mermaid",
      "list-item",
      "quote",
      "table",
      "terminal",
    ]);

    // First half keeps the original id; the second half is a new block.
    expect(blocks[1]?.id).toBe(ids.paragraph);
    expect(blocks[2]?.id).toBe("split-1");
    expect(blocks[1]?.text).toBe("The quick ");
    expect(blocks[2]?.text).toBe("brown fox jumps.");

    // A split is the operation stored positions would not survive. Every mark in
    // the half that moved is still on the same characters, in the new block.
    expect(getBlockInline(ydoc, "split-1")).toEqual([
      { text: "brown", marks: { bold: true } },
      { text: " ", marks: {} },
      { text: "fox", marks: { italic: true, link: "https://example.com/fox" } },
      { text: " ", marks: {} },
      { text: "jumps", marks: { strike: true, inlineCode: true } },
      { text: ".", marks: {} },
    ]);
    // …and the annotation stayed with the first half, where its text went.
    expect(getBlockInline(ydoc, ids.paragraph)).toEqual([
      { text: "The quick ", marks: {} },
    ]);
    expect(listAnnotationRanges(ydoc, ids.paragraph)).toEqual([
      { threadId, start: 4, end: 9 },
    ]);

    // Every id in the document is still unique and non-empty.
    const allIds = blocks.map((block) => block.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.every((id) => id !== "")).toBe(true);

    // Both halves are well-formed schema blocks: readable, revisioned, and the
    // fragment still holds only known node names.
    for (const block of blocks) {
      expect(block.rev).toMatch(/^[0-9a-z]+$/i);
    }
    expect(
      getBlocksFragment(ydoc)
        .toArray()
        .map((child) => (child instanceof Y.XmlElement ? child.nodeName : "#other")),
    ).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "code",
      "mermaid",
      "list-item",
      "quote",
      "table",
      "terminal",
    ]);
  });
});

/**
 * The authoring half: marks the user makes, rather than marks the schema wrote.
 * Typed markdown and the keyboard shortcuts have to land in the CRDT under the
 * same bare keys the schema package reads — one document, one vocabulary.
 */
describe("golden round trip: keystrokes → marks → schema", () => {
  /** An empty document with one paragraph and the caret in it. */
  function typingDoc(): { ydoc: Y.Doc; editor: Editor; blockId: string } {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "22222222-3333-4444-5555-666666666666", title: "Typed" });
    const blockId = appendBlock(ydoc, { type: "paragraph" });
    const editor = mount(ydoc);
    editor.commands.setTextSelection(1);
    return { ydoc, editor, blockId };
  }

  it("turns typed markdown into marks, under their bare Yjs keys", () => {
    const { ydoc, editor, blockId } = typingDoc();

    typeText(editor, "a **b** c *d* e `f` g ~~h~~ i [j](https://example.com/j) k");

    expect(getBlockInline(ydoc, blockId)).toEqual([
      { text: "a ", marks: {} },
      { text: "b", marks: { bold: true } },
      { text: " c ", marks: {} },
      { text: "d", marks: { italic: true } },
      { text: " e ", marks: {} },
      { text: "f", marks: { inlineCode: true } },
      { text: " g ", marks: {} },
      { text: "h", marks: { strike: true } },
      { text: " i ", marks: {} },
      { text: "j", marks: { link: "https://example.com/j" } },
      { text: " k", marks: {} },
    ]);
    // The delimiters are gone from the text, not just from the rendering.
    expect(getBlocks(ydoc)[0]?.text).toBe("a b c d e f g h i j k");
  });

  it("applies and removes marks through the keyboard shortcuts", () => {
    const { ydoc, editor, blockId } = typingDoc();
    typeText(editor, "shout");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    for (const [shortcut, mark] of [
      ["Mod-b", "bold"],
      ["Mod-i", "italic"],
      ["Mod-Shift-s", "strike"],
      ["Mod-e", "inlineCode"],
    ] as const) {
      expect(editor.commands.keyboardShortcut(shortcut), shortcut).toBe(true);
      expect(getBlockInline(ydoc, blockId), shortcut).toEqual([
        { text: "shout", marks: { [mark]: true } },
      ]);
      // The same shortcut toggles it back off, leaving no attribute behind.
      expect(editor.commands.keyboardShortcut(shortcut), shortcut).toBe(true);
      expect(getBlockInline(ydoc, blockId), shortcut).toEqual([
        { text: "shout", marks: {} },
      ]);
    }
  });

  it("makes no inline marks inside a code block, typed or commanded", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "33333333-4444-5555-6666-777777777777", title: "Source" });
    const blockId = appendBlock(ydoc, { type: "code", language: "ts" });
    const editor = mount(ydoc);
    editor.commands.setTextSelection(1);

    typeText(editor, "x = **2** && `y`");
    // Every delimiter is still there, and nothing carries a mark: source text is
    // source text.
    expect(getBlocks(ydoc)[0]?.text).toBe("x = **2** && `y`");
    expect(getBlockInline(ydoc, blockId)).toEqual([
      { text: "x = **2** && `y`", marks: {} },
    ]);

    // Nor can a command put one there — the node does not allow the mark.
    editor.commands.setTextSelection({ from: 1, to: 4 });
    expect(editor.commands.toggleMark("bold")).toBe(false);
    expect(getBlockInline(ydoc, blockId)).toEqual([
      { text: "x = **2** && `y`", marks: {} },
    ]);

    // The annotation anchor still works there, which is the one mark it may hold.
    const thread = createAnnotation(ydoc, blockId, 0, 3, "tester", "why?");
    expect(listAnnotationRanges(ydoc, blockId)).toEqual([
      { threadId: thread.id, start: 0, end: 3 },
    ]);
  });
});
