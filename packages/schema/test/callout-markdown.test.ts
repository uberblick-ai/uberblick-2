import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  appendBlock, CALLOUT_VARIANTS, exportMarkdown, getBlocksWithInline,
  importMarkdown, initDoc,
} from "../src/index.js";
import { INLINE_ICONS } from "../src/inline-icons.js";
import type { BlockInput, InlineRun } from "../src/types.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function document(blocks: readonly BlockInput[]): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Callouts" });
  for (const block of blocks) appendBlock(doc, block);
  return doc;
}

function content(doc: Y.Doc): unknown[] {
  return getBlocksWithInline(doc).map(({ block, inline }) => ({
    type: block.type, variant: block.variant, icon: block.icon,
    text: block.text, inline,
  }));
}

describe("callout Markdown", () => {
  it.each(CALLOUT_VARIANTS)("round-trips %s with every icon kind, newlines, marks and links", (variant) => {
    const inline: InlineRun[] = [
      { text: "First ", marks: {} },
      { text: "bold", marks: { bold: true } },
      { text: " and ", marks: {} },
      { text: "italic", marks: { italic: true } },
      { text: "\n", marks: {} },
      { text: "struck", marks: { strike: true } },
      { text: " and code", marks: { inlineCode: true } },
      { text: "\n\n", marks: {} },
      { text: "website", marks: { link: "https://example.test/help" } },
      { text: " and ", marks: {} },
      { text: "document", marks: { docLink: TARGET } },
      { text: "\n", marks: {} },
    ];
    const icons = [undefined, "🚀", "⏱️", ...Object.keys(INLINE_ICONS).map((name) => `:${name}:`)];
    const doc = document(icons.map((icon) => ({
      type: "callout", variant, ...(icon === undefined ? {} : { icon }), inline,
    })));
    const markdown = exportMarkdown(doc, { frontmatter: false });
    expect(markdown.match(new RegExp(`^> \\[!${variant.toUpperCase()}\\]$`, "gm"))).toHaveLength(icons.length);
    expect(markdown).toContain(">\n> [website](https://example.test/help)");
    expect(markdown).toContain("> <!-- icon: ⏱️ -->");
    const copy = document(importMarkdown(markdown).blocks);
    expect(content(copy)).toEqual(content(doc));
    copy.destroy();
    doc.destroy();
  });

  it.each(CALLOUT_VARIANTS)("reads an exact %s marker in any letter case", (variant) => {
    for (const name of [variant, variant.toUpperCase(), `${variant[0]?.toUpperCase()}${variant.slice(1)}`]) {
      expect(importMarkdown(`> [!${name}]\n> Body\n>\n> More.`).blocks).toEqual([
        { type: "callout", variant, text: "Body\n\nMore." },
      ]);
    }
  });

  it.each([
    "[!INFO]", "[!DANGER]", "[!NOTE] Title", "[!NOTE]-", "[!NOTE]+",
    "> [!NOTE]",
  ])("keeps a non-marker quote unchanged: %s", (first) => {
    const text = `${first}\nsecond line`;
    expect(importMarkdown(`> ${first}\n> second line`).blocks).toEqual([{ type: "quote", text }]);
    const doc = document([{ type: "quote", text }]);
    const copy = document(importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks);
    expect(content(copy)).toEqual(content(doc));
    copy.destroy();
    doc.destroy();
  });

  it.each(["[!NOTE] ", " [!NOTE]"])("requires a marker to occupy the complete first line: %s", (text) => {
    expect(importMarkdown(`> ${text}`).blocks).toEqual([{ type: "quote", text }]);
  });

  it.each(CALLOUT_VARIANTS)("escapes an ordinary quote starting with a %s marker", (variant) => {
    for (const name of [variant, variant.toUpperCase(), `${variant[0]?.toUpperCase()}${variant.slice(1)}`]) {
      const text = `[!${name}]\nStill a quote.`;
      const doc = document([{ type: "quote", text }]);
      const markdown = exportMarkdown(doc, { frontmatter: false });
      expect(markdown).toBe(`> \\[!${name}]\n> Still a quote.\n`);
      expect(importMarkdown(markdown).blocks).toEqual([{ type: "quote", text }]);
      doc.destroy();
    }
  });

  it("recognizes only an exact icon comment immediately after the marker", () => {
    expect(importMarkdown("> [!TIP]\n> <!-- icon: 🚀 -->\n> Body\n> <!-- icon: :codex: -->").blocks).toEqual([
      { type: "callout", variant: "tip", icon: "🚀", text: "Body\n<!-- icon: :codex: -->" },
    ]);
    for (const value of ["x", "1", "🚀🚀", ":unknown:", ""]) {
      expect(importMarkdown(`> [!NOTE]\n> <!-- icon: ${value} -->\n> Body`).blocks).toEqual([
        { type: "callout", variant: "note", text: "Body" },
      ]);
    }
    for (const line of ["<!-- icon:🚀 -->", "<!-- icon: 🚀-->", "<!-- Icon: 🚀 -->", " <!-- icon: 🚀 -->", "<!-- icon: 🚀 --> trailing"]) {
      expect(importMarkdown(`> [!NOTE]\n> ${line}`).blocks).toEqual([
        { type: "callout", variant: "note", text: line },
      ]);
    }
  });

  it.each([undefined, "🚀"])("protects first-line body comments with icon %s", (icon) => {
    const texts = [
      "<!-- icon: :claude: -->\nBody", "<!-- icon: invalid -->", "<!-- icon: incomplete",
      "\\<!-- icon: 🚀 -->", "<!-- ordinary comment -->\n<!-- icon: 🚀 -->",
    ];
    const doc = document(texts.map((text) => ({
      type: "callout", variant: "tip", ...(icon === undefined ? {} : { icon }), text,
    })));
    const markdown = exportMarkdown(doc, { frontmatter: false });
    expect(markdown).toContain("> \\<!-- icon: :claude: -->");
    const copy = document(importMarkdown(markdown).blocks);
    expect(content(copy)).toEqual(content(doc));
    copy.destroy();
    doc.destroy();
  });

  it("retains marked comments, literal escapes and nested quote text through CRLF Markdown", () => {
    const doc = document([
      { type: "callout", inline: [{ text: "<!-- icon: 🚀 -->", marks: { bold: true } }] },
      { type: "callout", icon: ":codex:", inline: [
        { text: "<!-- icon: ", marks: {} },
        { text: ":claude:", marks: { inlineCode: true } },
        { text: " -->\nAfter the comment.", marks: {} },
      ] },
      { type: "callout", text: "\\<!-- icon: 🚀 -->\n\\\\<!-- icon: :codex: -->\n> [!NOTE]\n# Heading\n- item\nTail  " },
      { type: "quote", inline: [{ text: "[!note]", marks: { italic: true } }] },
      { type: "quote", text: "> [!TIP]\n> nested" },
    ]);
    const markdown = exportMarkdown(doc, { frontmatter: false }).replace(/\n/g, "\r\n");
    const copy = document(importMarkdown(markdown).blocks);
    expect(content(copy)).toEqual(content(doc));
    expect(importMarkdown("   > > [!NOTE]\r\n   > literal").blocks).toEqual([
      { type: "quote", text: "> [!NOTE]\nliteral" },
    ]);
    copy.destroy();
    doc.destroy();
  });

  it("exports empty body lines as bare quote markers and retains an empty callout", () => {
    const doc = document([
      { type: "callout", text: "" },
      { type: "callout", variant: "warning", text: "First\n\nLast" },
    ]);
    const markdown = exportMarkdown(doc, { frontmatter: false });
    expect(markdown).toBe("> [!NOTE]\n>\n\n> [!WARNING]\n> First\n>\n> Last\n");
    const copy = document(importMarkdown(markdown).blocks);
    expect(content(copy)).toEqual(content(doc));
    copy.destroy();
    doc.destroy();
  });
});
