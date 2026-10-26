import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  CARD_PARTS, COMMENT_MARK, appendBlock, cardPartTexts, createAnnotation,
  editBlock, figmaCaptionTexts, findBlockElement, getAnnotation, getBlock,
  initDoc, resolveAnnotationRange, tableCellTexts, tableRows, writeGfmTable,
  type CardPart,
} from "../src/index.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEIGHBOUR = "Neighbour context";
const SURFACES = ["prose", "table", ...CARD_PARTS, "caption"] as const;
type Surface = typeof SURFACES[number];

function fixture(surface: Surface, value: string) {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Comment edits" });
  const source = (next: string): string => {
    if (surface === "prose") return next;
    if (surface === "table") return writeGfmTable([["Heading", "Other"], [next, NEIGHBOUR]]);
    if (surface === "caption") return `url: https://www.figma.com/design/Abc123/File\n\n${next}`;
    const parts = Object.fromEntries(CARD_PARTS.map((part) => [part, part === surface ? next : NEIGHBOUR]));
    return `label: ${parts.label}\ntitle: ${parts.title}\nfooter: ${parts.footer}\n\n${parts.body}`;
  };
  const type = surface === "prose" ? "paragraph" : surface === "table" ? "table" : surface === "caption" ? "figma" : "card";
  const id = appendBlock(doc, { type, text: source(value) });
  const block = findBlockElement(doc, id)!;
  const outside = appendBlock(doc, { type: "paragraph", text: NEIGHBOUR });
  const outsideText = findBlockElement(doc, outside)!.firstChild as Y.XmlText;
  const texts = surface === "prose" ? [block.firstChild as Y.XmlText]
    : surface === "table" ? tableRows(block).flatMap((row) => row.flatMap((cell) => tableCellTexts(cell)))
      : surface === "caption" ? figmaCaptionTexts(block)
        : CARD_PARTS.flatMap((part) => cardPartTexts(block, part));
  const text = surface === "prose" ? texts[0]!
    : surface === "table" ? tableCellTexts(tableRows(block)[1]![0]!)[0]!
      : surface === "caption" ? texts[0]!
        : cardPartTexts(block, surface)[0]!;
  const neighbours = [...texts.filter((candidate) => candidate !== text), outsideText];
  const beforeNeighbours = neighbours.map((neighbour) => neighbour.toDelta());
  const target = surface === "table" ? { row: 1, column: 0 }
    : surface === "prose" ? undefined : { part: surface as CardPart | "caption" };
  return {
    doc, id, text,
    annotate(start: number, end: number) {
      return createAnnotation(doc, id, start, end, "Reader", "Question", target).id;
    },
    edit(next: string) {
      editBlock(doc, id, getBlock(doc, id)!.text, source(next));
      expect(neighbours.map((neighbour) => neighbour.toDelta())).toEqual(beforeNeighbours);
    },
  };
}

function markedRuns(text: Y.XmlText, threadId: string): Array<{ start: number; end: number; text: string }> {
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  let offset = 0;
  for (const run of text.toDelta()) {
    const value = run.insert as string;
    if (run.attributes?.[COMMENT_MARK]?.threadId === threadId) {
      const previous = ranges.at(-1);
      if (previous?.end === offset) {
        previous.end += value.length;
        previous.text += value;
      } else {
        ranges.push({ start: offset, end: offset + value.length, text: value });
      }
    }
    offset += value.length;
  }
  return ranges;
}

function covered(text: Y.XmlText, threadId: string): string[] {
  return markedRuns(text, threadId).map((run) => run.text);
}

function withoutComments(text: Y.XmlText) {
  const runs: Array<{ insert: string; attributes?: Record<string, unknown> }> = [];
  for (const entry of text.toDelta()) {
    const attributes: Record<string, unknown> = { ...entry.attributes };
    delete attributes[COMMENT_MARK];
    const run = Object.keys(attributes).length === 0 ? { insert: entry.insert as string } : { insert: entry.insert as string, attributes };
    const previous = runs.at(-1);
    if (previous !== undefined && JSON.stringify(previous.attributes) === JSON.stringify(run.attributes)) previous.insert += run.insert;
    else runs.push(run);
  }
  return runs;
}

describe.each(SURFACES)("comment anchors through %s edits", (surface) => {
  it.each([
    ["Parti[cpating]", "Participating", "cipating", "cipating"],
    ["Engaged ([participating])", "Participating", "articipating", "articipating"],
    ["Hello [world] today", "Hello wonderful world today", "wonderful world", "wonderful world"],
    ["Hello [world] today", "Hello globe today", "lobe", "globe"],
    ["ab [cd] ef", "ab cxd ef", "cxd", "cxd"],
    ["Hello [world]", "Hello worlds", "worlds", "world"],
  ])("keeps one range when %s becomes %s", (marked, next, prose, structured) => {
    const start = marked.indexOf("[");
    const end = marked.indexOf("]") - 1;
    const current = fixture(surface, marked.replace("[", "").replace("]", ""));
    const thread = current.annotate(start, end);
    current.edit(next);
    expect(covered(current.text, thread)).toEqual([surface === "prose" ? prose : structured]);
    current.doc.destroy();
  });

  it.each(["start", "end"] as const)("keeps the existing %s-edge insertion rule", (edge) => {
    const current = fixture(surface, "Hello world today");
    const thread = current.annotate(6, 11);
    current.edit(edge === "start" ? "Hello Xworld today" : "Hello worldX today");
    expect(covered(current.text, thread)).toEqual([edge === "end" && surface === "prose" ? "worldX" : "world"]);
    current.doc.destroy();
  });

  it("widens surviving one- and two-character anchors to their word", () => {
    const current = fixture(surface, "Hello abcd today");
    const thread = current.annotate(6, 10);
    current.edit("Hello zaq today");
    expect(covered(current.text, thread)).toEqual(["zaq"]);
    current.doc.destroy();
  });

  it("widens a short word to three characters within the same text", () => {
    const current = fixture(surface, "Hello brave world");
    const thread = current.annotate(6, 11);
    current.edit("Hello be world");
    expect(covered(current.text, thread)).toEqual(["be "]);
    current.doc.destroy();
  });

  it.each([1, 2])("preserves an unchanged deliberately short anchor of %s characters", (length) => {
    const current = fixture(surface, "abc def");
    const thread = current.annotate(1, 1 + length);
    current.edit("Xabc def");
    expect(covered(current.text, thread)).toEqual(["bc".slice(0, length)]);
    current.doc.destroy();
  });

  it("widens a deliberately short anchor only when the edit shortens it", () => {
    const current = fixture(surface, "abc def");
    const thread = current.annotate(1, 3);
    current.edit("ac def");
    expect(covered(current.text, thread)).toEqual(["ac "]);
    current.doc.destroy();
  });

  it("stops widening at another thread on either side", () => {
    const current = fixture(surface, "abcdef");
    const thread = current.annotate(1, 5);
    const before = current.annotate(0, 1);
    const after = current.annotate(5, 6);
    current.edit("abf");
    expect(covered(current.text, thread)).toEqual(["b"]);
    expect(covered(current.text, before)).toEqual(["a"]);
    expect(covered(current.text, after)).toEqual(["f"]);
    current.doc.destroy();
  });

  it("does not treat different adjacent threads as one interior range", () => {
    const current = fixture(surface, "ab");
    const first = current.annotate(0, 1);
    const second = current.annotate(1, 2);
    current.edit("axb");
    expect(covered(current.text, first)).toEqual([surface === "prose" ? "ax" : "a"]);
    expect(covered(current.text, second)).toEqual(["b"]);
    current.doc.destroy();
  });

  it("keeps existing fragments and short anchors unchanged by an unrelated edit", () => {
    const current = fixture(surface, "ab cd ef");
    const thread = current.annotate(0, 5);
    current.text.format(2, 1, { [COMMENT_MARK]: null });
    current.edit("Xab cd ef");
    expect(covered(current.text, thread)).toEqual(["ab", "cd"]);
    current.doc.destroy();
  });

  it("widens by whole Unicode characters without splitting a surrogate pair", () => {
    const current = fixture(surface, "abcd🐈?");
    const thread = current.annotate(0, 4);
    current.edit("a🐈?");
    expect(markedRuns(current.text, thread)).toEqual([{ start: 0, end: 4, text: "a🐈?" }]);
    current.doc.destroy();
  });

  it.each(["a", "ab"])("uses only the whole target text when it is shorter than three characters: %s", (next) => {
    const current = fixture(surface, "abcd");
    const thread = current.annotate(0, 4);
    current.edit(next);
    expect(covered(current.text, thread)).toEqual([next]);
    current.doc.destroy();
  });

  it("leaves the thread orphaned when every marked character is deleted", () => {
    const current = fixture(surface, "Hello brave world");
    const thread = current.annotate(6, 11);
    current.edit("Hello world");
    expect(covered(current.text, thread)).toEqual([]);
    expect(resolveAnnotationRange(current.doc, thread)).toBeNull();
    expect(getAnnotation(current.doc, thread)?.comments).toHaveLength(1);
    current.doc.destroy();
  });

  it("changes only comment inheritance, preserving the formatting diff", () => {
    const old = "abXXcd **bold** *italic* ~~strike~~ `code` [link](https://example.test)";
    const next = "abYYcd **new bold** *italic* ~~strike~~ `code` [link](https://example.test/changed)";
    const current = fixture(surface, old);
    const control = fixture(surface, old);
    const thread = current.annotate(0, 6);
    current.edit(next);
    control.edit(next);
    expect(covered(current.text, thread)).toEqual(["abYYcd"]);
    expect(withoutComments(current.text)).toEqual(withoutComments(control.text));
    current.doc.destroy();
    control.doc.destroy();
  });

  it("publishes widening in the same transaction as the text edit", () => {
    const current = fixture(surface, "Hello brave world");
    const thread = current.annotate(6, 11);
    const observed: string[][] = [];
    current.doc.on("update", () => observed.push(covered(current.text, thread)));
    current.edit("Hello be world");
    expect(observed).toEqual([["be "]]);
    current.doc.destroy();
  });
});

it("uses stored table-cell offsets when projection trims edge whitespace", () => {
  const current = fixture("table", "ab cd ef");
  current.text.insert(0, "  ");
  current.text.insert(current.text.length, "  ");
  const thread = current.annotate(5, 7);
  current.edit("ab cxd ef");
  expect(current.text.toString()).toContain("  ab ");
  expect(markedRuns(current.text, thread)).toEqual([{ start: 5, end: 8, text: "cxd" }]);
  current.doc.destroy();
});
