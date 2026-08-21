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
  InvalidLinkHrefError,
  MarksNotAllowedError,
  appendBlock,
  createAnnotation,
  editBlock,
  exportMarkdown,
  getBlock,
  getBlockInline,
  getBlockText,
  getBlocks,
  getBlocksFragment,
  importMarkdown,
  initDoc,
  listAnnotationRanges,
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

/** One block's Y.XmlText, for writing the wire shapes a foreign client would. */
function text(doc: Y.Doc, index = 0): Y.XmlText {
  const element = getBlocksFragment(doc).get(index) as Y.XmlElement;
  return element.firstChild as Y.XmlText;
}

/** The raw formatting attributes on a block's text, per delta op. */
function delta(doc: Y.Doc, index = 0): Array<[unknown, unknown]> {
  return (
    text(doc, index).toDelta() as Array<{ insert: unknown; attributes?: unknown }>
  ).map((op) => [op.insert, op.attributes ?? null]);
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
    // `***x***` is both, and a link label can hold emphasis.
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

    // A comment mark cutting across a bold span splits the delta into three ops.
    // The bold span is still one span, so it is still one `**…**`.
    const doc2 = seeded();
    const id = appendBlock(doc2, {
      type: "paragraph",
      inline: [{ text: "one bold span", marks: { bold: true } }],
    });
    createAnnotation(doc2, id, 4, 8, "reviewer", "which one?");
    expect(getBlockInline(doc2, id)).toEqual([
      { text: "one bold span", marks: { bold: true } },
    ]);
    expect(exportMarkdown(doc2, { frontmatter: false })).toBe(
      "**one bold span**\n",
    );
  });

  /**
   * Reader and writer have to be closed over the mark combinations the document
   * model allows: whatever the editor can produce, export has to spell in a way
   * import reads back. These are the cases where a naive scan gets it wrong —
   * adjacent delimiter runs, emphasis nested inside emphasis, and a delimiter
   * that is really inside a code span.
   */
  it("round-trips adjacent, nested and code-shadowed delimiters", () => {
    const cases: Array<{ runs: InlineRun[]; markdown: string }> = [
      {
        // Adjacent runs sharing nothing: one delimiter run has to be split on
        // the way back in.
        runs: [
          { text: "a", marks: { bold: true } },
          { text: "b", marks: { italic: true } },
        ],
        markdown: "**a***b*",
      },
      {
        // Emphasis inside emphasis: the shared mark stays open across the runs,
        // and the inner opener must not be read as the outer closer.
        runs: [
          { text: "italic ", marks: { italic: true } },
          { text: "bold", marks: { italic: true, bold: true } },
          { text: " italic", marks: { italic: true } },
        ],
        markdown: "*italic **bold** italic*",
      },
      {
        // The delimiter that is not one: `**` inside a code span is content.
        runs: [{ text: "a**b", marks: { bold: true, inlineCode: true } }],
        markdown: "**`a**b`**",
      },
      {
        // …and the rule-of-three case, where a `*` that could close the outer
        // `**` has to be read as opening the inner emphasis instead.
        runs: [
          { text: "a", marks: { bold: true, strike: true } },
          { text: "b", marks: { bold: true, italic: true, strike: true } },
        ],
        markdown: "**~~a*b*~~**",
      },
    ];

    for (const { runs, markdown } of cases) {
      const doc = seeded();
      const id = appendBlock(doc, { type: "paragraph", inline: runs });
      expect(exportMarkdown(doc, { frontmatter: false }), markdown).toBe(
        `${markdown}\n`,
      );
      expect(importMarkdown(markdown).blocks[0]?.inline, markdown).toEqual(
        getBlockInline(doc, id),
      );
    }

    // Emphasis cannot touch whitespace in GFM, so the space moves out of the
    // span rather than the span silently becoming literal text on the way back.
    const spaced = seeded();
    appendBlock(spaced, {
      type: "paragraph",
      inline: [{ text: "word ", marks: { bold: true } }],
    });
    expect(exportMarkdown(spaced, { frontmatter: false })).toBe("**word** \n");
  });

  it("round-trips link labels and targets that markdown would truncate", () => {
    const cases: Array<{ run: InlineRun; markdown: string }> = [
      {
        // A `]` in the label would end it early.
        run: { text: "a]b", marks: { link: "https://example.com" } },
        markdown: "[a\\]b](https://example.com)",
      },
      {
        // Balanced parentheses belong to the target.
        run: { text: "x", marks: { link: "https://example.com/a_(b)" } },
        markdown: "[x](https://example.com/a_(b))",
      },
      {
        // An unbalanced one does not, so the target goes in angle brackets —
        // written differently, never rewritten.
        run: { text: "x", marks: { link: "https://example.com/a)b" } },
        markdown: "[x](<https://example.com/a)b>)",
      },
    ];
    for (const { run, markdown } of cases) {
      const doc = seeded();
      const id = appendBlock(doc, { type: "paragraph", inline: [run] });
      expect(exportMarkdown(doc, { frontmatter: false }), markdown).toBe(
        `${markdown}\n`,
      );
      expect(importMarkdown(markdown).blocks[0]?.inline, markdown).toEqual(
        getBlockInline(doc, id),
      );
    }
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

  /**
   * The refusal that keeps the two halves of the model consistent. Marks a source
   * block cannot hold must not get there by the back door, and `setBlockType`
   * cannot silently drop them either — its whole contract is that it preserves
   * the delta. So the re-type is refused, before it writes anything.
   */
  it("refuses to re-type formatted prose into a source block", () => {
    const doc = seeded();
    const id = appendBlock(doc, {
      type: "paragraph",
      inline: [
        { text: "plain ", marks: {} },
        { text: "bold", marks: { bold: true } },
      ],
    });
    const thread = createAnnotation(doc, id, 0, 5, "reviewer", "hm");

    for (const type of ["code", "mermaid"] as const) {
      expect(() => setBlockType(doc, id, type), type).toThrow(
        MarksNotAllowedError,
      );
    }
    // Refused *before* mutating: the block is exactly as it was.
    expect(getBlock(doc, id)?.type).toBe("paragraph");
    expect(getBlockInline(doc, id)).toEqual([
      { text: "plain ", marks: {} },
      { text: "bold", marks: { bold: true } },
    ]);

    // The error names what is in the way, so a caller can clear it and retry.
    try {
      setBlockType(doc, id, "code");
      expect.unreachable();
    } catch (error) {
      expect((error as MarksNotAllowedError).marks).toEqual(["bold"]);
      expect((error as MarksNotAllowedError).blockType).toBe("code");
    }

    // An annotation anchor is legal on every block type, so a block carrying
    // only that re-types as it always did.
    const annotated = seeded();
    const other = appendBlock(annotated, {
      type: "paragraph",
      text: "Hello brave world",
    });
    createAnnotation(annotated, other, 6, 11, "reviewer", "hm");
    setBlockType(annotated, other, "code", { language: "ts" });
    expect(getBlock(annotated, other)?.type).toBe("code");
    expect(listAnnotationRanges(annotated, other)).toHaveLength(1);
    expect(thread.id).not.toBe("");
  });

  /**
   * The link invariant belongs to the model, not to the editor's input rules: a
   * write refuses, and a read of something written elsewhere degrades. Together
   * they are what keeps a `javascript:` target out of the document and out of
   * every renderer downstream of it.
   */
  it("refuses to write a link target that is not an external URL", () => {
    for (const href of [
      "javascript:alert(1)",
      "mailto:a@b.com",
      "./relative.md",
      "ftp://example.com/x",
      "",
    ]) {
      const doc = seeded();
      expect(
        () =>
          appendBlock(doc, {
            type: "paragraph",
            inline: [{ text: "x", marks: { link: href } }],
          }),
        href,
      ).toThrow(InvalidLinkHrefError);
      // Nothing was written: the refusal comes before the delta.
      expect(getBlocks(doc), href).toEqual([]);
    }

    // Read the other way: a foreign writer's link is not a link here.
    const doc = seeded();
    const id = appendBlock(doc, { type: "paragraph", text: "click me" });
    text(doc).format(0, 5, { link: { href: "javascript:alert(1)" } });
    expect(getBlockInline(doc, id)).toEqual([{ text: "click me", marks: {} }]);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe("click me\n");
  });

  it("reads a flag only from the values it writes", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "paragraph", text: "abcdef" });
    // `{}` is what y-prosemirror writes for an attribute-less mark, and `true` is
    // what a person writes by hand. Anything else is not this mark.
    text(doc).format(0, 1, { bold: {} });
    text(doc).format(1, 1, { bold: true });
    text(doc).format(2, 1, { bold: false });
    text(doc).format(3, 1, { bold: 0 });
    text(doc).format(4, 1, { bold: "yes" });
    expect(getBlockInline(doc, id)).toEqual([
      { text: "ab", marks: { bold: true } },
      { text: "cdef", marks: {} },
    ]);
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
