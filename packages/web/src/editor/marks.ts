/**
 * Keep schema wire values: bare mark keys, {} for flags, {href} for external
 * links and {docId} for document links. Stock link attrs would persist rendering
 * policy; target/rel stay render-only. Every mark excludes itself or y-prosemirror
 * hashes its key. Link marks additionally exclude each other.
 *
 * Use shared isExternalHref/canonicalDocumentUuid at every input, paste and HTML
 * boundary. inlineCode has code:true to suppress neighboring input rules; its
 * name differs from the code node because schema node/mark names cannot collide.
 *
 * Keep delimiter boundaries outside matches with lookbehind: rule runners delete
 * matched punctuation prefixes. Paste starts are boundaries even inside words.
 * Accept underscore forms with flanking rules while export writes asterisks.
 */

import {
  InputRule,
  Mark,
  markInputRule,
  markPasteRule,
  mergeAttributes,
} from "@tiptap/core";
import type { PasteRuleFinder } from "@tiptap/core";
import type { MarkType } from "@tiptap/pm/model";
import {
  COMMENT_MARK,
  INLINE_MARKS,
  canonicalDocumentUuid,
  isExternalHref,
} from "@uberblick/schema";

/**
 * The marks a prose block may carry: the closed inline set plus the annotation
 * anchor, as a ProseMirror `marks` spec. Source blocks take
 * `COMMENT_MARK` alone.
 */
export const PROSE_MARKS: string = [...INLINE_MARKS, COMMENT_MARK].join(" ");

const BOLD_INPUT = /(?<=^|[\s([{"'])(\*\*(?!\s+\*\*)([^*]+)\*\*)$/;
const BOLD_UNDERSCORE_INPUT = /(?<=^|[\s([{"'])(__(?!\s+__)([^_]+)__)$/;
const BOLD_PASTE = /(?<=^|[\s([{"'])(\*\*(?!\s+\*\*)([^*]+)\*\*)/g;
const BOLD_UNDERSCORE_PASTE = /(?<=^|[\s([{"'])(__(?!\s+__)([^_]+)__)/g;
const ITALIC_INPUT = /(?<=^|[\s([{"'])(\*(?!\s+\*)([^*]+)\*)$/;
const ITALIC_UNDERSCORE_INPUT = /(?<=^|[\s([{"'])(_(?!\s+_)([^_]+)_)$/;
const ITALIC_PASTE = /(?<=^|[\s([{"'])(\*(?!\s+\*)([^*]+)\*)/g;
const ITALIC_UNDERSCORE_PASTE = /(?<=^|[\s([{"'])(_(?!\s+_)([^_]+)_)/g;
const STRIKE_INPUT = /(?<=^|[\s([{"'])(~~(?!\s+~~)([^~]+)~~)$/;
const STRIKE_PASTE = /(?<=^|[\s([{"'])(~~(?!\s+~~)([^~]+)~~)/g;
const CODE_INPUT = /(?<=^|[\s([{"'])(`([^`]+)`)$/;
const CODE_PASTE = /(?<=^|[\s([{"'])(`([^`]+)`)/g;
const LINK_INPUT = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/;
const LINK_PASTE = /https?:\/\/[^\s<>"]+/g;

/**
 * Formatting paste rules run before inline code. Filter delimiters inside its
 * raw backtick spans, retaining valid matches in the same paste and allowing
 * an outer mark around a whole code span. Returning null from a rule handler
 * would discard that rule's entire transaction, including valid matches.
 */
function outsideCode(pattern: RegExp): PasteRuleFinder {
  return (text) => {
    const codeSpans = [...text.matchAll(CODE_PASTE)];
    return [...text.matchAll(pattern)]
      .filter((match) => {
        const matchEnd = match.index + match[0].length;
        return !codeSpans.some((code) => {
          const codeEnd = code.index + code[0].length;
          return (
            (code.index <= match.index && match.index < codeEnd) ||
            (code.index < matchEnd && matchEnd <= codeEnd)
          );
        });
      })
      .map((match) => ({
        index: match.index,
        text: match[0],
        // These patterns all capture the marked content last.
        replaceWith: match[2] ?? "",
      }));
  };
}

function formattingPasteRule(find: RegExp, type: MarkType) {
  const rule = markPasteRule({ find: outsideCode(find), type });
  const handler = rule.handler;
  rule.handler = (props) => {
    const { state, range } = props;
    const doc = state.tr.doc;
    // Tiptap revisits rules after the code rule removes backticks. Skip only
    // delimiters covered by a code mark; an outer mark may contain code.
    if (
      [range.from, range.to - 1].some((pos) =>
        doc.nodeAt(pos)?.marks.some((mark) => mark.type.spec.code),
      )
    ) {
      return;
    }
    return handler(props);
  };
  return rule;
}

export const Bold = Mark.create({
  name: "bold",
  parseHTML() {
    return [{ tag: "strong" }, { tag: "b" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["strong", mergeAttributes(HTMLAttributes), 0];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-b": () => this.editor.commands.toggleMark(this.name),
      "Mod-B": () => this.editor.commands.toggleMark(this.name),
    };
  },
  addInputRules() {
    return [
      markInputRule({ find: BOLD_INPUT, type: this.type }),
      markInputRule({ find: BOLD_UNDERSCORE_INPUT, type: this.type }),
    ];
  },
  addPasteRules() {
    return [
      formattingPasteRule(BOLD_PASTE, this.type),
      formattingPasteRule(BOLD_UNDERSCORE_PASTE, this.type),
    ];
  },
});

export const Italic = Mark.create({
  name: "italic",
  parseHTML() {
    return [{ tag: "em" }, { tag: "i" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["em", mergeAttributes(HTMLAttributes), 0];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-i": () => this.editor.commands.toggleMark(this.name),
      "Mod-I": () => this.editor.commands.toggleMark(this.name),
    };
  },
  addInputRules() {
    return [
      markInputRule({ find: ITALIC_INPUT, type: this.type }),
      markInputRule({ find: ITALIC_UNDERSCORE_INPUT, type: this.type }),
    ];
  },
  addPasteRules() {
    return [
      formattingPasteRule(ITALIC_PASTE, this.type),
      formattingPasteRule(ITALIC_UNDERSCORE_PASTE, this.type),
    ];
  },
});

const Strike = Mark.create({
  name: "strike",
  parseHTML() {
    return [{ tag: "s" }, { tag: "del" }, { tag: "strike" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["s", mergeAttributes(HTMLAttributes), 0];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-s": () => this.editor.commands.toggleMark(this.name),
    };
  },
  addInputRules() {
    return [markInputRule({ find: STRIKE_INPUT, type: this.type })];
  },
  addPasteRules() {
    return [formattingPasteRule(STRIKE_PASTE, this.type)];
  },
});

/**
 * code:true suppresses neighboring formatting input rules.
 */
const InlineCode = Mark.create({
  name: "inlineCode",
  code: true,
  parseHTML() {
    return [{ tag: "code" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "code",
      mergeAttributes({ class: "ub-inline-code" }, HTMLAttributes),
      0,
    ];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-e": () => this.editor.commands.toggleMark(this.name),
    };
  },
  addInputRules() {
    return [markInputRule({ find: CODE_INPUT, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: CODE_PASTE, type: this.type })];
  },
});

export const Link = Mark.create({
  name: "link",
  // Typing after a link must not extend it — an href is a property of the words
  // it was put on, not of the caret.
  inclusive: false,
  // Self-exclusion keeps a bare Yjs key; mutual exclusion keeps one link target.
  excludes: "link docLink",
  addAttributes() {
    return {
      href: {
        default: null as string | null,
        parseHTML: (element: HTMLElement): string | null =>
          element.getAttribute("href"),
        renderHTML: (attributes: Record<string, unknown>): Record<string, string> =>
          typeof attributes.href === "string" ? { href: attributes.href } : {},
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "a[href]",
        // Refuse non-external pasted hrefs; retain their text without a link mark.
        getAttrs: (element: HTMLElement): { href: string } | false => {
          const href = element.getAttribute("href") ?? "";
          return isExternalHref(href) ? { href } : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "a",
      mergeAttributes(
        {
          class: "ub-link",
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
        HTMLAttributes,
      ),
      0,
    ];
  },
  addInputRules() {
    const type = this.type;
    return [
      // Preserve the label: markInputRule would keep the last capture, the href.
      new InputRule({
        find: LINK_INPUT,
        handler: ({ state, range, match }) => {
          const label = match[1];
          const href = match[2];
          if (label === undefined || href === undefined) return null;
          state.tr.replaceWith(
            range.from,
            range.to,
            state.schema.text(label, [type.create({ href })]),
          );
          return undefined;
        },
      }),
    ];
  },
  addPasteRules() {
    return [
      markPasteRule({
        find: LINK_PASTE,
        type: this.type,
        getAttributes: (match) => ({ href: match[0] }),
      }),
    ];
  },
});

/**
 * Store UUID identity only. Per-workspace labels, availability and navigation
 * stay in doc-links.ts because the schema is shared across editors.
 * Render data-doc-id without href; addresses are derived by the live mark view.
 * Its HTML rule outranks external links and validates pasted identities.
 */
const DocLink = Mark.create({
  name: "docLink",
  inclusive: false,
  excludes: "docLink link",
  addAttributes() {
    return {
      docId: {
        default: null as string | null,
        // Tiptap runs this after getAttrs and its value wins, so canonicalize
        // here too: uppercase UUIDs must retain the same document identity.
        parseHTML: (element: HTMLElement): string | null =>
          canonicalDocumentUuid(element.getAttribute("data-doc-id")),
        renderHTML: (attributes: Record<string, unknown>): Record<string, string> =>
          typeof attributes.docId === "string"
            ? { "data-doc-id": attributes.docId }
            : {},
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "a[data-doc-id]",
        // Prefer validated data-doc-id over copied href. An invalid id can still
        // fall through to the independently validated external-link rule.
        priority: 60,
        // The paste door: a target that is not a document uuid is not a
        // reference, and the text comes through unmarked.
        getAttrs: (element: HTMLElement): { docId: string } | false => {
          const docId = canonicalDocumentUuid(element.getAttribute("data-doc-id"));
          return docId === null ? false : { docId };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["a", mergeAttributes({ class: "ub-doclink" }, HTMLAttributes), 0];
  },
});

/** The inline marks, in the order the ProseMirror schema should see them. */
export const inlineMarkExtensions = [
  Bold,
  Italic,
  Strike,
  InlineCode,
  Link,
  DocLink,
];
