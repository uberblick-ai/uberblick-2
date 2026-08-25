/**
 * The editor palette: six custom block nodes, six marks, nothing else.
 *
 * The marks live in marks.ts — the five inline ones (`bold`, `italic`, `strike`,
 * `inlineCode`, `link`) plus the `comment` anchor defined below. StarterKit is
 * deliberately absent. Every node here mirrors a schema-owned Y.XmlElement
 * one-for-one:
 *
 *   <paragraph id="…">        Y.XmlText
 *   <heading   id="…" level="2">  Y.XmlText
 *   <code      id="…" language="ts">  Y.XmlText
 *   <mermaid   id="…">        Y.XmlText
 *   <list-item id="…" list="bullet" indent="1">  Y.XmlText
 *   <quote     id="…">        Y.XmlText
 *
 * A list is a *run* of adjacent `list-item` blocks, exactly as markdown means
 * it — no `bulletList` wrapper, no nested `listItem` tree. Stock Tiptap's list
 * extensions were rejected for that reason (#59): a nested tree has no
 * block-scoped text for an agent to edit, which is the contract the whole model
 * rests on. Depth is the `indent` attribute, and the keyboard that changes it
 * lives in list-keys.ts.
 *
 * Three non-obvious constraints, each of which comes from reading
 * y-prosemirror's sync-plugin rather than from taste:
 *
 * 1. **Every node declares `id`.** `updateYFragment` removes any Yjs attribute
 *    that is `undefined` in `node.attrs`. An undeclared `id` would therefore be
 *    stripped from the Y.XmlElement the first time the editor wrote the block —
 *    the block would lose its identity and orphan every reference to it.
 *
 * 2. **Attribute values stay strings, verbatim.** Both `equalAttrs` and
 *    `updateYFragment` compare Yjs attributes to ProseMirror attributes with
 *    `!==`. The schema writes `level` as the string `"2"`, so parsing it to the
 *    number `2` here would make every comparison fail and rewrite the attribute
 *    on the first keystroke. `level` is a string in this schema for exactly that
 *    reason; clamping to 1–6 happens at render time only, so the stored value
 *    round-trips untouched.
 *
 * 3. **Every node allows the `comment` mark, including `code`.** Annotation
 *    threads are anchored by a `comment` formatting mark on the block's
 *    Y.XmlText, and an agent may annotate a code block. A `marks: ""` node spec
 *    would make `schema.text(…, [commentMark])` throw, and y-prosemirror's catch
 *    block **deletes the Y.XmlText from the document** — data loss, not a render
 *    failure.
 *
 *    Prose blocks take `PROSE_MARKS` on top of that — the inline set. `code` and
 *    `mermaid` never do: their text is source, so `comment` is the only mark
 *    they may hold, and an inline mark found inside one is foreign content the
 *    palette gate refuses to bind (see palette.ts).
 */

import { Node, Mark, mergeAttributes } from "@tiptap/core";
import { COMMENT_MARK, MAX_LIST_INDENT } from "@uberblick/schema";
import type { HeadingLevel, ListIndent } from "@uberblick/schema";
import { PROSE_MARKS, inlineMarkExtensions } from "./marks.js";
import {
  codeBlockChrome,
  mermaidChrome,
  sourceBlockView,
} from "./source-chrome.js";

/**
 * The stable block id, assigned by `BlockIds` (see block-ids.ts) and owned by
 * the schema package everywhere else. `null` means "not yet assigned" — a null
 * attribute is skipped by y-prosemirror's attribute writer, so a transient null
 * never clears an existing id in the document.
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
  // The document is a flat sequence of blocks. No nesting, ever — the schema
  // package's `blocks` fragment has exactly one level.
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
      // A string, on purpose — see the module comment, constraint 2.
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
 * One item of a list. Flat: `list` is its marker and `indent` its depth, and
 * the run of items around it is the list.
 *
 * Rendered as a bare `<li>` — no `<ul>` to put it in, since the document has no
 * nesting to build one from. The marker is drawn by CSS off `data-list` and
 * `data-indent` (ordered numbering included, by counters); see styles.css. A
 * bare `<li>` is also what makes a list copied out of this editor paste back as
 * list items, and what lets an HTML list pasted *in* land as one item per line.
 */
export const ListItem = Node.create({
  name: "list-item",
  group: "block",
  content: "inline*",
  marks: PROSE_MARKS,
  addAttributes() {
    return {
      id: idAttribute,
      // Strings, verbatim, like every other attribute — see constraint 2.
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

/** A block quote. One block, one quote — nested quotes are out of scope (#59). */
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
      mergeAttributes({ class: "ub-quote" }, HTMLAttributes),
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
      mergeAttributes({ class: "ub-code" }, HTMLAttributes),
      ["code", {}, 0],
    ];
  },
  // Same DOM as `renderHTML` above, plus a copy button in the chrome (#103).
  // `renderHTML` still governs serialization — getHTML, copy, paste — so the
  // button exists only while the block is on screen.
  addNodeView() {
    return sourceBlockView(codeBlockChrome);
  },
  // No Enter override. Tiptap's core `keymap` extension already chains
  // newlineInCode → createParagraphNear → liftEmptyBlock → splitBlock, and
  // `code: true` above is what makes its first link fire inside this node. A
  // node-level `Enter` binding wins over that chain *globally* — not just
  // inside this node — which silently breaks Enter in paragraphs.
});

/**
 * Mermaid source, rendered as plain text in a styled block.
 *
 * A live mermaid renderer is explicitly out of scope: rendering the diagram
 * would mean a second representation of the block's text, and the whole point
 * of the model is that the Y.XmlText is the only representation.
 */
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
        { class: "ub-mermaid", "data-block-type": "mermaid" },
        HTMLAttributes,
      ),
      ["pre", {}, 0],
    ];
  },
  // Mermaid source is text people take away too — see CodeBlock's node view.
  addNodeView() {
    return sourceBlockView(mermaidChrome);
  },
  // See CodeBlock: Enter is handled by the core keymap, driven by `code: true`.
});

/**
 * The annotation anchor.
 *
 * `excludes` is left at its ProseMirror default — "exclusive with marks of the
 * same type". That is load-bearing: y-prosemirror's `marksToAttributes` checks
 * `mark.type.excludes(mark.type)` and, when a mark type does *not* exclude
 * itself, writes the Yjs attribute under a hashed key (`comment--A1b2C3d4`)
 * instead of the bare mark name. The schema package writes and reads the bare
 * key `comment`, so setting `excludes: ""` here would silently stop annotations
 * round-tripping. Do not touch it.
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
                // The keyboard's half of the prose→rail link (#101). A
                // highlight is a control: Tab reaches it, Enter and Space
                // activate it through the same delegated handler the click
                // goes through, and focus lands on the thread's card.
                //
                // On the attribute rather than in `renderHTML` below, so the
                // three ride exactly with `data-comment-thread`: a mark with
                // no thread id has nothing to activate, and a focusable span
                // that does nothing is a tab stop that wastes the reader's
                // time.
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
  CommentMark,
  ...inlineMarkExtensions,
];
