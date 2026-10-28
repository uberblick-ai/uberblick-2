import { Extension } from "@tiptap/core";
import { gapCursor } from "@tiptap/pm/gapcursor";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";

export const DividerBlocks = Extension.create<{ allowPaste: boolean }>({
  name: "uberblickDividerBlocks",
  addOptions: () => ({ allowPaste: true }),
  addProseMirrorPlugins() {
    return [gapCursor(), new Plugin({
      props: {
        clipboardTextParser: (text, $context, _plainText, view) => {
          // Keep ProseMirror's paragraph-per-line parsing, including its collapse
          // of consecutive newlines. Only a literal rule after a blank line differs.
          const parts = text.split(/((?:\r\n?|\n)+)/);
          const isDivider = (index: number): boolean => this.options.allowPaste &&
            ($context.depth === 0 || $context.depth === 1 && $context.parent.type.name === "paragraph") && parts[index] === "---" &&
            (parts[index - 1]?.replace(/\r\n?/g, "\n").length ?? 0) > 1;
          const { schema } = view.state;
          const serializer = DOMSerializer.fromSchema(schema);
          const marks = $context.marks();
          const dom = document.createElement("div");
          parts.forEach((line, index) => {
            if (index % 2 !== 0) return;
            const block = dom.appendChild(document.createElement(isDivider(index) ? "hr" : "p"));
            if (block.tagName === "P" && line !== "") block.appendChild(serializer.serializeNode(schema.text(line, marks)));
          });
          const parser = view.someProp("clipboardParser") ?? view.someProp("domParser") ?? DOMParser.fromSchema(schema);
          return parser.parseSlice(dom, { preserveWhitespace: true, context: $context });
        },
      },
    })];
  },
});
