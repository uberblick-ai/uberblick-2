import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlockInline, initDoc } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor, pastePlainText, typeText } from "./helpers.js";

const forms = [
  ["**", "bold"],
  ["__", "bold"],
  ["*", "italic"],
  ["_", "italic"],
  ["~~", "strike"],
  ["`", "inlineCode"],
] as const;
const prefixes = ["", " ", "(", "[", "{", '"', "'"];
const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function typingDoc() {
  const ydoc = new Y.Doc();
  initDoc(ydoc, {
    uuid: "22222222-3333-4444-5555-666666666666",
    title: "Inline marks",
  });
  const blockId = appendBlock(ydoc, { type: "paragraph" });
  const { editor } = mountEditor(ydoc);
  editors.push(editor);
  editor.commands.setTextSelection(1);
  return { ydoc, blockId, editor };
}

for (const [route, insert] of [
  ["typed", typeText],
  ["pasted", pastePlainText],
] as const) {
  describe(`${route} inline markdown`, () => {
    it.each(
      forms.flatMap(([delimiter, mark]) =>
        prefixes.map((prefix) => ({ delimiter, mark, prefix })),
      ),
    )(
      "opens $delimiter after '$prefix' and preserves the prefix",
      ({ delimiter, mark, prefix }) => {
        const { ydoc, blockId, editor } = typingDoc();
        insert(editor, `${prefix}${delimiter}ab${delimiter}`);

        expect(getBlockInline(ydoc, blockId)).toEqual([
          ...(prefix === "" ? [] : [{ text: prefix, marks: {} }]),
          { text: "ab", marks: { [mark]: true } },
        ]);
      },
    );

    it.each([
      ...forms.flatMap(([delimiter]) =>
        ["a", "1"].map((prefix) => `${prefix}${delimiter}ab${delimiter}`),
      ),
      "snake_case",
      "a*b*c",
      "x(y`ab`",
    ])("keeps intraword delimiters plain: %s", (text) => {
      const { ydoc, blockId, editor } = typingDoc();
      insert(editor, text);

      expect(getBlockInline(ydoc, blockId)).toEqual([{ text, marks: {} }]);
    });
  });
}

it.each([
  { before: "Call ", code: "def __init__(self)", after: " first" },
  { before: "Use ", code: 'if __name__ == "__main__":', after: " here" },
  { before: "", code: "a _b_ c", after: "" },
  { before: "", code: "f(*args*)", after: "" },
])("pastes inline code literally: $code", ({ before, code, after }) => {
  const { ydoc, blockId, editor } = typingDoc();
  pastePlainText(editor, `${before}\`${code}\`${after}`);

  expect(getBlockInline(ydoc, blockId)).toEqual([
    ...(before === "" ? [] : [{ text: before, marks: {} }]),
    { text: code, marks: { inlineCode: true } },
    ...(after === "" ? [] : [{ text: after, marks: {} }]),
  ]);
});

it("pastes marks outside code without changing any delimiter family inside it", () => {
  const { ydoc, blockId, editor } = typingDoc();
  const prose = "**bold** __also bold__ *italic* _also italic_ ~~strike~~";
  const code = "**bold** __bold__ *italic* _italic_ ~~strike~~";
  pastePlainText(editor, `${prose} \`${code}\` ${prose}`);

  const markedProse = [
    { text: "bold", marks: { bold: true } },
    { text: " ", marks: {} },
    { text: "also bold", marks: { bold: true } },
    { text: " ", marks: {} },
    { text: "italic", marks: { italic: true } },
    { text: " ", marks: {} },
    { text: "also italic", marks: { italic: true } },
    { text: " ", marks: {} },
    { text: "strike", marks: { strike: true } },
  ];
  expect(getBlockInline(ydoc, blockId)).toEqual([
    ...markedProse,
    { text: " ", marks: {} },
    { text: code, marks: { inlineCode: true } },
    { text: " ", marks: {} },
    ...markedProse,
  ]);
});

it("pastes a complete inline code span within an outer mark", () => {
  const { ydoc, blockId, editor } = typingDoc();
  pastePlainText(editor, "**outer `code` outer**");

  expect(getBlockInline(ydoc, blockId)).toEqual([
    { text: "outer ", marks: { bold: true } },
    { text: "code", marks: { bold: true, inlineCode: true } },
    { text: " outer", marks: { bold: true } },
  ]);
});

it.each([
  { boundary: "opening", before: "*outside ", code: "code* literal", after: "" },
  { boundary: "closing", before: "", code: "literal *code", after: " outside*" },
])(
  "keeps formatting delimiters crossing the $boundary code boundary literal",
  ({ before, code, after }) => {
    const { ydoc, blockId, editor } = typingDoc();
    pastePlainText(editor, `${before}\`${code}\`${after}`);

    expect(getBlockInline(ydoc, blockId)).toEqual([
      ...(before === "" ? [] : [{ text: before, marks: {} }]),
      { text: code, marks: { inlineCode: true } },
      ...(after === "" ? [] : [{ text: after, marks: {} }]),
    ]);
  },
);

it.each(forms.filter(([, mark]) => mark !== "inlineCode"))(
  "does not start %s inside existing inline code",
  (delimiter) => {
    const { ydoc, blockId, editor } = typingDoc();
    typeText(editor, "`code`");
    editor.commands.setTextSelection(3);
    typeText(editor, `(${delimiter}ab${delimiter}`);

    expect(getBlockInline(ydoc, blockId)).toEqual([
      { text: `co(${delimiter}ab${delimiter}de`, marks: { inlineCode: true } },
    ]);
  },
);
