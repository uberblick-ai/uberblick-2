import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  exportMarkdown,
  getBlocks,
  importMarkdown,
  initDoc,
  listNumbers,
  parseGfmTable,
  setTags,
} from "../src/index.js";

const UUID = "66666666-6666-4666-8666-666666666666";

const SOURCE = [
  "---",
  `uuid: ${UUID}`,
  "title: Test protocol",
  "tags: [protocol, schema]",
  "---",
  "",
  "How to verify the block model.",
  "",
  "## Steps",
  "",
  "Run the suite:",
  "",
  "```bash",
  "mise run test",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  read-->compare",
  "  compare-->work",
  "```",
  "",
  "###### Notes",
  "",
  "A paragraph that",
  "spans two source lines.",
  "",
].join("\n");

function docFrom(markdown: string): Y.Doc {
  const imported = importMarkdown(markdown);
  const doc = new Y.Doc();
  initDoc(doc, {
    uuid: imported.uuid ?? UUID,
    title: imported.title,
    tags: imported.tags,
  });
  for (const block of imported.blocks) appendBlock(doc, block);
  return doc;
}

describe("importMarkdown", () => {
  it("parses frontmatter, headings, fences and paragraphs", () => {
    const imported = importMarkdown(SOURCE);
    expect(imported.uuid).toBe(UUID);
    expect(imported.title).toBe("Test protocol");
    expect(imported.tags).toEqual(["protocol", "schema"]);
    expect(imported.blocks).toEqual([
      { type: "paragraph", text: "How to verify the block model." },
      { type: "heading", text: "Steps", level: 2 },
      { type: "paragraph", text: "Run the suite:" },
      { type: "code", text: "mise run test", language: "bash" },
      {
        type: "mermaid",
        text: "graph TD\n  read-->compare\n  compare-->work",
      },
      { type: "heading", text: "Notes", level: 6 },
      {
        type: "paragraph",
        text: "A paragraph that\nspans two source lines.",
      },
    ]);

    expect(importMarkdown("")).toEqual({ title: "", tags: [], blocks: [] });
  });

  it("takes the title from a leading H1 when there is no frontmatter, and consumes it", () => {
    const imported = importMarkdown("# Product definition\n\nWhat it is.\n");
    expect(imported.title).toBe("Product definition");
    expect(imported.tags).toEqual([]);
    expect(imported.uuid).toBeUndefined();
    expect(imported.blocks).toEqual([
      { type: "paragraph", text: "What it is." },
    ]);

    // Only a LEADING H1 is a title: any other heading stays a block, and the
    // document is left untitled.
    const notATitle = importMarkdown("## Section\n\nBody.\n");
    expect(notATitle.title).toBe("");
    expect(notATitle.blocks[0]).toEqual({
      type: "heading",
      text: "Section",
      level: 2,
    });
  });

  it("reads block-sequence tags, quoted scalars and CRLF input", () => {
    const imported = importMarkdown(
      [
        "---",
        'title: "Tricky: title, quoted"',
        "tags:",
        "  - one",
        '  - "two: also tricky"',
        "---",
        "",
        "Body.",
      ].join("\r\n"),
    );
    expect(imported.title).toBe("Tricky: title, quoted");
    expect(imported.tags).toEqual(["one", "two: also tricky"]);
    expect(imported.blocks).toEqual([{ type: "paragraph", text: "Body." }]);
  });

  it("skips HTML comments, including exported annotation comments", () => {
    const imported = importMarkdown(
      [
        "Para one.",
        "",
        "<!-- annotation abc range=0-4 alice: \"hm\" -->",
        "",
        "<!-- a",
        "     multi-line comment -->",
        "",
        "Para two.",
      ].join("\n"),
    );
    expect(imported.blocks).toEqual([
      { type: "paragraph", text: "Para one." },
      { type: "paragraph", text: "Para two." },
    ]);
  });

  it("handles tilde fences, unlabelled fences and an unterminated fence", () => {
    expect(importMarkdown("~~~\nplain\n~~~\n").blocks).toEqual([
      { type: "code", text: "plain", language: "" },
    ]);
    expect(importMarkdown("```\nplain\n```\n").blocks).toEqual([
      { type: "code", text: "plain", language: "" },
    ]);
    expect(importMarkdown("```ts\nnever closed\n").blocks).toEqual([
      { type: "code", text: "never closed", language: "ts" },
    ]);
  });

});

describe("markdown round-trip", () => {
  it("import → export → import is stable for a representative document", () => {
    const doc = docFrom(SOURCE);
    const exported = exportMarkdown(doc);
    expect(exported).toBe(SOURCE);

    const reimported = importMarkdown(exported);
    const first = importMarkdown(SOURCE);
    expect(reimported).toEqual(first);
    expect(getBlocks(docFrom(exported)).map(({ id, ...rest }) => rest)).toEqual(
      getBlocks(doc).map(({ id, ...rest }) => rest),
    );

    // Export reads nothing but the Y.Doc, so a replica hydrated from an update
    // exports byte-identically — and `frontmatter: false` drops only the header.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(exportMarkdown(replica)).toBe(exported);
    expect(exportMarkdown(replica, { frontmatter: false })).toBe(
      exported.slice(exported.indexOf("\n---\n\n") + "\n---\n\n".length),
    );
  });

  it("quotes frontmatter scalars that need it and round-trips them", () => {
    const doc = new Y.Doc();
    initDoc(doc, {
      uuid: UUID,
      title: "Schema: the keystone",
      tags: ["a tag", "with: colon"],
    });
    appendBlock(doc, { type: "paragraph", text: "Body." });

    const exported = exportMarkdown(doc);
    expect(exported).toBe(
      [
        "---",
        `uuid: ${UUID}`,
        'title: "Schema: the keystone"',
        'tags: [a tag, "with: colon"]',
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    const imported = importMarkdown(exported);
    expect(imported.title).toBe("Schema: the keystone");
    expect(imported.tags).toEqual(["a tag", "with: colon"]);

    // The degenerate end of the same emitter: an empty title and no tags still
    // produce valid, re-importable frontmatter — and a blockless document has
    // no body at all, which with `frontmatter: false` is the empty string.
    const empty = new Y.Doc();
    initDoc(empty, { uuid: UUID, title: "" });
    setTags(empty, []);
    const emptyExport = exportMarkdown(empty);
    expect(emptyExport).toBe(
      ["---", `uuid: ${UUID}`, 'title: ""', "tags: []", "---", ""].join("\n"),
    );
    expect(importMarkdown(emptyExport)).toEqual({
      title: "",
      tags: [],
      uuid: UUID,
      blocks: [],
    });
    expect(exportMarkdown(empty, { frontmatter: false })).toBe("");
  });

  it("lengthens the fence when the code itself contains backticks", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Fences" });
    appendBlock(doc, {
      type: "code",
      text: "```\nnested fence\n```",
      language: "md",
    });

    const exported = exportMarkdown(doc, { frontmatter: false });
    expect(exported).toBe(
      ["````md", "```", "nested fence", "```", "````", ""].join("\n"),
    );
    expect(importMarkdown(exported).blocks).toEqual([
      { type: "code", text: "```\nnested fence\n```", language: "md" },
    ]);
  });

  it("folds newlines out of headings", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Headings" });
    appendBlock(doc, { type: "heading", text: "One\nline", level: 2 });
    expect(exportMarkdown(doc, { frontmatter: false })).toBe("## One line\n");
  });
});

/**
 * Lists and quotes are the flat model's whole claim about GFM: a list is a run
 * of adjacent `list-item` blocks and a quote is one block, so the trip out and
 * back has to be exact in *both* directions — the markdown a reader wrote, and
 * the blocks an agent reads.
 */
describe("lists and quotes", () => {
  const LIST_SOURCE = [
    "- alpha",
    "- beta",
    "    - nested one",
    "    - nested two",
    "1. first",
    "2. second",
    "    1. sub",
    "",
    "> a quote",
    "> second line",
    "",
    "Plain paragraph.",
    "",
  ].join("\n");

  it("reads a list into flat blocks, depth from the source's own indentation", () => {
    expect(importMarkdown(LIST_SOURCE).blocks).toEqual([
      { type: "list-item", text: "alpha", list: "bullet", indent: 0 },
      { type: "list-item", text: "beta", list: "bullet", indent: 0 },
      { type: "list-item", text: "nested one", list: "bullet", indent: 1 },
      { type: "list-item", text: "nested two", list: "bullet", indent: 1 },
      { type: "list-item", text: "first", list: "ordered", indent: 0 },
      { type: "list-item", text: "second", list: "ordered", indent: 0 },
      { type: "list-item", text: "sub", list: "ordered", indent: 1 },
      { type: "quote", text: "a quote\nsecond line" },
      { type: "paragraph", text: "Plain paragraph." },
    ]);
  });

  /**
   * Two spaces, four spaces, `*`, `+`, `1)` — all of them are GFM, and an agent
   * writing markdown by hand will use whichever it likes. Depth is relative, so
   * every one of them means the same list.
   */
  it("reads every marker and any indent unit as the same depth", () => {
    expect(
      importMarkdown(["* alpha", "  + nested", "  + also", "1) numbered"].join("\n"))
        .blocks,
    ).toEqual([
      { type: "list-item", text: "alpha", list: "bullet", indent: 0 },
      { type: "list-item", text: "nested", list: "bullet", indent: 1 },
      { type: "list-item", text: "also", list: "bullet", indent: 1 },
      { type: "list-item", text: "numbered", list: "ordered", indent: 0 },
    ]);

    // Deeper than the model holds is clamped, not refused.
    const deep = importMarkdown(
      ["- a", "  - b", "    - c", "      - d", "        - e"].join("\n"),
    );
    expect(deep.blocks.map((block) => block.indent)).toEqual([0, 1, 2, 3, 3]);
  });

  /**
   * Depth is not "further right than the line above": an item is nested only
   * when it reaches the column where the item above it starts its *content* —
   * marker column, plus the marker, plus the spaces after it. Reading a
   * relative column instead invents nesting a reader never wrote, and the
   * export then writes a different list back out.
   */
  it("nests only an item that reaches the parent's content column", () => {
    // One space in is still a sibling: `- a` starts its content at column 2.
    expect(
      importMarkdown(["- a", " - b", "   - c"].join("\n")).blocks.map(
        (block) => block.indent,
      ),
    ).toEqual([0, 0, 1]);

    // An ordered marker is wider, so its children start further in: two spaces
    // do not reach `1. a`'s content column of three.
    expect(
      importMarkdown(["1. a", "  - b", "    - c"].join("\n")).blocks.map(
        (block) => block.indent,
      ),
    ).toEqual([0, 0, 1]);

    // …and what this writer emits comes back as what it meant, which is the
    // property the four-space unit exists for.
    const nested = ["- a", "    - b", "        - c"].join("\n");
    expect(importMarkdown(nested).blocks.map((block) => block.indent)).toEqual([
      0, 1, 2,
    ]);
    expect(exportMarkdown(docFrom(nested), { frontmatter: false })).toBe(
      `${nested}\n`,
    );
  });

  it("exports a run of items as one tight, correctly nested list", () => {
    const doc = docFrom(LIST_SOURCE);
    const exported = exportMarkdown(doc, { frontmatter: false });
    expect(exported).toBe(LIST_SOURCE);

    // …and the second trip changes nothing, blocks or bytes.
    expect(importMarkdown(exported).blocks).toEqual(
      importMarkdown(LIST_SOURCE).blocks,
    );
    expect(exportMarkdown(docFrom(exported), { frontmatter: false })).toBe(
      exported,
    );
  });

  /**
   * The numbers are display: the model stores "ordered" and nothing else, so
   * the writer counts. A run that changes style, or a level that is re-entered,
   * starts again at one — which is what the markdown means anyway.
   */
  it("numbers ordered items per level, restarting where the run does", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Numbers" });
    for (const [text, list, indent] of [
      ["one", "ordered", 0],
      ["one.one", "ordered", 1],
      ["one.two", "ordered", 1],
      ["two", "ordered", 0],
      ["bullet", "bullet", 0],
      ["one again", "ordered", 0],
    ] as const) {
      appendBlock(doc, { type: "list-item", text, list, indent });
    }
    appendBlock(doc, { type: "paragraph", text: "After." });
    appendBlock(doc, { type: "list-item", text: "fresh", list: "ordered" });

    expect(exportMarkdown(doc, { frontmatter: false })).toBe(
      [
        "1. one",
        "    1. one.one",
        "    2. one.two",
        "2. two",
        "- bullet",
        "1. one again",
        "",
        "After.",
        "",
        "1. fresh",
        "",
      ].join("\n"),
    );
  });

  /**
   * A nested bullet is *inside* the ordered item above it, so it ends nothing
   * the enclosing list was counting — the parent after it is item two. The
   * editor draws the same numbers from the same rule (`listNumbers`), which is
   * what keeps the markers a reader sees and the markdown they export in step.
   */
  it("keeps an outer ordered run counting across a nested bullet", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Mixed" });
    for (const [text, list, indent] of [
      ["parent", "ordered", 0],
      ["child", "bullet", 1],
      ["parent two", "ordered", 0],
      ["child two", "bullet", 1],
      ["parent three", "ordered", 0],
    ] as const) {
      appendBlock(doc, { type: "list-item", text, list, indent });
    }

    expect(exportMarkdown(doc, { frontmatter: false })).toBe(
      [
        "1. parent",
        "    - child",
        "2. parent two",
        "    - child two",
        "3. parent three",
        "",
      ].join("\n"),
    );
    expect(
      listNumbers(getBlocks(doc).map(({ type, list, indent }) => ({ type, list, indent }))),
    ).toEqual([1, null, 2, null, 3]);
  });

  it("carries inline marks through both directions", () => {
    const source = ["- an *emphatic* item", "", "> a **loud** quote", ""].join(
      "\n",
    );
    const imported = importMarkdown(source);
    expect(imported.blocks[0]?.inline).toEqual([
      { text: "an ", marks: {} },
      { text: "emphatic", marks: { italic: true } },
      { text: " item", marks: {} },
    ]);
    expect(imported.blocks[1]?.inline).toEqual([
      { text: "a ", marks: {} },
      { text: "loud", marks: { bold: true } },
      { text: " quote", marks: {} },
    ]);
    expect(exportMarkdown(docFrom(source), { frontmatter: false })).toBe(source);
  });

  it("keeps a blank line inside a list from ending it", () => {
    expect(
      importMarkdown(["- a", "", "- b", "", "Prose.", "", "- c"].join("\n"))
        .blocks,
    ).toEqual([
      { type: "list-item", text: "a", list: "bullet", indent: 0 },
      { type: "list-item", text: "b", list: "bullet", indent: 0 },
      { type: "paragraph", text: "Prose." },
      { type: "list-item", text: "c", list: "bullet", indent: 0 },
    ]);
  });

  it("reads a table's source as one block, and writes it back verbatim", () => {
    const source = [
      "| name | count |",
      "| :--- | ----: |",
      "| alpha | 1 |",
      "| beta  | 2 |",
      "",
      "After the table.",
      "",
    ].join("\n");

    const imported = importMarkdown(source);
    expect(imported.blocks).toEqual([
      {
        type: "table",
        text: [
          "| name | count |",
          "| :--- | ----: |",
          "| alpha | 1 |",
          "| beta  | 2 |",
        ].join("\n"),
      },
      { type: "paragraph", text: "After the table." },
    ]);

    // Verbatim, down to the spacing someone lined the pipes up with: the block
    // stores GFM source, so the export has nothing to decide.
    expect(exportMarkdown(docFrom(source), { frontmatter: false })).toBe(source);
  });

  /**
   * A table is a header row *and* a delimiter row. Pipes alone are prose — a
   * paragraph mentioning `a | b` must not become a table, or an agent's
   * `edit_block` would silently change a block's type on the next import.
   */
  it("takes pipes without a delimiter row as the prose they are", () => {
    expect(importMarkdown("a | b\nc | d").blocks).toEqual([
      { type: "paragraph", text: "a | b\nc | d" },
    ]);
    expect(parseGfmTable("| a | b |\n| --- |")).toBeNull();
    expect(parseGfmTable("| a | b |")).toBeNull();

    // …and the cells a reader would expect, escaped pipes included.
    expect(parseGfmTable("| a | b |\n| --- | :-: |\n| 1 \\| 2 |")).toEqual({
      header: ["a", "b"],
      align: [null, "center"],
      // Short rows are padded to the header, which is GFM's own rule.
      rows: [["1 | 2", ""]],
    });
  });

  /**
   * The pipes that make a table are *structural* ones. A `\|` is a pipe in
   * somebody's prose, and a reader that counted it would take a paragraph plus
   * a line of hyphens — a setext heading, in any other reader — as a
   * single-column table, swallowing the paragraph into it.
   */
  it("does not count an escaped pipe as table structure", () => {
    expect(parseGfmTable("a \\| b\n---")).toBeNull();
    // Prose, and prose keeps its backslash: `\|` is not one of the escapes the
    // inline reader resolves, so the text is the line.
    expect(importMarkdown("a \\| b\n---").blocks).toEqual([
      { type: "paragraph", text: "a \\| b\n---" },
    ]);

    // The same line with a real pipe in it is a table, one column wide.
    expect(parseGfmTable("| a \\| b |\n| --- |")).toEqual({
      header: ["a | b"],
      align: [null],
      rows: [],
    });
  });

  /**
   * `- | -` is both a legal one-hyphen delimiter row (GFM's own example writes
   * `:-: | -----------:`) and a list item, and a table read swallows the
   * paragraph above it into a block nobody wrote. The list read costs nothing,
   * so the list wins.
   */
  it("reads a delimiter row that is also a list line as the list item it looks like", () => {
    expect(importMarkdown("a | b\n- | -\n").blocks).toEqual([
      { type: "paragraph", text: "a | b" },
      { type: "list-item", text: "| -", list: "bullet", indent: 0 },
    ]);

    // A delimiter row no list could claim still opens a table, one hyphen and
    // all — the length of the runs was never what made it one.
    expect(importMarkdown("a | b\n:-: | -\n").blocks).toEqual([
      { type: "table", text: "a | b\n:-: | -" },
    ]);
  });

  it("reads an empty item and an empty quote line without losing the block", () => {
    expect(importMarkdown(["-", "> "].join("\n")).blocks).toEqual([
      { type: "list-item", text: "", list: "bullet", indent: 0 },
      { type: "quote", text: "" },
    ]);
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Empty" });
    appendBlock(doc, { type: "list-item" });
    appendBlock(doc, { type: "quote", text: "line\n\nlast" });
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(
      ["-", "", "> line", ">", "> last", ""].join("\n"),
    );
  });
});
