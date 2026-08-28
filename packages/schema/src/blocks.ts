/**
 * Block reads and block-scoped writes.
 *
 * Every write in this module touches exactly one block. There is deliberately
 * no whole-document replace: a document-scoped write would clobber concurrent
 * human edits, which is the failure mode the whole model exists to prevent.
 *
 * On-wire shape of one block:
 *
 *   <heading id="…" level="2">Y.XmlText("Some title")</heading>
 *
 * The single Y.XmlText child holds the block's plain-text source, plus its
 * formatting marks: the closed inline set (`bold`, `italic`, `strike`,
 * `inlineCode`, `link`, `docLink` — see `marks.ts`) and the `comment` mark anchoring
 * annotation threads. `code` and `mermaid` are text-source blocks too — a rich
 * block is a text block with a fancy renderer, never a different storage shape —
 * and they carry no inline marks, only `comment`.
 *
 * `list-item` and `quote` are prose blocks like any other, and flat like every
 * other: a list is a *run* of adjacent list-item elements carrying `list` and
 * `indent` attributes, exactly markdown's own model. Nothing nests, so nothing
 * here walks a tree.
 *
 * Every read in this module is mark-blind: `text` and `rev` are plain text, so
 * formatting a range never invalidates a prepared edit. `getBlockInline` is the
 * one read that sees marks.
 */

import * as Y from "yjs";
import fastDiff from "fast-diff";
import { getBlocksFragment } from "./doc.js";
import {
  BlockNotFoundError,
  MarksNotAllowedError,
  StaleBlockError,
} from "./errors.js";
import {
  applyInlineRuns,
  assertInlineWritable,
  marksOtherThanComment,
  readInlineRuns,
} from "./marks.js";
import { blockRev } from "./rev.js";
import {
  MAX_LIST_INDENT,
  isBlockType,
  isListStyle,
  isProseBlockType,
} from "./types.js";
import type {
  Block,
  BlockInput,
  BlockType,
  HeadingLevel,
  InlineRun,
  ListIndent,
  ListStyle,
} from "./types.js";

const DIFF_DELETE = -1;
const DIFF_EQUAL = 0;
const DIFF_INSERT = 1;

/**
 * A list indent the model can hold: a whole number of levels, 0 to
 * {@link MAX_LIST_INDENT}. Anything else is clamped rather than refused — an
 * indent is presentation, and a document that arrived with a deeper one still
 * has to be readable.
 */
function normalizeIndent(indent: number | undefined): ListIndent {
  if (indent === undefined) return 0;
  const rounded = Math.trunc(indent);
  if (rounded < 0) return 0;
  if (rounded > MAX_LIST_INDENT) return MAX_LIST_INDENT as ListIndent;
  return rounded as ListIndent;
}

function normalizeLevel(level: number | undefined): HeadingLevel {
  if (level === undefined) return 1;
  const rounded = Math.trunc(level);
  if (rounded < 1) return 1;
  if (rounded > 6) return 6;
  return rounded as HeadingLevel;
}

function elementType(element: Y.XmlElement): BlockType {
  // Unknown node names are read as paragraphs rather than throwing: a reader
  // must never be broken by a writer that knows one more block type than it.
  return isBlockType(element.nodeName) ? element.nodeName : "paragraph";
}

/**
 * The Y.XmlText holding a block's source, or null when the element has no text
 * child yet (possible for an element created by another client mid-transaction).
 */
function textOf(element: Y.XmlElement): Y.XmlText | null {
  const first = element.firstChild;
  return first instanceof Y.XmlText ? first : null;
}

/** Read a Y.XmlText as plain text, ignoring any formatting marks. */
function readText(text: Y.XmlText | null): string {
  if (text === null) return "";
  let out = "";
  for (const op of text.toDelta() as Array<{ insert?: unknown }>) {
    if (typeof op.insert === "string") out += op.insert;
  }
  return out;
}

/**
 * Split the fragment's element children into the ones a reader may see and the
 * duplicates it must not: the first element to claim an id wins, and every later
 * element carrying that id is *shadowed*.
 *
 * Duplicate ids exist because a re-type must re-insert (Yjs element names are
 * immutable), so two replicas re-typing one block concurrently converge on two
 * elements sharing its id — see {@link setBlockType}. Document order is
 * identical on every replica, so every replica shadows the same elements.
 *
 * Only a real, non-empty id can shadow anything. An element with no id has
 * claimed no block identity, so two of them are not copies of one block: they
 * stay visible and unrepairable, because unknown content degrades loudly and is
 * never silently dropped.
 *
 * This is the one place that rule lives: everything that walks the fragment goes
 * through here.
 */
function partitionById(fragment: Y.XmlFragment): {
  /** The visible element for each id, in document order. */
  visible: Y.XmlElement[];
  /** Fragment indexes of the shadowed duplicates, ascending. */
  shadowed: number[];
} {
  const seen = new Set<string>();
  const visible: Y.XmlElement[] = [];
  const shadowed: number[] = [];
  const children = fragment.toArray();
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!(child instanceof Y.XmlElement)) continue;
    const id = child.getAttribute("id") ?? "";
    if (id !== "") {
      if (seen.has(id)) {
        shadowed.push(i);
        continue;
      }
      seen.add(id);
    }
    visible.push(child);
  }
  return { visible, shadowed };
}

/** Every fragment index carrying `blockId`, ascending. */
function indexesOfBlock(fragment: Y.XmlFragment, blockId: string): number[] {
  const out: number[] = [];
  const children = fragment.toArray();
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child instanceof Y.XmlElement && child.getAttribute("id") === blockId) {
      out.push(i);
    }
  }
  return out;
}

/** The index of the visible element for `blockId`, or -1. */
function indexOfBlock(fragment: Y.XmlFragment, blockId: string): number {
  return indexesOfBlock(fragment, blockId)[0] ?? -1;
}

/**
 * The visible element for a block id — the first one carrying it, so a shadowed
 * duplicate is never returned.
 *
 * @internal — shared with the annotations module.
 */
export function findBlockElement(
  ydoc: Y.Doc,
  blockId: string,
): Y.XmlElement | null {
  const fragment = getBlocksFragment(ydoc);
  const index = indexOfBlock(fragment, blockId);
  return index === -1 ? null : (fragment.get(index) as Y.XmlElement);
}

/** @internal — shared with the annotations module. */
export function blockTextType(element: Y.XmlElement): Y.XmlText | null {
  return textOf(element);
}

/** @internal — shared with the annotations module. */
export function requireBlockText(
  ydoc: Y.Doc,
  element: Y.XmlElement,
  blockId: string,
): Y.XmlText {
  const existing = textOf(element);
  if (existing !== null) return existing;
  ydoc.transact(() => {
    element.insert(0, [new Y.XmlText()]);
  });
  const created = textOf(element);
  if (created === null) throw new BlockNotFoundError(blockId);
  return created;
}

function levelOf(element: Y.XmlElement): HeadingLevel {
  const raw = element.getAttribute("level");
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 1 : normalizeLevel(parsed);
}

/** A list item's marker. An unset or unreadable attribute reads as a bullet. */
function listOf(element: Y.XmlElement): ListStyle {
  const raw = element.getAttribute("list");
  return raw !== undefined && isListStyle(raw) ? raw : "bullet";
}

function indentOf(element: Y.XmlElement): ListIndent {
  const raw = element.getAttribute("indent");
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : normalizeIndent(parsed);
}

function toBlock(element: Y.XmlElement): Block {
  const type = elementType(element);
  const id = element.getAttribute("id") ?? "";
  const text = readText(textOf(element));
  if (type === "heading") {
    const level = levelOf(element);
    return { id, type, text, rev: blockRev({ type, text, level }), level };
  }
  if (type === "code") {
    const language = element.getAttribute("language") ?? "";
    return { id, type, text, rev: blockRev({ type, text, language }), language };
  }
  if (type === "list-item") {
    const list = listOf(element);
    const indent = indentOf(element);
    return {
      id,
      type,
      text,
      rev: blockRev({ type, text, list, indent }),
      list,
      indent,
    };
  }
  return { id, type, text, rev: blockRev({ type, text }) };
}

/**
 * All blocks, in document order — exactly one per id. A shadowed duplicate left
 * behind by concurrent re-types is skipped; see {@link partitionById}.
 */
export function getBlocks(ydoc: Y.Doc): Block[] {
  return partitionById(getBlocksFragment(ydoc)).visible.map(toBlock);
}

/** One block by id, or null when it does not exist (or was deleted). */
export function getBlock(ydoc: Y.Doc, blockId: string): Block | null {
  const element = findBlockElement(ydoc, blockId);
  return element === null ? null : toBlock(element);
}

/** One block's plain-text source. Throws {@link BlockNotFoundError} if absent. */
export function getBlockText(ydoc: Y.Doc, blockId: string): string {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  return readText(textOf(element));
}

/** One block's content hash. Throws {@link BlockNotFoundError} if absent. */
export function getBlockRev(ydoc: Y.Doc, blockId: string): string {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  return toBlock(element).rev;
}

/**
 * One block's text as maximal runs of equally-marked text — the mark-aware
 * counterpart of {@link getBlockText}. A block with no formatting is a single
 * unmarked run; an absent block is no runs at all.
 *
 * The `comment` mark is not reported here: annotation ranges are read through
 * `listAnnotationRanges`, which is the one consumer that needs thread ids.
 */
export function getBlockInline(ydoc: Y.Doc, blockId: string): InlineRun[] {
  const element = findBlockElement(ydoc, blockId);
  return element === null ? [] : readInlineRuns(textOf(element));
}

/**
 * Every visible block with its inline runs, from a single traversal — what a
 * whole-document reader wants. Looking each block's marks up by id instead would
 * rescan the fragment per block, which is quadratic in the block count.
 *
 * @internal — shared with the markdown module.
 */
export function getBlocksWithInline(
  ydoc: Y.Doc,
): Array<{ block: Block; inline: InlineRun[] }> {
  return partitionById(getBlocksFragment(ydoc)).visible.map((element) => ({
    block: toBlock(element),
    inline: readInlineRuns(textOf(element)),
  }));
}

/**
 * The formatted content to write for an input, or null to write `input.text`.
 * Only prose blocks carry inline marks — `code` and `mermaid` hold source.
 */
function inlineOf(input: BlockInput): readonly InlineRun[] | null {
  if (input.inline === undefined) return null;
  return isProseBlockType(input.type) ? input.inline : null;
}

function buildElement(id: string, input: BlockInput): Y.XmlElement {
  // Before anything is inserted: a Yjs transaction does not roll back, so a
  // refusal from inside one would leave a stray empty block behind.
  const runs = inlineOf(input);
  if (runs !== null) assertInlineWritable(runs);

  const element = new Y.XmlElement(input.type);
  element.setAttribute("id", id);
  if (input.type === "heading") {
    element.setAttribute("level", String(normalizeLevel(input.level)));
  }
  if (input.type === "code" && input.language !== undefined) {
    element.setAttribute("language", input.language);
  }
  if (input.type === "list-item") {
    // Both attributes always, so a list item never depends on a reader's
    // default: the run's shape is what the document says it is.
    element.setAttribute("list", input.list ?? "bullet");
    element.setAttribute("indent", String(normalizeIndent(input.indent)));
  }
  element.insert(0, [
    new Y.XmlText(inlineOf(input) === null ? (input.text ?? "") : ""),
  ]);
  return element;
}

/**
 * Replay an input's inline marks, once its element is in the document — a
 * detached Y.XmlText cannot take a delta. Same transaction as the insert, so no
 * reader ever sees the unformatted intermediate state.
 */
function writeInline(element: Y.XmlElement, input: BlockInput): void {
  const runs = inlineOf(input);
  if (runs === null) return;
  const text = textOf(element);
  if (text !== null) applyInlineRuns(text, runs);
}

/**
 * Insert a block after `afterBlockId`, or at the start of the document when
 * `afterBlockId` is null. Returns the new block's stable id.
 *
 * Throws {@link BlockNotFoundError} when `afterBlockId` does not exist.
 */
export function insertBlock(
  ydoc: Y.Doc,
  afterBlockId: string | null,
  input: BlockInput,
): string {
  const fragment = getBlocksFragment(ydoc);
  const id = crypto.randomUUID();
  ydoc.transact(() => {
    let index = 0;
    if (afterBlockId !== null) {
      const found = indexOfBlock(fragment, afterBlockId);
      if (found === -1) throw new BlockNotFoundError(afterBlockId);
      index = found + 1;
    }
    const element = buildElement(id, input);
    fragment.insert(index, [element]);
    writeInline(element, input);
  });
  return id;
}

/** Insert a block at the end of the document. Returns the new block's id. */
export function appendBlock(ydoc: Y.Doc, input: BlockInput): string {
  const fragment = getBlocksFragment(ydoc);
  const id = crypto.randomUUID();
  ydoc.transact(() => {
    const element = buildElement(id, input);
    fragment.insert(fragment.length, [element]);
    writeInline(element, input);
  });
  return id;
}

/**
 * Delete a block. Throws {@link BlockNotFoundError} when it is already gone.
 *
 * Every element carrying the id goes, not just the visible one: leaving a
 * shadowed duplicate behind would make the block reappear after the delete.
 */
export function deleteBlock(ydoc: Y.Doc, blockId: string): void {
  const fragment = getBlocksFragment(ydoc);
  ydoc.transact(() => {
    const indexes = indexesOfBlock(fragment, blockId);
    if (indexes.length === 0) throw new BlockNotFoundError(blockId);
    // Descending, so an earlier delete cannot shift a later index.
    for (const index of [...indexes].reverse()) {
      fragment.delete(index, 1);
    }
  });
}

/**
 * Delete the shadowed duplicates left by concurrent re-types, keeping the
 * document-order winner — the element every replica's reads already resolve.
 * Returns how many elements were removed.
 *
 * Nothing to repair means no transaction and no update, so calling this on every
 * observed change is free, and two replicas repairing the same duplicate
 * converge: they delete the same element, and a second delete of it is a no-op.
 *
 * Only a repeated, non-empty id is a duplicate. Foreign content — an element
 * some future writer added, with no id of its own — is never deleted here.
 *
 * The losing copy's text goes with it, including anything written to it after
 * the re-type — the same semantics as a text edit concurrent with a re-type, and
 * the reason {@link editBlock} takes a `rev`.
 */
export function repairDuplicateBlocks(ydoc: Y.Doc): number {
  const fragment = getBlocksFragment(ydoc);
  const indexes = partitionById(fragment).shadowed;
  if (indexes.length === 0) return 0;
  ydoc.transact(() => {
    for (const index of [...indexes].reverse()) {
      fragment.delete(index, 1);
    }
  });
  return indexes.length;
}

/** Set a heading's level. */
export function setBlockLevel(
  ydoc: Y.Doc,
  blockId: string,
  level: HeadingLevel,
): void {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  ydoc.transact(() => {
    element.setAttribute("level", String(normalizeLevel(level)));
  });
}

/** Set a code block's language. */
export function setBlockLanguage(
  ydoc: Y.Doc,
  blockId: string,
  language: string,
): void {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  ydoc.transact(() => {
    element.setAttribute("language", language);
  });
}

export interface BlockTypeAttrs {
  /** Heading level for the new type. Carried over when the old block was a heading. */
  level?: HeadingLevel;
  /** Code language for the new type. Carried over when the old block was code. */
  language?: string;
  /** List marker for the new type. Carried over when the old block was a list item. */
  list?: ListStyle;
  /** List indent for the new type. Carried over when the old block was a list item. */
  indent?: number;
}

/**
 * Re-type a block, preserving its id and its full text delta — marks included.
 *
 * This is the only sanctioned way to change a block's type. A delete-and-
 * reinsert re-type churns the block id (breaking every inbound reference) and
 * drops the text's formatting marks, orphaning every annotation thread anchored
 * in the block. Doing it the other way is an invariant violation, not a style
 * preference.
 *
 * Mechanics, all inside one transaction: read the old text's delta, insert a
 * new element with the same id and the new node name directly after the old
 * one, replay the delta into its Y.XmlText, then delete the old element — so
 * the block keeps its position in the document.
 *
 * Type-specific attributes are carried over where they still apply and can be
 * overridden through `attrs`.
 *
 * **Prose → source is refused when the text carries any mark but `comment`.**
 * `code` and `mermaid` hold source text and may carry only the annotation anchor,
 * so there is no honest way to re-type formatted prose into one: dropping the
 * marks would break this function's whole promise, and keeping them would leave a
 * document the web editor refuses to bind (its palette gate rejects a block
 * holding a mark its node type disallows, precisely so nothing gets destroyed).
 * So the re-type is refused *before* it mutates anything — see
 * {@link MarksNotAllowedError}, which names the marks in the way. A mark from a
 * writer this package has never heard of counts: the editor cannot render that
 * either. Annotation anchors are unaffected — `comment` is legal on every block
 * type and always survives.
 *
 * Concurrency: because a re-type inserts a replacement element, two replicas
 * re-typing the same block concurrently converge on two elements sharing that
 * block id. The earlier one in document order wins — identically on every
 * replica — and the later copy is shadowed: every read skips it
 * ({@link getBlocks}, {@link getBlock}), and {@link repairDuplicateBlocks}
 * deletes it once an observer sees it.
 *
 * The losing copy's text is therefore discarded, including edits made to it
 * after that replica's re-type: they were written into an element no reader ever
 * resolves. This is the same rule as a text edit concurrent with a re-type — a
 * re-type is a structural change, and `rev`/`oldText` is what protects a caller
 * who cares. Divergent duplicate texts are never merged.
 */
export function setBlockType(
  ydoc: Y.Doc,
  blockId: string,
  newType: BlockType,
  attrs: BlockTypeAttrs = {},
): void {
  const fragment = getBlocksFragment(ydoc);
  ydoc.transact(() => {
    const index = indexOfBlock(fragment, blockId);
    if (index === -1) throw new BlockNotFoundError(blockId);
    const old = fragment.get(index) as Y.XmlElement;
    const oldType = elementType(old);

    // Refused before anything is written: nothing to roll back, and the caller
    // still has the block it started with. Every formatting key counts, not only
    // the ones this package knows — see `marksOtherThanComment`.
    if (!isProseBlockType(newType)) {
      const marks = marksOtherThanComment(textOf(old));
      if (marks.length > 0) {
        throw new MarksNotAllowedError(blockId, newType, marks);
      }
    }

    const level =
      attrs.level ?? (oldType === "heading" ? levelOf(old) : undefined);
    const language =
      attrs.language ?? (oldType === "code" ? old.getAttribute("language") : undefined);
    const list = attrs.list ?? (oldType === "list-item" ? listOf(old) : undefined);
    const indent =
      attrs.indent ?? (oldType === "list-item" ? indentOf(old) : undefined);

    const replacement = new Y.XmlElement(newType);
    replacement.setAttribute("id", blockId);
    if (newType === "heading") {
      replacement.setAttribute("level", String(normalizeLevel(level)));
    }
    if (newType === "code" && language !== undefined) {
      replacement.setAttribute("language", language);
    }
    if (newType === "list-item") {
      replacement.setAttribute("list", list ?? "bullet");
      replacement.setAttribute("indent", String(normalizeIndent(indent)));
    }
    replacement.insert(0, [new Y.XmlText()]);
    fragment.insert(index + 1, [replacement]);

    const oldText = textOf(old);
    const newText = textOf(replacement);
    if (oldText !== null && newText !== null) {
      const delta = oldText.toDelta() as Array<Record<string, unknown>>;
      if (delta.length > 0) newText.applyDelta(delta);
    }
    fragment.delete(index, 1);
  });
}

export interface EditBlockOptions {
  /**
   * The `rev` the caller read. When given and it no longer matches, the edit is
   * refused even if `oldText` happens to match — an attribute change alone
   * (a heading level, a code language) is enough to invalidate it.
   */
  rev?: string;
}

/**
 * THE core write.
 *
 * In one transaction: locate the block, verify it still matches what the caller
 * read (`oldText`, and `rev` when supplied), then apply
 * `fast-diff(oldText, newText)` as minimal retain/delete/insert splices to the
 * block's Y.XmlText.
 *
 * The minimal-splice property is what makes concurrent human+agent editing
 * safe: characters the edit did not touch are never deleted and reinserted, so
 * a concurrent edit elsewhere in the same block — or at the block's very end —
 * survives the merge, and marks over untouched text stay anchored.
 *
 * **Marks are invisible to this call, by design.** `oldText`, `newText` and
 * `rev` are all plain text: an edit never mentions inline marks and never
 * changes one, and formatting a range does not make a prepared edit stale.
 * Spliced text inherits formatting the way Yjs inserts always do — from the
 * character to its left — so text inserted strictly inside a bold run is bold,
 * and text inserted at a run's start boundary is not. Deleting a whole run
 * removes its mark with it. A caller that wants to *change* formatting writes
 * the marks, not the text.
 *
 * The staleness check is local-replica-only. See {@link StaleBlockError}.
 *
 * @throws BlockNotFoundError when the block does not exist, or when a
 * concurrent delete detached it — never a silent no-op.
 * @throws StaleBlockError when the text or the asserted rev is stale. The error
 * carries `currentText` and `currentRev` so the caller can re-read and retry.
 */
export function editBlock(
  ydoc: Y.Doc,
  blockId: string,
  oldText: string,
  newText: string,
  options: EditBlockOptions = {},
): void {
  ydoc.transact(() => {
    const element = findBlockElement(ydoc, blockId);
    if (element === null) throw new BlockNotFoundError(blockId);

    const current = toBlock(element);
    if (current.text !== oldText || (options.rev !== undefined && options.rev !== current.rev)) {
      throw new StaleBlockError({
        blockId,
        expectedText: oldText,
        expectedRev: options.rev,
        currentText: current.text,
        currentRev: current.rev,
      });
    }
    if (oldText === newText) return;

    const text = requireBlockText(ydoc, element, blockId);
    let index = 0;
    for (const [op, chunk] of fastDiff(oldText, newText)) {
      if (op === DIFF_EQUAL) {
        index += chunk.length;
      } else if (op === DIFF_DELETE) {
        text.delete(index, chunk.length);
      } else if (op === DIFF_INSERT) {
        text.insert(index, chunk);
        index += chunk.length;
      }
    }

    // The block must still be attached when the splice lands. A caller can
    // delete a block inside an enclosing transaction, and a detached element
    // accepts writes that go nowhere — report that instead of returning as if
    // the edit had applied.
    if (findBlockElement(ydoc, blockId) === null) {
      throw new BlockNotFoundError(blockId);
    }
  });
}
