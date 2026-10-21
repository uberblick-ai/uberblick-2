import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  FIGMA_PROVIDER, InlineLinkRangeError, InvalidFigmaError,
  OldTextMismatchError, StaleBlockError, addComment, appendBlock, createAnnotation,
  editBlock, exportMarkdown, figmaCaptionElement, figmaCaptionTexts,
  findBlockElement, getBlock, getBlocks, getBlocksWithInline, importMarkdown, initDoc, insertBlock, isSupportedFigma, listAnnotationRanges, normalizeFigmaLink,
  parseFigmaHeight, parseFigmaInput, resolveAnnotationRange, seedNewFigmaCaptions, setAnnotationResolved,
  setInlineLink,
} from "../src/index.js";
import { FigmaAnnotationError } from "../src/errors.js";
import { figmaInline, writeFigmaText } from "../src/figma.js";
import { figmaEmbedAddress } from "../src/providers/figma.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const URL = "https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345";
const SOURCE = `url: ${URL}\ntitle: Payment, mobile\nheight: 560\n\nCard form after the address step.`;

function fixture(source = SOURCE): { doc: Y.Doc; id: string; figma: Y.XmlElement } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Designs" });
  const id = appendBlock(doc, { type: "figma", text: source });
  return { doc, id, figma: findBlockElement(doc, id)! };
}

describe("Figma provider link identity", () => {
  it("drops tracking and fragments, canonicalizes the host, and exposes the view identity", () => {
    const first = normalizeFigmaLink(`${URL}&t=AbC123-1&starting-point-node-id=12%3A401&version-id=987#private`);
    expect(first).toEqual({
      url: `${URL}&starting-point-node-id=12%3A401&version-id=987`,
      figma: { kind: "frame", file: "k3Lm9QzT2x", fileName: "Checkout flow", node: "12:345" },
    });
    expect(normalizeFigmaLink(`${URL.replace("www.figma.com", "figma.com")}&t=another`)).toEqual(normalizeFigmaLink(URL));
  });

  it.each([
    ["design/key", "file"], ["file/key", "file"],
    ["design/key?node-id=12-345", "frame"], ["file/key?node-id=12%3A345", "frame"],
    ["proto/key?node-id=12-345", "prototype"], ["board/key", "board"],
    ["slides/key", "slides"], ["community/file/123456", "community file"],
  ] as const)("derives the accepted kind for %s", (path, kind) => {
    const fields = normalizeFigmaLink(`https://www.figma.com/${path}`).figma;
    expect(fields.kind).toBe(kind);
    expect(fields.file).toBe(path.startsWith("community") ? "123456" : "key");
    expect(fields.fileName).toBeUndefined();
    expect(fields.node).toBe(path.includes("node-id") ? "12:345" : undefined);
  });

  it("decodes the optional name without treating it as inline Markdown", () => {
    expect(normalizeFigmaLink("https://figma.com/community/file/123/Checkout-%E2%9C%93").figma).toEqual({
      kind: "community file", file: "123", fileName: "Checkout ✓",
    });
    expect(normalizeFigmaLink("https://figma.com/design/key/UI%2FUX").figma.fileName).toBe("UI/UX");
    expect(() => normalizeFigmaLink("HTTPS://figma.com/design/key/../other")).toThrow(InvalidFigmaError);
  });

  it.each([
    "http://www.figma.com/design/key", "https://other.test/design/key", "https://figma.com.other.test/design/key",
    "https://user:secret@figma.com/design/key", "https://figma.com:9999/design/key", "not a link",
  ])("refuses a non-Figma address with the exact recovery message: %s", (url) => {
    expect(() => normalizeFigmaLink(url)).toThrow("figma blocks take figma.com links only; use a plain link for other sites");
  });

  it.each([
    "/deck/key", "/design/key/branch/other", "/design/key/name/extra", "/unknown/key",
    "/design/", "/design/key/", "/community/file/", "/community/file/123/name/extra",
    "/design/key/../other", "/design/key/%2e%2e/other",
  ])("names the accepted kinds when the path is unsupported: %s", (path) => {
    expect(() => normalizeFigmaLink(`https://figma.com${path}`)).toThrow(/\/design\/.*\/file\/.*\/proto\/.*\/board\/.*\/slides\/.*\/community\/file\//);
  });
});

describe("Figma viewer provider contract", () => {
  it("builds a frame address from only the kept identity and reader appearance", () => {
    expect(FIGMA_PROVIDER.embedAddress(`${URL}&starting-point-node-id=12%3A401&version-id=987&theme=wrong&embed-host=https://private.test&document=secret&t=tracking#private`, "dark"))
      .toBe("https://embed.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345&starting-point-node-id=12%3A401&version-id=987&embed-host=uberblick&footer=false&theme=dark&page-selector=false");
  });

  it.each(["design/key", "file/key", "proto/key?node-id=12-345", "board/key", "slides/key", "community/file/123"])("keeps the accepted path and shows page selection for %s", (path) => {
    const address = new globalThis.URL(figmaEmbedAddress(`https://figma.com/${path}`, "light"));
    expect(address.origin).toBe("https://embed.figma.com");
    expect(`${address.pathname}${address.searchParams.has("node-id") ? `?node-id=${address.searchParams.get("node-id")}` : ""}`).toBe(`/${path}`);
    expect(address.searchParams.get("theme")).toBe("light");
    expect(address.searchParams.has("page-selector")).toBe(false);
  });

  it("refuses an unsupported viewer destination and fixes the security attributes", () => {
    expect(() => figmaEmbedAddress("https://example.test/design/key", "light")).toThrow(InvalidFigmaError);
    expect(FIGMA_PROVIDER.frameAttributes).toEqual({
      sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-storage-access-by-user-activation",
      allow: "fullscreen; clipboard-write",
      referrerpolicy: "no-referrer",
      allowfullscreen: "",
    });
  });
});

describe("Figma title lookup address", () => {
  it("sends only the normalized stored link to the fixed oEmbed endpoint", () => {
    const address = new globalThis.URL(FIGMA_PROVIDER.lookupAddress(
      `${URL.replace("www.figma.com", "figma.com")}&starting-point-node-id=12%3A401&version-id=987&document=secret&workspace=private&t=tracking#private`,
    )!);
    expect(address.origin).toBe("https://www.figma.com");
    expect(address.pathname).toBe("/api/oembed");
    expect([...address.searchParams]).toEqual([
      ["url", `${URL}&starting-point-node-id=12%3A401&version-id=987`],
    ]);
  });

  it.each(["design/key?node-id=12-345", "design/key", "file/key", "proto/key?node-id=12-345", "board/key", "slides/key"])(
    "looks up public-file information for the supported kind %s", (path) => {
      const address = new globalThis.URL(FIGMA_PROVIDER.lookupAddress(`https://figma.com/${path}`)!);
      expect(address.searchParams.get("url")).toBe(`https://www.figma.com/${path}`);
    },
  );

  it("skips community files rather than treating an unsupported public kind as private", () => {
    expect(FIGMA_PROVIDER.lookupAddress("https://www.figma.com/community/file/123456/Public-file")).toBeNull();
  });

  it("refuses non-Figma destinations before constructing a request address", () => {
    expect(() => FIGMA_PROVIDER.lookupAddress("https://example.test/design/key")).toThrow(InvalidFigmaError);
  });
});

describe("Figma block contract", () => {
  it("stores only kept identity, literal title, explicit height and a marked caption", () => {
    const title = `**Literal** [target](${TARGET})`;
    const { doc, id, figma } = fixture(`height: 560\ntitle:${title}\nurl: ${URL}&t=discarded\n\nA **bold** caption with [doc](${TARGET}).`);
    expect(figma.getAttributes()).toEqual({ id, url: URL, title, height: "560" });
    expect(isSupportedFigma(figma)).toBe(true);
    expect(figma.toArray().map((part) => (part as Y.XmlElement).nodeName)).toEqual(["figmaCaption"]);
    expect(getBlock(doc, id)).toMatchObject({ type: "figma", figma: { kind: "frame", file: "k3Lm9QzT2x", fileName: "Checkout flow", node: "12:345" } });
    expect(getBlock(doc, id)!.text).toBe(`url: ${URL}\ntitle: ${title}\nheight: 560\n\nA **bold** caption with [doc](${TARGET}).`);
    expect(getBlocksWithInline(doc)[0]!.figma).toEqual({ caption: [
      { text: "A ", marks: {} }, { text: "bold", marks: { bold: true } },
      { text: " caption with ", marks: {} }, { text: "doc", marks: { docLink: TARGET } }, { text: ".", marks: {} },
    ] });
    expect(getBlocksWithInline(doc)[0]!.inline).toEqual([]);
  });

  it("omits absent or empty title and height while seeding an empty caption", () => {
    const { doc, id, figma } = fixture(`url: ${URL}\ntitle:\n\n`);
    expect(getBlock(doc, id)!.text).toBe(`url: ${URL}\n\n`);
    expect(figma.getAttributes()).toEqual({ id, url: URL });
    expect(figmaCaptionTexts(figma)).toHaveLength(1);
    expect(parseFigmaInput(`url:${URL}`)).toEqual({ url: URL, caption: "" });
    expect(writeFigmaText({ url: URL, title: "First\nSecond", caption: "" })).toBe(`url: ${URL}\ntitle: First Second\n\n`);
    figma.setAttribute("title", "First\nSecond");
    expect(getBlock(doc, id)!.text).toBe(`url: ${URL}\ntitle: First Second\n\n`);
    const before = getBlock(doc, id)!.text;
    editBlock(doc, id, before, `${before}New caption`);
    expect(figma.getAttribute("title")).toBe("First\nSecond");
    const captionEdit = getBlock(doc, id)!.text;
    editBlock(doc, id, captionEdit, captionEdit.replace("First Second", "Changed title"));
    expect(figma.getAttribute("title")).toBe("Changed title");
  });

  it.each([
    "", "title: Missing url", `url: ${URL}\nurl: ${URL}`, `url: ${URL}\ntitle: A\ntitle: B`,
    `url: ${URL}\nheight: 480\nheight: 560`, `url: ${URL}\nunknown: key`, `Url: ${URL}`, `url: ${URL}\nnot a header`,
    `url: ${URL}\nheight:`, `url: ${URL}\nheight: 239`, `url: ${URL}\nheight: 961`,
    `url: ${URL}\nheight: -480`, `url: ${URL}\nheight: 480.0`, `url: ${URL}\nheight: 5e2`, `url: ${URL}\nheight: NaN`,
  ])("rejects invalid insert and edit text before any write: %s", (source) => {
    const { doc, id } = fixture();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => insertBlock(doc, id, { type: "figma", text: source })).toThrow(InvalidFigmaError);
    expect(() => editBlock(doc, id, SOURCE, source)).toThrow(InvalidFigmaError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(getBlocks(doc)).toHaveLength(1);
  });

  it("accepts only the specified inclusive whole-pixel height range", () => {
    expect(parseFigmaInput(`url: ${URL}\nheight:240`).height).toBe(240);
    expect(parseFigmaInput(`url: ${URL}\nheight:960`).height).toBe(960);
  });

  it("shares the same height refusal between structured text and the web field", () => {
    expect(parseFigmaHeight("480")).toBe(480);
    for (const height of ["", "239", "961", "-480", "480.0", "5e2", "NaN"]) {
      expect(() => parseFigmaHeight(height)).toThrow("Height must be a whole number of pixels from 240 to 960");
      expect(() => parseFigmaInput(`url: ${URL}\nheight: ${height}`)).toThrow("Height must be a whole number of pixels from 240 to 960");
    }
  });

  it("seeds a web-created empty caption in its creating transaction for concurrent first edits", () => {
    const doc = new Y.Doc();
    doc.on("beforeObserverCalls", seedNewFigmaCaptions);
    doc.transact(() => {
      const figma = new Y.XmlElement("figma");
      figma.setAttribute("id", "web-created");
      figma.setAttribute("url", URL);
      const caption = new Y.XmlElement("figmaCaption");
      caption.insert(0, [new Y.XmlElement("paragraph")]);
      figma.insert(0, [caption]);
      doc.getXmlFragment("blocks").insert(0, [figma]);
    });
    const copy = new Y.Doc();
    copy.on("beforeObserverCalls", seedNewFigmaCaptions);
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const first = doc.getXmlFragment("blocks").get(0) as Y.XmlElement;
    const second = copy.getXmlFragment("blocks").get(0) as Y.XmlElement;
    expect(figmaCaptionTexts(first)).toHaveLength(1);
    expect(figmaCaptionTexts(second)).toHaveLength(1);
    figmaCaptionTexts(first)[0]!.insert(0, "First ");
    figmaCaptionTexts(second)[0]!.insert(0, "Second ");
    syncDocs(doc, copy);
    expect(figmaCaptionTexts(first)).toHaveLength(1);
    expect(figmaCaptionTexts(second)[0]!.toString()).toBe(figmaCaptionTexts(first)[0]!.toString());
    expect(figmaCaptionTexts(first)[0]!.toString()).toContain("First ");
    expect(figmaCaptionTexts(first)[0]!.toString()).toContain("Second ");
    doc.destroy();
    copy.destroy();
  });

  it("does not repair captions created remotely or emptied after creation", () => {
    const source = new Y.Doc();
    const figma = new Y.XmlElement("figma");
    const caption = new Y.XmlElement("figmaCaption");
    const paragraph = new Y.XmlElement("paragraph");
    caption.insert(0, [paragraph]);
    figma.insert(0, [caption]);
    source.getXmlFragment("blocks").insert(0, [figma]);
    const copy = new Y.Doc();
    copy.on("beforeObserverCalls", seedNewFigmaCaptions);
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
    const remote = copy.getXmlFragment("blocks").get(0) as Y.XmlElement;
    expect(figmaCaptionTexts(remote)).toEqual([]);
    paragraph.insert(0, [new Y.XmlText()]);
    source.on("beforeObserverCalls", seedNewFigmaCaptions);
    source.transact(() => paragraph.delete(0, 1));
    expect(figmaCaptionTexts(figma)).toEqual([]);
    source.destroy();
    copy.destroy();
  });

  it("refuses block annotations and link ranges without writes", () => {
    const { doc, id } = fixture();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => createAnnotation(doc, id, 0, 2, "Reader", "question")).toThrow(FigmaAnnotationError);
    expect(() => setInlineLink(doc, id, { start: 0, end: 2 }, TARGET)).toThrow(InlineLinkRangeError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("preserves stale-edit priority and refuses unsupported stored shapes", () => {
    const { doc, id, figma } = fixture();
    const rev = getBlock(doc, id)!.rev;
    expect(() => editBlock(doc, id, SOURCE, "invalid", { rev: "stale" })).toThrow(StaleBlockError);
    expect(() => editBlock(doc, id, "wrong", "invalid", { rev })).toThrow(OldTextMismatchError);
    figma.setAttribute("future", "shape");
    expect(isSupportedFigma(figma)).toBe(false);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => editBlock(doc, id, SOURCE, SOURCE.replace("mobile", "desktop"))).toThrow(InvalidFigmaError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(["\u2028", "\u2029"])("keeps a stored title with a Unicode separator supported through edits and Markdown: %j", (separator) => {
    const { doc, id, figma } = fixture();
    const title = `Payment,${separator}mobile`;
    figma.setAttribute("title", title);
    expect(isSupportedFigma(figma)).toBe(true);
    const before = getBlock(doc, id)!.text;
    expect(before).toContain(`title: ${title}\n`);
    editBlock(doc, id, before, before);
    expect(getBlock(doc, id)!.text).toBe(before);
    const edited = before.replace("address step", "address screen");
    editBlock(doc, id, before, edited);
    expect(getBlock(doc, id)!.text).toBe(edited);
    expect(figma.getAttribute("title")).toBe(title);
    const blocks = importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "figma", text: edited });
    const copy = new Y.Doc();
    initDoc(copy, { uuid: UUID, title: "Copy" });
    const copyId = appendBlock(copy, blocks[0]!);
    const restored = findBlockElement(copy, copyId)!;
    expect(restored.getAttribute("title")).toBe(title);
    expect(isSupportedFigma(restored)).toBe(true);
  });

  it("keeps stored caption newlines during a header edit", () => {
    const { doc, id, figma } = fixture();
    const caption = figmaCaptionTexts(figma)[0]!;
    caption.insert(4, "\n");
    const delta = caption.toDelta();
    expect(isSupportedFigma(figma)).toBe(true);
    const before = getBlock(doc, id)!.text;
    editBlock(doc, id, before, before.replace("Payment, mobile", "Payment, desktop"));
    expect(caption.toDelta()).toEqual(delta);
    expect(getBlock(doc, id)!.text).toContain("Card\n form");
    doc.destroy();
  });

  it("changes only requested headers and preserves caption text, marks and anchors", () => {
    const { doc, id, figma } = fixture(SOURCE.replace("Card form", "**Card form**"));
    const text = figmaCaptionTexts(figma)[0]!;
    const thread = createAnnotation(doc, id, 5, 9, "Reader", "question", { part: "caption" });
    const delta = text.toDelta();
    const before = getBlock(doc, id)!.text;
    editBlock(doc, id, before, before.replace("Payment, mobile", "Payment, desktop").replace("height: 560", "height: 600"));
    expect(figmaCaptionTexts(figma)[0]).toBe(text);
    expect(text.toDelta()).toEqual(delta);
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ part: "caption", start: 5, end: 9, collapsed: false });
    const header = figma.getAttributes();
    const current = getBlock(doc, id)!.text;
    editBlock(doc, id, current, current.replace("address step", "address screen"));
    expect(figma.getAttributes()).toEqual(header);
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ part: "caption", start: 5, end: 9, collapsed: false });
    expect(figmaInline(figma).caption[0]).toEqual({ text: "Card form", marks: { bold: true } });
  });

  it("includes caption formatting in rev and retains anchors during formatting-only edits", () => {
    const { doc, id } = fixture();
    const thread = createAnnotation(doc, id, 0, 4, "Reader", "question", { part: "caption" });
    const rev = getBlock(doc, id)!.rev;
    editBlock(doc, id, SOURCE, SOURCE.replace("Card form", "**Card form**"));
    expect(getBlock(doc, id)!.rev).not.toBe(rev);
    expect(resolveAnnotationRange(doc, thread.id)).toEqual({ part: "caption", start: 0, end: 4, collapsed: false });
    expect(listAnnotationRanges(doc, id)[0]).toMatchObject({ threadId: thread.id, part: "caption" });
    expect(addComment(doc, thread.id, "Agent", "reply")!.comments).toHaveLength(2);
    expect(setAnnotationResolved(doc, thread.id, true)!.resolved).toBe(true);
    expect(setAnnotationResolved(doc, thread.id, false)!.resolved).toBe(false);
  });

  it("removes optional headers without creating a default height attribute", () => {
    const { doc, id, figma } = fixture();
    editBlock(doc, id, SOURCE, SOURCE.replace("title: Payment, mobile\nheight: 560\n", ""));
    expect(figma.getAttributes()).toEqual({ id, url: URL });
    expect(getBlock(doc, id)!.text).toBe(`url: ${URL}\n\nCard form after the address step.`);
  });

  it("keeps first concurrent caption writes and independent header edits", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Designs" });
      id = appendBlock(doc, { type: "figma", text: `url: ${URL}\n\n` });
    });
    const first = findBlockElement(a, id)!;
    const second = findBlockElement(b, id)!;
    figmaCaptionTexts(first)[0]!.insert(0, "Agent A ");
    figmaCaptionTexts(second)[0]!.insert(0, "Agent B ");
    const oldText = getBlock(a, id)!.text;
    editBlock(a, id, oldText, oldText.replace(`url: ${URL}`, `url: ${URL}\ntitle: Shared design`));
    syncDocs(a, b);
    expect(getBlock(a, id)!.text).toBe(getBlock(b, id)!.text);
    expect(figmaCaptionTexts(first)).toHaveLength(1);
    expect(getBlock(a, id)!.text).toContain("Agent A ");
    expect(getBlock(a, id)!.text).toContain("Agent B ");
    expect(first.getAttribute("title")).toBe("Shared design");
  });

  it("rejects foreign caption grammar before rewriting it", () => {
    const mutations = [
      (figma: Y.XmlElement) => figma.delete(0, 1),
      (figma: Y.XmlElement) => figma.insert(0, [new Y.XmlText("stray")]),
      (figma: Y.XmlElement) => figmaCaptionElement(figma)!.setAttribute("future", "shape"),
      (figma: Y.XmlElement) => figmaCaptionTexts(figma)[0]!.insertEmbed(0, { hidden: true }),
      (figma: Y.XmlElement) => figmaCaptionTexts(figma)[0]!.format(0, 1, { future: {} }),
      (figma: Y.XmlElement) => figmaCaptionTexts(figma)[0]!.format(0, 1, { bold: false }),
      (figma: Y.XmlElement) => (figmaCaptionElement(figma)!.firstChild as Y.XmlElement).setAttribute("future", "shape"),
      (figma: Y.XmlElement) => (figmaCaptionElement(figma)!.firstChild as Y.XmlElement).insert(1, [new Y.XmlText("extra")]),
    ];
    for (const mutate of mutations) {
      const { doc, id, figma } = fixture();
      mutate(figma);
      expect(isSupportedFigma(figma)).toBe(false);
      const before = Y.encodeStateAsUpdate(doc);
      const oldText = getBlock(doc, id)!.text;
      const edit = () => editBlock(doc, id, oldText, oldText.replace("mobile", "desktop"));
      expect(edit).toThrow(InvalidFigmaError);
      expect(edit).toThrow("Stored Figma shape is unsupported; it cannot be rewritten");
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      doc.destroy();
    }
  });
});
