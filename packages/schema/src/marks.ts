/**
 * Inline marks, on the wire.
 *
 * The six inline marks — `bold`, `italic`, `strike`, `inlineCode`, `link`,
 * `docLink` — ride
 * the exact mechanism the annotation anchor already proved: Yjs text formatting
 * attributes on the block's single Y.XmlText (or each table cell's text). Nothing new is stored, and the
 * concurrency properties come for free — a mark is part of the text's own CRDT
 * state, so it survives splits, re-types (`setBlockType` replays the delta) and
 * concurrent edits, which a pair of stored positions would not.
 *
 * Three rules make the format work, and all three are load-bearing:
 *
 * 1. **Keys are the bare mark names; values are ProseMirror-shaped attributes.**
 *    `{}` for the four attribute-less marks, `{ href }` for `link`,
 *    `{ docId }` for `docLink`.
 *    y-prosemirror turns a text attribute into a mark named for its key with the
 *    value as that mark's attrs, so the editor needs no translation layer in
 *    either direction — the same reason `comment` stores `{ threadId }`.
 * 2. **Prose marks are not part of a block's `rev`.** Prose revs hash plain text
 *    and block attributes (see `rev.ts`), so prose edits never mention marks.
 *    Tables expose inline markdown instead: their cell marks are part of both
 *    the GFM text and its rev, and edits can change those marks.
 * 3. **The set is closed.** Anything else in a text's attributes is foreign
 *    content, and the web client refuses to bind rather than let y-prosemirror
 *    destroy it. `code` and `mermaid` blocks are source text and carry no inline
 *    marks at all — only `comment`.
 *
 * Writing and reading are deliberately asymmetric, the way the rest of the
 * package is:
 *
 *   - **Writing refuses.** A `link` target that is not an external `http(s)` URL
 *     throws {@link InvalidLinkHrefError}, a `docLink` target that is not a
 *     document uuid throws {@link InvalidDocLinkTargetError}, and a range that
 *     would carry both marks throws {@link ConflictingLinkMarksError} — none of
 *     them reaching the CRDT. This is
 *     the model-level door for that invariant; the import parser and the editor's
 *     input/paste rules are conveniences in front of it, not the enforcement.
 *   - **Reading degrades.** A flag written as something other than `true` or an
 *     attribute object, or a `link` with no usable `href`, reads as "not marked".
 *     A reader must never break on a writer that knows more — and the loudness
 *     lives where it can act: the web client's palette gate refuses to bind a
 *     text carrying a mark it cannot faithfully render, including a `link` whose
 *     href is not external, so nothing reaches a renderer unchecked.
 *   - **Reading also resolves**, in the one place it must. Two Yjs keys have no
 *     cross-key exclusion, so a merge of two replicas that formatted one range
 *     differently really can land both link marks on it. Refusing to read that
 *     would mean legitimate concurrent edits damaging text, so a range carrying
 *     both reads as a `docLink` — one rule, in {@link inlineLinkTarget}, that
 *     every consumer shares.
 */

import type * as Y from "yjs";
import {
  ConflictingLinkMarksError,
  InvalidDocLinkTargetError,
  InvalidLinkHrefError,
} from "./errors.js";
import { canonicalDocumentUuid } from "./rooms.js";
import { COMMENT_MARK, isCommentMark } from "./types.js";
import type { InlineMarkSet, InlineRun } from "./types.js";

const FLAGS = ["bold", "italic", "strike", "inlineCode"] as const;

/**
 * The one definition of a legal `link` target, shared by every door: this
 * module, the markdown reader, the editor's input and paste rules and the
 * palette gate. A `link` is external, so nothing but an `http(s)` URL is one —
 * a bare uuid included, which is a {@link isDocId} target and is never
 * reinterpreted as a link.
 */
export function isExternalHref(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\/\S+$/i.test(href);
}

/**
 * The same, for a `docLink`: a document uuid in its stored spelling, which is
 * the lowercase one. A writer's upper-cased id is canonicalized down at the
 * write boundary, so anything already in a document either reads as a docLink
 * here or is not one.
 */
export function isDocId(docId: unknown): docId is string {
  return canonicalDocumentUuid(docId) === docId;
}

/**
 * The one link target a run carries — the `docLink`, or the `link`, or nothing.
 *
 * This is the docLink-wins read rule, in the one place every consumer reads it
 * from: `marksOf` below, the run comparisons, and the markdown writer, which
 * spells both marks `[label](target)` and tells them apart by the target's own
 * shape. The two target spaces are disjoint (an `http(s)` URL is never a uuid),
 * so the string alone identifies both the target and which mark it came from.
 */
export function inlineLinkTarget(marks: InlineMarkSet): string | undefined {
  return marks.docLink ?? marks.link;
}

/**
 * Whether a delta attribute's value means its mark is *on*, for every mark this
 * package knows — the six inline ones and the annotation anchor.
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
  if (name === "docLink") {
    return (
      typeof value === "object" &&
      value !== null &&
      isDocId((value as { docId?: unknown }).docId)
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
 *
 * A range carrying both link marks — which only a merge can produce — reads as
 * the `docLink` alone, so no consumer downstream ever sees the pair.
 */
function marksOf(attributes: unknown): InlineMarkSet {
  if (typeof attributes !== "object" || attributes === null) return {};
  const source = attributes as Record<string, unknown>;
  const marks: InlineMarkSet = {};
  for (const flag of FLAGS) {
    if (readsAsMark(flag, source[flag])) marks[flag] = true;
  }
  if (readsAsMark("docLink", source.docLink)) {
    marks.docLink = (source.docLink as { docId: string }).docId;
  } else if (readsAsMark("link", source.link)) {
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
    inlineLinkTarget(a) === inlineLinkTarget(b)
  );
}

/** Whether a run carries any inline mark at all. */
export function hasInlineMarks(marks: InlineMarkSet): boolean {
  return (
    marks.bold === true ||
    marks.italic === true ||
    marks.strike === true ||
    marks.inlineCode === true ||
    inlineLinkTarget(marks) !== undefined
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
 * @throws InvalidLinkHrefError when a `link` target is not an external URL.
 * @throws InvalidDocLinkTargetError when a `docLink` target is not a document
 * uuid; one that is is written in its canonical lowercase spelling.
 * @throws ConflictingLinkMarksError when a run carries both link marks. This is
 * the boundary the invariants are enforced at, so no caller — `appendBlock`, an
 * MCP tool, the seed importer — can put another scheme into the document.
 */
export function attributesOf(marks: InlineMarkSet): Record<string, unknown> | null {
  const attributes: Record<string, unknown> = {};
  for (const flag of FLAGS) {
    if (marks[flag] === true) attributes[flag] = {};
  }
  if (marks.link !== undefined && marks.docLink !== undefined) {
    throw new ConflictingLinkMarksError(marks.link, marks.docLink);
  }
  if (marks.link !== undefined) {
    if (!isExternalHref(marks.link)) throw new InvalidLinkHrefError(marks.link);
    attributes.link = { href: marks.link };
  }
  if (marks.docLink !== undefined) {
    const docId = canonicalDocumentUuid(marks.docLink);
    if (docId === null) throw new InvalidDocLinkTargetError(marks.docLink);
    attributes.docLink = { docId };
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
 * @throws InvalidDocLinkTargetError
 * @throws ConflictingLinkMarksError
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
 * @throws InvalidLinkHrefError, InvalidDocLinkTargetError or
 * ConflictingLinkMarksError before writing anything, when a run carries a link
 * target this package refuses.
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
