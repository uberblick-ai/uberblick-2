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
 * Reading is lossy on purpose: a `link` whose value has no string `href`, or a
 * flag written as something other than an object, is read as "not marked" rather
 * than throwing. A reader must never break on a writer that knows more.
 */

import type * as Y from "yjs";
import type { InlineMarkSet, InlineRun } from "./types.js";

const FLAGS = ["bold", "italic", "strike", "inlineCode"] as const;

/** The inline marks in one delta op's attributes. Unknown keys are ignored. */
function marksOf(attributes: unknown): InlineMarkSet {
  if (typeof attributes !== "object" || attributes === null) return {};
  const source = attributes as Record<string, unknown>;
  const marks: InlineMarkSet = {};
  for (const flag of FLAGS) {
    if (source[flag] !== undefined && source[flag] !== null) marks[flag] = true;
  }
  const link = source.link;
  if (typeof link === "object" && link !== null) {
    const href = (link as { href?: unknown }).href;
    if (typeof href === "string" && href !== "") marks.link = href;
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

/** One run's marks as Yjs formatting attributes, or null when it has none. */
function attributesOf(marks: InlineMarkSet): Record<string, unknown> | null {
  const attributes: Record<string, unknown> = {};
  for (const flag of FLAGS) {
    if (marks[flag] === true) attributes[flag] = {};
  }
  if (marks.link !== undefined && marks.link !== "") {
    attributes.link = { href: marks.link };
  }
  return Object.keys(attributes).length === 0 ? null : attributes;
}

/**
 * Write `runs` into a Y.XmlText as one delta — text and marks together.
 *
 * The text must be attached to a document (a detached Y.XmlText cannot take a
 * delta), and it is appended to rather than replaced: callers create the element
 * with an empty text and apply once.
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
