import * as Y from "yjs";
import { InvalidTableError, InvalidTableMappingError, TableMappingRequiredError } from "./errors.js";
import { applyInlineRuns, assertInlineWritable, inlinePlainText, readInlineRuns } from "./marks.js";
import { spliceInlineText } from "./inline-edit.js";
import { buildInlinePart, ensureInlinePartText, inlinePartTexts, isSupportedInlinePart, plainXmlText, seedNewInlinePartsOfKind, tableRows } from "./inline-parts.js";
import { parseInline, renderInline } from "./markdown.js";
import type { InlineRun } from "./types.js";

/** `null` leaves alignment at the renderer's default. */
export type ColumnAlign = "left" | "center" | "right" | null;

export interface GfmTable {
  header: string[];
  align: ColumnAlign[];
  /** Body rows are padded or truncated to the header's column count. */
  rows: string[][];
}

/**
 * GFM permits one hyphen and optional alignment colons.
 * The row still needs a structural pipe to distinguish it from prose.
 */
const DELIMITER_CELL = /^:?-+:?$/;

interface Row {
  cells: string[];
  /** Count only unescaped separators; zero means the line has no table structure. */
  pipes: number;
}

/**
 * Odd backslash runs escape the following pipe; even runs leave it structural.
 * Resolve only pipe escapes and adjacent backslash pairs, leaving other escapes
 * and inline Markdown literal. Structural edge pipes decorate rather than add cells.
 */
function scanRow(line: string): Row {
  const trimmed = line.trim();
  const cells: string[] = [];
  let pipes = 0;
  let firstPipe = -1;
  let lastPipe = -1;
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === "\\") {
      let run = 0;
      while (trimmed[i + run] === "\\") run += 1;
      const escapesPipe = run % 2 === 1 && trimmed[i + run] === "|";
      // Decode pairs only beside pipes so the writer can round-trip any backslash count.
      current += "\\".repeat(trimmed[i + run] === "|" ? Math.floor(run / 2) : run);
      if (escapesPipe) current += "|";
      i += escapesPipe ? run : run - 1;
      continue;
    }
    if (char === "|") {
      pipes += 1;
      if (firstPipe === -1) firstPipe = i;
      lastPipe = i;
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  // Only scanned structural pipes can decorate the edges.
  if (firstPipe === 0) cells.shift();
  if (lastPipe === trimmed.length - 1) cells.pop();
  return { cells: cells.map((cell) => cell.trim()), pipes };
}

/** A write must contain exactly one table, rather than a table plus a block. */
export function parseTableInput(source: string): GfmTable {
  const parsed = parseGfmTable(source);
  const lines = source.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  const otherBlock = lines.some((line) =>
    /^(?: {4}| {0,3}\t)/.test(line) || startsNonTableBlock(line),
  );
  if (parsed === null || otherBlock) throw new InvalidTableError();
  return parsed;
}

/** GFM block starters interrupt a table even without an intervening blank line. */
function startsNonTableBlock(line: string): boolean {
  const text = line.replace(/^ {0,3}/, "");
  if (/^(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/.test(text)) return true;
  if (/^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(text)) return true;
  // HTML block types 1–6 start even when text follows the opening tag. Type 7
  // requires a complete standalone tag; an autolink or inline HTML stays a row.
  if (/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(text) || /^<!--|^<\?|^<![A-Z]|^<!\[CDATA\[/.test(text)) return true;
  if (/^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t/>]|$)/i.test(text)) return true;
  return /^<\/[A-Za-z][A-Za-z\d-]*[ \t]*>[ \t]*$/.test(text) ||
    /^<[A-Za-z][A-Za-z\d-]*(?:[ \t]+[A-Za-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^ \t"'=<>`]+))?)*[ \t]*\/?>[ \t]*$/.test(text);
}

export { INLINE_PART_MARKS as TABLE_CELL_MARKS, plainXmlText, tableRows } from "./inline-parts.js";

export function parseTableCell(source: string): InlineRun[] {
  return parseInline(source, true);
}

/** First writes into an empty paragraph can concurrently create several texts. */
export function tableCellTexts(cell: Y.XmlElement): Y.XmlText[] {
  return inlinePartTexts(cell);
}

export function tableCellText(cell: Y.XmlElement): Y.XmlText | null {
  return tableCellTexts(cell)[0] ?? null;
}

function escapeTableText(text: string): string {
  return text.replace(/(\\*)\|/g, (_match, slashes: string) => `${slashes.repeat(2)}\\|`);
}

/** Header, delimiter and all rows are padded to the widest stored row. */
export function writeGfmTable(
  rows: readonly (readonly string[])[],
  escapeCell: (text: string) => string = escapeTableText,
): string {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0 || rows.length === 0) return "";
  const line = (row: readonly string[]) => `| ${Array.from({ length: width }, (_, col) => escapeCell(row[col] ?? "")).join(" | ")} |`;
  return [line(rows[0] ?? []), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

export function tableText(element: Y.XmlElement): string {
  return writeGfmTable(tableRows(element).map((row) => row.map((cell) => renderInline(tableCellTexts(cell).flatMap(readInlineRuns), true))));
}

export function isSupportedColumnWidth(value: unknown): boolean {
  return value === undefined || value === null ||
    (Array.isArray(value) && value.length === 1 && typeof value[0] === "number" && Number.isFinite(value[0]) && value[0] > 0);
}

/** Bindable cell grammar. Rectangularity is deliberately not a read invariant. */
export function isSupportedTable(element: Y.XmlElement): boolean {
  if (element.nodeName !== "table" || element.length === 0) return false;
  if (Object.keys(element.getAttributes()).some((key) => key !== "id")) return false;
  return element.toArray().every((row, index) => {
    if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow" || row.length === 0 || Object.keys(row.getAttributes()).length !== 0) return false;
    return row.toArray().every((cell) => {
      if (!(cell instanceof Y.XmlElement) || cell.nodeName !== (index === 0 ? "tableHeader" : "tableCell")) return false;
      const attrs = cell.getAttributes() as Record<string, unknown>;
      if (Object.keys(attrs).some((key) => !["colspan", "rowspan", "colwidth"].includes(key)) || attrs.colspan !== 1 || attrs.rowspan !== 1 || !isSupportedColumnWidth(attrs.colwidth)) return false;
      return isSupportedInlinePart(cell, false);
    });
  });
}

export function buildTableCell(text: string, header: boolean): Y.XmlElement {
  const cell = buildInlinePart(header ? "tableHeader" : "tableCell", text);
  // y-prosemirror writes native ProseMirror attribute values, not strings.
  const attrs = cell as unknown as { setAttribute(name: string, value: unknown): void };
  attrs.setAttribute("colspan", 1);
  attrs.setAttribute("rowspan", 1);
  // ProseMirror's colwidth default is null. y-prosemirror omits null attrs.
  return cell;
}

export function buildTableRow(texts: readonly string[], header: boolean): Y.XmlElement {
  const row = new Y.XmlElement("tableRow");
  row.insert(0, texts.map((text) => buildTableCell(text, header)));
  return row;
}

export function buildTableElement(id: string, table: GfmTable): Y.XmlElement {
  const element = new Y.XmlElement("table");
  element.setAttribute("id", id);
  element.insert(0, [buildTableRow(table.header, true), ...table.rows.map((row) => buildTableRow(row, false))]);
  return element;
}

/** Seed cells created by TableKit in the same local transaction as their row. */
export function seedNewTableCells(transaction: Y.Transaction): void {
  seedNewInlinePartsOfKind(transaction, "table");
}

/**
 * Diff only changed characters and mark keys in the old projection, preserving
 * unexpressible marks, comments and trimmed edge whitespace elsewhere.
 */
function spliceTableCell(cell: Y.XmlElement, before: string, after: string): void {
  const text = ensureInlinePartText(cell);
  if (text === null) throw new InvalidTableError();
  const oldRuns = parseTableCell(before);
  const newRuns = parseTableCell(after);
  const oldValue = inlinePlainText(oldRuns);
  // Keep edge whitespace omitted by scanRow outside the projected edit range.
  const offset = plainXmlText(text).indexOf(oldValue);
  if (offset < 0) throw new InvalidTableError();
  spliceInlineText(text, oldRuns, newRuns, offset);
}

/** Create a new mapped cell's inline content only after attaching its text. */
function writeTableCell(cell: Y.XmlElement, value: string): void {
  const text = tableCellText(cell);
  if (text !== null) applyInlineRuns(text, parseTableCell(value));
}

/** Each output position names an old projected position, or a newly created one. */
export interface TableMapping {
  rows: Array<number | null>;
  columns: Array<number | null>;
}

function validatePositions(positions: Array<number | null>, oldLength: number, newLength: number, name: string): void {
  if (!Array.isArray(positions) || positions.length !== newLength) {
    throw new InvalidTableMappingError(`${name} must have one entry per requested ${name === "rows" ? "row" : "column"}`);
  }
  let previous = -1;
  for (const position of positions) {
    if (position === null) continue;
    if (!Number.isSafeInteger(position) || position < 0 || position >= oldLength || position <= previous) {
      throw new InvalidTableMappingError(`${name} must contain null or unique, increasing old indices in bounds`);
    }
    previous = position;
  }
}

function tableMapping(oldValues: string[][], newValues: string[][], supplied: TableMapping | undefined): TableMapping {
  const oldWidth = oldValues[0]?.length ?? 0;
  const newWidth = newValues[0]?.length ?? 0;
  if (supplied !== undefined) {
    if (supplied === null || typeof supplied !== "object") throw new InvalidTableMappingError("rows and columns are required together");
    validatePositions(supplied.rows, oldValues.length, newValues.length, "rows");
    validatePositions(supplied.columns, oldWidth, newWidth, "columns");
    if (supplied.rows[0] !== 0) throw new InvalidTableMappingError("the header row must map to old row 0");
    return supplied;
  }
  if (oldValues.length !== newValues.length || oldWidth !== newWidth) throw new TableMappingRequiredError();
  let changes = 0;
  for (let row = 0; row < newValues.length; row += 1) {
    for (let column = 0; column < newWidth; column += 1) {
      if (oldValues[row]?.[column] !== newValues[row]?.[column]) changes += 1;
      if (changes > 1) throw new TableMappingRequiredError();
    }
  }
  return {
    rows: oldValues.map((_, row) => row),
    columns: Array.from({ length: oldWidth }, (_, column) => column),
  };
}

/**
 * Caller mappings preserve row/column identity that equal GFM values cannot convey.
 * Compare parsed cells so unchanged whitespace and marks survive.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validation must precede the first write because Yjs transactions do not roll back; checks and writes share one row and column mapping.
export function editTable(element: Y.XmlElement, oldTable: GfmTable, newTable: GfmTable, mapping?: TableMapping): void {
  if (!isSupportedTable(element)) throw new InvalidTableError();
  const oldValues = [oldTable.header, ...oldTable.rows];
  const newValues = [newTable.header, ...newTable.rows];
  const { rows: rowMap, columns: columnMap } = tableMapping(oldValues, newValues, mapping);
  for (const value of newValues.flat()) assertInlineWritable(parseTableCell(value));
  const storedRows = element.toArray() as Y.XmlElement[];
  const oldCells = tableRows(element);
  const mappedRows = rowMap.map((oldIndex) => {
    if (oldIndex === null) return null;
    const rowElement = storedRows[oldIndex];
    if (rowElement === undefined) throw new InvalidTableMappingError("mapped row is absent from stored table");
    return { oldIndex, rowElement, cells: oldCells[oldIndex] ?? [] };
  });
  // Validate offsets before structural edits so malformed projections leave no partial write.
  for (const [row, mapped] of mappedRows.entries()) {
    if (mapped === null) continue;
    for (const [column, oldColumn] of columnMap.entries()) {
      if (oldColumn === null) continue;
      const cell = mapped.cells[oldColumn];
      if (cell === undefined) continue;
      const before = oldValues[mapped.oldIndex]?.[oldColumn] ?? "";
      const after = newValues[row]?.[column] ?? "";
      if (before !== after && plainXmlText(tableCellText(cell)).indexOf(inlinePlainText(parseTableCell(before))) < 0) throw new InvalidTableError();
    }
  }
  const retainedRows = new Set(rowMap);
  const retainedCols = new Set(columnMap);
  // All validation precedes the first write: Yjs transactions do not roll back.
  for (let row = storedRows.length - 1; row >= 1; row -= 1) {
    if (!retainedRows.has(row)) element.delete(row, 1);
  }
  for (let row = 0; row < newValues.length; row += 1) {
    const mapped = mappedRows[row];
    const newRow = newValues[row] ?? [];
    if (mapped === null || mapped === undefined) {
      const inserted = buildTableRow(newRow.map(() => ""), row === 0);
      element.insert(row, [inserted]);
      for (const [column, cell] of inserted.toArray().entries()) writeTableCell(cell as Y.XmlElement, newRow[column] ?? "");
      continue;
    }
    const { oldIndex, rowElement, cells } = mapped;
    for (let column = cells.length - 1; column >= 0; column -= 1) {
      if (!retainedCols.has(column)) rowElement.delete(column, 1);
    }
    let actualColumn = 0;
    for (let column = 0; column < newRow.length; column += 1) {
      const oldColumn = columnMap[column] ?? null;
      const cell = oldColumn === null ? undefined : cells[oldColumn];
      const value = newRow[column] ?? "";
      const previous = oldColumn === null ? undefined : oldValues[oldIndex]?.[oldColumn] ?? "";
      if (cell === undefined) {
        // An untouched projected empty cell stays virtual. A later requested
        // cell needs preceding positions materialized to keep its column.
        if (oldColumn !== null && previous === value) continue;
        while (actualColumn < column) {
          rowElement.insert(actualColumn, [buildTableCell("", row === 0)]);
          actualColumn += 1;
        }
        const inserted = buildTableCell("", row === 0);
        rowElement.insert(actualColumn, [inserted]);
        writeTableCell(inserted, value);
      } else if (previous !== value) {
        spliceTableCell(cell, previous ?? "", value);
      }
      actualColumn += 1;
    }
    // Virtual-only selections need one real cell to retain the nonempty row grammar;
    // leave the remaining padding virtual.
    if (actualColumn === 0) rowElement.insert(0, [buildTableCell("", row === 0)]);
  }
}

function alignOf(delimiter: string): ColumnAlign {
  const left = delimiter.startsWith(":");
  const right = delimiter.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/**
 * Share table-start recognition with the Markdown reader: a header and equally
 * wide delimiter row precede zero or more body rows.
 */
export function parseGfmTable(source: string): GfmTable | null {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  if (lines.length < 2) return null;

  const header = scanRow(lines[0] ?? "");
  const delimiters = scanRow(lines[1] ?? "");
  // Escaped pipes do not make a table; otherwise setext headings become table rows.
  if (header.pipes === 0 || delimiters.pipes === 0) return null;
  if (header.cells.length === 0) return null;
  if (delimiters.cells.length !== header.cells.length) return null;
  if (!delimiters.cells.every((cell) => DELIMITER_CELL.test(cell))) return null;

  const body = lines.slice(2);
  // Internal blank lines split blocks; trailing blanks have already been removed.
  if (body.some((line) => line.trim() === "")) return null;

  const rows = body.map((line) => {
    const { cells } = scanRow(line);
    // Short rows are padded and long ones truncated, which is what GFM does.
    return header.cells.map((_, column) => cells[column] ?? "");
  });

  return {
    header: header.cells,
    align: delimiters.cells.map(alignOf),
    rows,
  };
}
