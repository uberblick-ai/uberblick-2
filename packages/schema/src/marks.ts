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
 * Link targets are external http(s) URLs; UUIDs belong to docLink. Writers,
 * import and the editor gate share this check to keep the two spaces disjoint.
 */
export function isExternalHref(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\/\S+$/i.test(href);
}

/**
 * Stored docLink targets must already use lowercase canonical UUID spelling;
 * writers canonicalize before storing them.
 */
export function isDocId(docId: unknown): docId is string {
  return typeof docId === "string" && canonicalDocumentUuid(docId) === docId;
}

/**
 * Concurrent formatting can merge both link keys; every reader gives docLink
 * precedence. The target's disjoint URL/UUID shape also identifies its mark.
 */
export function inlineLinkTarget(marks: InlineMarkSet): string | undefined {
  return marks.docLink ?? marks.link;
}

/**
 * Unknown or malformed attributes read as unmarked. The editor gate must use
 * this same closed vocabulary and refuse unrenderable text: y-prosemirror
 * accepts attrs such as false that would otherwise bind differently here.
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
 * Ignore unknown or unreadable keys and collapse merged link conflicts to
 * docLink before exposing runs to consumers.
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

export function sameInlineMarks(a: InlineMarkSet, b: InlineMarkSet): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.inlineCode === b.inlineCode &&
    inlineLinkTarget(a) === inlineLinkTarget(b)
  );
}

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
 * One delta scan returns maximal marked runs; non-string embeds have no text
 * and contribute no run.
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

/** Prose revisions and edits use plain text; table revisions include cell marks. */
export function inlinePlainText(runs: readonly InlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

/**
 * Bare mark keys and ProseMirror attrs ({}, {href}, {docId}) bind directly to
 * y-prosemirror. Formatting lives on each block/cell's Y.XmlText, so CRDT edits,
 * splits and delta-preserving retypes keep marks attached to their text.
 * Invalid URLs/UUIDs and simultaneous link marks throw before reaching Yjs.
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
 * Validate all runs before writing: Yjs transactions do not roll back on throw,
 * so validating midway could leave a partial write.
 */
export function assertInlineWritable(runs: readonly InlineRun[]): void {
  for (const run of runs) attributesOf(run.marks);
}

/**
 * Source blocks allow only valid comment anchors. Include unknown keys and
 * malformed comments in document order, or a retype could pass this check but
 * produce text the editor refuses to bind.
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
 * Append one text-and-marks delta to attached Y.XmlText; detached text cannot
 * take a delta. Building the complete delta validates every run before writing.
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
