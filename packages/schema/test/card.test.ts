import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  CARD_PARTS, InvalidCardError,
  InlineLinkRangeError, OldTextMismatchError, StaleBlockError,
  appendBlock, cardButtons, cardPartElement, cardPartTexts,
  createAnnotation, decisionApprovalFingerprint, editBlock,
  exportMarkdown, findBlockElement, getBlock, getBlocks, getBlocksFragment,
  importMarkdown, initDoc, insertBlock, isCardButtonHref, isSupportedCard,
  listAnnotationRanges, parseCardButtons, parseCardInput, parseInline, resolveAnnotationRange,
  setAnnotationResolved, setInlineLink, writeCardButton, writeCardButtons,
  type CardButton, type CardPart,
} from "../src/index.js";
import { buildCardElement, cardInline, parseCardButton } from "../src/card.js";
import { CardAnnotationError } from "../src/errors.js";
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
  it("keeps existing cards' canonical text, revision and approval fingerprint", () => {
    const { doc, id, card } = fixture();
    expect(getBlock(doc, id)!.text).toBe(SOURCE);
    expect(card.getAttributes()).toEqual({ id });
    expect(getBlock(doc, id)!.rev).toBe("a0c7c7a974288d67");
    expect(decisionApprovalFingerprint(doc)).toBe("71a456ed645bb13b");
  });

  it("writes the fixed supported shape and canonical marked part order", () => {
    const source = `footer: [target](${TARGET})\ntitle: **Title** and *emphasis*\nlabel: "Literal quotes"\n\nA ~~struck~~ body with \`code\` and [web](https://example.test).`;
    const { doc, id, card } = fixture(source);
    expect(isSupportedCard(card)).toBe(true);
    expect(card.toArray().map((part) => (part as Y.XmlElement).nodeName)).toEqual(["cardLabel", "cardTitle", "cardBody", "cardFooter"]);
    expect(getBlock(doc, id)!.text).toBe(`label: "Literal quotes"\ntitle: **Title** and *emphasis*\nfooter: [target](${TARGET})\n\nA ~~struck~~ body with \`code\` and [web](https://example.test).`);
    expect(cardInline(card).footer).toEqual([{ text: "target", marks: { docLink: TARGET } }]);
    const before = getBlock(doc, id)!.rev;
    partText(card, "label").format(0, 7, { bold: {} });
    expect(getBlock(doc, id)!.rev).not.toBe(before);
  });

  it("refuses invalid writes and block offsets before writing", () => {
    const { doc, id } = fixture();
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    for (const source of ["", "label: only", "title:", "title:   ", "Title: wrong", "title: title\nunknown: key", "title: title\ntitle: again", "title: title\nnot a key"] ) {
      expect(() => insertBlock(doc, id, { type: "card", text: source })).toThrow(InvalidCardError);
      expect(() => editBlock(doc, id, SOURCE, source)).toThrow(InvalidCardError);
    }
    expect(() => createAnnotation(doc, id, 0, 2, "Reader", "question")).toThrow(CardAnnotationError);
    expect(() => setInlineLink(doc, id, { start: 0, end: 2 }, TARGET)).toThrow(InlineLinkRangeError);
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
    expect(() => editBlock(doc, id, getBlock(doc, id)!.text, SOURCE.replace("body", "content"))).toThrow(InvalidCardError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("changes only requested parts and characters, preserving marks and comment anchors", () => {
    const { doc, id, card } = fixture(SOURCE.replace("A useful title", "**A useful title**"));
    const title = partText(card, "title");
    const footer = partText(card, "footer");
    const titleThread = createAnnotation(doc, id, 2, 8, "Reader", "title?", { part: "title" });
    const footerThread = createAnnotation(doc, id, 0, 8, "Reader", "footer?", { part: "footer" });
    const footerDelta = footer.toDelta();
    const before = getBlock(doc, id)!.text;
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
    expect(getBlock(copy, getBlocks(copy)[2]!.id)!.text).toBe(prose);
    expect(getBlock(doc, id)!.text).toContain("\\:::");
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
    expect(parseCardInput(getBlock(doc, id)!.text).title).toBe("Hello there");
    const before = getBlock(doc, id)!.text;
    editBlock(doc, id, before, before.replace("Hello there", "Hello there changed"));
    expect((partText(card, "title").toDelta() as Array<{ insert?: unknown }>).some((op) => typeof op.insert === "string" && op.insert.includes("\n"))).toBe(true);
    expect(cardInline(card).title).toEqual([{ text: "Hello\nthere changed", marks: {} }]);
    expect(resolveAnnotationRange(doc, footerThread.id)).toEqual({ part: "footer", start: 0, end: 8, collapsed: false });
    title.insert(6, "\n");
    const twoNewlines = getBlock(doc, id)!.text;
    expect(parseCardInput(twoNewlines).title).toBe("Hello  there changed");
    editBlock(doc, id, twoNewlines, twoNewlines.replace("there changed", "there changed again"));
    expect(cardInline(card).title).toEqual([{ text: "Hello\n\nthere changed again", marks: {} }]);
    const footer = partText(card, "footer");
    footer.delete(0, footer.length);
    expect(getBlock(doc, id)!.text).not.toContain("footer:");
    title.delete(0, title.length);
    const empty = getBlock(doc, id)!.text;
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
    editBlock(a, id, getBlock(a, id)!.text, getBlock(a, id)!.text.replace("Original", "Changed"));
    partText(cardB, "body").insert(0, "Concurrent body");
    syncDocs(a, b);
    expect(getBlock(a, id)!.text).toBe(getBlock(b, id)!.text);
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

describe("card link button", () => {
  it("keeps the single default button's stored value, text, revision and approval fingerprint", () => {
    const source = SOURCE.replace("footer: Metadata", "footer: Metadata\nbutton: [Discuss](codex://new)");
    const { doc, id, card } = fixture(source);
    expect(card.getAttribute("button")).toBe("[Discuss](codex://new)");
    expect(getBlock(doc, id)!.text).toBe(source);
    expect(getBlock(doc, id)!.rev).toBe("4cda8e09ed946563");
    expect(decisionApprovalFingerprint(doc)).toBe("6bf5ef896d475499");
    const canonicalRev = getBlock(doc, id)!.rev;
    editBlock(doc, id, source, source.replace("(codex://new)", "(codex://new) neutral outline"));
    expect(getBlock(doc, id)!.text).toBe(source);
    expect(getBlock(doc, id)!.rev).toBe(canonicalRev);
  });

  it("canonicalizes every appearance and preserves authored order through Markdown", () => {
    const values = [
      "[First](https://example.test) neutral outline",
      "[Second](codex://new) blue outline",
      "[Third](claude://code/new) green outline",
      "[Fourth](claude-cli://open) violet outline",
      "[Fifth](https://example.test/5) neutral filled",
      "[Sixth](https://example.test/6) blue filled",
      "[Seventh](https://example.test/7) green filled",
      "[Eighth](https://example.test/8) violet filled",
    ];
    const canonical = [
      "[First](https://example.test)", "[Second](codex://new) blue",
      "[Third](claude://code/new) green", "[Fourth](claude-cli://open) violet",
      "[Fifth](https://example.test/5) filled", "[Sixth](https://example.test/6) filled blue",
      "[Seventh](https://example.test/7) filled green", "[Eighth](https://example.test/8) filled violet",
    ];
    const { doc, id, card } = fixture(`title: Actions\n${values.map((value) => `button: ${value}`).join("\n")}\nfooter: Metadata\n\nBody`);
    expect(card.getAttribute("button")).toBe(canonical.join("\n"));
    expect(getBlock(doc, id)!.text).toBe(`title: Actions\nfooter: Metadata\n${canonical.map((value) => `button: ${value}`).join("\n")}\n\nBody`);
    const copy = imported(exportMarkdown(doc, { frontmatter: false }));
    expect(getBlocks(copy)[0]!.text).toBe(getBlock(doc, id)!.text);
    expect(cardButtons(findBlockElement(copy, getBlocks(copy)[0]!.id)!)).toEqual(cardButtons(card));
    expect(cardButtons(card)[0]).toEqual({ text: "First", href: "https://example.test" });
  });

  it("accepts lists beyond any fixed button count", () => {
    const buttons = Array.from({ length: 50 }, (_, index) => ({ text: `Action ${index}`, href: `https://example.test/${index}` }));
    const { doc, id, card } = fixture(`title: Many actions\n${buttons.map((button) => `button: ${writeCardButton(button)}`).join("\n")}\n\n`);
    expect(cardButtons(card)).toEqual(buttons);
    expect(getBlock(doc, id)!.text.match(/^button:/gm)).toHaveLength(50);
  });

  it("refuses long malformed appearance suffixes without backtracking", () => {
    const suffix = "\t".repeat(100_000);
    for (const ending of ["\r", "\n"]) {
      expect(() => parseCardButton(`[Action](codex://new)${suffix}${ending}`)).toThrow(InvalidCardError);
    }
  });

  it("refuses unsupported whole-button appearance values before serializing them", () => {
    for (const appearance of [{ style: "filled blue" }, { style: "" }, { color: "filled" }, { color: "amber" }]) {
      expect(() => writeCardButton({ text: "Action", href: "codex://new", ...appearance } as CardButton)).toThrow(InvalidCardError);
    }
  });

  it.each([
    "[Bad](https://example.test) amber", "[Bad](https://example.test) filled outline",
    "[Bad](https://example.test) filled filled", "[Bad](https://example.test) blue green",
    "[Bad](https://example.test) neutral neutral", "[Bad](https://example.test) blue filled trailing",
    "[Bad](https://example.test)filled", "[Bad](https://example.test) [Other](https://example.test)",
    "[Bad](javascript:alert(1))", "[**Bad**](https://example.test)",
  ])("refuses the complete write and preserves literal import when a later button is invalid: %s", (value) => {
    const { doc, id } = fixture();
    const source = `title: Actions\nbutton: [Good](codex://new) filled blue\nbutton: ${value}\n\nBody`;
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => appendBlock(doc, { type: "card", text: source })).toThrow(InvalidCardError);
    expect(() => editBlock(doc, id, SOURCE, source)).toThrow(InvalidCardError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const container = `:::card\n${source}\n:::`;
    expect(importMarkdown(container).blocks).toEqual([{ type: "paragraph", text: container, inline: [{ text: container, marks: {} }] }]);
  });

  it.each(["label", "title", "footer"])("still refuses duplicate %s headers beside repeated buttons", (key) => {
    const source = `title: Actions\nbutton: [First](codex://new)\n${key}: One\nbutton: [Second](claude-cli://open)\n${key}: Two\n\n`;
    expect(() => parseCardInput(source)).toThrow(InvalidCardError);
    const container = `:::card\n${source}\n:::`;
    expect(importMarkdown(container).blocks[0]!.type).toBe("paragraph");
  });

  it.each(["", "\n[Good](codex://new)", "[Good](codex://new)\n", "[Good](codex://new)\n\n[Other](codex://new)", "[Good](codex://new)\ninvalid"])("never uses or rewrites malformed stored lists: %s", (source) => {
    const { doc, id, card } = fixture();
    card.setAttribute("button", source);
    expect(() => parseCardButtons(source)).toThrow(InvalidCardError);
    expect(isSupportedCard(card)).toBe(false);
    expect(cardButtons(card)).toEqual([]);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => editBlock(doc, id, getBlock(doc, id)!.text, SOURCE)).toThrow(InvalidCardError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("includes each button property and position in rev, but only ordered text in approval", () => {
    const source = `title: Actions\nbutton: [First](codex://new)\nbutton: [Second](claude-cli://open) filled blue\n\nBody`;
    const { doc, id, card } = fixture(source);
    const originalRev = getBlock(doc, id)!.rev;
    const originalApproval = decisionApprovalFingerprint(doc);
    for (const [changed, approvalChanges] of [
      [source.replace("[First]", "[Renamed]"), true],
      [source.replace("codex://new", "https://example.test"), false],
      [source.replace("filled blue", "blue"), false],
      [source.replace("filled blue", "filled green"), false],
      [source.replace("button: [First](codex://new)\nbutton: [Second](claude-cli://open) filled blue", "button: [Second](claude-cli://open) filled blue\nbutton: [First](codex://new)"), true],
    ] as const) {
      editBlock(doc, id, source, changed);
      expect(getBlock(doc, id)!.rev).not.toBe(originalRev);
      expect(decisionApprovalFingerprint(doc) === originalApproval).toBe(!approvalChanges);
      editBlock(doc, id, changed, source);
    }
    const buttons = cardButtons(card);
    editBlock(doc, id, source, source.replace("Body", "Changed body"));
    expect(cardButtons(card)).toEqual(buttons);
    const before = getBlock(doc, id)!.text;
    editBlock(doc, id, before, before.replace("[First]", "[Updated first]"));
    expect(cardButtons(card)[1]).toEqual(buttons[1]);
  });

  it("syncs one complete atomic button list while concurrent prose edits survive", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Cards" });
      id = appendBlock(doc, { type: "card", text: SOURCE });
    });
    const lists: CardButton[][] = [
      [{ text: "First A", href: "codex://new", style: "filled", color: "blue" }, { text: "Second A", href: "https://example.test/a", color: "green" }],
      [{ text: "First B", href: "claude-cli://open", color: "violet" }, { text: "Second B", href: "https://example.test/b", style: "filled" }],
    ];
    for (const [index, doc] of [a, b].entries()) {
      editBlock(doc, id, SOURCE, SOURCE.replace("footer: Metadata", `footer: Metadata\n${lists[index]!.map((button) => `button: ${writeCardButton(button)}`).join("\n")}`));
    }
    partText(findBlockElement(a, id)!, "title").insert(0, "Changed ");
    partText(findBlockElement(b, id)!, "body").insert(0, "Concurrent ");
    syncDocs(a, b);
    expect(lists).toContainEqual(cardButtons(findBlockElement(a, id)!));
    expect(cardButtons(findBlockElement(b, id)!)).toEqual(cardButtons(findBlockElement(a, id)!));
    expect(cardInline(findBlockElement(a, id)!).title[0]!.text).toBe("Changed A useful title");
    expect(cardInline(findBlockElement(a, id)!).body[0]!.text).toBe("Concurrent The body text.");
    expect(writeCardButtons([])).toBe("");
    const current = getBlock(a, id)!.text;
    editBlock(a, id, current, current.replace(/^button:.*\n/gm, ""));
    syncDocs(a, b);
    expect(findBlockElement(b, id)!.getAttribute("button")).toBeUndefined();
  });

  it.each([
    "https://example.test/path?prompt=a%20b#details",
    "claude://code/new", "claude-cli://open", "codex://new",
    "claude://code/new?", "claude-cli://open?repo=example/project&q=%25%2F",
    "codex://new?prompt=opaque%ZZ&future=unchanged#query-value",
  ])("accepts only supported destinations without rewriting query values: %s", (href) => {
    expect(isCardButtonHref(href)).toBe(true);
    const source = writeCardButton({ text: "Author's text", href });
    expect(parseCardButton(source)).toEqual({ text: "Author's text", href });
    const { doc, id, card } = fixture(`button: ${source}\n${SOURCE}`);
    expect(isSupportedCard(card)).toBe(true);
    expect(card.getAttribute("button")).toBe(source);
    expect(getBlock(doc, id)!.text).toBe(SOURCE.replace("footer: Metadata", `footer: Metadata\nbutton: ${source}`));
    const copy = imported(exportMarkdown(doc, { frontmatter: false }));
    expect(getBlocks(copy).map(({ text }) => text)).toEqual([getBlock(doc, id)!.text]);
    expect(cardButtons(findBlockElement(copy, getBlocks(copy)[0]!.id)!)).toEqual([{ text: "Author's text", href }]);
  });

  it.each([
    "http://example.test", "javascript:alert(1)", "data:text/plain,example", "file:///example",
    "vbscript:example", "mailto:reader@example.test", "/relative", "https://", "https://?prompt=example",
    "claude://code/settings", "claude-cli://other", "codex://settings", "codex://new/", "codex://new#fragment",
    "CODEX://new", "codex://new\n?prompt=example", "codex://new\u0000?prompt=example",
  ])("refuses disallowed destinations through writes and literal import: %s", (href) => {
    expect(isCardButtonHref(href)).toBe(false);
    expect(() => writeCardButton({ text: "Discuss", href })).toThrow(InvalidCardError);
    const source = `title: Action\nbutton: [Discuss](${href})\n\nBody`;
    const { doc, id, card } = fixture();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => appendBlock(doc, { type: "card", text: source })).toThrow(InvalidCardError);
    expect(() => editBlock(doc, id, SOURCE, source)).toThrow(InvalidCardError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const container = `:::card\n${source}\n:::`;
    expect(importMarkdown(container).blocks).toEqual([{ type: "paragraph", text: container, inline: [{ text: container, marks: {} }] }]);
    card.setAttribute("button", `[Discuss](${href})`);
    expect(isSupportedCard(card)).toBe(false);
    expect(cardButtons(card)).toEqual([]);
  });

  it.each([
    "not a link", "[](https://example.test)", "[   ](https://example.test)",
    "[**bold**](https://example.test)", "[*italic*](https://example.test)",
    "[`code`](https://example.test)", "[~~strike~~](https://example.test)",
    `[doc](${TARGET})`, "[A](https://example.test) trailing",
    "[A](https://example.test) [B](https://example.test)", "[A](https://example.test \"Title\")",
  ])("requires a single link with a plain nonempty label: %s", (value) => {
    expect(() => parseCardInput(`title: Action\nbutton: ${value}\n\nBody`)).toThrow(InvalidCardError);
    const container = `:::card\ntitle: Action\nbutton: ${value}\n\nBody\n:::`;
    expect(importMarkdown(container).blocks[0]).toEqual({ type: "paragraph", text: container, inline: [{ text: container, marks: {} }] });
  });

  it("round-trips literal labels and unusual opaque query bytes with the shared link grammar", () => {
    const text = "Discuss [this] in **Codex** with `code`, _labels_, \\ paths and ü";
    const href = "codex://new?prompt=space and (<opaque>)\\literal&encoded=%2F%25";
    const button = { text, href };
    const { doc, id, card } = fixture(`title: Action\nbutton: ${writeCardButton(button)}\n\nBody`);
    expect(cardButtons(card)).toEqual([button]);
    const copy = imported(exportMarkdown(doc, { frontmatter: false }));
    expect(getBlocks(copy)[0]!.text).toBe(getBlock(doc, id)!.text);
    expect(cardButtons(findBlockElement(copy, getBlocks(copy)[0]!.id)!)).toEqual([button]);
    for (const value of ["", " ", "line\nbreak", "line\rbreak"]) {
      expect(() => writeCardButton({ text: value, href })).toThrow(InvalidCardError);
    }
    expect(parseInline("[Ordinary](codex://new)")).toEqual([{ text: "[Ordinary](codex://new)", marks: {} }]);
  });

  it("keeps the button on unrelated edits and counts its label but not its destination in approval", () => {
    const { doc, id, card } = fixture();
    const originalApproval = decisionApprovalFingerprint(doc);
    const add = SOURCE.replace("footer: Metadata", "footer: Metadata\nbutton: [Discuss](codex://new)");
    editBlock(doc, id, SOURCE, add);
    const buttonApproval = decisionApprovalFingerprint(doc);
    const rev = getBlock(doc, id)!.rev;
    const originalParts = CARD_PARTS.map((part) => partText(card, part));
    expect(buttonApproval).not.toBe(originalApproval);
    const target = add.replace("codex://new", "claude://code/new?q=review");
    editBlock(doc, id, add, target);
    expect(decisionApprovalFingerprint(doc)).toBe(buttonApproval);
    expect(getBlock(doc, id)!.rev).not.toBe(rev);
    const storedButton = card.getAttribute("button");
    const body = target.replace("body text", "body prose");
    editBlock(doc, id, target, body);
    expect(card.getAttribute("button")).toBe(storedButton);
    expect(CARD_PARTS.map((part) => partText(card, part))).toEqual(originalParts);
    const changedText = body.replace("[Discuss]", "[Read]");
    const beforeLabel = decisionApprovalFingerprint(doc);
    editBlock(doc, id, body, changedText);
    expect(decisionApprovalFingerprint(doc)).not.toBe(beforeLabel);
    editBlock(doc, id, changedText, SOURCE);
    expect(card.getAttribute("button")).toBeUndefined();
    expect(getBlock(doc, id)!.rev).toBe("a0c7c7a974288d67");
    expect(decisionApprovalFingerprint(doc)).toBe(originalApproval);
  });

  it("syncs whole button pairs without overwriting independent prose edits", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Cards" });
      id = appendBlock(doc, { type: "card", text: SOURCE });
    });
    editBlock(a, id, SOURCE, SOURCE.replace("footer: Metadata", "footer: Metadata\nbutton: [First](codex://new)"));
    editBlock(b, id, SOURCE, SOURCE.replace("footer: Metadata", "footer: Metadata\nbutton: [Second](claude-cli://open?q=second)"));
    partText(findBlockElement(a, id)!, "title").insert(0, "Changed ");
    partText(findBlockElement(b, id)!, "body").insert(0, "Concurrent ");
    syncDocs(a, b);
    expect(getBlock(a, id)!.text).toBe(getBlock(b, id)!.text);
    const winner = cardButtons(findBlockElement(a, id)!);
    expect([[{ text: "First", href: "codex://new" }], [{ text: "Second", href: "claude-cli://open?q=second" }]]).toContainEqual(winner);
    expect(cardInline(findBlockElement(a, id)!).title).toEqual([{ text: "Changed A useful title", marks: {} }]);
    expect(cardInline(findBlockElement(a, id)!).body).toEqual([{ text: "Concurrent The body text.", marks: {} }]);
    const current = getBlock(a, id)!.text;
    editBlock(a, id, current, current.replace(/^button:.*\n/m, ""));
    syncDocs(a, b);
    expect(cardButtons(findBlockElement(b, id)!)).toEqual([]);
  });
});
