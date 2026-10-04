/** Structured TableKit nodes, with GFM as the agent-facing text projection. */
import * as Y from "yjs";
import fastDiff from "fast-diff";
import { InvalidTableError } from "./errors.js";
import { readsAsMark } from "./marks.js";

/** A column's alignment, from its delimiter cell. `null` is the default. */
export type ColumnAlign = "left" | "center" | "right" | null;

/** GFM table source, parsed into what a renderer needs. */
export interface GfmTable {
  header: string[];
  align: ColumnAlign[];
  /** Body rows, each padded to the header's column count — GFM's own rule. */
  rows: string[][];
}

/**
 * A delimiter cell: hyphens, with a colon at either end for alignment.
 *
 * One hyphen is enough, because GFM says so — the spec's own table example is
 * `:-: | -----------:`, a centred column and a right-aligned one. What tells a
 * delimiter row apart from prose is not the length of its runs but that every
 * cell is one of these *and* the row carries a structural pipe; see
 * {@link parseGfmTable}.
 */
const DELIMITER_CELL = /^:?-+:?$/;

/** A row split on its structural pipes, and how many of those there were. */
interface Row {
  cells: string[];
  /**
   * Unescaped pipes in the line. Zero means the line carries no table structure
   * at all: any pipe in it is somebody's prose, and its one "cell" is the line.
   */
  pipes: number;
}

/**
 * One row's cells. Pipes separate; a backslash escapes one into the cell text;
 * a pipe at either end of the line is decoration rather than an empty cell.
 *
 * Backslashes escape in pairs, and the **parity of the run** is what decides
 * the pipe after it: `\|` is a pipe inside a cell, while `\\|` is a literal
 * backslash followed by a real separator. Reading only the character in front
 * of the pipe gets that backwards and joins two cells into one.
 *
 * Only pipe escapes and adjacent backslash pairs are resolved. Other escapes
 * stay literal: this reader does not interpret a cell's inline markdown.
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
      // Decode pairs only next to a pipe. This lets the canonical writer
      // represent *any* number of literal backslashes before a literal pipe.
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
  // Decoration is a *structural* pipe at either end, which is why the ends are
  // read off the scan rather than off the string.
  if (firstPipe === 0) cells.shift();
  if (lastPipe === trimmed.length - 1) cells.pop();
  return { cells: cells.map((cell) => cell.trim()), pipes };
}

/** A write must contain exactly one table, rather than a table plus a block. */
export function parseTableInput(source: string): GfmTable {
  const parsed = parseGfmTable(source);
  const otherBlock = source.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n").slice(2).some((line) =>
    /^\s*(?:#{1,6}\s|>|`{3,}|~{3,}|<!--|[-+*]\s|\d+[.)]\s)/.test(line),
  );
  if (parsed === null || otherBlock) throw new InvalidTableError();
  return parsed;
}

/** The formatting vocabulary in a cell. Document links stay prose-only. */
export const TABLE_CELL_MARKS = ["bold", "italic", "strike", "inlineCode", "link", "comment"] as const;

/** Direct row cells. Readers retain uneven rows produced by concurrent edits. */
export function tableRows(element: Y.XmlElement): Y.XmlElement[][] {
  return element.toArray().filter((node): node is Y.XmlElement =>
    node instanceof Y.XmlElement && node.nodeName === "tableRow",
  ).map((row) => row.toArray().filter((cell): cell is Y.XmlElement =>
    cell instanceof Y.XmlElement && (cell.nodeName === "tableCell" || cell.nodeName === "tableHeader"),
  ));
}

export function tableCellText(cell: Y.XmlElement): Y.XmlText | null {
  const paragraph = cell.firstChild;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph") return null;
  const text = paragraph.firstChild;
  return text instanceof Y.XmlText ? text : null;
}

/** Read plain text without rendering XmlText's formatting as XML tags. */
export function plainXmlText(text: Y.XmlText | null): string {
  return text === null ? "" : (text.toDelta() as Array<{ insert?: unknown }>).map((op) =>
    typeof op.insert === "string" ? op.insert : "",
  ).join("");
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
  return writeGfmTable(tableRows(element).map((row) => row.map((cell) => plainXmlText(tableCellText(cell)))));
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
      if (Object.keys(attrs).some((key) => !["colspan", "rowspan"].includes(key)) || attrs.colspan !== 1 || attrs.rowspan !== 1 || cell.length !== 1) return false;
      const paragraph = cell.firstChild;
      if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" || Object.keys(paragraph.getAttributes()).length !== 0 || paragraph.length > 1) return false;
      if (paragraph.length === 0) return true; // y-prosemirror represents an empty paragraph this way.
      const text = tableCellText(cell);
      if (text === null) return false;
      return (text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>).every((op) =>
        typeof op.insert === "string" && !/[\r\n]/.test(op.insert) && Object.entries(op.attributes ?? {}).every(([key, value]) =>
          (TABLE_CELL_MARKS as readonly string[]).includes(key) && readsAsMark(key, value),
        ),
      );
    });
  });
}

export function buildTableCell(text: string, header: boolean): Y.XmlElement {
  const cell = new Y.XmlElement(header ? "tableHeader" : "tableCell");
  // y-prosemirror writes native ProseMirror attribute values, not strings.
  const attrs = cell as unknown as { setAttribute(name: string, value: unknown): void };
  attrs.setAttribute("colspan", 1);
  attrs.setAttribute("rowspan", 1);
  // ProseMirror's colwidth default is null. y-prosemirror omits null attrs.
  const paragraph = new Y.XmlElement("paragraph");
  if (text !== "") paragraph.insert(0, [new Y.XmlText(text)]);
  cell.insert(0, [paragraph]);
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

/** Splice changed characters only, preserving marks and unseen concurrent edits. */
export function spliceTableCell(cell: Y.XmlElement, value: string): void {
  let text = tableCellText(cell);
  if (text === null) {
    const paragraph = cell.firstChild as Y.XmlElement;
    paragraph.insert(0, [new Y.XmlText()]);
    text = tableCellText(cell);
  }
  if (text === null) throw new InvalidTableError();
  let offset = 0;
  for (const [op, chunk] of fastDiff(plainXmlText(text), value)) {
    if (op === 0) offset += chunk.length;
    else if (op === -1) text.delete(offset, chunk.length);
    else { text.insert(offset, chunk); offset += chunk.length; }
  }
}

/**
 * Match unchanged structural entries, then pair substitutions between anchors.
 * An insertion/removal keeps the surviving Yjs subtree rather than replaying it.
 */
function alignEntries(
  oldKeys: readonly string[], newKeys: readonly string[],
  matches?: (oldIndex: number, newIndex: number) => boolean,
): Array<number | null> {
  const positions = new Map<string, number[]>();
  oldKeys.forEach((key, index) => {
    const entries = positions.get(key) ?? [];
    entries.push(index);
    positions.set(key, entries);
  });
  const anchors: Array<[number, number]> = [];
  let oldCursor = 0;
  newKeys.forEach((key, index) => {
    const match = matches === undefined
      ? positions.get(key)?.find((candidate) => candidate >= oldCursor)
      : oldKeys.findIndex((_, candidate) => candidate >= oldCursor && matches(candidate, index));
    if (match !== undefined && match !== -1) { anchors.push([match, index]); oldCursor = match + 1; }
  });
  anchors.push([oldKeys.length, newKeys.length]);
  const result: Array<number | null> = Array<number | null>(newKeys.length).fill(null);
  let oldStart = 0;
  let newStart = 0;
  for (const [oldEnd, newEnd] of anchors) {
    for (let offset = 0; offset < Math.min(oldEnd - oldStart, newEnd - newStart); offset += 1) {
      result[newStart + offset] = oldStart + offset;
    }
    if (newEnd < newKeys.length) result[newEnd] = oldEnd;
    oldStart = oldEnd + 1;
    newStart = newEnd + 1;
  }
  return result;
}

function isSubsequence(shorter: readonly string[], longer: readonly string[]): boolean {
  let matched = 0;
  for (const value of longer) {
    if (value === shorter[matched]) matched += 1;
  }
  return matched === shorter.length;
}

function countFeatures(entries: readonly (readonly string[])[], indexed: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const key of new Set(entry.map((value, index) => indexed ? JSON.stringify([index, value]) : value))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Edit the GFM projection without replacing surviving rows, cells or marks.
 * Parsed old/new cells decide what changed: GFM trims whitespace, while the
 * stored cell need not, and comparing the stored string would churn that text.
 */
export function editTable(element: Y.XmlElement, oldTable: GfmTable, newTable: GfmTable): void {
  if (!isSupportedTable(element)) throw new InvalidTableError();
  const oldValues = [oldTable.header, ...oldTable.rows];
  const newValues = [newTable.header, ...newTable.rows];
  const storedRows = element.toArray() as Y.XmlElement[];
  const oldCells = tableRows(element);
  const widthChanged = oldTable.header.length !== newTable.header.length;
  const oldRowKeys = oldTable.rows.map((row) => JSON.stringify(row));
  const newRowKeys = newTable.rows.map((row) => JSON.stringify(row));
  const oldRowFeatures = countFeatures(oldTable.rows, !widthChanged);
  const newRowFeatures = countFeatures(newTable.rows, !widthChanged);
  // A row unchanged except for inserted/removed columns is still an anchor.
  // This also handles a combined row+column insertion with repeated headers.
  const rowMap = [0, ...alignEntries(
    oldRowKeys, newRowKeys,
    (oldRow, newRow) => {
      const before = oldTable.rows[oldRow] ?? [];
      const after = newTable.rows[newRow] ?? [];
      if (oldRowKeys[oldRow] === newRowKeys[newRow]) return true;
      if (widthChanged && (before.length < after.length ? isSubsequence(before, after) : isSubsequence(after, before))) return true;
      // A surviving cell can identify a row even when another cell is edited
      // in the same GFM mutation. Ignore values repeated across several rows.
      return before.some((value, col) => value !== "" &&
        (widthChanged ? after.includes(value) : after[col] === value) &&
        oldRowFeatures.get(widthChanged ? value : JSON.stringify([col, value])) === 1 &&
        newRowFeatures.get(widthChanged ? value : JSON.stringify([col, value])) === 1,
      );
    },
  ).map((index) => index === null ? null : index + 1)];
  const matchedRows = rowMap.flatMap((oldIndex, newIndex) => oldIndex === null ? [] : [{ oldIndex, newIndex }]);
  const oldColumns = oldTable.header.map((_, col) => matchedRows.map(({ oldIndex }) => oldValues[oldIndex]?.[col] ?? ""));
  const newColumns = newTable.header.map((_, col) => matchedRows.map(({ newIndex }) => newValues[newIndex]?.[col] ?? ""));
  const oldColumnKeys = oldColumns.map((col) => JSON.stringify(col));
  const newColumnKeys = newColumns.map((col) => JSON.stringify(col));
  const oldColumnFeatures = countFeatures(oldColumns, true);
  const newColumnFeatures = countFeatures(newColumns, true);
  const oldHeaders = countFeatures(oldTable.header.map((value) => [value]), false);
  const newHeaders = countFeatures(newTable.header.map((value) => [value]), false);
  const columnMap = widthChanged
    ? alignEntries(
      oldColumnKeys, newColumnKeys,
      (oldCol, newCol) => {
        const before = oldColumns[oldCol] ?? [];
        const after = newColumns[newCol] ?? [];
        if (oldColumnKeys[oldCol] === newColumnKeys[newCol]) return true;
        const header = oldTable.header[oldCol];
        if (header !== undefined && header === newTable.header[newCol] &&
          oldHeaders.get(header) === 1 && newHeaders.get(header) === 1) return true;
        return before.some((value, row) => row > 0 && value !== "" && value === after[row] &&
          oldColumnFeatures.get(JSON.stringify([row, value])) === 1 &&
          newColumnFeatures.get(JSON.stringify([row, value])) === 1,
        );
      },
    )
    : newTable.header.map((_, col) => col);

  const retainedRows = new Set(rowMap);
  for (let row = storedRows.length - 1; row >= 1; row -= 1) {
    if (!retainedRows.has(row)) element.delete(row, 1);
  }
  for (let row = 0; row < newValues.length; row += 1) {
    const oldIndex = rowMap[row] ?? null;
    const newRow = newValues[row] ?? [];
    if (oldIndex === null) {
      element.insert(row, [buildTableRow(newRow, row === 0)]);
      continue;
    }
    const rowElement = storedRows[oldIndex];
    const cells = oldCells[oldIndex] ?? [];
    if (rowElement === undefined) throw new InvalidTableError();
    const retainedCols = new Set(columnMap);
    for (let col = cells.length - 1; col >= 0; col -= 1) {
      if (!retainedCols.has(col)) rowElement.delete(col, 1);
    }
    let actualColumn = 0;
    for (let col = 0; col < newRow.length; col += 1) {
      const oldCol = columnMap[col] ?? null;
      const cell = oldCol === null ? undefined : cells[oldCol];
      const value = newRow[col] ?? "";
      const previous = oldCol === null ? undefined : oldValues[oldIndex]?.[oldCol] ?? "";
      if (cell === undefined) {
        // Leave a merge's padded positions virtual unless the edit fills one
        // or actually changes the table's column structure.
        if (oldCol !== null && previous === value) continue;
        // A filled padded position also needs any missing preceding cells.
        while (actualColumn < col) { rowElement.insert(actualColumn, [buildTableCell("", row === 0)]); actualColumn += 1; }
        rowElement.insert(actualColumn, [buildTableCell(value, row === 0)]);
      } else if (previous !== value) {
        spliceTableCell(cell, value);
      }
      actualColumn += 1;
    }
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
 * Parse GFM table source, or `null` when the text is not a table.
 *
 * A table is a header row, a delimiter row with the same number of cells, and
 * any number of body rows. That is the same test the markdown reader applies to
 * decide whether two lines *start* a table, so what imports as a table and what
 * renders as a table can never disagree.
 */
export function parseGfmTable(source: string): GfmTable | null {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  if (lines.length < 2) return null;

  const header = scanRow(lines[0] ?? "");
  const delimiters = scanRow(lines[1] ?? "");
  // A structural pipe in each row, and structural is the load-bearing word: a
  // `\|` is a pipe in somebody's prose. Counting one would read `a \| b` over
  // `---` — which is a setext heading — as a one-column table, and swallow the
  // paragraph into it.
  if (header.pipes === 0 || delimiters.pipes === 0) return null;
  if (header.cells.length === 0) return null;
  if (delimiters.cells.length !== header.cells.length) return null;
  if (!delimiters.cells.every((cell) => DELIMITER_CELL.test(cell))) return null;

  const body = lines.slice(2);
  // A blank line ends a table, so one *inside* the source means this is not one
  // table: taking the lines after it as rows would render a following paragraph
  // as a row of a table it was never part of. Trailing blanks are already gone.
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
