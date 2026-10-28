import * as Y from "yjs";
import { partitionById, toBlock } from "./blocks.js";
import { CARD_PARTS, cardButtons, cardPartTexts } from "./card.js";
import { getBlocksFragment } from "./doc.js";
import { figmaCaptionTexts, figmaTextParts } from "./figma.js";
import { inlinePartTexts } from "./inline-parts.js";
import { inlinePlainText, pushInlineRun, readInlineRuns } from "./marks.js";
import { diffWords, matchSequence } from "./revision-sequence.js";
import type { SequencePair, TextSpan } from "./revision-sequence.js";
import type { BlockType, InlineMarkSet, InlineRun } from "./types.js";

export interface RevisionTableCell {
  id: string;
  key: string;
  text: string;
  inline: InlineRun[];
  width: number | null;
}

export interface RevisionTableRow {
  id: string;
  key: string;
  cells: RevisionTableCell[];
}

export interface RevisionTable {
  width: number;
  rows: RevisionTableRow[];
}

export interface RevisionBlock {
  id: string;
  type: BlockType;
  key: string;
  text: string;
  fields: Record<string, unknown>;
  inline?: InlineRun[];
  table?: RevisionTable;
  chartMapping?: boolean;
}

export interface RevisionCellComparison {
  column: number;
  kind: "unchanged" | "changed";
  spans: TextSpan[];
  fields: string[];
}

export interface RevisionRowComparison {
  kind: "unchanged" | "changed" | "added" | "removed";
  beforeIndex?: number;
  afterIndex?: number;
  cells?: RevisionCellComparison[];
}

/** Exact, sorted content keys avoid collisions and ignore JSON object key order. */
export function contentKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(contentKey).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${contentKey(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizedRuns(texts: readonly Y.XmlText[]): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const text of texts) {
    for (const run of readInlineRuns(text)) pushInlineRun(runs, run.text, run.marks);
  }
  return runs;
}

function storedIdentity(element: Y.XmlElement): string {
  const id = Y.createRelativePositionFromTypeIndex(element, 0).type;
  return id === null ? "" : `${id.client}:${id.clock}`;
}

function snapshotTable(element: Y.XmlElement): RevisionTable | undefined {
  const storedRows = element.toArray().filter((node): node is Y.XmlElement =>
    node instanceof Y.XmlElement && node.nodeName === "tableRow",
  );
  if (storedRows.length === 0) return undefined;
  const rows = storedRows.map((row): RevisionTableRow => {
    const cells = row.toArray().filter((node): node is Y.XmlElement =>
      node instanceof Y.XmlElement && (node.nodeName === "tableHeader" || node.nodeName === "tableCell"),
    ).map((cell): RevisionTableCell => {
      const inline = normalizedRuns(inlinePartTexts(cell));
      const colwidth = cell.getAttributes().colwidth as unknown;
      const width = Array.isArray(colwidth) && typeof colwidth[0] === "number" ? colwidth[0] : null;
      return { id: storedIdentity(cell), key: contentKey(inline), text: inlinePlainText(inline), inline, width };
    });
    return { id: storedIdentity(row), key: contentKey(cells.map((cell) => cell.inline)), cells };
  });
  const width = Math.max(0, ...rows.map((row) => row.cells.length));
  for (const row of rows) {
    while (row.cells.length < width) row.cells.push(EMPTY_CELL);
    row.key = contentKey(row.cells.map((cell) => cell.inline));
  }
  return { width, rows };
}

function chartFields(text: string): { fields: Record<string, unknown>; mapping: boolean } {
  try {
    const mapping: unknown = JSON.parse(text);
    if (mapping !== null && typeof mapping === "object" && !Array.isArray(mapping)) return { fields: mapping as Record<string, unknown>, mapping: true };
  } catch {
    // Invalid source remains authored content even when it cannot be a mapping.
  }
  return { fields: { source: text }, mapping: false };
}

function snapshotBlock(element: Y.XmlElement): RevisionBlock {
  const block = toBlock(element);
  const base = { id: block.id, type: block.type, text: block.text };
  const fields: Record<string, unknown> = {};
  if (block.type === "divider") return { ...base, fields, key: contentKey({ type: block.type }) };
  if (block.type === "card") {
    for (const part of CARD_PARTS) fields[part] = normalizedRuns(cardPartTexts(element, part));
    fields.buttons = cardButtons(element);
  } else if (block.type === "figma") {
    const parts = figmaTextParts(element);
    fields.url = parts.url;
    fields.title = parts.title;
    fields.height = parts.height;
    fields.caption = normalizedRuns(figmaCaptionTexts(element));
  } else if (block.type === "chart") {
    const chart = chartFields(block.text);
    return { ...base, fields: chart.fields, chartMapping: chart.mapping, key: contentKey({ type: block.type, mapping: chart.mapping, fields: chart.fields }) };
  } else if (block.type === "table") {
    const table = snapshotTable(element);
    if (table !== undefined) {
      return {
        ...base, fields, table,
        key: contentKey({ type: block.type, rows: table.rows.map((row) => row.cells.map((cell) => ({ inline: cell.inline, width: cell.width }))) }),
      };
    }
    fields.source = block.text;
  } else {
    if (block.level !== undefined) fields.level = block.level;
    if (block.language !== undefined) fields.language = block.language;
    if (block.list !== undefined) fields.list = block.list;
    if (block.indent !== undefined) fields.indent = block.indent;
    if (block.type === "callout") {
      fields.variant = element.getAttribute("variant") ?? "note";
      const icon = element.getAttribute("icon");
      if (icon !== undefined) fields.icon = icon;
    }
    const first = element.firstChild;
    const inline = normalizedRuns(first instanceof Y.XmlText ? [first] : []);
    return { ...base, fields, inline, key: contentKey({ type: block.type, fields, inline }) };
  }
  return { ...base, fields, key: contentKey({ type: block.type, fields }) };
}

/** One visible-block traversal; keys contain only the authored comparison fields. */
export function snapshotBlocks(doc: Y.Doc): RevisionBlock[] {
  return partitionById(getBlocksFragment(doc)).visible.map(snapshotBlock);
}

interface MarkSlice { length: number; marks: InlineMarkSet }

function markReader(runs: readonly InlineRun[]): (length: number) => MarkSlice[] {
  let index = 0;
  let offset = 0;
  return (length) => {
    const slices: MarkSlice[] = [];
    let remaining = length;
    while (remaining > 0) {
      const run = runs[index];
      if (run === undefined) break;
      const take = Math.min(remaining, run.text.length - offset);
      if (take > 0) slices.push({ length: take, marks: run.marks });
      remaining -= take;
      offset += take;
      if (offset === run.text.length) { index += 1; offset = 0; }
    }
    return slices;
  };
}

function markKey(marks: InlineMarkSet, field: "formatting" | "link"): string {
  return field === "link" ? contentKey(marks.docLink ?? marks.link ?? null)
    : contentKey([marks.bold === true, marks.italic === true, marks.strike === true, marks.inlineCode === true]);
}

function markSignature(slices: readonly MarkSlice[], field: "formatting" | "link", lengths: boolean): string {
  const parts: Array<{ key: string; length: number }> = [];
  for (const slice of slices) {
    const key = markKey(slice.marks, field);
    const last = parts[parts.length - 1];
    if (last?.key === key) last.length += slice.length;
    else parts.push({ key, length: slice.length });
  }
  return contentKey(parts.map((part) => lengths ? [part.key, part.length] : part.key));
}

/** Align marks with equal text, so changing a word alone does not imply formatting. */
export function inlineChanges(before: readonly InlineRun[], after: readonly InlineRun[], spans: readonly TextSpan[]): string[] {
  const readBefore = markReader(before);
  const readAfter = markReader(after);
  const changed = new Set<string>();
  let removed: MarkSlice[] = [];
  let added: MarkSlice[] = [];
  const compare = (oldSlices: readonly MarkSlice[], newSlices: readonly MarkSlice[], lengths: boolean): void => {
    for (const field of ["formatting", "link"] as const) {
      if (markSignature(oldSlices, field, lengths) !== markSignature(newSlices, field, lengths)) changed.add(field);
    }
  };
  const flush = (): void => {
    if (removed.length > 0 && added.length > 0) compare(removed, added, false);
    removed = [];
    added = [];
  };
  for (const span of spans) {
    if (span.kind === "unchanged") {
      flush();
      compare(readBefore(span.text.length), readAfter(span.text.length), true);
    } else if (span.kind === "removed") removed.push(...readBefore(span.text.length));
    else added.push(...readAfter(span.text.length));
  }
  flush();
  return [...changed];
}

function sameMultiset(before: readonly string[], after: readonly string[]): boolean {
  return contentKey([...before].sort()) === contentKey([...after].sort());
}

function columnsChanged(before: RevisionTable, after: RevisionTable): boolean {
  if (before.width !== after.width) return true;
  const oldHeader = before.rows[0]?.cells ?? [];
  const newHeader = after.rows[0]?.cells ?? [];
  const oldIds = oldHeader.map((cell) => cell.id);
  const newIds = newHeader.map((cell) => cell.id);
  const oldSet = new Set(oldIds);
  const sharedIds = newIds.filter((id) => id !== "" && oldSet.has(id));
  if (sharedIds.length > 0) return contentKey(oldIds) !== contentKey(newIds);
  const oldKeys = oldHeader.map((cell) => cell.key);
  const newKeys = newHeader.map((cell) => cell.key);
  if (contentKey(oldKeys) !== contentKey(newKeys) && sameMultiset(oldKeys, newKeys)) return true;
  if (before.rows.length !== after.rows.length) return false;
  const columns = (table: RevisionTable): string[] => Array.from({ length: table.width }, (_, column) =>
    contentKey(table.rows.map((row) => row.cells[column]?.key ?? EMPTY_CELL.key)),
  );
  const oldColumns = columns(before);
  const newColumns = columns(after);
  return contentKey(oldColumns) !== contentKey(newColumns) && sameMultiset(oldColumns, newColumns);
}

function rowPairs(before: readonly RevisionTableRow[], after: readonly RevisionTableRow[]): SequencePair[] {
  const pairs = matchSequence(before.slice(1), after.slice(1)).map((pair) => ({ before: pair.before + 1, after: pair.after + 1 }));
  if (before.length > 0 && after.length > 0) pairs.unshift({ before: 0, after: 0 });
  const ids = new Set(before.map((row) => row.id));
  if (after.some((row) => row.id !== "" && ids.has(row.id))) return pairs;
  const expanded: SequencePair[] = [];
  let oldStart = 0;
  let newStart = 0;
  for (const pair of [...pairs, { before: before.length, after: after.length }]) {
    const overlap = Math.min(pair.before - oldStart, pair.after - newStart);
    for (let offset = 0; offset < overlap; offset += 1) expanded.push({ before: oldStart + offset, after: newStart + offset });
    if (pair.before < before.length) expanded.push(pair);
    oldStart = pair.before + 1;
    newStart = pair.after + 1;
  }
  return expanded;
}

const EMPTY_CELL: RevisionTableCell = { id: "", key: "[]", text: "", inline: [], width: null };

function changedWidths(before: RevisionTable, after: RevisionTable, pairs: readonly SequencePair[], changedColumns: boolean): boolean {
  const oldHeader = before.rows[0]?.cells ?? [];
  const oldColumns = new Map(oldHeader.map((cell, index) => [cell.id, index]));
  const columns = (after.rows[0]?.cells ?? []).flatMap((cell, index) => {
    const previous = changedColumns ? (cell.id === "" ? undefined : oldColumns.get(cell.id)) : index;
    return previous === undefined ? [] : [{ before: previous, after: index }];
  });
  return pairs.some((pair) => {
    const oldCells = before.rows[pair.before]?.cells ?? [];
    const newCells = after.rows[pair.after]?.cells ?? [];
    return columns.some((column) => (oldCells[column.before]?.width ?? null) !== (newCells[column.after]?.width ?? null));
  });
}

function compareRow(before: RevisionTableRow, after: RevisionTableRow, pair: SequencePair, width: number): RevisionRowComparison {
  const cells = Array.from({ length: width }, (_, column): RevisionCellComparison => {
    const oldCell = before.cells[column] ?? EMPTY_CELL;
    const newCell = after.cells[column] ?? EMPTY_CELL;
    const spans = diffWords(oldCell.text, newCell.text);
    const fields = inlineChanges(oldCell.inline, newCell.inline, spans);
    const changed = oldCell.key !== newCell.key;
    return {
      column, kind: changed ? "changed" : "unchanged", fields,
      spans: oldCell.text === newCell.text ? [] : spans,
    };
  });
  return { kind: cells.some((cell) => cell.kind === "changed") ? "changed" : "unchanged", beforeIndex: pair.before, afterIndex: pair.after, cells };
}

/** Column structure changes deliberately suppress cell spans; rows retain their positions. */
export function compareTables(before: RevisionBlock, after: RevisionBlock): { fields: string[]; rows: RevisionRowComparison[] } {
  const oldTable = before.table;
  const newTable = after.table;
  if (oldTable === undefined || newTable === undefined) return { fields: ["source"], rows: [] };
  const changedColumns = columnsChanged(oldTable, newTable);
  const pairs = rowPairs(oldTable.rows, newTable.rows);
  const fields: string[] = changedColumns ? ["columns"] : [];
  if (changedWidths(oldTable, newTable, pairs, changedColumns)) fields.push("columnWidths");
  if (changedColumns) return { fields, rows: [] };
  const rows: RevisionRowComparison[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const pair of [...pairs, { before: oldTable.rows.length, after: newTable.rows.length }]) {
    while (oldIndex < pair.before) { rows.push({ kind: "removed", beforeIndex: oldIndex }); oldIndex += 1; }
    while (newIndex < pair.after) { rows.push({ kind: "added", afterIndex: newIndex }); newIndex += 1; }
    const oldRow = oldTable.rows[pair.before];
    const newRow = newTable.rows[pair.after];
    if (oldRow !== undefined && newRow !== undefined) rows.push(compareRow(oldRow, newRow, pair, oldTable.width));
    oldIndex = pair.before + 1;
    newIndex = pair.after + 1;
  }
  return { fields, rows };
}
