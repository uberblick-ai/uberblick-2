import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, cardButtons, decisionApprovalFingerprint, exportMarkdown, findBlockElement,
  getBlocks, getBlocksWithInline, importMarkdown, initDoc, parseInline,
} from "../src/index.js";
import type { BlockInput } from "../src/index.js";

const UUID = "66666666-6666-4666-8666-666666666666";
const SOURCE = ":claude: :codex: :github: :future-icon: :rocket: 10:30:15 note:this:";
const CARD = `label: :claude:\ntitle: :codex:\nfooter: :github:\nbutton: [:claude: Discuss with Claude](claude://code/new?prompt=Review)\n\n${SOURCE}`;
const FIGMA = `url: https://www.figma.com/design/key\n\n${SOURCE}`;
const docs: Y.Doc[] = [];

function document(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Inline source" });
  docs.push(doc);
  return doc;
}

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

it("round-trips icon source as ordinary text in every prose and source container", () => {
  const doc = document();
  const inputs: BlockInput[] = [
    { type: "paragraph", text: SOURCE },
    { type: "heading", text: SOURCE, level: 2 },
    { type: "list-item", text: SOURCE, list: "bullet", indent: 0 },
    { type: "quote", text: SOURCE },
    { type: "table", text: `| :claude: |\n| --- |\n| ${SOURCE} |` },
    { type: "card", text: CARD },
    { type: "figma", text: FIGMA },
    { type: "paragraph", text: ":codex:", inline: [{ text: ":codex:", marks: { inlineCode: true } }] },
    ...(["code", "terminal", "chart"] as const).map(type => ({ type, text: SOURCE })),
  ];
  for (const input of inputs) appendBlock(doc, input);
  const before = Y.encodeStateAsUpdate(doc);
  const approval = decisionApprovalFingerprint(doc);
  const markdown = exportMarkdown(doc, { frontmatter: false });
  expect(markdown).toContain(SOURCE);
  expect(markdown).toContain(CARD);
  expect(markdown).toContain("`:codex:`");
  expect(markdown).not.toContain("<svg");

  const copy = document();
  for (const block of importMarkdown(markdown).blocks) appendBlock(copy, block);
  const content = (value: Y.Doc) => getBlocksWithInline(value).map(({ block, ...rest }) => ({
    block: { ...block, id: undefined }, ...rest,
  }));
  expect(content(copy)).toEqual(content(doc));
  expect(decisionApprovalFingerprint(copy)).toBe(approval);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

  const card = getBlocks(doc).find(block => block.type === "card")!;
  expect(cardButtons(findBlockElement(doc, card.id)!)).toEqual([
    { text: ":claude: Discuss with Claude", href: "claude://code/new?prompt=Review" },
  ]);
});

it("preserves icon source in inline runs and counts its literal spelling in approval", () => {
  expect(parseInline(SOURCE)).toEqual([{ text: SOURCE, marks: {} }]);
  expect(parseInline("`:claude:` [:github:](https://github.com)")).toEqual([
    { text: ":claude:", marks: { inlineCode: true } },
    { text: " ", marks: {} },
    { text: ":github:", marks: { link: "https://github.com" } },
  ]);
  const doc = document();
  appendBlock(doc, { type: "paragraph", text: ":claude:" });
  const copy = document();
  appendBlock(copy, { type: "paragraph", text: "Claude" });
  expect(decisionApprovalFingerprint(doc)).not.toBe(decisionApprovalFingerprint(copy));
});
