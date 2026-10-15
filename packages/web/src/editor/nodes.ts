/**
 * Mirror schema-owned elements and marks exactly; StarterKit's wider palette
 * and nested list trees cannot preserve block-scoped storage. Lists remain flat
 * list-item blocks with string list/indent attributes.
 *
 * Declare every top-level id: updateYFragment removes undeclared attributes.
 * Keep attribute values as stored strings because y-prosemirror compares with
 * !==; clamp level and indent only while rendering.
 *
 * Every text block allows comment anchors. Source blocks allow only comment;
 * the palette gate rejects other marks before binding. TableKit cells and card
 * parts hold one prose paragraph with formatting, links and comments.
 */

import { Node, Mark, mergeAttributes } from "@tiptap/core";
import { COMMENT_MARK, MAX_LIST_INDENT } from "@uberblick/schema";
import type { HeadingLevel, ListIndent } from "@uberblick/schema";
import { PROSE_MARKS, inlineMarkExtensions } from "./marks.js";
import {
  codeBlockChrome,
  sourceBlockView,
} from "./source-chrome.js";
import { TableNodes } from "./table.js";
import { terminalBlockView } from "./terminal.js";
import type * as Y from "yjs";
import { chartBlockView } from "./chart.js";
import { wireframeBlockView } from "./wireframe.js";
import { mermaidBlockView } from "./mermaid.js";
import { Card, CardParts } from "./card.js";
import { Figma, FigmaCaption } from "./figma.js";

/**
 * BlockIds assigns null ids. y-prosemirror skips null attributes, so a transient
 * null must not clear an existing document id.
 */
const idAttribute = {
  default: null as string | null,
  parseHTML: (element: HTMLElement): string | null => element.getAttribute("id"),
  renderHTML: (attributes: Record<string, unknown>): Record<string, string> =>
    typeof attributes.id === "string" ? { id: attributes.id } : {},
};

const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

/**
 * Clamp a stored `level` to a renderable heading level. Render-time only: the
 * attribute itself keeps whatever the document holds.
 */
export function renderableHeadingLevel(raw: unknown): HeadingLevel {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (Number.isNaN(parsed)) return 1;
  if (parsed < 1) return 1;
  if (parsed > 6) return 6;
  return parsed as HeadingLevel;
}

/**
 * Clamp a stored `indent` to a depth the stylesheet can draw. Render-time only,
 * like the heading level: the attribute keeps whatever the document holds.
 */
export function renderableIndent(raw: unknown): ListIndent {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  if (parsed > MAX_LIST_INDENT) return MAX_LIST_INDENT as ListIndent;
  return parsed as ListIndent;
}

export const Doc = Node.create({
  name: "doc",
  topNode: true,
  // The document is a flat sequence of blocks. Tables and cards hold their
  // structured prose parts below that top level.
  content: "block+",
});

export const Text = Node.create({
  name: "text",
  group: "inline",
});

export const Paragraph = Node.create({
  name: "paragraph",
  group: "block",
  content: "inline*",
  marks: PROSE_MARKS,
  addAttributes() {
    return { id: idAttribute };
  },
  parseHTML() {
    return [{ tag: "p" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["p", mergeAttributes({ class: "ub-paragraph" }, HTMLAttributes), 0];
  },
});

export const Heading = Node.create({
  name: "heading",
  group: "block",
  content: "inline*",
  marks: PROSE_MARKS,
  defining: true,
  addAttributes() {
    return {
      id: idAttribute,
      // Preserve the stored string; y-prosemirror compares attributes verbatim.
      level: {
        default: "1",
        parseHTML: (element: HTMLElement): string =>
          String(renderableHeadingLevel(element.tagName.replace(/^H/i, ""))),
        // The level is carried by the tag name; do not also emit it as an
        // attribute named `level`, which is not valid HTML on a heading.
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-level": String(attributes.level ?? "1"),
        }),
      },
    };
  },
  parseHTML() {
    return HEADING_LEVELS.map((level) => ({ tag: `h${level}` }));
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      `h${renderableHeadingLevel(node.attrs.level)}`,
      mergeAttributes({ class: "ub-heading" }, HTMLAttributes),
      0,
    ];
  },
});

/**
 * Render flat items as li so clipboard lists round-trip one item per line.
 * listStructurePlugin supplies schema-aligned numbering and accessible list
 * containers; CSS renders data-list/data-indent/data-number markers.
 */
export const ListItem = Node.create({
  name: "list-item",
  group: "block",
  content: "inline*",
  marks: PROSE_MARKS,
  addAttributes() {
    return {
      id: idAttribute,
      // Preserve stored strings; clamp only rendering.
      list: {
        default: "bullet",
        parseHTML: (element: HTMLElement): string =>
          element.getAttribute("data-list") === "ordered" ? "ordered" : "bullet",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-list": String(attributes.list ?? "bullet"),
        }),
      },
      indent: {
        default: "0",
        parseHTML: (element: HTMLElement): string =>
          String(renderableIndent(element.getAttribute("data-indent"))),
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-indent": String(renderableIndent(attributes.indent)),
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "li" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["li", mergeAttributes({ class: "ub-list-item" }, HTMLAttributes), 0];
  },
});

/**
 * One block per quote; nested quotes are outside this schema.
 */
export const Quote = Node.create({
  name: "quote",
  group: "block",
  content: "inline*",
  marks: PROSE_MARKS,
  addAttributes() {
    return { id: idAttribute };
  },
  parseHTML() {
    return [{ tag: "blockquote" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "blockquote",
      mergeAttributes({ class: "ub-quote ub-block-frame" }, HTMLAttributes),
      0,
    ];
  },
});

/**
 * A source-text block. `code: true` + `whitespace: "pre"` keep newlines and
 * runs of spaces intact, and make `newlineInCode` the right Enter behaviour.
 */
export const CodeBlock = Node.create({
  name: "code",
  group: "block",
  content: "text*",
  marks: COMMENT_MARK,
  code: true,
  defining: true,
  whitespace: "pre",
  addAttributes() {
    return {
      id: idAttribute,
      language: {
        default: null as string | null,
        parseHTML: (element: HTMLElement): string | null =>
          element.getAttribute("data-language"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.language === "string"
            ? { "data-language": attributes.language }
            : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "pre", preserveWhitespace: "full" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "pre",
      mergeAttributes({ class: "ub-code ub-block-frame" }, HTMLAttributes),
      ["code", {}, 0],
    ];
  },
  // Wireframe drawing is view chrome. Serialization still emits the ordinary
  // pre/code source, regardless of which editor view its language selects.
  addNodeView() {
    const ordinary = sourceBlockView(codeBlockChrome);
    const wireframe = wireframeBlockView();
    return (props) => {
      const rendered = props.node.attrs.language === "wireframe";
      const view = (rendered ? wireframe : ordinary)(props);
      const update = view.update;
      view.update = (node, decorations, innerDecorations) => {
        if ((node.attrs.language === "wireframe") !== rendered) return false;
        return update?.(node, decorations, innerDecorations) ?? false;
      };
      return view;
    };
  },
  // Keep the core Enter keymap: code enables newlineInCode, while a node-level
  // Enter override would also intercept paragraph splits.
});

/** Persist literal Mermaid source; the drawing belongs to its NodeView. */
export const Mermaid = Node.create({
  name: "mermaid",
  group: "block",
  content: "text*",
  marks: COMMENT_MARK,
  code: true,
  defining: true,
  whitespace: "pre",
  addAttributes() {
    return { id: idAttribute };
  },
  parseHTML() {
    return [{ tag: "div[data-block-type=mermaid]", preserveWhitespace: "full" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(
        { class: "ub-mermaid ub-block-frame", "data-block-type": "mermaid" },
        HTMLAttributes,
      ),
      ["pre", {}, 0],
    ];
  },
  addNodeView() {
    return mermaidBlockView();
  },
  // See CodeBlock: Enter is handled by the core keymap, driven by `code: true`.
});

/**
 * Persist only transcript source; playback state belongs to the NodeView and
 * must not enter the document.
 */
export const Terminal = Node.create({
  name: "terminal",
  group: "block",
  content: "text*",
  marks: COMMENT_MARK,
  code: true,
  defining: true,
  whitespace: "pre",
  addAttributes() {
    return { id: idAttribute };
  },
  parseHTML() {
    return [{ tag: "div[data-block-type=terminal]", preserveWhitespace: "full" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(
        { class: "ub-terminal ub-block-frame", "data-block-type": "terminal" },
        HTMLAttributes,
      ),
      ["pre", { class: "ub-terminal-source" }, 0],
    ];
  },
  addNodeView() {
    return terminalBlockView;
  },
  // See CodeBlock: Enter is handled by the core keymap, driven by `code: true`,
  // so a newline in the transcript is a newline and never a new block.
});

/** The versioned JSON mapping is ordinary, annotation-capable source text. */
export const ChartBlock = Node.create<{ ydoc: Y.Doc | null }>({
  name: "chart",
  group: "block",
  content: "text*",
  marks: COMMENT_MARK,
  code: true,
  defining: true,
  whitespace: "pre",
  addOptions() { return { ydoc: null }; },
  addAttributes() { return { id: idAttribute }; },
  parseHTML() {
    return [{ tag: "div[data-block-type=chart]", preserveWhitespace: "full" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ class: "ub-chart ub-block-frame", "data-block-type": "chart" }, HTMLAttributes),
      ["pre", { class: "ub-chart-source" }, 0]];
  },
  addNodeView() { return chartBlockView(this.options.ydoc); },
});

/**
 * Keep default self-exclusion: y-prosemirror otherwise hashes comment keys,
 * while the schema reads and writes the bare comment key.
 */
export const CommentMark = Mark.create({
  name: COMMENT_MARK,
  addAttributes() {
    return {
      threadId: {
        default: null as string | null,
        parseHTML: (element: HTMLElement): string | null =>
          element.getAttribute("data-comment-thread"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.threadId === "string"
            ? {
                "data-comment-thread": attributes.threadId,
                // Only attributed anchors are focusable controls. Enter/Space
                // share click activation into the rail. CommentAnchors owns
                // live views; these attributes cover static HTML/clipboard.
                tabindex: "0",
                role: "button",
                "aria-label": "Comment thread",
              }
            : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-thread]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ class: "ub-comment" }, HTMLAttributes),
      0,
    ];
  },
});

/** The palette, in the order the ProseMirror schema should see it. */
export const paletteExtensions = [
  Doc,
  Text,
  Paragraph,
  Heading,
  CodeBlock,
  Mermaid,
  ListItem,
  Quote,
  TableNodes,
  Terminal,
  ChartBlock,
  Card,
  ...CardParts,
  Figma,
  FigmaCaption,
  CommentMark,
  ...inlineMarkExtensions,
];
