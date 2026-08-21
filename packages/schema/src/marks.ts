/**
 * Inline marks, on the wire.
 *
 * The five inline marks — `bold`, `italic`, `strike`, `inlineCode`, `link` — ride
 * the exact mechanism the annotation anchor already proved: Yjs text formatting
 * attributes on the block's single Y.XmlText. Nothing new is stored, and the
 * concurrency properties come for free — a mark is part of the text's own CRDT
 * state, so it survives splits, re-types (`setBlockType` replays the delta) and
 * concurrent edits, which a pair of stored positions would not.
 *
 * Three rules make the format work, and all three are load-bearing:
 *
 * 1. **Keys are the bare mark names; values are ProseMirror-shaped attributes.**
 *    `{}` for the four attribute-less marks, `{ href }` for `link`.
 *    y-prosemirror turns a text attribute into a mark named for its key with the
 *    value as that mark's attrs, so the editor needs no translation layer in
 *    either direction — the same reason `comment` stores `{ threadId }`.
 * 2. **Marks are not part of a block's `rev`.** A rev hashes the plain text and
 *    the block's attributes only (see `rev.ts`), so formatting a range never
 *    invalidates an edit a caller has already prepared. `editBlock` works on
 *    plain text for the same reason: `old_text`/`new_text` never mention marks.
 * 3. **The set is closed.** Anything else in a text's attributes is foreign
 *    content, and the web client refuses to bind rather than let y-prosemirror
 *    destroy it. `code` and `mermaid` blocks are source text and carry no inline
 *    marks at all — only `comment`.
 *
 * Writing and reading are deliberately asymmetric, the way the rest of the
 * package is:
 *
 *   - **Writing refuses.** A `link` target that is not an external `http(s)` URL
 *     throws {@link InvalidLinkHrefError} rather than reaching the CRDT. This is
 *     the model-level door for that invariant; the import parser and the editor's
 *     input/paste rules are conveniences in front of it, not the enforcement.
 *   - **Reading degrades.** A flag written as something other than `true` or an
 *     attribute object, or a `link` with no usable `href`, reads as "not marked".
 *     A reader must never break on a writer that knows more — and the loudness
 *     lives where it can act: the web client's palette gate refuses to bind a
 *     text carrying a mark it cannot faithfully render, including a `link` whose
 *     href is not external, so nothing reaches a renderer unchecked.
 */

import type * as Y from "yjs";
import { InvalidLinkHrefError } from "./errors.js";
import { COMMENT_MARK, isCommentMark } from "./types.js";
import type { InlineMarkSet, InlineRun } from "./types.js";

const FLAGS = ["bold", "italic", "strike", "inlineCode"] as const;

/**
 * The one definition of a legal inline-link target, shared by every door: this
 * module, the markdown reader, the editor's input and paste rules and the
 * palette gate. Doc-to-doc references are `meta.links` by UUID, never a link
 * mark, so nothing but an external `http(s)` URL is a link.
 */
export function isExternalHref(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\/\S+$/i.test(href);
}

/**
 * Whether a delta attribute's value means its mark is *on*, for every mark this
 * package knows — the five inline ones and the annotation anchor.
 *
 * This is the definition of "readable", and it is deliberately the only one:
 * every consumer has to agree with it or the document means two things at once.
 * The editor's palette gate asks this question too, and refuses to bind a text
 * whose answer is no, because y-prosemirror does *not* ask — `schema.mark` builds
 * a mark from any attrs object it is handed, so a `{bold: false}` that reads as
 * unmarked here would bind as bold there and be rewritten as real bold on the
 * next keystroke. Silent, and a divergence rather than a loss, which is worse.
 */
export function readsAsMark(name: string, value: unknown): boolean {
  if (name === COMMENT_MARK) return isCommentMark(value);
  if (name === "link") {
    return (
      typeof value === "object" &&
      value !== null &&
      isExternalHref((value as { href?: unknown }).href)
    );
  }
  // `{}` is what y-prosemirror writes for an attribute-less mark; `true` is what
  // a person writes by hand. Nothing else is this mark.
  if ((FLAGS as readonly string[]).includes(name)) {
    return value === true || (typeof value === "object" && value !== null);
  }
  return false;
}

/**
 * The inline marks in one delta op's attributes. Unknown keys are ignored, and so
 * is a known key whose value {@link readsAsMark} rejects.
 */
function marksOf(attributes: unknown): InlineMarkSet {
  if (typeof attributes !== "object" || attributes === null) return {};
  const source = attributes as Record<string, unknown>;
  const marks: InlineMarkSet = {};
  for (const flag of FLAGS) {
    if (readsAsMark(flag, source[flag])) marks[flag] = true;
  }
  if (readsAsMark("link", source.link)) {
    marks.link = (source.link as { href: string }).href;
  }
  return marks;
}

/** Whether two runs carry the same marks, so they can be merged. */
export function sameInlineMarks(a: InlineMarkSet, b: InlineMarkSet): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.inlineCode === b.inlineCode &&
    a.link === b.link
  );
}

/** Whether a run carries any inline mark at all. */
export function hasInlineMarks(marks: InlineMarkSet): boolean {
  return (
    marks.bold === true ||
    marks.italic === true ||
    marks.strike === true ||
    marks.inlineCode === true ||
    marks.link !== undefined
  );
}

/**
 * Append `text` to `runs`, merging into the last run when the marks match, so
 * the result is always maximal runs. Empty text is dropped.
 */
export function pushInlineRun(
  runs: InlineRun[],
  text: string,
  marks: InlineMarkSet,
): void {
  if (text === "") return;
  const last = runs[runs.length - 1];
  if (last !== undefined && sameInlineMarks(last.marks, marks)) {
    last.text += text;
    return;
  }
  runs.push({ text, marks });
}

/**
 * A Y.XmlText as maximal runs of equally-marked text. One delta scan.
 *
 * Embeds (non-string inserts, which this package never writes) contribute
 * nothing: they have no text, so there is no run to report.
 */
export function readInlineRuns(text: Y.XmlText | null): InlineRun[] {
  if (text === null) return [];
  const runs: InlineRun[] = [];
  for (const op of text.toDelta() as Array<{
    insert?: unknown;
    attributes?: unknown;
  }>) {
    if (typeof op.insert !== "string") continue;
    pushInlineRun(runs, op.insert, marksOf(op.attributes));
  }
  return runs;
}

/** The plain text of a run list — what `rev` hashes and `editBlock` edits. */
export function inlinePlainText(runs: readonly InlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

/**
 * One run's marks as Yjs formatting attributes, or null when it has none.
 *
 * @throws InvalidLinkHrefError when a `link` target is not an external URL. This
 * is the boundary the invariant is enforced at, so no caller — `appendBlock`, an
 * MCP tool, the seed importer — can put another scheme into the document.
 */
function attributesOf(marks: InlineMarkSet): Record<string, unknown> | null {
  const attributes: Record<string, unknown> = {};
  for (const flag of FLAGS) {
    if (marks[flag] === true) attributes[flag] = {};
  }
  if (marks.link !== undefined) {
    if (!isExternalHref(marks.link)) throw new InvalidLinkHrefError(marks.link);
    attributes.link = { href: marks.link };
  }
  return Object.keys(attributes).length === 0 ? null : attributes;
}

/**
 * Throw if any run carries a mark this package refuses to write, without
 * touching the document.
 *
 * A caller checks *before* it starts writing: a Yjs transaction does not roll
 * back when a callback throws, so validating halfway through would leave the
 * half that already applied behind.
 *
 * @throws InvalidLinkHrefError
 */
export function assertInlineWritable(runs: readonly InlineRun[]): void {
  for (const run of runs) attributesOf(run.marks);
}

/**
 * Every formatting key on a text that a source block cannot hold, in document
 * order.
 *
 * Deliberately *not* limited to the marks this package knows, and not filtered by
 * {@link readsAsMark}: the question is "would a block holding this text be
 * unbindable as a source block?", and the editor's gate judges a text by the
 * attribute keys it carries against what the node type allows. A key nothing here
 * recognises stops the editor just as dead as a known one, so it has to stop a
 * re-type too.
 *
 * `comment` is the one exemption, because it is the one mark every block type
 * allows — but only when its value is an anchor {@link readsAsMark} accepts. The
 * gate refuses a malformed one, so exempting it here would be this module saying
 * a re-type is fine and the editor then refusing to bind the result.
 */
export function marksOtherThanComment(text: Y.XmlText | null): string[] {
  if (text === null) return [];
  const names: string[] = [];
  for (const op of text.toDelta() as Array<{ attributes?: unknown }>) {
    for (const [name, value] of Object.entries(
      (op.attributes ?? {}) as Record<string, unknown>,
    )) {
      if (value === undefined || value === null) continue;
      if (name === COMMENT_MARK && readsAsMark(name, value)) continue;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Write `runs` into a Y.XmlText as one delta — text and marks together.
 *
 * The text must be attached to a document (a detached Y.XmlText cannot take a
 * delta), and it is appended to rather than replaced: callers create the element
 * with an empty text and apply once.
 *
 * @throws InvalidLinkHrefError before writing anything, when a run carries a
 * link target that is not an external URL.
 */
export function applyInlineRuns(
  text: Y.XmlText,
  runs: readonly InlineRun[],
): void {
  const delta = runs
    .filter((run) => run.text !== "")
    .map((run) => {
      const attributes = attributesOf(run.marks);
      return attributes === null
        ? { insert: run.text }
        : { insert: run.text, attributes };
    });
  if (delta.length > 0) text.applyDelta(delta);
}
