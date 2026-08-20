/**
 * THE ACCEPTANCE GATE.
 *
 * A document built entirely with @uberblick/schema is loaded into a real Tiptap
 * editor bound through ySyncPlugin, a real keystroke is dispatched through the
 * editor view, and afterwards the `blocks` fragment must be recognisably the
 * same document: same elements in the same order, every block id and every
 * attribute untouched, the annotation mark still anchored, and `getBlocks()`
 * still able to parse all of it.
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
  };
  threadId: string;
}

/** All four block types, known ids, and one annotation created by the schema. */
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
    text: "The quick brown fox jumps.",
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

  // "quick" in the paragraph.
  const annotation = createAnnotation(ydoc, paragraph, 4, 9, "tester", "why quick?");

  return {
    ydoc,
    ids: { heading, paragraph, code, mermaid },
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

describe("golden round trip: schema → editor → keystroke → schema", () => {
  it("loads the schema-owned fragment into ProseMirror unchanged", () => {
    const { ydoc, ids, threadId } = buildDocument();
    const editor = mount(ydoc);

    const doc = editor.state.doc;
    expect(doc.childCount).toBe(4);
    expect([0, 1, 2, 3].map((i) => doc.child(i).type.name)).toEqual([
      "heading",
      "paragraph",
      "code",
      "mermaid",
    ]);
    expect([0, 1, 2, 3].map((i) => doc.child(i).attrs.id)).toEqual([
      ids.heading,
      ids.paragraph,
      ids.code,
      ids.mermaid,
    ]);

    // Attributes arrive verbatim, as the strings the schema wrote.
    expect(doc.child(0).attrs.level).toBe("3");
    expect(doc.child(2).attrs.language).toBe("ts");

    // Text survives, newlines included.
    expect(doc.child(2).textContent).toBe("const answer = 42;\nreturn answer;");
    expect(doc.child(3).textContent).toBe("graph TD;\n  A-->B;");

    // The comment mark becomes a ProseMirror mark carrying the thread id.
    const marked = doc
      .child(1)
      .content.content.filter((node) => node.marks.length > 0);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.text).toBe("quick");
    expect(marked[0]?.marks[0]?.type.name).toBe(COMMENT_MARK);
    expect(marked[0]?.marks[0]?.attrs.threadId).toBe(threadId);
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
    expect(after).toHaveLength(4);

    // Identity and attributes: byte-identical, including value *types*.
    expect(after.map((block) => block.attributes)).toEqual(
      before.map((block) => block.attributes),
    );
    expect(after[0]?.attributes).toEqual({ id: ids.heading, level: "3" });
    expect(after[1]?.attributes).toEqual({ id: ids.paragraph });
    expect(after[2]?.attributes).toEqual({ id: ids.code, language: "ts" });
    expect(after[3]?.attributes).toEqual({ id: ids.mermaid });

    // Only the edited block's text changed.
    expect(after[0]?.text).toBe(before[0]?.text);
    expect(after[2]?.text).toBe(before[2]?.text);
    expect(after[3]?.text).toBe(before[3]?.text);
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

    // The mark is stored under the bare `comment` key, not a hashed variant.
    // (y-prosemirror hashes the key for marks that do not exclude themselves.)
    const paragraphDelta = after[1]?.delta ?? [];
    const attributeKeys = new Set(
      paragraphDelta.flatMap((op) =>
        Object.keys((op.attributes ?? {}) as Record<string, unknown>),
      ),
    );
    expect([...attributeKeys]).toEqual([COMMENT_MARK]);

    // And the schema package can still read the whole document.
    const blocks = getBlocks(ydoc);
    expect(blocks.map((block) => [block.id, block.type])).toEqual([
      [ids.heading, "heading"],
      [ids.paragraph, "paragraph"],
      [ids.code, "code"],
      [ids.mermaid, "mermaid"],
    ]);
    expect(blocks[0]?.level).toBe(3);
    expect(blocks[2]?.language).toBe("ts");
    expect(blocks[2]?.text).toBe("const answer = 42;\nreturn answer;");
    expect(blocks[3]?.text).toBe("graph TD;\n  A-->B;");
  });

  it("splits a paragraph on Enter into two valid blocks with a fresh id", () => {
    const { ydoc, ids } = buildDocument();
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
    ]);

    // First half keeps the original id; the second half is a new block.
    expect(blocks[1]?.id).toBe(ids.paragraph);
    expect(blocks[2]?.id).toBe("split-1");
    expect(blocks[1]?.text).toBe("The quick ");
    expect(blocks[2]?.text).toBe("brown fox jumps.");

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
    ).toEqual(["heading", "paragraph", "paragraph", "code", "mermaid"]);
  });
});
