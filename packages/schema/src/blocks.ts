/**
 * Writes address one logical block; whole-document replacement loses
 * concurrent edits. Block elements stay flat, including list items and quotes.
 * Table cells and card parts contain their own single paragraphs.
 */

import * as Y from "yjs";
import fastDiff from "fast-diff";
import { getBlocksFragment } from "./doc.js";
import { CARD_PARTS, buildCardElement, cardInline, cardText, cardTextParts, editCard, parseCardInput, writeCardInline } from "./card.js";
import type { CardInline } from "./card.js";
import { parseInline } from "./markdown.js";
import {
  BlockNotFoundError,
  CardAnnotationError,
  CardConversionError,
  ConflictingLinkMarksError,
  InlineLinkRangeError,
  InvalidDocLinkTargetError,
  InvalidTableMappingError,
  MarksNotAllowedError,
  OldTextMismatchError,
  StaleBlockError,
  TableAnnotationError,
} from "./errors.js";
import {
  applyInlineRuns,
  assertInlineWritable,
  marksOtherThanComment,
  readInlineRuns,
} from "./marks.js";
import { blockRev } from "./rev.js";
import { canonicalDocumentUuid } from "./rooms.js";
import { buildTableElement, editTable, parseGfmTable, parseTableInput, parseTableCell, tableCellTexts, tableRows, tableText } from "./table.js";
import type { TableMapping } from "./table.js";
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
 * Clamp presentation depth to whole levels 0–3 so deeper foreign lists stay readable.
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
  // Future node names degrade to paragraphs without breaking older readers.
  return isBlockType(element.nodeName) ? element.nodeName : "paragraph";
}

/**
 * Flat blocks use one Y.XmlText child for source, inline marks and thread marks.
 * A foreign element with no text child reads as empty until it gains one.
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
 * All fragment readers share the first document-order element for each id.
 * Concurrent re-types insert same-id copies; converged order shadows the same
 * losers on every replica. Empty-id elements remain visible and unrepairable,
 * since missing identity cannot justify silently dropping foreign content.
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
 * @internal — annotations share the first same-id element, never a shadowed copy.
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
export function requireBlockText(
  ydoc: Y.Doc,
  element: Y.XmlElement,
  blockId: string,
): Y.XmlText {
  if (element.nodeName === "table") throw new TableAnnotationError(blockId);
  if (element.nodeName === "card") throw new CardAnnotationError(blockId);
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
  // Prose rev excludes marks; table and card projections include inline formatting.
  const type = elementType(element);
  const id = element.getAttribute("id") ?? "";
  const text = type === "card" ? cardText(element)
    : type === "table" && element.toArray().some((node) => node instanceof Y.XmlElement && node.nodeName === "tableRow")
      ? tableText(element) : readText(textOf(element));
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
 * Document-order visible blocks, with duplicate identities shadowed.
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
  return toBlock(element).text;
}

/** One block's content hash. Throws {@link BlockNotFoundError} if absent. */
export function getBlockRev(ydoc: Y.Doc, blockId: string): string {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);
  return toBlock(element).rev;
}

/**
 * Maximal equally-marked runs: one unmarked run without formatting, [] if absent.
 * Thread marks are excluded; use listAnnotationRanges for annotation anchors.
 */
export function getBlockInline(ydoc: Y.Doc, blockId: string): InlineRun[] {
  const element = findBlockElement(ydoc, blockId);
  return element === null ? [] : readInlineRuns(textOf(element));
}

/**
 * One traversal for whole-document mark reads; repeated id lookups are quadratic.
 */
export function getBlocksWithInline(
  ydoc: Y.Doc,
): Array<{ block: Block; inline: InlineRun[]; table?: InlineRun[][][]; card?: CardInline }> {
  return partitionById(getBlocksFragment(ydoc)).visible.map((element) => ({
    block: toBlock(element),
    inline: readInlineRuns(textOf(element)),
    ...(element.nodeName === "table" ? {
      table: tableRows(element).map((row) => row.map((cell) => tableCellTexts(cell).flatMap(readInlineRuns))),
    } : {}),
    ...(element.nodeName === "card" ? { card: cardInline(element) } : {}),
  }));
}

/**
 * Inline input overrides text only for prose; structured/source blocks ignore it.
 */
function inlineOf(input: BlockInput): readonly InlineRun[] | null {
  if (input.inline === undefined) return null;
  return isProseBlockType(input.type) ? input.inline : null;
}

function buildElement(id: string, input: BlockInput, inlineTables = true): Y.XmlElement {
  // Validate before insertion: Yjs transactions cannot roll back stray blocks.
  const runs = inlineOf(input);
  if (runs !== null) assertInlineWritable(runs);

  if (input.type === "card") {
    const card = parseCardInput(input.text ?? "");
    for (const part of CARD_PARTS) assertInlineWritable(parseInline(card[part]));
    return buildCardElement(id);
  }

  if (input.type === "table") {
    const table = parseTableInput(input.text ?? "");
    // Retyping and legacy normalization build literal cells; agent GFM has marks.
    if (!inlineTables) return buildTableElement(id, table);
    for (const cell of [table.header, ...table.rows].flat()) assertInlineWritable(parseTableCell(cell));
    return buildTableElement(id, {
      ...table, header: table.header.map(() => ""), rows: table.rows.map((row) => row.map(() => "")),
    });
  }

  const element = new Y.XmlElement(input.type);
  element.setAttribute("id", id);
  if (input.type === "heading") {
    element.setAttribute("level", String(normalizeLevel(input.level)));
  }
  if (input.type === "code" && input.language !== undefined) {
    element.setAttribute("language", input.language);
  }
  if (input.type === "list-item") {
    // Store both attributes so the run never depends on a reader's defaults.
    element.setAttribute("list", input.list ?? "bullet");
    element.setAttribute("indent", String(normalizeIndent(input.indent)));
  }
  element.insert(0, [
    new Y.XmlText(inlineOf(input) === null ? (input.text ?? "") : ""),
  ]);
  return element;
}

/**
 * Apply deltas after integration: detached Y.XmlText cannot accept them.
 * Use the insert transaction so readers see no unformatted intermediate state.
 */
function writeInline(element: Y.XmlElement, input: BlockInput): void {
  if (input.type === "card") {
    writeCardInline(element, parseCardInput(input.text ?? ""));
    return;
  }
  if (input.type === "table") {
    const table = parseTableInput(input.text ?? "");
    const cells = tableRows(element);
    for (const [row, values] of [table.header, ...table.rows].entries()) {
      for (const [column, value] of values.entries()) {
        const cell = cells[row]?.[column];
        const text = cell === undefined ? null : tableCellTexts(cell)[0];
        if (text !== null && text !== undefined) applyInlineRuns(text, parseTableCell(value));
      }
    }
    return;
  }
  const runs = inlineOf(input);
  if (runs === null) return;
  const text = textOf(element);
  if (text !== null) applyInlineRuns(text, runs);
}

/**
 * Insert after the named block, or at the start for null. An absent predecessor
 * is refused; the new block receives a stable id.
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
 * Delete all same-id elements so shadowed copies cannot resurface.
 * An already absent block is refused.
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
 * Remove only shadowed non-empty ids, keeping the shared document-order winner.
 * Losers' text and later edits are discarded, never merged into the winner.
 * Concurrent repairs delete the same copies; no duplicates means no update.
 * Returns the number removed.
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

/**
 * Normalize only legacy table content. Replacement uses the re-type primitive
 * so simultaneous converters shadow one another instead of duplicating rows.
 * Invalid GFM becomes same-id code with its complete source delta and anchors.
 * Ordinary structured tables cause no update, even when merged rows are uneven.
 */
export function normalizeLegacyTables(ydoc: Y.Doc): number {
  const fragment = getBlocksFragment(ydoc);
  let changed = 0;
  for (const element of partitionById(fragment).visible) {
    if (element.nodeName !== "table") continue;
    const children = element.toArray();
    if (children.some((node) => node instanceof Y.XmlElement && node.nodeName === "tableRow")) {
      const indexes = children.flatMap((node, index) => node instanceof Y.XmlText ? [index] : []);
      if (indexes.length === 0) continue;
      ydoc.transact(() => { for (const index of indexes.reverse()) element.delete(index, 1); });
      changed += 1;
      continue;
    }
    if (children.length !== 1 || !(children[0] instanceof Y.XmlText)) continue;
    const source = readText(children[0]);
    const delta = children[0].toDelta();
    const parsed = parseGfmTable(source);
    const index = fragment.toArray().indexOf(element);
    const id = element.getAttribute("id");
    if (index < 0 || id === undefined || id === "") continue;
    ydoc.transact(() => {
      if (parsed === null) {
        const replacement = new Y.XmlElement("code");
        replacement.setAttribute("id", id);
        replacement.insert(0, [new Y.XmlText()]);
        fragment.insert(index + 1, [replacement]);
        (replacement.firstChild as Y.XmlText).applyDelta(delta);
      } else {
        fragment.insert(index + 1, [buildTableElement(id, parsed)]);
      }
      fragment.delete(index, 1);
    });
    changed += 1;
  }
  return changed;
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
 * Only sanctioned retype: retain id, position and full text delta, including thread marks.
 * Applicable attributes carry over unless overridden. Yjs node names are
 * immutable, so insert the replacement beside the old element before deleting it.
 * Concurrent replacements use partitionById's winner; losing text is discarded.
 * Unseen concurrent edits to the replaced element can also be lost.
 * editBlock's rev/oldText guards cannot detect unseen remote changes.
 */
export function setBlockType(
  ydoc: Y.Doc,
  blockId: string,
  newType: BlockType,
  attrs: BlockTypeAttrs = {},
): void {
  const fragment = getBlocksFragment(ydoc);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
  ydoc.transact(() => {
    const index = indexOfBlock(fragment, blockId);
    if (index === -1) throw new BlockNotFoundError(blockId);
    const old = fragment.get(index) as Y.XmlElement;
    const oldType = elementType(old);

    if (oldType === "card" || newType === "card") {
      if (oldType === newType) return;
      throw new CardConversionError();
    }

    if (oldType === "table" || newType === "table") {
      // Same-type tables are inert. Table/flat offsets cannot preserve marks;
      // refuse every mark before mutation. Only legacy normalization may drop anchors.
      if (oldType === "table" && newType === "table") return;
      const marked = oldType === "table"
        ? tableRows(old).flat().flatMap((cell) => tableCellTexts(cell).flatMap((text) => text.toDelta() as Array<{ attributes?: Record<string, unknown> }>))
        : (textOf(old)?.toDelta() as Array<{ attributes?: Record<string, unknown> }> | undefined) ?? [];
      const marks = [...new Set(marked.flatMap((op) => Object.keys(op.attributes ?? {})))];
      if (marks.length > 0) throw new MarksNotAllowedError(blockId, newType, marks);
      const replacement = buildElement(blockId, {
        type: newType, text: toBlock(old).text,
        ...(attrs.level === undefined ? {} : { level: attrs.level }),
        ...(attrs.language === undefined ? {} : { language: attrs.language }),
        ...(attrs.list === undefined ? {} : { list: attrs.list }),
        ...(attrs.indent === undefined ? {} : { indent: attrs.indent }),
      }, false);
      fragment.insert(index + 1, [replacement]);
      fragment.delete(index, 1);
      return;
    }

    // Source blocks allow only thread marks. Refuse known and foreign formatting
    // before mutation: dropping it loses content, keeping it breaks editor binding.
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
   * Refuse a stale rev even if oldText matches; attributes also affect the hash.
   */
  rev?: string;
  /** Surviving old GFM positions, or null for newly created rows and columns. */
  tableMapping?: TableMapping;
}

/**
 * Validate oldText/optional rev, then splice only changed characters in one
 * transaction. Untouched characters, their marks and concurrent edits survive,
 * including edits at the end of the block. Prose marks neither affect rev nor
 * receive explicit writes; inserts inherit left formatting, start-boundary
 * inserts stay outside, and fully deleted runs lose their marks.
 * Table edits compare marked GFM and retain unchanged cell text and mark keys.
 * StaleBlockError guards only the local replica; a current rev with wrong
 * oldText yields OldTextMismatchError. Both carry current text/rev for retry.
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
    if (options.rev !== undefined && options.rev !== current.rev) {
      throw new StaleBlockError({
        blockId,
        expectedText: oldText,
        expectedRev: options.rev,
        currentText: current.text,
        currentRev: current.rev,
      });
    }
    if (current.text !== oldText) {
      const details = {
        blockId,
        expectedText: oldText,
        expectedRev: options.rev,
        currentText: current.text,
        currentRev: current.rev,
      };
      if (options.rev !== undefined) {
        throw new OldTextMismatchError({ ...details, expectedRev: options.rev });
      }
      throw new StaleBlockError(details);
    }
    if (current.type === "table") {
      const parsedOld = parseTableInput(oldText);
      const parsedNew = parseTableInput(newText);
      editTable(element, parsedOld, parsedNew, options.tableMapping);
      return;
    }
    if (options.tableMapping !== undefined) throw new InvalidTableMappingError("mapping applies only to a table block");
    if (current.type === "card") {
      // Empty editor titles project without a title header; MCP must repair them.
      const after = parseCardInput(newText);
      editCard(element, cardTextParts(element), after);
      return;
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

    // An enclosing transaction may detach the block; detached writes go nowhere.
    // Report absence rather than silently succeeding, just as for the initial lookup.
    if (findBlockElement(ydoc, blockId) === null) {
      throw new BlockNotFoundError(blockId);
    }
  });
}

/** A half-open character range in a block's text, in UTF-16 code units. */
export interface InlineLinkRange {
  start: number;
  /** Exclusive. */
  end: number;
}

export interface SetInlineLinkOptions {
  /**
   * Guard offsets against changed text. Mark writes leave this prose rev valid.
   */
  rev?: string;
}

/**
 * Visible external link in [lo, hi), or null. Formatting one Yjs key cannot
 * enforce cross-key exclusion, so check explicitly. Merged pairs read as docLink.
 */
function linkInRange(text: Y.XmlText, lo: number, hi: number): string | null {
  let index = 0;
  for (const run of readInlineRuns(text)) {
    const end = index + run.text.length;
    if (index < hi && lo < end && run.marks.link !== undefined) {
      return run.marks.link;
    }
    index = end;
  }
  return null;
}

/**
 * Mark an ordered, clamped half-open prose range without changing text or rev.
 * Existing docLink targets are replaced; visible external links are refused.
 * Merged raw link/docLink pairs read as docLink and are repaired by retargeting.
 * Empty or non-prose ranges are refused; document UUID targets normalize to lowercase.
 */
export function setInlineLink(
  ydoc: Y.Doc,
  blockId: string,
  range: InlineLinkRange,
  docId: string,
  options: SetInlineLinkOptions = {},
): void {
  const element = findBlockElement(ydoc, blockId);
  if (element === null) throw new BlockNotFoundError(blockId);

  // Validate before mutation: Yjs transactions do not roll back.
  const current = toBlock(element);
  if (!isProseBlockType(current.type)) {
    throw new InlineLinkRangeError("not-prose", blockId, current.type);
  }
  if (options.rev !== undefined && options.rev !== current.rev) {
    throw new StaleBlockError({
      blockId,
      expectedRev: options.rev,
      currentText: current.text,
      currentRev: current.rev,
    });
  }

  const target = canonicalDocumentUuid(docId);
  if (target === null) throw new InvalidDocLinkTargetError(docId);

  // Do not create missing text: empty-range refusal must leave the document unchanged.
  const ytext = textOf(element);
  const length = ytext === null ? 0 : ytext.length;
  const lo = Math.max(0, Math.min(length, Math.min(range.start, range.end)));
  const hi = Math.max(0, Math.min(length, Math.max(range.start, range.end)));
  if (ytext === null || lo === hi) {
    throw new InlineLinkRangeError("empty", blockId);
  }

  const href = linkInRange(ytext, lo, hi);
  if (href !== null) throw new ConflictingLinkMarksError(href, target);

  ydoc.transact(() => {
    // Clear invisible merged link keys; an already absent key causes no update.
    ytext.format(lo, hi - lo, { docLink: { docId: target }, link: null });
  });
}
