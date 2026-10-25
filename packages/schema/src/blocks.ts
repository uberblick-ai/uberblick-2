/**
 * Writes address one logical block; whole-document replacement loses
 * concurrent edits. Block elements stay flat, including list items and quotes.
 * Table cells, card parts and Figma captions contain their own single paragraphs.
 */

import * as Y from "yjs";
import fastDiff from "fast-diff";
import { getBlocksFragment } from "./doc.js";
import { CARD_PARTS, buildCardElement, cardButtons, cardText, cardTextParts, editCard, parseCardInput, writeCardInline } from "./card.js";
import type { CardButton, CardInline } from "./card.js";
import { isCalloutIcon, isCalloutVariant, validateCalloutAttributes } from "./callout.js";
import { buildFigmaElement, editFigma, figmaFields, figmaText, parseFigmaInput, writeFigmaInline } from "./figma.js";
import type { FigmaInline } from "./figma.js";
import { parseInline } from "./markdown.js";
import { plainXmlText, structuredInlineParts } from "./inline-parts.js";
import {
  BlockNotFoundError,
  ConflictingLinkMarksError,
  InlineLinkRangeError,
  InvalidDocLinkTargetError,
  InvalidBlockMoveError,
  InvalidListAttributesError,
  InvalidCalloutError,
  InvalidTableMappingError,
  OldTextMismatchError,
  StaleBlockError,
} from "./errors.js";
import {
  applyInlineRuns,
  assertInlineWritable,
  readInlineRuns,
} from "./marks.js";
import { blockRev } from "./rev.js";
import { canonicalDocumentUuid } from "./rooms.js";
import { buildTableElement, editTable, parseGfmTable, parseTableInput, parseTableCell, tableRows, tableText } from "./table.js";
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
  CalloutVariant,
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

/**
 * All fragment readers share the first document-order element for each id.
 * Concurrent re-types insert same-id copies; converged order shadows the same
 * losers on every replica. Empty-id elements remain visible and unrepairable,
 * since missing identity cannot justify silently dropping foreign content.
 */
export function partitionById(fragment: Y.XmlFragment): {
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

/**
 * @internal — shared with the annotations module. Flat blocks only: callers
 * branch on table, card and Figma first, or this would insert a text child.
 */
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

export function toBlock(element: Y.XmlElement): Block {
  // Prose rev excludes marks; structured prose projections include inline formatting.
  const type = elementType(element);
  const id = element.getAttribute("id") ?? "";
  const text = type === "card" ? cardText(element)
    : type === "figma" ? figmaText(element)
    : type === "table" && element.toArray().some((node) => node instanceof Y.XmlElement && node.nodeName === "tableRow")
      ? tableText(element) : plainXmlText(textOf(element));
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
  if (type === "callout") {
    const storedVariant = element.getAttribute("variant");
    const storedIcon = element.getAttribute("icon");
    return {
      id, type, text,
      rev: blockRev({ type, text, variant: storedVariant, icon: storedIcon }),
      variant: isCalloutVariant(storedVariant) ? storedVariant : "note",
      ...(isCalloutIcon(storedIcon) ? { icon: storedIcon } : {}),
    };
  }
  const figma = type === "figma" ? figmaFields(element) : undefined;
  return { id, type, text, rev: blockRev({ type, text }), ...(figma === undefined ? {} : { figma }) };
}

/**
 * Document-order visible blocks, with duplicate identities shadowed.
 */
export function getBlocks(ydoc: Y.Doc): Block[] {
  return partitionById(getBlocksFragment(ydoc)).visible.map(toBlock);
}

/** Fold visible content and order, caching by element so re-types invalidate it. */
function foldDocRev(ydoc: Y.Doc, revs: Map<Y.XmlElement, string>): string {
  const next = new Map<Y.XmlElement, string>();
  const lines: string[] = [];
  for (const element of partitionById(getBlocksFragment(ydoc)).visible) {
    const rev = revs.get(element) ?? toBlock(element).rev;
    next.set(element, rev);
    lines.push(`${element.getAttribute("id") ?? ""} ${rev}`);
  }
  revs.clear();
  for (const [element, rev] of next) revs.set(element, rev);
  return blockRev({ type: "paragraph", text: lines.join("\n") });
}

/** The page's visible text revision, excluding metadata and prose marks. */
export function docRev(ydoc: Y.Doc): string {
  return foldDocRev(ydoc, new Map());
}

/**
 * Seed once, then reread only changed visible blocks. Element identity keeps
 * re-types fresh and gives distinct ID-less blocks their own revisions.
 */
export function observeDocRev(ydoc: Y.Doc, emit: (rev: string) => void): () => void {
  const fragment = getBlocksFragment(ydoc);
  const revs = new Map<Y.XmlElement, string>();
  const onChange = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
    for (const event of events) {
      let current: Y.AbstractType<unknown> | null = event.target;
      while (current !== null && current.parent !== fragment) {
        current = current.parent;
      }
      if (current instanceof Y.XmlElement) revs.delete(current);
    }
    emit(foldDocRev(ydoc, revs));
  };
  emit(foldDocRev(ydoc, revs));
  fragment.observeDeep(onChange);
  return () => fragment.unobserveDeep(onChange);
}

/** One block by id, or null when it does not exist (or was deleted). */
export function getBlock(ydoc: Y.Doc, blockId: string): Block | null {
  const element = findBlockElement(ydoc, blockId);
  return element === null ? null : toBlock(element);
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
): Array<{ block: Block; inline: InlineRun[]; table?: InlineRun[][][]; card?: CardInline; cardButtons?: CardButton[]; figma?: FigmaInline }> {
  return partitionById(getBlocksFragment(ydoc)).visible.map((element) => {
    const table: InlineRun[][][] = tableRows(element).map(() => []);
    const card = {} as CardInline;
    const figma: FigmaInline = { caption: [] };
    for (const part of structuredInlineParts(element)) {
      const runs = part.texts.flatMap(readInlineRuns);
      if (part.kind === "table") table[part.row]?.push(runs);
      else if (part.kind === "card") card[part.part] = runs;
      else figma.caption = runs;
    }
    return {
      block: toBlock(element),
      inline: readInlineRuns(textOf(element)),
      ...(element.nodeName === "table" ? { table } : {}),
      ...(element.nodeName === "card" ? { card, cardButtons: cardButtons(element) } : {}),
      ...(element.nodeName === "figma" ? { figma } : {}),
    };
  });
}

/**
 * Inline input overrides text only for prose; structured/source blocks ignore it.
 */
function inlineOf(input: BlockInput): readonly InlineRun[] | null {
  if (input.inline === undefined) return null;
  return isProseBlockType(input.type) ? input.inline : null;
}

function buildElement(id: string, input: BlockInput): Y.XmlElement {
  // Validate before insertion: Yjs transactions cannot roll back stray blocks.
  if (input.type === "callout") validateCalloutAttributes(input);
  const runs = inlineOf(input);
  if (runs !== null) assertInlineWritable(runs);

  if (input.type === "card") {
    const card = parseCardInput(input.text ?? "");
    for (const part of CARD_PARTS) assertInlineWritable(parseInline(card[part]));
    return buildCardElement(id);
  }

  if (input.type === "figma") {
    const figma = parseFigmaInput(input.text ?? "");
    assertInlineWritable(parseInline(figma.caption));
    return buildFigmaElement(id);
  }

  if (input.type === "table") {
    const table = parseTableInput(input.text ?? "");
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
  if (input.type === "callout") {
    element.setAttribute("variant", input.variant ?? "note");
    if (input.icon !== undefined) element.setAttribute("icon", input.icon);
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
  if (input.type === "figma") {
    writeFigmaInline(element, parseFigmaInput(input.text ?? ""));
    return;
  }
  if (input.type === "card") {
    writeCardInline(element, parseCardInput(input.text ?? ""));
    return;
  }
  if (input.type === "table") {
    const table = parseTableInput(input.text ?? "");
    const values = [table.header, ...table.rows];
    for (const part of structuredInlineParts(element)) {
      if (part.kind !== "table") continue;
      const text = part.texts[0];
      if (text !== undefined) applyInlineRuns(text, parseTableCell(values[part.row]?.[part.column] ?? ""));
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
 * Move visible block copies together, preserving their attributes and marks.
 * Concurrent edits to their deleted originals do not follow the copies.
 * Returns false without writing when the requested visible order already holds.
 */
export function moveBlocks(
  ydoc: Y.Doc,
  blockIds: readonly string[],
  afterBlockId: string | null = null,
): boolean {
  if (blockIds.length === 0) throw new InvalidBlockMoveError("empty_block_ids");
  const selected = new Set<string>();
  for (const id of blockIds) {
    if (selected.has(id)) throw new InvalidBlockMoveError("duplicate_block_id", id);
    selected.add(id);
  }
  if (afterBlockId !== null && selected.has(afterBlockId)) {
    throw new InvalidBlockMoveError("move_target_in_selection", afterBlockId);
  }

  const fragment = getBlocksFragment(ydoc);
  const { visible } = partitionById(fragment);
  const byId = new Map<string, Y.XmlElement>();
  for (const element of visible) {
    const id = element.getAttribute("id");
    if (id !== undefined && !byId.has(id)) byId.set(id, element);
  }
  const moving = blockIds.map((id) => {
    const element = byId.get(id);
    if (element === undefined) throw new BlockNotFoundError(id);
    return element;
  });
  if (afterBlockId !== null && !byId.has(afterBlockId)) {
    throw new BlockNotFoundError(afterBlockId);
  }

  const isSelected = (element: Y.XmlElement): boolean => {
    const id = element.getAttribute("id");
    return id !== undefined && selected.has(id);
  };
  const remaining = visible.filter((element) => !isSelected(element));
  const position = afterBlockId === null ? 0 : remaining.findIndex((element) => element.getAttribute("id") === afterBlockId) + 1;
  const ordered = [...remaining.slice(0, position), ...moving, ...remaining.slice(position)];
  if (ordered.every((element, index) => element === visible[index])) return false;

  const copies = moving.map((element) => element.clone());
  const indexes = fragment.toArray().flatMap((node, index) =>
    node instanceof Y.XmlElement && isSelected(node) ? [index] : [],
  );
  ydoc.transact(() => {
    for (const index of indexes.reverse()) fragment.delete(index, 1);
    const destination = afterBlockId === null ? 0 : indexOfBlock(fragment, afterBlockId) + 1;
    fragment.insert(destination, copies);
  });
  return true;
}

/** Remove retired Mermaid elements, including shadowed or malformed copies. */
export function removeLegacyMermaidBlocks(ydoc: Y.Doc): number {
  const fragment = getBlocksFragment(ydoc);
  const indexes = fragment.toArray().flatMap((node, index) =>
    node instanceof Y.XmlElement && node.nodeName === "mermaid" ? [index] : [],
  );
  if (indexes.length > 0) {
    ydoc.transact(() => {
      for (const index of indexes.reverse()) fragment.delete(index, 1);
    });
  }
  return indexes.length;
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
 * Normalize only legacy table content. Each replacement is a same-id element,
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
    const source = plainXmlText(children[0]);
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

export interface EditBlockOptions {
  /**
   * Refuse a stale rev even if oldText matches; attributes also affect the hash.
   */
  rev?: string;
  /** List marker to set in place; omitted markers remain unchanged. */
  list?: ListStyle;
  /** List depth, an integer from 0 to 3; omitted depth remains unchanged. */
  indent?: ListIndent;
  /** Callout variant to set in place; omission leaves it unchanged. */
  variant?: CalloutVariant;
  /** Callout icon to set in place; an empty value removes the override. */
  icon?: string;
  /** Surviving old GFM positions, or null for newly created rows and columns. */
  tableMapping?: TableMapping;
}

function validateListAttributes(type: BlockType, options: EditBlockOptions): void {
  if (options.list === undefined && options.indent === undefined) return;
  if (type !== "list-item") {
    throw new InvalidListAttributesError("list and indent apply only to list-item blocks");
  }
  if (options.list !== undefined && !isListStyle(options.list)) {
    throw new InvalidListAttributesError("list must be bullet or ordered");
  }
  if (options.indent !== undefined && (!Number.isInteger(options.indent) || options.indent < 0 || options.indent > MAX_LIST_INDENT)) {
    throw new InvalidListAttributesError("indent must be an integer from 0 to 3");
  }
}

function validateCalloutEdit(type: BlockType, options: EditBlockOptions): void {
  if (options.variant === undefined && options.icon === undefined) return;
  if (type !== "callout") throw new InvalidCalloutError("variant and icon apply only to callout blocks");
  validateCalloutAttributes(options, true);
}

function writeCalloutAttributes(element: Y.XmlElement, options: EditBlockOptions): void {
  if (options.variant !== undefined) element.setAttribute("variant", options.variant);
  if (options.icon === "") element.removeAttribute("icon");
  else if (options.icon !== undefined) element.setAttribute("icon", options.icon);
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
 * List attributes update the existing element without replacing its text child.
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
    validateListAttributes(current.type, options);
    validateCalloutEdit(current.type, options);
    if (current.type === "table") {
      const parsedOld = parseTableInput(oldText);
      const parsedNew = parseTableInput(newText);
      editTable(element, parsedOld, parsedNew, options.tableMapping);
      return;
    }
    if (options.tableMapping !== undefined) throw new InvalidTableMappingError("mapping applies only to a table block");
    if (current.type === "figma") {
      editFigma(element, parseFigmaInput(current.text), parseFigmaInput(newText));
      return;
    }
    if (current.type === "card") {
      // Empty editor titles project without a title header; MCP must repair them.
      const after = parseCardInput(newText);
      editCard(element, cardTextParts(element), after);
      return;
    }
    if (options.list !== undefined) element.setAttribute("list", options.list);
    if (options.indent !== undefined) element.setAttribute("indent", String(options.indent));
    writeCalloutAttributes(element, options);
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
