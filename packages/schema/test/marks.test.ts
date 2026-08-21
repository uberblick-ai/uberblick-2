/**
 * Inline marks, end to end on the schema side.
 *
 * The contracts worth defending, and nothing else: the wire shape (bare Yjs
 * formatting keys with ProseMirror-shaped values), the markdown round trip in
 * both directions, that literal markdown stays literal, that source blocks carry
 * no inline marks, and that the CRDT properties the `comment` mark already has
 * hold for these five too — a re-type and a block-scoped edit keep them.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  editBlock,
  exportMarkdown,
  getBlockInline,
  getBlockText,
  getBlocks,
  getBlocksFragment,
  importMarkdown,
  initDoc,
  setBlockType,
} from "../src/index.js";
import type { InlineRun } from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** Every mark in one paragraph — the fixture the round trip is built on. */
const ALL_FIVE =
  "Read the **bold** *italic* ~~struck~~ `code()` in [the hub](https://example.com/hub).";

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Marks" });
  return doc;
}

/** Import one markdown body and build the document it describes. */
function docFromBody(body: string): { doc: Y.Doc; ids: string[] } {
  const doc = seeded();
  const ids = importMarkdown(body).blocks.map((block) => appendBlock(doc, block));
  return { doc, ids };
}

/** The raw formatting attributes on a block's text, per delta op. */
function delta(doc: Y.Doc, index = 0): Array<[unknown, unknown]> {
  const element = getBlocksFragment(doc).get(index) as Y.XmlElement;
  const text = element.firstChild as Y.XmlText;
  return (text.toDelta() as Array<{ insert: unknown; attributes?: unknown }>).map(
    (op) => [op.insert, op.attributes ?? null],
  );
}

describe("inline marks in the document", () => {
  it("stores marks as bare formatting keys with ProseMirror-shaped values", () => {
    const { doc } = docFromBody("A **word** and [a link](https://example.com).");

    // The keys are the mark names — not hashed variants — and the values are
    // exactly what y-prosemirror hands a ProseMirror mark as its attrs.
    expect(delta(doc)).toEqual([
      ["A ", null],
      ["word", { bold: {} }],
      [" and ", null],
      ["a link", { link: { href: "https://example.com" } }],
      [".", null],
    ]);

    // Marks are not text: `text` and `rev` see plain prose.
    expect(getBlockText(doc, getBlocks(doc)[0]?.id ?? "")).toBe(
      "A word and a link.",
    );
  });

  it("round-trips all five marks through export and import", () => {
    const { doc, ids } = docFromBody(ALL_FIVE);
    const runs: InlineRun[] = [
      { text: "Read the ", marks: {} },
      { text: "bold", marks: { bold: true } },
      { text: " ", marks: {} },
      { text: "italic", marks: { italic: true } },
      { text: " ", marks: {} },
      { text: "struck", marks: { strike: true } },
      { text: " ", marks: {} },
      { text: "code()", marks: { inlineCode: true } },
      { text: " in ", marks: {} },
      { text: "the hub", marks: { link: "https://example.com/hub" } },
      { text: ".", marks: {} },
    ];
    expect(getBlockInline(doc, ids[0] ?? "")).toEqual(runs);

    // Export reproduces the source byte for byte, and re-importing is stable.
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(`${ALL_FIVE}\n`);
    expect(importMarkdown(ALL_FIVE).blocks[0]?.inline).toEqual(runs);

    // Headings carry the same marks.
    const heading = docFromBody("## A **bold** heading");
    expect(exportMarkdown(heading.doc, { frontmatter: false })).toBe(
      "## A **bold** heading\n",
    );
  });

  it("nests marks, and keeps one span whole across a run boundary", () => {
    // `***x***` is both, a link label can hold emphasis, and a bold span broken
    // into two delta ops by an overlapping mark still exports as one `**…**`.
    const { doc } = docFromBody(
      "***both*** and [**bold** link](https://example.com/a).",
    );
    expect(getBlockInline(doc, getBlocks(doc)[0]?.id ?? "")).toEqual([
      { text: "both", marks: { bold: true, italic: true } },
      { text: " and ", marks: {} },
      { text: "bold", marks: { bold: true, link: "https://example.com/a" } },
      { text: " link", marks: { link: "https://example.com/a" } },
      { text: ".", marks: {} },
    ]);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(
      "***both*** and [**bold** link](https://example.com/a).\n",
    );

    // One bold run written as two ops (an annotation splits it) is one span.
    const doc2 = seeded();
    const id = appendBlock(doc2, {
      type: "paragraph",
      inline: [
        { text: "a", marks: { bold: true } },
        { text: "b", marks: { bold: true } },
      ],
    });
    expect(getBlockInline(doc2, id)).toEqual([
      { text: "ab", marks: { bold: true } },
    ]);
    expect(exportMarkdown(doc2, { frontmatter: false })).toBe("**ab**\n");
  });

  it("keeps literal markdown literal, in both directions", () => {
    const literals = [
      "Not bold: \\*\\*this\\*\\* is literal.",
      "A backslash \\\\ and a backtick \\` stay put.",
      "Tilde \\~\\~pair\\~\\~, path ~/.config, snake_case and __underscores__.",
      "\\[not a link](https://example.com) and [not one either](./relative.md).",
    ];
    for (const source of literals) {
      const imported = importMarkdown(source);
      // Nothing became a mark…
      expect(imported.blocks[0]?.inline, source).toBeUndefined();
      // …and the escapes are gone from the stored text, then written back.
      const { doc } = docFromBody(source);
      expect(exportMarkdown(doc, { frontmatter: false }), source).toBe(
        `${source}\n`,
      );
    }

    // `_` is never a delimiter, so it is never escaped either.
    expect(importMarkdown("__underscores__").blocks[0]?.text).toBe(
      "__underscores__",
    );

    // The writer canonicalises: text the reader would not have taken as a
    // delimiter anyway is still escaped, so the round trip is stable.
    const loose = seeded();
    appendBlock(loose, {
      type: "paragraph",
      text: "Spaced * asterisks * are not emphasis.",
    });
    const escaped = exportMarkdown(loose, { frontmatter: false });
    expect(escaped).toBe("Spaced \\* asterisks \\* are not emphasis.\n");
    expect(importMarkdown(escaped).blocks[0]).toEqual({
      type: "paragraph",
      text: "Spaced * asterisks * are not emphasis.",
    });
  });

  it("lengthens a code span's fence around backticks it must hold", () => {
    const doc = seeded();
    appendBlock(doc, {
      type: "paragraph",
      inline: [{ text: "a ` b", marks: { inlineCode: true } }],
    });
    const exported = exportMarkdown(doc, { frontmatter: false });
    expect(exported).toBe("``a ` b``\n");
    expect(importMarkdown(exported).blocks[0]?.inline).toEqual([
      { text: "a ` b", marks: { inlineCode: true } },
    ]);
  });

  it("gives source blocks no inline marks — only the annotation anchor", () => {
    // A fenced block's content is source: the asterisks stay in the text.
    const { doc, ids } = docFromBody("```ts\nconst x = **1**;\n```");
    expect(getBlockText(doc, ids[0] ?? "")).toBe("const x = **1**;");
    expect(getBlockInline(doc, ids[0] ?? "")).toEqual([
      { text: "const x = **1**;", marks: {} },
    ]);

    // And `inline` on a code or mermaid input is ignored, not written.
    for (const type of ["code", "mermaid"] as const) {
      const other = seeded();
      const id = appendBlock(other, {
        type,
        text: "plain source",
        inline: [{ text: "formatted", marks: { bold: true } }],
      });
      expect(getBlockText(other, id), type).toBe("plain source");
      expect(getBlockInline(other, id), type).toEqual([
        { text: "plain source", marks: {} },
      ]);
    }
  });

  it("survives a re-type, a block-scoped edit and a concurrent merge", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Marks" });
      id = appendBlock(doc, {
        type: "paragraph",
        inline: [
          { text: "Hello ", marks: {} },
          { text: "brave", marks: { bold: true } },
          { text: " world", marks: {} },
        ],
      });
    });

    // A re-type replays the delta, marks included.
    setBlockType(a, id, "heading", { level: 2 });
    expect(getBlockInline(a, id)).toEqual([
      { text: "Hello ", marks: {} },
      { text: "brave", marks: { bold: true } },
      { text: " world", marks: {} },
    ]);

    // A splice outside the marked run leaves it alone; text spliced into it
    // inherits the formatting, the way every Yjs insert does.
    editBlock(a, id, "Hello brave world", "Hello bravest world!");
    expect(getBlockInline(a, id)).toEqual([
      { text: "Hello ", marks: {} },
      { text: "bravest", marks: { bold: true } },
      { text: " world!", marks: {} },
    ]);

    // Meanwhile the other replica edits the same block elsewhere.
    editBlock(b, id, "Hello brave world", "Well, Hello brave world");
    syncDocs(a, b);
    expect(getBlockText(a, id)).toBe(getBlockText(b, id));
    expect(getBlockInline(a, id)).toEqual(getBlockInline(b, id));
    expect(
      getBlockInline(a, id).filter((run) => run.marks.bold === true),
    ).toEqual([{ text: "bravest", marks: { bold: true } }]);
  });
});
