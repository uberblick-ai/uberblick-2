import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, exportMarkdown, getBlocks, importMarkdown, initDoc } from "../src/index.js";
import type { BlockInput } from "../src/index.js";

const DIVIDER = { type: "divider", text: "" } as const;
const PARAGRAPH = { type: "paragraph", text: "Summary" } as const;

describe("Markdown dividers and setext headings", () => {
  it.each(["---", "***", "___", "- - -", "* * *", "-----", " _\t_ _ \t", "   -\t- -"])(
    "reads %j as a divider before considering list markers",
    (line) => expect(importMarkdown(line).blocks).toEqual([DIVIDER]),
  );

  it.each(["--", "**", "__", "- _ -", "    ---", "\t---", "--- text", "= = ="])(
    "does not read %j as a divider",
    (line) => expect(importMarkdown(line).blocks.some((block) => block.type === "divider")).toBe(false),
  );

  it("ends paragraphs, quotes, lists and tables at a thematic break", () => {
    expect(importMarkdown("Summary\n- - -\nDetails").blocks).toEqual([
      PARAGRAPH, DIVIDER, { type: "paragraph", text: "Details" },
    ]);
    expect(importMarkdown("> Quoted\n---\n- item\n    - nested\n***\n    - fresh").blocks).toEqual([
      { type: "quote", text: "Quoted" }, DIVIDER,
      { type: "list-item", text: "item", list: "bullet", indent: 0 },
      { type: "list-item", text: "nested", list: "bullet", indent: 1 }, DIVIDER,
      { type: "list-item", text: "fresh", list: "bullet", indent: 0 },
    ]);
    expect(importMarkdown("| Header |\n| --- |\n---\nAfter").blocks).toEqual([
      { type: "table", text: "| Header |\n| --- |" }, DIVIDER,
      { type: "paragraph", text: "After" },
    ]);
  });

  it.each(["-", "--", "---", "   -----\t"])("uses a contiguous %j underline for a level-2 heading", (underline) => {
    expect(importMarkdown(`First **line**\nsecond line\n${underline}`).blocks).toEqual([
      {
        type: "heading", text: "First line second line", level: 2,
        inline: [
          { text: "First ", marks: {} }, { text: "line", marks: { bold: true } },
          { text: " second line", marks: {} },
        ],
      },
    ]);
  });

  it("uses only a leading level-1 heading as a title and lets frontmatter override it", () => {
    expect(importMarkdown("First line\nsecond line\n===\n\nBody")).toEqual({
      title: "First line second line", tags: [], blocks: [{ type: "paragraph", text: "Body" }],
    });
    expect(importMarkdown("---\ntitle: Metadata\n---\nHeading\n=\n\nBody")).toEqual({
      title: "Metadata", tags: [], blocks: [
        { type: "heading", text: "Heading", level: 1 }, { type: "paragraph", text: "Body" },
      ],
    });
    expect(importMarkdown("Intro\n\nHeading\n===").blocks).toEqual([
      { type: "paragraph", text: "Intro" }, { type: "heading", text: "Heading", level: 1 },
    ]);
  });

  it("keeps a separated underline a divider and leaves headings within flat quotes and lists alone", () => {
    expect(importMarkdown("Summary\n\n---\n## Section\n---\n- item\n---\n> Quote\n---").blocks).toEqual([
      PARAGRAPH, DIVIDER, { type: "heading", text: "Section", level: 2 }, DIVIDER,
      { type: "list-item", text: "item", list: "bullet", indent: 0 }, DIVIDER,
      { type: "quote", text: "Quote" }, DIVIDER,
    ]);
    expect(importMarkdown("> Heading\n> ---\n\n- Heading\n  ===").blocks).toEqual([
      { type: "quote", text: "Heading\n---" },
      { type: "list-item", text: "Heading", list: "bullet", indent: 0 },
      { type: "paragraph", text: "  ===" },
    ]);
    expect(importMarkdown("Summary\n \t \n---").blocks).toEqual([PARAGRAPH, DIVIDER]);
  });
});

describe("leading frontmatter recognition", () => {
  it("accepts known and unknown keys, blank lines and both block-list indentations", () => {
    expect(importMarkdown("---\ntitle: Example\n\ntags:\n- alpha\n  - beta\nunknown:\n- ignored\nlinks:\n  - linked\n---\nBody")).toEqual({
      title: "Example", tags: ["alpha", "beta"], links: ["linked"],
      blocks: [{ type: "paragraph", text: "Body" }],
    });
  });

  it.each([
    "---\n\nStatus: done\n\n---",
    "---\nFirst section\n\n---",
    "---\ntitle: Candidate\n# Body heading\n---",
    "---\ntitle: Candidate\n# YAML comment\n---",
    "---\n- orphan list\n---",
    "---\ntitle: Unclosed",
  ])("preserves a leading divider and all subsequent body for %j", (source) => {
    const imported = importMarkdown(source);
    expect(imported.title).toBe("");
    expect(imported.blocks[0]).toEqual(DIVIDER);
    expect(imported.blocks).toEqual(importMarkdown(`Body sentinel\n\n${source}`).blocks.slice(1));
  });

  it.each(["welcome-to-uberblick.md", "how-to-use-it.md"])("keeps the %s starter template's frontmatter", (name) => {
    const source = readFileSync(new URL(`../../cli/templates/${name}`, import.meta.url), "utf8");
    const imported = importMarkdown(source);
    expect(imported.blocks[0]?.type).not.toBe("divider");
    expect(imported.links).toBeDefined();
  });
});

describe("divider Markdown export", () => {
  it("puts a blank line on both sides, including document boundaries and consecutive dividers", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: "88888888-8888-4888-8888-888888888888", title: "Example" });
    appendBlock(doc, DIVIDER);
    appendBlock(doc, DIVIDER);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe("\n---\n\n---\n\n");
    doc.destroy();
  });

  it.each([true, false])("round-trips divider placement with frontmatter=%s", (frontmatter) => {
    const neighbors: BlockInput[] = [
      { type: "table", text: "| Header |\n| --- |\n| Value |" },
      { type: "list-item", text: "Item", list: "bullet" },
      { type: "quote", text: "Quoted" },
      { type: "callout", text: "Notice", variant: "note" },
      { type: "card", text: "title: Card" },
    ];
    const cases: BlockInput[][] = [
      [PARAGRAPH, DIVIDER, { type: "paragraph", text: "Details" }],
      [DIVIDER, PARAGRAPH], [PARAGRAPH, DIVIDER], [DIVIDER, DIVIDER],
      [DIVIDER, { type: "paragraph", text: "Status: done" }, DIVIDER],
      ...neighbors.map((neighbor) => [DIVIDER, neighbor, DIVIDER]),
      [{ type: "paragraph", text: "---" }], [{ type: "paragraph", text: "- - -" }],
      ...["---", "--", "- -"].map((text): BlockInput[] => [{ type: "list-item", text, list: "bullet" }]),
      ...["---", "--", "==="].map((text): BlockInput[] => [{ type: "paragraph", text: `Title\n${text}` }]),
    ];
    for (const blocks of cases) {
      const doc = new Y.Doc();
      initDoc(doc, { uuid: "88888888-8888-4888-8888-888888888888", title: "Example" });
      for (const block of blocks) appendBlock(doc, block);
      const exported = exportMarkdown(doc, { frontmatter });
      const reimported = importMarkdown(exported);
      expect(reimported.blocks, exported).toEqual(getBlocks(doc).map(({ id: _id, rev: _rev, columnWidths: _widths, ...block }) => block));
      doc.destroy();
    }
  });

  it("escapes block-level hyphen and equals ambiguities while keeping their text", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: "88888888-8888-4888-8888-888888888888", title: "Example" });
    for (const block of [
      { type: "paragraph", text: "---" },
      { type: "paragraph", text: "Title\n--\n===" },
      { type: "list-item", text: "--", list: "bullet" },
    ] as const) appendBlock(doc, block);
    const exported = exportMarkdown(doc, { frontmatter: false });
    expect(exported).toBe("\\---\n\nTitle\n\\--\n\\===\n\n- \\--\n");
    expect(importMarkdown(exported).blocks).toEqual([
      { type: "paragraph", text: "---" }, { type: "paragraph", text: "Title\n--\n===" },
      { type: "list-item", text: "--", list: "bullet", indent: 0 },
    ]);
    doc.destroy();
  });
});
