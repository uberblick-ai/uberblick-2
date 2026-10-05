import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlockInline, initDoc } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor, typeText } from "./helpers.js";

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

/** ProseMirror's plain-text paste transaction, without jsdom's missing ClipboardEvent. */
function pastePlainText(editor: Editor, text: string): void {
  const { state } = editor.view;
  const { from, to } = state.selection;
  editor.view.dispatch(
    state.tr
      .insertText(text, from, to)
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste"),
  );
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
