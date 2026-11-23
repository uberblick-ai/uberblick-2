import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, exportMarkdown, getBlocksWithInline, importMarkdown, initDoc, parseInline } from "../src/index.js";

function documentFrom(source: string): Y.Doc {
  const imported = importMarkdown(source);
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "66666666-6666-4666-8666-666666666666", title: imported.title });
  for (const block of imported.blocks) appendBlock(doc, block);
  return doc;
}

describe("Markdown footnotes", () => {
  it("keeps missing, shared, duplicate and unused labels and orders notes by first reference", () => {
    const source = [
      "[^Unused]: unused **note**",
      "[^SECOND]: second *note*",
      "[^First]: first `note`",
      "[^first]: duplicate note",
      "",
      "Read **this[^first][^SECOND]** then [^FIRST] and [^missing].",
    ].join("\n");
    const imported = importMarkdown(source);
    expect(imported.blocks.map((block) => [block.type, block.label, block.text])).toEqual([
      ["paragraph", undefined, "Read this[^first][^SECOND] then [^FIRST] and [^missing]."],
      ["footnote", "First", "first note"],
      ["footnote", "SECOND", "second note"],
      ["footnote", "Unused", "unused note"],
      ["footnote", "first", "duplicate note"],
    ]);
    expect(imported.blocks[0]?.inline).toEqual([
      { text: "Read ", marks: {} },
      { text: "this", marks: { bold: true } },
      { text: "[^first]", marks: { bold: true, footnoteRef: true } },
      { text: "[^SECOND]", marks: { bold: true, footnoteRef: true } },
      { text: " then ", marks: {} },
      { text: "[^FIRST]", marks: { footnoteRef: true } },
      { text: " and ", marks: {} },
      { text: "[^missing]", marks: { footnoteRef: true } },
      { text: ".", marks: {} },
    ]);
    expect(imported.blocks[1]?.inline).toEqual([
      { text: "first ", marks: {} }, { text: "note", marks: { inlineCode: true } },
    ]);
    const doc = documentFrom(source);
    const markdown = exportMarkdown(doc, { frontmatter: false });
    expect(markdown).toContain("Read **this[^first][^SECOND]** then [^FIRST] and [^missing].");
    expect(markdown).toContain("[^First]: first `note`");
    expect(importMarkdown(markdown).blocks).toEqual(imported.blocks);
    expect(getBlocksWithInline(doc)[0]?.inline.filter((run) => run.marks.footnoteRef).map((run) => run.text)).toEqual([
      "[^first]", "[^SECOND]", "[^FIRST]", "[^missing]",
    ]);
    doc.destroy();
  });

  it("starts consecutive definitions after prose and stops a preceding table", () => {
    expect(importMarkdown("Before[^a]\n[^a]: first\n[^b]: second\nAfter").blocks).toMatchObject([
      { type: "paragraph", text: "Before[^a]" },
      { type: "paragraph", text: "After" },
      { type: "footnote", label: "a", text: "first" },
      { type: "footnote", label: "b", text: "second" },
    ]);
    expect(importMarkdown("| h |\n| - |\n[^a]: note").blocks).toEqual([
      { type: "table", text: "| h |\n| - |" },
      { type: "footnote", label: "a", text: "note" },
    ]);
  });

  it.each(["1", "Case", "é", "a*b_~:!`", "a.b/c"])("preserves the label %s literally", (label) => {
    const source = `Text[^${label}]\n\n[^${label}]: note`;
    const imported = importMarkdown(source);
    expect(imported.blocks[0]?.inline).toEqual([
      { text: "Text", marks: {} }, { text: `[^${label}]`, marks: { footnoteRef: true } },
    ]);
    const doc = documentFrom(source);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(`${source}\n`);
    expect(importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks).toEqual(imported.blocks);
    doc.destroy();
  });

  it.each(["", "two words", "a[b", "a\\b"])("keeps malformed label %s literal", (label) => {
    expect(importMarkdown(`text[^${label}]\n\n[^${label}]: note`).blocks).toEqual([
      { type: "paragraph", text: `text[^${label}]` },
      { type: "paragraph", text: `[^${label}]: note` },
    ]);
  });

  it("preserves escaped and stored literal lookalikes without promoting them", () => {
    const source = "Literal \\[^one] and \\[^two]: text";
    const imported = importMarkdown(source);
    expect(imported.blocks).toEqual([{ type: "paragraph", text: "Literal [^one] and [^two]: text" }]);
    const doc = documentFrom(source);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(`${source}\n`);
    expect(importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks).toEqual(imported.blocks);
    doc.destroy();
  });

  it("keeps references before prose colons distinct from note definitions", () => {
    const doc = documentFrom("[^one]\\: prose\n\n[^one]: note");
    expect(exportMarkdown(doc, { frontmatter: false })).toBe("[^one]\\: prose\n\n[^one]: note\n");
    expect(importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks).toMatchObject([
      { type: "paragraph", text: "[^one]: prose", inline: [
        { text: "[^one]", marks: { footnoteRef: true } }, { text: ": prose", marks: {} },
      ] },
      { type: "footnote", label: "one", text: "note" },
    ]);
    doc.destroy();
  });

  it("enables references in prose but keeps code, links, note text and other inline readers literal", () => {
    for (const prefix of ["", "## ", "- ", "> ", "> [!NOTE]\n> "]) {
      expect(importMarkdown(`${prefix}[^one]`).blocks[0]?.inline).toEqual([
        { text: "[^one]", marks: { footnoteRef: true } },
      ]);
    }
    const source = "`[^one]` [literal [^one]](https://example.com) [^linked](https://other.example.com)\n\n[^note]: literal [^one] and **bold**";
    const imported = importMarkdown(source);
    expect(imported.blocks[0]?.inline).toEqual([
      { text: "[^one]", marks: { inlineCode: true } },
      { text: " ", marks: {} },
      { text: "literal [^one]", marks: { link: "https://example.com" } },
      { text: " ", marks: {} },
      { text: "^linked", marks: { link: "https://other.example.com" } },
    ]);
    expect(imported.blocks[1]?.inline).toEqual([
      { text: "literal [^one] and ", marks: {} }, { text: "bold", marks: { bold: true } },
    ]);
    expect(parseInline("[^one]")).toEqual([{ text: "[^one]", marks: {} }]);
    expect(parseInline("[^one]", true)).toEqual([{ text: "[^one]", marks: {} }]);
    const doc = documentFrom(source);
    expect(importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks).toEqual(imported.blocks);
    doc.destroy();
  });

  it.each(["", "terminal", "chart", "mermaid", "json-tree"])("leaves %s source fences literal", (language) => {
    const source = `\`\`\`${language}\n[^one]\n[^one]: note\n\`\`\``;
    const imported = importMarkdown(source);
    expect(imported.blocks).toHaveLength(1);
    expect(imported.blocks[0]?.text).toBe("[^one]\n[^one]: note");
    expect(imported.blocks[0]?.inline).toBeUndefined();
  });

  it("keeps tables, cards, Figma captions and decision answers literal", () => {
    const source = [
      "| [^one] |", "| --- |", "", ":::card", "title: Card [^one]", "", "Body [^one]", ":::", "",
      ":::figma", "url: https://www.figma.com/design/Abc123/File", "", "Caption [^one]", ":::",
    ].join("\n");
    const doc = documentFrom(source);
    const entries = getBlocksWithInline(doc);
    expect(entries.map((entry) => entry.block.type)).toEqual(["table", "card", "figma"]);
    expect(entries[0]?.table?.[0]?.[0]).toEqual([{ text: "[^one]", marks: {} }]);
    expect(exportMarkdown(doc, { frontmatter: false })).toContain("\\[^one]");
    doc.destroy();
    expect(importMarkdown("---\nkind: decision\n---\nAnswer [^one]\n\n[^one]: literal").blocks).toEqual([
      { type: "paragraph", text: "Answer [^one]" },
      { type: "paragraph", text: "[^one]: literal" },
    ]);
  });

  it("retains one paragraph of note continuation and exports misplaced notes after the body", () => {
    const doc = documentFrom("[^one]: first **line**\n    second [^literal]\n\nAfter[^one]");
    appendBlock(doc, { type: "paragraph", text: "Last body block" });
    const markdown = exportMarkdown(doc, { frontmatter: false });
    expect(markdown).toBe("After[^one]\n\nLast body block\n\n[^one]: first **line**\n    second \\[^literal]\n");
    expect(importMarkdown(markdown).blocks.at(-1)).toMatchObject({
      type: "footnote", label: "one", text: "first line\nsecond [^literal]",
    });
    doc.destroy();
  });
});
