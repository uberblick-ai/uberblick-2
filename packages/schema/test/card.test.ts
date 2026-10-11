import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  CARD_PARTS, CardAnnotationError, CardConversionError, InvalidCardError,
  InlineLinkRangeError, OldTextMismatchError, StaleBlockError,
  appendBlock, buildCardElement, cardInline, cardPartElement, cardPartTexts,
  createAnnotation, decisionApprovalFingerprint, deleteAnnotation, editBlock,
  exportMarkdown, findBlockElement, getBlock, getBlocks, getBlocksFragment,
  getBlockText, importMarkdown, initDoc, insertBlock, isSupportedCard,
  listAnnotationRanges, parseCardInput, parseInline, resolveAnnotationRange,
  setAnnotationResolved, setBlockType, setInlineLink,
  type CardPart,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE = "label: A lever\ntitle: A useful title\nfooter: Metadata\n\nThe body text.";

function fixture(source = SOURCE): { doc: Y.Doc; id: string; card: Y.XmlElement } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Cards" });
  const id = appendBlock(doc, { type: "card", text: source });
  return { doc, id, card: findBlockElement(doc, id)! };
}

function partText(card: Y.XmlElement, part: CardPart): Y.XmlText {
  return cardPartTexts(card, part)[0]!;
}

function imported(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Copy" });
  for (const block of importMarkdown(markdown).blocks) appendBlock(doc, block);
  return doc;
}

describe("card block contract", () => {
  it("writes the fixed supported shape and canonical marked part order", () => {
    const source = `footer: [target](${TARGET})\ntitle: **Title** and *emphasis*\nlabel: "Literal quotes"\n\nA ~~struck~~ body with \`code\` and [web](https://example.test).`;
    const { doc, id, card } = fixture(source);
    expect(isSupportedCard(card)).toBe(true);
    expect(card.toArray().map((part) => (part as Y.XmlElement).nodeName)).toEqual(["cardLabel", "cardTitle", "cardBody", "cardFooter"]);
    expect(getBlockText(doc, id)).toBe(`label: "Literal quotes"\ntitle: **Title** and *emphasis*\nfooter: [target](${TARGET})\n\nA ~~struck~~ body with \`code\` and [web](https://example.test).`);
    expect(cardInline(card).footer).toEqual([{ text: "target", marks: { docLink: TARGET } }]);
    const before = getBlock(doc, id)!.rev;
    partText(card, "label").format(0, 7, { bold: {} });
    expect(getBlock(doc, id)!.rev).not.toBe(before);
  });

  it("refuses invalid writes, source conversions and block offsets before writing", () => {
    const { doc, id } = fixture();
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    for (const source of ["", "label: only", "title:", "title:   ", "Title: wrong", "title: title\nunknown: key", "title: title\ntitle: again", "title: title\nnot a key"] ) {
      expect(() => insertBlock(doc, id, { type: "card", text: source })).toThrow(InvalidCardError);
      expect(() => editBlock(doc, id, SOURCE, source)).toThrow(InvalidCardError);
    }
    expect(() => createAnnotation(doc, id, 0, 2, "Reader", "question")).toThrow(CardAnnotationError);
    expect(() => setInlineLink(doc, id, { start: 0, end: 2 }, TARGET)).toThrow(InlineLinkRangeError);
    expect(() => setBlockType(doc, id, "paragraph")).toThrow(CardConversionError);
    expect(() => setBlockType(doc, id, "card")).not.toThrow();
    expect(updates).toBe(0);
    expect(getBlocks(doc)).toHaveLength(1);
  });

  it("retains stale assertions ahead of parsing and leaves invalid stored shapes untouched", () => {
    const { doc, id, card } = fixture();
    const rev = getBlock(doc, id)!.rev;
    expect(() => editBlock(doc, id, SOURCE, "invalid", { rev: "stale" })).toThrow(StaleBlockError);
    expect(() => editBlock(doc, id, "wrong", "invalid", { rev })).toThrow(OldTextMismatchError);
    card.setAttribute("future", "shape");
    expect(isSupportedCard(card)).toBe(false);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => editBlock(doc, id, getBlockText(doc, id), SOURCE.replace("body", "content"))).toThrow(InvalidCardError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("changes only requested parts and characters, preserving marks and comment anchors", () => {
    const { doc, id, card } = fixture(SOURCE.replace("A useful title", "**A useful title**"));
    const title = partText(card, "title");
    const footer = partText(card, "footer");
    const titleThread = createAnnotation(doc, id, 2, 8, "Reader", "title?", { part: "title" });
    const footerThread = createAnnotation(doc, id, 0, 8, "Reader", "footer?", { part: "footer" });
    const footerDelta = footer.toDelta();
    const before = getBlockText(doc, id);
    editBlock(doc, id, before, before.replace("title**", "title extended**").replace("body text", "body prose"));
    expect(partText(card, "title")).toBe(title);
    expect(partText(card, "footer")).toBe(footer);
    expect(footer.toDelta()).toEqual(footerDelta);
    expect(resolveAnnotationRange(doc, titleThread.id)).toEqual({ part: "title", start: 2, end: 8, collapsed: false });
    expect(resolveAnnotationRange(doc, footerThread.id)).toEqual({ part: "footer", start: 0, end: 8, collapsed: false });
    expect(cardInline(card).title).toEqual([{ text: "A useful title extended", marks: { bold: true } }]);
  });

  it("keeps approval content unchanged across formatting and thread operations in every part", () => {
    const { doc, id, card } = fixture();
    const approval = decisionApprovalFingerprint(doc);
    for (const part of CARD_PARTS) {
      const text = partText(card, part);
      text.format(0, text.length, { italic: {}, docLink: { docId: TARGET } });
      const thread = createAnnotation(doc, id, 0, 1, "Reader", "question", { part });
      expect(listAnnotationRanges(doc, id).some((range) => range.threadId === thread.id && range.part === part)).toBe(true);
      setAnnotationResolved(doc, thread.id, true);
      setAnnotationResolved(doc, thread.id, false);
      expect(decisionApprovalFingerprint(doc)).toBe(approval);
      deleteAnnotation(doc, thread.id);
      expect(decisionApprovalFingerprint(doc)).toBe(approval);
    }
  });

  it("round-trips separate containers, inline marks, delimiter escapes and literal backslashes", () => {
    const { doc, id, card } = fixture(`title: **First**\n\n:::card\n:::\n\\\\::: literal\n[doc](${TARGET})`);
    appendBlock(doc, { type: "card", text: "title: Second\n\n*Another* body" });
    const prose = ":::card\n:::figma\n:::\n\\:::";
    appendBlock(doc, { type: "paragraph", text: prose });
    const markdown = exportMarkdown(doc, { frontmatter: false });
    expect(markdown).toContain("\\:::card\n\\:::");
    const copy = imported(markdown);
    expect(getBlocks(copy).map(({ type }) => type)).toEqual(["card", "card", "paragraph"]);
    expect(getBlocks(copy).map(({ text }) => text)).toEqual(getBlocks(doc).map(({ text }) => text));
    expect(cardInline(findBlockElement(copy, getBlocks(copy)[0]!.id)!)).toEqual(cardInline(card));
    expect(getBlockText(copy, getBlocks(copy)[2]!.id)).toBe(prose);
    expect(getBlockText(doc, id)).toContain("\\:::");
  });

  it.each([
    ":::card\nlabel: Missing title\n\nBody\n:::",
    ":::card\ntitle: A\nunknown: Key\n\n# heading\n<!-- retained -->\n```\n:::",
    ":::card\ntitle: A\ntitle: B\n\nBody\n:::",
    ":::card\n# not a key\n\nBody\n:::",
    ":::card\ntitle: Unclosed\n\nBody",
  ])("imports invalid containers as literal paragraphs without losing syntax: %s", (source) => {
    const blocks = importMarkdown(source).blocks;
    expect(blocks).toEqual([{ type: "paragraph", text: source, inline: [{ text: source, marks: {} }] }]);
  });

  it("requires line-exact delimiters and does not absorb a following card into a table", () => {
    expect(importMarkdown(" :::card\ntitle: prose\n:::").blocks[0]!.type).toBe("paragraph");
    expect(importMarkdown(":::card \ntitle: prose\n:::").blocks[0]!.type).toBe("paragraph");
    expect(importMarkdown("| H |\n| - |\n:::card\ntitle: Card\n\nBody\n:::").blocks.map(({ type }) => type)).toEqual(["table", "card"]);
  });

  it("folds header newlines, omits empty parts, and lets MCP repair an editor-empty title", () => {
    const { doc, id, card } = fixture();
    const title = partText(card, "title");
    title.delete(0, title.length);
    title.insert(0, "Hello\nthere");
    const footerThread = createAnnotation(doc, id, 0, 8, "Reader", "footer?", { part: "footer" });
    expect(parseCardInput(getBlockText(doc, id)).title).toBe("Hello there");
    const before = getBlockText(doc, id);
    editBlock(doc, id, before, before.replace("Hello there", "Hello there changed"));
    expect((partText(card, "title").toDelta() as Array<{ insert?: unknown }>).some((op) => typeof op.insert === "string" && op.insert.includes("\n"))).toBe(true);
    expect(cardInline(card).title).toEqual([{ text: "Hello\nthere changed", marks: {} }]);
    expect(resolveAnnotationRange(doc, footerThread.id)).toEqual({ part: "footer", start: 0, end: 8, collapsed: false });
    title.insert(6, "\n");
    const twoNewlines = getBlockText(doc, id);
    expect(parseCardInput(twoNewlines).title).toBe("Hello  there changed");
    editBlock(doc, id, twoNewlines, twoNewlines.replace("there changed", "there changed again"));
    expect(cardInline(card).title).toEqual([{ text: "Hello\n\nthere changed again", marks: {} }]);
    title.delete(0, title.length);
    const empty = getBlockText(doc, id);
    expect(empty).not.toContain("title:");
    expect(() => editBlock(doc, id, empty, empty)).toThrow(InvalidCardError);
    editBlock(doc, id, empty, empty.replace("label: A lever", "label: A lever\ntitle: Repaired"));
    expect(cardInline(card).title).toEqual([{ text: "Repaired", marks: {} }]);
    expect(importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks[0]!.type).toBe("card");
  });

  it("retains independent concurrent edits and first writes into seeded empty parts", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Cards" });
      id = appendBlock(doc, { type: "card", text: "title: Original\n\n" });
    });
    const cardA = findBlockElement(a, id)!;
    const cardB = findBlockElement(b, id)!;
    partText(cardA, "footer").insert(0, "agent A ");
    partText(cardB, "footer").insert(0, "agent B ");
    editBlock(a, id, getBlockText(a, id), getBlockText(a, id).replace("Original", "Changed"));
    partText(cardB, "body").insert(0, "Concurrent body");
    syncDocs(a, b);
    expect(getBlockText(a, id)).toBe(getBlockText(b, id));
    expect(cardPartTexts(cardA, "footer")).toHaveLength(1);
    expect(cardInline(cardA).footer.map(({ text }) => text).join("")).toContain("agent A ");
    expect(cardInline(cardA).footer.map(({ text }) => text).join("")).toContain("agent B ");
    expect(cardInline(cardA).body).toEqual([{ text: "Concurrent body", marks: {} }]);
  });

  it("rejects each foreign grammar before it can be rewritten", () => {
    const mutations = [
      (card: Y.XmlElement) => card.delete(0, 1),
      (card: Y.XmlElement) => card.insert(0, [new Y.XmlText("stray")]),
      (card: Y.XmlElement) => cardPartElement(card, "title")!.setAttribute("future", "shape"),
      (card: Y.XmlElement) => partText(card, "title").insertEmbed(0, { hidden: true }),
      (card: Y.XmlElement) => partText(card, "title").format(0, 1, { future: {} }),
    ];
    for (const mutate of mutations) {
      const { card } = fixture();
      mutate(card);
      expect(isSupportedCard(card)).toBe(false);
    }
    const doc = new Y.Doc();
    const emptyCard = buildCardElement(UUID);
    getBlocksFragment(doc).insert(0, [emptyCard]);
    expect(isSupportedCard(emptyCard)).toBe(true);
    expect(parseInline("\\:::card")).toEqual([{ text: ":::card", marks: {} }]);
  });
});
