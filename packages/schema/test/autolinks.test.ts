import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, editBlock, findBlockElement, findWebAddresses, getBlock, initDoc,
  isExternalHref, linkifyInline, parseInline, structuredInlineParts,
} from "../src/index.js";
import { readInlineRuns } from "../src/marks.js";

describe("web address matching", () => {
  it.each([
    ["https://example.com.", "https://example.com"],
    ["www.commonmark.org/a.b.", "www.commonmark.org/a.b"],
    ["www.example/path.", "www.example/path"],
    ["www.google.com/search?q=Markup+(business)))", "www.google.com/search?q=Markup+(business)"],
    ["www.google.com/search?q=(business))+ok", "www.google.com/search?q=(business))+ok"],
    ["www.google.com/search?q=commonmark&hl;", "www.google.com/search?q=commonmark"],
    ["https://example.com/path?!.,:*_~", "https://example.com/path"],
    ["https://example.com/path;", "https://example.com/path;"],
    ["https://example.com/he<lp", "https://example.com/he"],
    ["<https://example.com/path.)>", "https://example.com/path.)"],
    ["<HTTP://localhost>", "HTTP://localhost"],
  ])("matches %s with GFM punctuation and CommonMark angle rules", (source, expected) => {
    const [address] = findWebAddresses(source);
    expect(address?.text).toBe(expected);
    expect(address?.href).toBe(expected.startsWith("www.") ? `https://${expected}` : expected);
    expect(source.slice(address!.from, address!.to)).toBe(expected);
    expect(isExternalHref(address?.href)).toBe(true);
  });

  it("recognizes only supported forms, domains and GFM starting boundaries", () => {
    const source = "https://example.com _www.example.com_ (http://sub_domain.example.com) xhttps://example.com :www.example.com https://bad_domain.com https://example.bad_domain https://localhost mail@example.com <ftp://example.com/https://example.com> <mailto:mail@example.com>";
    expect(findWebAddresses(source).map(({ text }) => text)).toEqual([
      "https://example.com", "www.example.com", "http://sub_domain.example.com",
    ]);
  });
});

describe("structured Markdown writes", () => {
  it.each([
    { type: "table", source: "| Header |\n| --- |\n| Before https://old.example.com then placeholder |" },
    { type: "card", source: "title: Links\n\nBefore https://old.example.com then placeholder" },
    { type: "figma", source: "url: https://www.figma.com/design/Abc123/File\n\nBefore https://old.example.com then placeholder" },
  ] as const)("stores newly written addresses in $type prose while retaining an old plain address", ({ type, source }) => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Links" });
    const id = appendBlock(doc, { type, text: source });
    const part = structuredInlineParts(findBlockElement(doc, id)!).find(({ texts }) =>
      texts.some((text) => readInlineRuns(text).some((run) => run.text.includes("https://old.example.com"))))!;
    const text = part.texts[0]!;
    expect(readInlineRuns(text)).toContainEqual({ text: "https://old.example.com", marks: { link: "https://old.example.com" } });
    text.format(7, "https://old.example.com".length, { link: null });
    const before = getBlock(doc, id)!.text;
    editBlock(doc, id, before, before.replace("placeholder", "https://new.example.com"));
    expect(readInlineRuns(text)).toEqual([
      { text: "Before https://old.example.com then ", marks: {} },
      { text: "https://new.example.com", marks: { link: "https://new.example.com" } },
    ]);
    doc.destroy();
  });
});

describe("linkifying literal inline runs", () => {
  it("preserves literal text and formatting across split addresses", () => {
    const runs = [
      { text: "See <https://exam", marks: { bold: true } },
      { text: "ple.com> or www.example.com.", marks: { italic: true } },
    ];
    const result = linkifyInline(runs);
    expect(result).toEqual([
      { text: "See <", marks: { bold: true } },
      { text: "https://exam", marks: { bold: true, link: "https://example.com" } },
      { text: "ple.com", marks: { italic: true, link: "https://example.com" } },
      { text: "> or ", marks: { italic: true } },
      { text: "www.example.com", marks: { italic: true, link: "https://www.example.com" } },
      { text: ".", marks: { italic: true } },
    ]);
    expect(result.map(({ text }) => text).join("")).toBe(runs.map(({ text }) => text).join(""));
    expect(runs[0]?.marks).toEqual({ bold: true });
  });

  it("keeps existing links and inline code intact and never bridges their boundaries", () => {
    const runs = [
      { text: "https://example.com ", marks: { link: "https://other.example.com" } },
      { text: "www.example.com ", marks: { docLink: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
      { text: "https://example.com ", marks: { inlineCode: true } },
      { text: "https://exam", marks: {} },
      { text: "ple.com", marks: { inlineCode: true } },
    ];
    expect(linkifyInline(runs)).toEqual(runs);
  });

  it("allows callers with literal-label or display contracts to disable new links", () => {
    expect(parseInline("www.example.com <https://example.com>", { autolinks: false })).toEqual([
      { text: "www.example.com <https://example.com>", marks: {} },
    ]);
  });
});
