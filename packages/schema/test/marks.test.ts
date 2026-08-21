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
  resolveAnnotationRange,
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
      {
        // Three runs sharing marks pairwise but not all round: the emitted
        // delimiters merge into runs that only split correctly if the reader
        // spends them a piece at a time.
        runs: [
          { text: "a", marks: { italic: true } },
          { text: "b", marks: { bold: true } },
          { text: "c", marks: { bold: true, italic: true } },
        ],
        markdown: "*a***b*c***",
      },
      {
        // A `~` that closes nothing is text inside the span, not the end of it.
        runs: [{ text: "a~b", marks: { strike: true } }],
        markdown: "~~a\\~b~~",
      },
      {
        // The mark that outlives its neighbour goes outside it, even though at
        // the first run nothing has said so yet: the italic here spans both runs,
        // the bold only the first, so italic is the outer span and the bold
        // closes inside it.
        runs: [
          { text: "a", marks: { bold: true, italic: true } },
          { text: "b", marks: { italic: true } },
        ],
        markdown: "***a**b*",
      },
      {
        // The same, the other way round, so the ordering is not just a lucky
        // tie-break: bold outlives italic here.
        runs: [
          { text: "a", marks: { bold: true, italic: true } },
          { text: "b", marks: { bold: true } },
        ],
        markdown: "***a*b**",
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

    // Reading hand-written markdown the writer would never emit: a delimiter run
    // is spent a piece at a time, and what nobody can spend is text. These are
    // the answers a CommonMark reader gives.
    expect(importMarkdown("**a***b**").blocks[0]?.inline).toEqual([
      { text: "a", marks: { bold: true } },
      { text: "*b**", marks: {} },
    ]);
    expect(importMarkdown("~~a~b~~").blocks[0]?.inline).toEqual([
      { text: "a~b", marks: { strike: true } },
    ]);
  });

  /**
   * The rule of three, and the one waiver it allows.
   *
   * `***c****d*` and `a***b****c` are the same shape at the moment of the match —
   * a three-run opener and a four-run closer — and they must read differently. The
   * first is a construct the writer emitted: an italic inside a bold, whose closer
   * shuts both and reopens the italic for a later `*` to close. The second has no
   * later closer, so CommonMark leaves three asterisks as text. What separates
   * them is only whether the construct finishes, so the waiver is granted and then
   * withdrawn if it did not.
   */
  it("waives the rule of three only for a construct that finishes", () => {
    // Finished: every delimiter is spent, and the marks come back.
    expect(importMarkdown("***c****d*").blocks[0]).toEqual({
      type: "paragraph",
      text: "cd",
      inline: [
        { text: "c", marks: { bold: true, italic: true } },
        { text: "d", marks: { italic: true } },
      ],
    });

    // Unfinished: the waiver is withdrawn, and the leftovers are text — the same
    // reading CommonMark gives, with every character of the input preserved.
    expect(importMarkdown("a***b****c").blocks[0]).toEqual({
      type: "paragraph",
      text: "a*b**c",
      inline: [
        { text: "a*", marks: {} },
        { text: "b", marks: { bold: true } },
        { text: "**c", marks: {} },
      ],
    });

    // Both on one line: the second one's failure says nothing about the first,
    // and withdrawing the waiver line-wide would take the good one apart.
    expect(importMarkdown("***c****d* a***b****c").blocks[0]).toEqual({
      type: "paragraph",
      text: "cd a*b**c",
      inline: [
        { text: "c", marks: { bold: true, italic: true } },
        { text: "d", marks: { italic: true } },
        { text: " a*", marks: {} },
        { text: "b", marks: { bold: true } },
        { text: "**c", marks: {} },
      ],
    });
  });

  /**
   * Delimiter soup: several runs on one line, pairing across whatever looks like a
   * construct, with waivers granted and some of them withdrawn again.
   *
   * These are the shapes where a reader can quietly lose characters, so what is
   * pinned is the thing that must never bend — every character of the input is
   * still there afterwards — plus the settling: read it, write it, read it again,
   * and nothing moves. The *marks* these produce are this implementation's reading
   * of genuinely ambiguous input, not a reference implementation's; cmark could not
   * be run here to compare, so they are recorded rather than claimed as canonical.
   */
  it("keeps every character of tangled delimiter runs, and settles", () => {
    const tangles = [
      "a***b****c ***d****e*",
      "***a****a*****a*****",
      "****a******a*******",
      "***c****d* a***b****c",
    ];
    for (const source of tangles) {
      const letters = (text: string): string => text.replace(/[^a-z ]/g, "");
      const first = importMarkdown(source).blocks[0];
      expect(first, source).toBeDefined();
      // Nothing but delimiters may be consumed: every letter and space survives.
      expect(letters(first?.text ?? ""), source).toBe(letters(source));

      // …and the reading is stable, which is what stops an edit from churning.
      const doc = seeded();
      const id = appendBlock(doc, first ?? { type: "paragraph" });
      const exported = exportMarkdown(doc, { frontmatter: false });
      const again = importMarkdown(exported).blocks[0];
      const reread = seeded();
      const rereadId = appendBlock(reread, again ?? { type: "paragraph" });
      expect(getBlockText(reread, rereadId), source).toBe(getBlockText(doc, id));
      expect(exportMarkdown(reread, { frontmatter: false }), source).toBe(exported);
    }
  });

  /**
   * Only *emphasis* cannot sit against whitespace. A link is perfectly happy to
   * hold a space, so hoisting the space out of everything would throw away a mark
   * the format can express.
   */
  it("keeps a link over edge whitespace, and only drops the emphasis", () => {
    for (const [text, markdown] of [
      [" word", "[ **word**](https://example.com)"],
      ["word ", "[**word** ](https://example.com)"],
    ] as Array<[string, string]>) {
      const doc = seeded();
      const id = appendBlock(doc, {
        type: "paragraph",
        inline: [{ text, marks: { link: "https://example.com", bold: true } }],
      });
      expect(exportMarkdown(doc, { frontmatter: false }), text).toBe(
        `${markdown}\n`,
      );
      // The space kept the link and lost only the bold, and the text is intact.
      const back = importMarkdown(markdown).blocks[0];
      expect(back?.text, text).toBe(getBlockText(doc, id));
      expect(
        back?.inline?.every((run) => run.marks.link === "https://example.com"),
        text,
      ).toBe(true);
    }
  });

  /**
   * …but only when the link is the deeper of the two. When emphasis spans further
   * than the link does, the space cannot stay inside it: the emphasis closes after
   * the link's `)` and would then be covering a trailing space, which the next read
   * strips — an export whose own re-export disagrees with it. So both marks come
   * off the space, the text is untouched, and `expressibleInGfm` counts the
   * document out rather than the exactness assertion pretending otherwise.
   *
   * Keeping the link here means splitting the emphasis so the link ends up
   * outermost (`**a**[**b** ](url)`), which is expressible — but the next trip
   * reads the space as its own run and orders the two marks the other way, so the
   * bytes never settle. Measured; the stable spelling is the one below.
   */
  it("drops an inner link from edge whitespace rather than churning", () => {
    const doc = seeded();
    const id = appendBlock(doc, {
      type: "paragraph",
      inline: [
        { text: "a", marks: { bold: true } },
        { text: "b ", marks: { bold: true, link: "https://example.com" } },
      ],
    });
    const exported = exportMarkdown(doc, { frontmatter: false });
    expect(exported).toBe("**a[b](https://example.com)** \n");

    // The text is intact, and re-exporting agrees with itself.
    const back = importMarkdown(exported).blocks[0];
    const reread = seeded();
    const rereadId = appendBlock(reread, back ?? { type: "paragraph" });
    expect(getBlockText(reread, rereadId)).toBe(getBlockText(doc, id));
    expect(exportMarkdown(reread, { frontmatter: false })).toBe(exported);
  });

  it("does not read a currency symbol as punctuation for the `_` rule", () => {
    // `€` is a Unicode *symbol*, not punctuation, so it does not license the
    // intraword `_` that CommonMark's flanking rules would otherwise allow.
    expect(importMarkdown("€_x_€").blocks[0]).toEqual({
      type: "paragraph",
      text: "€_x_€",
    });
    // A real punctuation neighbour does license it.
    expect(importMarkdown("(_x_)").blocks[0]?.inline).toEqual([
      { text: "(", marks: {} },
      { text: "x", marks: { italic: true } },
      { text: ")", marks: {} },
    ]);
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
      {
        // A backslash in a target is data. Inside the angle form the writer
        // escapes it and the reader takes exactly that escape back off.
        run: { text: "x", marks: { link: "https://example.com/a)b\\q" } },
        markdown: "[x](<https://example.com/a)b\\\\q>)",
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

    // The other side of that escape rule: a backslash the writer did not put
    // there stays in the target, because an href is never rewritten.
    expect(
      importMarkdown("[x](<https://example.com/a)b\\q>)").blocks[0]?.inline,
    ).toEqual([{ text: "x", marks: { link: "https://example.com/a)b\\q" } }]);
  });

  it("keeps literal markdown literal, in both directions", () => {
    const literals = [
      "Not bold: \\*\\*this\\*\\* is literal.",
      "A backslash \\\\ and a backtick \\` stay put.",
      "Tilde \\~\\~pair\\~\\~, path ~/.config, snake_case and \\_\\_underscores\\_\\_.",
      "\\[not a link](https://example.com) and \\[not one either](./relative.md).",
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

    // `_` *is* a delimiter now, so a literal one is escaped — except between two
    // word characters, where CommonMark's intraword rule means it can never
    // delimit anything and `snake_case` needs no help.
    expect(importMarkdown("__underscores__").blocks[0]?.inline).toEqual([
      { text: "underscores", marks: { bold: true } },
    ]);
    expect(importMarkdown("_em_ and snake_case").blocks[0]?.inline).toEqual([
      { text: "em", marks: { italic: true } },
      { text: " and snake_case", marks: {} },
    ]);
    const underscores = seeded();
    appendBlock(underscores, {
      type: "paragraph",
      text: "snake_case but __not bold__",
    });
    expect(exportMarkdown(underscores, { frontmatter: false })).toBe(
      "snake_case but \\_\\_not bold\\_\\_\n",
    );

    // `[` always is, even the one above whose target is not a link. What makes a
    // bracket dangerous is a `](…)` later in the *line*, which another run can
    // emit, so no run-local test could decide it.
    const bracket = seeded();
    appendBlock(bracket, { type: "paragraph", text: "see [1] and [2]" });
    expect(exportMarkdown(bracket, { frontmatter: false })).toBe(
      "see \\[1] and \\[2]\n",
    );

    // The case that rule exists for: a bracket in one run, and a *later* run whose
    // link mark emits the `](…)` that would pair with it. Escaping only what a run
    // can see would turn the two into one link and lose both characters.
    const paired = seeded();
    const pairedId = appendBlock(paired, {
      type: "paragraph",
      inline: [
        { text: "[not a link", marks: { bold: true } },
        { text: " but ", marks: {} },
        { text: "this is", marks: { link: "https://example.com" } },
      ],
    });
    const pairedOut = exportMarkdown(paired, { frontmatter: false });
    expect(pairedOut).toBe(
      "**\\[not a link** but [this is](https://example.com)\n",
    );
    expect(importMarkdown(pairedOut).blocks[0]?.inline).toEqual(
      getBlockInline(paired, pairedId),
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

    // …and a paragraph that therefore *starts* with three backticks is still a
    // paragraph. A fence's info string may hold no backticks, which is what tells
    // the two apart — CommonMark's rule, and the reason this round-trips.
    const leading = seeded();
    appendBlock(leading, {
      type: "paragraph",
      inline: [{ text: "``x", marks: { inlineCode: true } }],
    });
    const fenced = exportMarkdown(leading, { frontmatter: false });
    expect(fenced).toBe("``` ``x ```\n");
    expect(importMarkdown(fenced).blocks[0]).toEqual({
      type: "paragraph",
      text: "``x",
      inline: [{ text: "``x", marks: { inlineCode: true } }],
    });
  });

  /**
   * Two code spans whose fences met would be one span nothing could split, so the
   * writer must not put them next to each other. Usually it does not have to merge
   * them to manage that: the delimiters of whatever mark they disagree about go
   * between them and keep the backtick runs apart, and runs with *identical* marks
   * merge losing nothing at all. The exception is a code run of nothing but
   * whitespace, where the separating delimiter cannot be written either — see the
   * forced-merge case below.
   */
  it("keeps neighbouring code runs apart without losing their marks", () => {
    const doc = seeded();
    const id = appendBlock(doc, {
      type: "paragraph",
      inline: [
        { text: "one", marks: { inlineCode: true, bold: true } },
        { text: "two", marks: { inlineCode: true } },
      ],
    });
    const exported = exportMarkdown(doc, { frontmatter: false });
    // The `**` between the two spans is what stops the fences meeting.
    expect(exported).toBe("**`one`**`two`\n");
    // Nothing was lost: the marks, and so the text, come back as they went in.
    expect(importMarkdown(exported).blocks[0]?.inline).toEqual(
      getBlockInline(doc, id),
    );

    // Identical marks *are* merged, because then there is nothing to lose.
    const same = seeded();
    const sameId = appendBlock(same, {
      type: "paragraph",
      inline: [
        { text: "one", marks: { inlineCode: true, bold: true } },
        { text: "two", marks: { inlineCode: true, bold: true } },
      ],
    });
    expect(exportMarkdown(same, { frontmatter: false })).toBe("**`onetwo`**\n");
    expect(getBlockInline(same, sameId)).toEqual([
      { text: "onetwo", marks: { inlineCode: true, bold: true } },
    ]);
  });

  /**
   * A code span's content is verbatim, so the whitespace rules that keep emphasis
   * off spaces must not reach inside one. Hoisting the leading whitespace out of a
   * code run whose text is *only* whitespace used to empty the span entirely and
   * emit `` `` ``, which reads back as two literal backticks.
   */
  it("does not hoist whitespace out of a code span", () => {
    const doc = seeded();
    const id = appendBlock(doc, {
      type: "paragraph",
      inline: [
        { text: "  ", marks: { inlineCode: true, bold: true } },
        { text: "after", marks: {} },
      ],
    });
    const exported = exportMarkdown(doc, { frontmatter: false });
    expect(exported).toBe("**`    `**after\n");
    expect(getBlockText(doc, id)).toBe("  after");
    expect(importMarkdown(exported).blocks[0]?.inline).toEqual(
      getBlockInline(doc, id),
    );
  });

  /**
   * A tilde fence's info string may hold backticks — only a *backtick* fence's may
   * not. Applying the backtick rule to both turned a `~~~` block into a paragraph.
   */
  it("reads a tilde fence whose info string holds backticks", () => {
    const imported = importMarkdown("~~~`weird`\nbody\n~~~");
    expect(imported.blocks).toEqual([
      { type: "code", text: "body", language: "`weird`" },
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

    // The refusal left the annotation where it was, anchored on its own text.
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({
      start: 0,
      end: 5,
      collapsed: false,
    });

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
  });

  /**
   * The refusal cannot be a list of marks this package knows. A source block's
   * node type allows `comment` and nothing else, so a key from a writer nobody
   * here has heard of makes the block just as unbindable — and a reader that
   * skipped it would copy it into the new element and hand the editor a document
   * it must refuse.
   */
  it("refuses a re-type over a mark it has never heard of", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "paragraph", text: "from the future" });
    text(doc).format(0, 4, { underline: {} });

    expect(() => setBlockType(doc, id, "code")).toThrow(MarksNotAllowedError);
    try {
      setBlockType(doc, id, "mermaid");
      expect.unreachable();
    } catch (error) {
      expect((error as MarksNotAllowedError).marks).toEqual(["underline"]);
    }

    // Untouched, foreign mark included: refusing is what keeps it that way.
    expect(getBlock(doc, id)?.type).toBe("paragraph");
    expect(delta(doc)).toEqual([
      ["from", { underline: {} }],
      [" the future", null],
    ]);
  });

  /**
   * `comment` is exempt from that refusal because every block type allows it —
   * but only a real anchor is. The editor's gate rejects a malformed one, so
   * exempting it here would let a re-type produce exactly the document the gate
   * then refuses to bind.
   */
  it("exempts only a comment mark that is really an anchor", () => {
    const real = seeded();
    const anchored = appendBlock(real, {
      type: "paragraph",
      text: "Hello brave world",
    });
    createAnnotation(real, anchored, 6, 11, "reviewer", "hm");
    setBlockType(real, anchored, "code");
    expect(getBlock(real, anchored)?.type).toBe("code");

    for (const value of [true, {}, { threadId: "" }, { threadId: 7 }]) {
      const doc = seeded();
      const id = appendBlock(doc, { type: "paragraph", text: "not an anchor" });
      text(doc).format(0, 3, { comment: value });
      const label = JSON.stringify(value);

      expect(() => setBlockType(doc, id, "code"), label).toThrow(
        MarksNotAllowedError,
      );
      expect(getBlock(doc, id)?.type, label).toBe("paragraph");
    }
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

/**
 * The closure contract, as a property rather than a list of examples.
 *
 * Named cases pin the failures we know about; this catches the ones we do not.
 * Every bug the reader and writer had — nested emphasis, adjacent delimiter runs,
 * the rule of three, whitespace at a span edge, a tilde next to a `~~` — was
 * found by generating documents like these, and each was invisible to a
 * hand-written case until it was written down.
 *
 * Three properties, all about the pair rather than either half:
 *
 *  1. **The text never changes**, on any trip. This is the invariant that cannot
 *     bend, and a mis-emitted or mis-read delimiter shows up here first.
 *  2. **Per-character mark sets never change**, from the first export's own
 *     re-read onward: read what was written, write it again, read it again, and
 *     the runs are identical.
 *  3. **The bytes settle immediately**: the export of a re-import is byte-identical
 *     to the export it came from.
 *
 * And two exceptions, both the format's rather than ours: GFM cannot write
 * emphasis that touches whitespace, and it cannot keep two code spans apart when
 * the mark that would separate them falls on a space. A document that needs either
 * loses that one mark on the way out — after which everything above holds exactly.
 * For every document GFM *can* express, the first export is already exact, and
 * `expressibleInGfm` names both exceptions structurally so neither can quietly
 * grow.
 *
 * Fixed seed and a small count, so it is a deterministic sub-second test rather
 * than a fuzzer.
 */
describe("export and import are closed over the marks the model allows", () => {
  const CHUNKS = [
    "a",
    "bb",
    " ",
    "  ",
    "*",
    "**",
    "***",
    "~~",
    "~",
    "`",
    "[",
    "]",
    "(",
    ")",
    "\\",
    "_",
    "snake_case",
    "x)y",
  ];

  /**
   * A tiny deterministic PRNG, so a failure is always reproducible.
   *
   * mulberry32, and the choice matters: the obvious textbook LCG
   * (`state * 1103515245 + 12345 & 0x7fffffff`) is *broken* in JavaScript, because
   * the multiply overflows 2^53 and loses the low bits — its output is never
   * 2 or 3 mod 4, which silently made every generated document a single run and
   * the whole corpus blind to run transitions. This one stays in 32-bit integer
   * territory (`Math.imul`, `>>> 0`) and is uniform in every modulus used here.
   */
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
  }

  function randomDocument(next: () => number): InlineRun[] {
    const pick = (n: number): number => next() % n;
    const runs: InlineRun[] = [];
    for (let i = pick(4) + 1; i > 0; i -= 1) {
      let content = "";
      for (let j = pick(4) + 1; j > 0; j -= 1) {
        content += CHUNKS[pick(CHUNKS.length)];
      }
      const marks: InlineRun["marks"] = {};
      if (pick(3) === 0) marks.bold = true;
      if (pick(3) === 0) marks.italic = true;
      if (pick(4) === 0) marks.strike = true;
      if (pick(5) === 0) marks.inlineCode = true;
      if (pick(5) === 0) {
        marks.link = pick(2) === 0 ? "https://e.com/a" : "https://e.com/a_(b)";
      }
      runs.push({ text: content, marks });
    }
    return runs;
  }

  /**
   * Whether GFM can express this document at all, decided from the runs
   * themselves rather than from what came back.
   *
   * Two things it cannot spell, and both are visible in the runs:
   *
   *  - Emphasis against whitespace — `**word **` is not bold in any reader. The
   *    condition is per *run*, not per span, because a crossing span can be split
   *    at any run boundary and the delimiter lands there.
   *  - Two code spans that would meet with nothing between them: fences merge into
   *    one unsplittable run. Marks they disagree about normally keep them apart,
   *    but not when one of them is only whitespace, since that mark cannot be
   *    written there either.
   *
   * Conservative — some excluded documents would come out exact anyway — but never
   * derived from the answer. Deriving it from the answer would make the exactness
   * assertion unfalsifiable: a document that should have been exact and was not
   * would simply drop out of the sample.
   */
  function expressibleInGfm(runs: readonly InlineRun[]): boolean {
    const emphasised = (run: InlineRun): boolean =>
      run.marks.bold === true ||
      run.marks.italic === true ||
      run.marks.strike === true;
    const emphasisOnSpace = runs.some(
      (run) => emphasised(run) && /^\s|\s$/.test(run.text),
    );
    const fencesWouldMeet = runs.some((run, index) => {
      const next = runs[index + 1];
      if (next === undefined) return false;
      if (run.marks.inlineCode !== true || next.marks.inlineCode !== true) {
        return false;
      }
      if (JSON.stringify(run.marks) === JSON.stringify(next.marks)) return false;
      return run.text.trim() === "" || next.text.trim() === "";
    });
    return !emphasisOnSpace && !fencesWouldMeet;
  }

  /** One trip through markdown and back: what the document became. */
  function roundTrip(markdown: string): {
    runs: InlineRun[];
    text: string;
    markdown: string;
  } {
    const imported = importMarkdown(markdown).blocks[0];
    const doc = seeded();
    const id = appendBlock(doc, imported ?? { type: "paragraph" });
    return {
      runs: getBlockInline(doc, id),
      text: getBlockText(doc, id),
      markdown: exportMarkdown(doc, { frontmatter: false }),
    };
  }

  it("preserves text and marks and settles, for 200 documents", () => {
    const next = generator(20260821);
    let checked = 0;
    let multiRun = 0;
    let marked = 0;
    let expressible = 0;
    let blank = 0;

    for (let round = 0; round < 200; round += 1) {
      const runs = randomDocument(next);
      const doc = seeded();
      const id = appendBlock(doc, { type: "paragraph", inline: runs });
      const plain = getBlockText(doc, id);
      if (plain.trim() === "") {
        // A paragraph of nothing but whitespace, asserted rather than skipped so
        // that a change here has to be deliberate. Which of the two things happens
        // depends on whether any mark survived to hold the line up: with nothing
        // left, the line is blank and a blank line is not a block; with a code span
        // or a link on it, there is something to read and the text comes back.
        blank += 1;
        const exported = exportMarkdown(doc, { frontmatter: false });
        const back = importMarkdown(exported).blocks[0];
        if (exported.trim() === "") {
          expect(back, JSON.stringify(exported)).toBeUndefined();
        } else {
          expect(back?.text, JSON.stringify(exported)).toBe(plain);
        }
        continue;
      }

      const first = exportMarkdown(doc, { frontmatter: false });
      const one = roundTrip(first);
      const two = roundTrip(one.markdown);
      const three = roundTrip(two.markdown);
      const label = `${JSON.stringify(getBlockInline(doc, id))} -> ${JSON.stringify(first)}`;

      // 1. The text, every trip.
      for (const trip of [one, two, three]) {
        expect(trip.text, label).toBe(plain);
      }
      // 2. The marks, from the first re-read onward.
      expect(two.runs, label).toEqual(one.runs);
      expect(three.runs, label).toEqual(two.runs);
      // 3. The bytes, from the first re-read onward.
      expect(two.markdown, label).toBe(one.markdown);
      expect(three.markdown, label).toBe(two.markdown);

      // …and when the format can express the document at all, the first export is
      // already exact. The exceptions are emphasis touching whitespace and two code
      // spans that would meet; this is what stops them growing into anything else.
      if (expressibleInGfm(getBlockInline(doc, id))) {
        expressible += 1;
        expect(one.runs, label).toEqual(getBlockInline(doc, id));
        expect(one.markdown, label).toBe(first);
      }

      checked += 1;
      if (runs.length > 1) multiRun += 1;
      if (runs.some((run) => Object.keys(run.marks).length > 0)) marked += 1;
    }

    // The corpus has to be worth checking, and a generator can go quietly
    // degenerate — the first version of this one did, and every document came out
    // a single run, so the transitions between runs (where the delimiters are)
    // were never exercised at all. Assert the shape of the corpus, not just that
    // it ran.
    expect(checked).toBeGreaterThan(150);
    expect(multiRun).toBeGreaterThan(100);
    expect(marked).toBeGreaterThan(100);
    // Most documents are expressible, so the exact-first-export assertion above is
    // carrying real weight rather than being skipped.
    expect(expressible).toBeGreaterThan(100);
    // The blank-paragraph branch above is exercised too, not dead weight.
    expect(blank).toBeGreaterThan(0);
  });
});
