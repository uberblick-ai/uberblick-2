import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  appendBlock, exportMarkdown, figmaInline, findBlockElement, getBlocks,
  importMarkdown, initDoc,
} from "../src/index.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const URL = "https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345";

function imported(source: string): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Design references" });
  for (const block of importMarkdown(source).blocks) appendBlock(doc, block);
  return doc;
}

describe("Figma Markdown containers", () => {
  it("round-trips adjacent Figma and card containers, caption marks and delimiter text", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Design references" });
    const id = appendBlock(doc, {
      type: "figma",
      text: `height: 560\ntitle: **Literal**, mobile\nurl: ${URL}&t=tracking#discard\n\nA **bold** *caption* with ~~strike~~, \`code\`, [web](https://example.test) and [doc](${TARGET}).\n:::figma\n:::\n\\\\::: literal`,
    });
    appendBlock(doc, { type: "figma", text: "url: https://figma.com/board/boardKey\n\n" });
    appendBlock(doc, { type: "card", text: "title: **Card**\n\nA separate card." });
    const prose = ":::figma\n:::card\n:::\n\\::: literal";
    appendBlock(doc, { type: "paragraph", text: prose });

    const markdown = exportMarkdown(doc, { frontmatter: false });
    expect(markdown).toContain(`:::figma\nurl: ${URL}\ntitle: **Literal**, mobile\nheight: 560\n\n`);
    expect(markdown).toContain("\\:::figma\n\\:::");
    expect(markdown).not.toContain("tracking");
    const copy = imported(markdown);
    const blocks = getBlocks(copy);
    expect(blocks.map(({ type }) => type)).toEqual(["figma", "figma", "card", "paragraph"]);
    expect(blocks.map(({ text }) => text)).toEqual(getBlocks(doc).map(({ text }) => text));
    expect(figmaInline(findBlockElement(copy, blocks[0]!.id)!)).toEqual(figmaInline(findBlockElement(doc, id)!));
    expect(blocks[3]!.text).toBe(prose);
  });

  it.each([
    ":::figma\ntitle: Missing URL\n\n**literal**\n:::",
    ":::figma\nurl: https://example.test/design/key\n\n# heading\n<!-- retained -->\n```\n:::",
    `:::figma\nurl: ${URL}\nurl: ${URL}\n\nCaption\n:::`,
    `:::figma\nurl: ${URL}\nunknown: value\n\nCaption\n:::`,
    `:::figma\nurl: ${URL}\nheight: 239\n\nCaption\n:::`,
    `:::figma\nurl: ${URL}\nnot a key\n\nCaption\n:::`,
    `:::figma\nurl: ${URL}\n\nUnclosed **literal**`,
  ])("preserves every invalid or unclosed container as literal prose: %s", (source) => {
    expect(importMarkdown(source).blocks).toEqual([
      { type: "paragraph", text: source, inline: [{ text: source, marks: {} }] },
    ]);
    const doc = imported(source);
    expect(getBlocks(doc).map(({ text }) => text)).toEqual([source]);
  });

  it("requires exact delimiter lines and stops a preceding one-column table", () => {
    expect(importMarkdown(` :::figma\nurl: ${URL}\n:::`).blocks[0]!.type).toBe("paragraph");
    expect(importMarkdown(`:::figma \nurl: ${URL}\n:::`).blocks[0]!.type).toBe("paragraph");
    const source = `| Design |\n| --- |\n:::figma\nurl: ${URL}\n\nCaption\n:::`;
    expect(importMarkdown(source).blocks.map(({ type }) => type)).toEqual(["table", "figma"]);
  });

  it("keeps figma source fences as literal code", () => {
    const source = `:::figma\nurl: ${URL}\n\nCaption\n:::`;
    expect(importMarkdown(`\`\`\`figma\n${source}\n\`\`\``).blocks).toEqual([
      { type: "code", language: "figma", text: source },
    ]);
  });
});
