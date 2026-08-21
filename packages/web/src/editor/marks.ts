/**
 * The inline marks: bold, italic, strike, inlineCode, link. Five marks,
 * hand-written, because the wire format is the contract and stock extensions do
 * not respect it.
 *
 * The schema package owns the vocabulary (`INLINE_MARKS`) and the storage: a mark
 * is a Yjs formatting attribute on the block's Y.XmlText, keyed by the bare mark
 * name, holding that mark's ProseMirror attrs — `{}` for the four flags,
 * `{ href }` for a link. Four constraints follow, and each one is the reason a
 * stock Tiptap mark is not used here:
 *
 * 1. **`excludes` stays at its ProseMirror default** ("exclusive with marks of
 *    the same type"). y-prosemirror's `marksToAttributes` checks
 *    `mark.type.excludes(mark.type)` and, for a mark that does not exclude
 *    itself, writes the Yjs attribute under a *hashed* key (`bold--A1b2C3d4`)
 *    instead of `bold`. Tiptap's own `Code` mark sets `excludes: "_"`, which is
 *    still self-excluding and would work — but writing it out here keeps every
 *    mark on the one rule the annotation anchor already documents. See the
 *    module comment in nodes.ts.
 * 2. **Only `link` declares an attribute, and only `href`.** Every declared
 *    attribute lands in the Yjs value; Tiptap's Link ships `target`, `rel` and
 *    `class` attributes, which would put three keys of rendering policy into the
 *    document. `target`/`rel` are render-time only here.
 * 3. **Links are external URLs only.** Doc-to-doc references are `meta.links` by
 *    UUID — never a link mark. The invariant is enforced at the model boundary
 *    (the schema package refuses to write another scheme, and its palette gate
 *    refuses to bind one that arrived over the wire); the three doors here — the
 *    input rule, the paste rule and HTML parsing — keep it from being reached in
 *    the first place, and share the schema's `isExternalHref` so there is one
 *    definition. No validation registry, no link resolver.
 * 4. **The `inlineCode` mark declares `code: true`.** Tiptap's input-rule runner
 *    skips every rule adjacent to a mark whose spec says `code`, which is what
 *    keeps `**x**` from turning into bold inside an inline code span. (Code
 *    *blocks* get this from the node spec, which is why no rule fires inside
 *    them.)
 *
 * The name is `inlineCode` and not `code` because ProseMirror refuses a schema
 * where one name is both a node and a mark, and `code` is a block type. A mark's
 * name is its Yjs key, so the schema package uses the same name — see
 * `INLINE_MARKS` there.
 *
 * Input rules take `(?:^|\s)` before the opening delimiter rather than
 * `[^delimiter]`: `markInputRule` deletes from the start of the match up to the
 * captured text, skipping leading *whitespace* only, so a non-space prefix in the
 * pattern is eaten along with the delimiter. Underscore forms (`__b__`, `_i_`)
 * are editor conveniences; markdown export always writes asterisks, and the
 * markdown reader treats `_` as an ordinary character.
 */

import {
  InputRule,
  Mark,
  markInputRule,
  markPasteRule,
  mergeAttributes,
} from "@tiptap/core";
import { COMMENT_MARK, INLINE_MARKS, isExternalHref } from "@uberblick/schema";

/**
 * The marks a prose block may carry: the closed inline set plus the annotation
 * anchor, as a ProseMirror `marks` spec. Source blocks (`code`, `mermaid`) take
 * `COMMENT_MARK` alone.
 */
export const PROSE_MARKS: string = [...INLINE_MARKS, COMMENT_MARK].join(" ");

const BOLD_INPUT = /(?:^|\s)(\*\*(?!\s+\*\*)([^*]+)\*\*)$/;
const BOLD_UNDERSCORE_INPUT = /(?:^|\s)(__(?!\s+__)([^_]+)__)$/;
const BOLD_PASTE = /(?:^|\s)(\*\*(?!\s+\*\*)([^*]+)\*\*)/g;
const ITALIC_INPUT = /(?:^|\s)(\*(?!\s+\*)([^*]+)\*)$/;
const ITALIC_UNDERSCORE_INPUT = /(?:^|\s)(_(?!\s+_)([^_]+)_)$/;
const ITALIC_PASTE = /(?:^|\s)(\*(?!\s+\*)([^*]+)\*)/g;
const STRIKE_INPUT = /(?:^|\s)(~~(?!\s+~~)([^~]+)~~)$/;
const STRIKE_PASTE = /(?:^|\s)(~~(?!\s+~~)([^~]+)~~)/g;
const CODE_INPUT = /(?:^|\s)(`([^`]+)`)$/;
const CODE_PASTE = /(?:^|\s)(`([^`]+)`)/g;
const LINK_INPUT = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/;
const LINK_PASTE = /https?:\/\/[^\s<>"]+/g;

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
    return [markPasteRule({ find: BOLD_PASTE, type: this.type })];
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
    return [markPasteRule({ find: ITALIC_PASTE, type: this.type })];
  },
});

export const Strike = Mark.create({
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
    return [markPasteRule({ find: STRIKE_PASTE, type: this.type })];
  },
});

/**
 * Inline code. `code: true` is what stops the other input rules from firing
 * next to it — see constraint 4 in the module comment.
 */
export const InlineCode = Mark.create({
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
        // The paste door. Pasted HTML is the one place a `mailto:`,
        // `javascript:` or in-app href could walk in, so anything that is not an
        // external URL is not a link — the text comes through unmarked.
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
      // Written out rather than built with `markInputRule`, which keeps the
      // *last* capture group as the text: here that is the href, and the label
      // is what has to survive.
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

/** The inline marks, in the order the ProseMirror schema should see them. */
export const inlineMarkExtensions = [Bold, Italic, Strike, InlineCode, Link];
