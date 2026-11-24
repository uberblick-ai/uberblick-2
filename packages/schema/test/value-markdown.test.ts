import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, editBlock, exportMarkdown, findBlockElement, getBlockInline, getBlocksWithInline, importMarkdown, initDoc, isSupportedTable, tableCellText, tableRows, writeGfmTable } from "../src/index.js";
import { renderInline } from "../src/markdown.js";

const source = `:value${JSON.stringify({ collection: "results", filter: { system: '*_[]`\\[^note] https://example.com and <https://other.example.com> | \\| } "' }, field: "wer", format: "number", decimals: 1 })}`;

function documentFrom(markdown: string): Y.Doc {
  const imported = importMarkdown(markdown);
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "66666666-6666-4666-8666-666666666666", title: imported.title });
  for (const block of imported.blocks) appendBlock(doc, block);
  return doc;
}

describe("Markdown inline data values", () => {
  it.each(["", "## ", "- ", "> ", "> [!NOTE]\n> "])("preserves source bytes and surrounding formatting in %s prose", (prefix) => {
    const markdown = `${prefix}Before **${source}** after.\n`;
    const imported = importMarkdown(markdown);
    expect(imported.blocks[0]?.text).toBe(`Before ${source} after.`);
    expect(imported.blocks[0]?.inline).toEqual([
      { text: "Before ", marks: {} }, { text: source, marks: { bold: true } }, { text: " after.", marks: {} },
    ]);
    const doc = documentFrom(markdown);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(markdown);
    expect(importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks).toEqual(imported.blocks);
    doc.destroy();
  });

  it("preserves source in ordinary tables with only GFM pipe escaping", () => {
    const markdown = writeGfmTable([["Value"], [`Before ${source} after.`]]);
    const doc = documentFrom(markdown);
    expect(getBlocksWithInline(doc)[0]?.table?.[1]?.[0]).toEqual([{ text: `Before ${source} after.`, marks: {} }]);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(`${markdown}\n`);
    const reread = documentFrom(exportMarkdown(doc, { frontmatter: false }));
    expect(getBlocksWithInline(reread)[0]?.table).toEqual(getBlocksWithInline(doc)[0]?.table);
    reread.destroy();
    doc.destroy();
  });

  it("keeps balanced unreadable sources intact for their web marker", () => {
    for (const invalid of [":value{}", `:value${JSON.stringify({ unknown: '*_[^note]`\\' })}`, ":value{broken}"]) {
      const doc = documentFrom(`Before ${invalid} after.`);
      expect(getBlocksWithInline(doc)[0]?.block.text).toBe(`Before ${invalid} after.`);
      expect(exportMarkdown(doc, { frontmatter: false })).toBe(`Before ${invalid} after.\n`);
      doc.destroy();
    }
  });

  it("MCP-style text edits never turn punctuation inside a source into footnotes or addresses", () => {
    const doc = documentFrom("Before");
    const id = getBlocksWithInline(doc)[0]!.block.id;
    editBlock(doc, id, "Before", `Before ${source} after.`, { autolink: true });
    expect(getBlockInline(doc, id)).toEqual([{ text: `Before ${source} after.`, marks: {} }]);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(`Before ${source} after.\n`);
    doc.destroy();
  });

  it("keeps source bytes contiguous across stored marks and still recognizes syntax after it", () => {
    const divided = [
      { text: `Before ${source.slice(0, 30)}`, marks: {} },
      { text: source.slice(30, 60), marks: { bold: true } },
      { text: `${source.slice(60)} after.`, marks: {} },
    ];
    expect(renderInline(divided, false, true)).toBe(`Before ${source} after.`);
    const imported = importMarkdown(`${source} https://after.example.com [^outside]\n\n[^outside]: note`);
    expect(imported.blocks[0]?.inline).toEqual([
      { text: `${source} `, marks: {} },
      { text: "https://after.example.com", marks: { link: "https://after.example.com" } },
      { text: " ", marks: {} }, { text: "[^outside]", marks: { footnoteRef: true } },
    ]);
    expect(importMarkdown(`\\${source}`).blocks[0]).toEqual({ type: "paragraph", text: source });
  });

  it("keeps inline code and link labels under the ordinary Markdown rules", () => {
    const plain = ':value{"collection":"results","filter":{"system":"x"},"field":"wer"}';
    const code = importMarkdown(`\`${plain}\``).blocks[0];
    expect(code?.inline).toEqual([{ text: plain, marks: { inlineCode: true } }]);
    const linked = importMarkdown(`[${plain}](https://example.com)`).blocks[0];
    expect(linked?.inline).toEqual([{ text: plain, marks: { link: "https://example.com" } }]);
    expect(importMarkdown("`:value{` then [^outside] https://outside.example.com").blocks[0]?.inline).toEqual([
      { text: ":value{", marks: { inlineCode: true } }, { text: " then ", marks: {} },
      { text: "[^outside]", marks: { footnoteRef: true } }, { text: " ", marks: {} },
      { text: "https://outside.example.com", marks: { link: "https://outside.example.com" } },
    ]);
  });

  it.each(["\n", "\r\n", "\r"])("retains JSON whitespace %j in every prose type that admits newlines", (ending) => {
    const multiline = ':value{\n  "collection": "results",\n\n  "filter": {"system": "*_[]`\\\\ and \uE000value-newline\uE001"},\n  "field": "wer"\n}'.replaceAll("\n", ending);
    for (const type of ["paragraph", "heading", "list-item", "quote", "callout"] as const) {
      const doc = new Y.Doc();
      initDoc(doc, { uuid: "66666666-6666-4666-8666-666666666666", title: "Values" });
      appendBlock(doc, { type, text: `Before ${multiline} after.`, ...(type === "heading" ? { level: 2 } : {}) });
      const markdown = exportMarkdown(doc, { frontmatter: false });
      expect(markdown).toContain(multiline);
      expect(importMarkdown(markdown).blocks).toMatchObject([{ type, text: `Before ${multiline} after.` }]);
      doc.destroy();
    }
  });

  it("leaves source-block and excluded container line handling unchanged", () => {
    const multiline = ':value{\n\n  "unknown": "*literal*"\n}';
    const code = `\`\`\`text\n${multiline}\n\`\`\``;
    expect(importMarkdown(code).blocks).toEqual([{ type: "code", language: "text", text: multiline }]);
    const markdown = `:::card\ntitle: Title\n\n${multiline}\n:::\n\n[^note]: ${multiline}`;
    const before = importMarkdown(markdown);
    expect(before.blocks[0]?.type).toBe("card");
    expect(before.blocks.filter((block) => block.type === "footnote")).toMatchObject([{ text: ":value{" }]);
    expect(importMarkdown(`---\nkind: decision\n---\n## Before ${multiline}`).blocks).toMatchObject([
      { type: "heading", text: "Before :value{" }, { type: "paragraph", text: '  "unknown": "literal"\n}' },
    ]);
    expect(importMarkdown(multiline).blocks).toEqual([{ type: "paragraph", text: multiline }]);
  });

  it("retains the existing ordinary-table grammar that excludes stored newlines", () => {
    const doc = documentFrom("| Value |\n| --- |\n| stored |");
    const element = findBlockElement(doc, getBlocksWithInline(doc)[0]!.block.id)!;
    const cell = tableRows(element)[1]![0]!;
    const text = tableCellText(cell)!;
    text.delete(0, text.length);
    text.insert(0, ':value{\n"collection":"results","filter":{"system":"x"},"field":"wer"}');
    expect(isSupportedTable(element)).toBe(false);
    doc.destroy();
  });
});
