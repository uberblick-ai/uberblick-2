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

/** First writes into an empty paragraph can concurrently create several texts. */
export function tableCellTexts(cell: Y.XmlElement): Y.XmlText[] {
  const paragraph = cell.firstChild;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph") return [];
  return paragraph.toArray().filter((text): text is Y.XmlText => text instanceof Y.XmlText);
}

export function tableCellText(cell: Y.XmlElement): Y.XmlText | null {
  return tableCellTexts(cell)[0] ?? null;
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
  return writeGfmTable(tableRows(element).map((row) => row.map((cell) => tableCellTexts(cell).map(plainXmlText).join(""))));
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
      return paragraph.toArray().every((text) => text instanceof Y.XmlText &&
        (text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>).every((op) =>
        typeof op.insert === "string" && !/[\r\n]/.test(op.insert) && Object.entries(op.attributes ?? {}).every(([key, value]) =>
          (TABLE_CELL_MARKS as readonly string[]).includes(key) && readsAsMark(key, value),
        ),
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
  // Even an empty cell needs a shared text before its first writers arrive.
  // Independently inserting texts on the first keystroke loses later writes
  // when y-prosemirror consolidates the adjacent types.
  paragraph.insert(0, [new Y.XmlText(text)]);
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

/** Seed cells created by TableKit in the same local transaction as their row. */
export function seedNewTableCells(transaction: Y.Transaction): void {
  if (!transaction.local) return;
  const doc = transaction.doc;
  const start = transaction.beforeState.get(doc.clientID) ?? 0;
  for (const table of doc.getXmlFragment("blocks").toArray()) {
    if (!(table instanceof Y.XmlElement) || table.nodeName !== "table") continue;
    for (const cell of tableRows(table).flat()) {
      const paragraph = cell.firstChild;
      if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" || paragraph.length !== 0) continue;
      const id = Y.createRelativePositionFromTypeIndex(paragraph, 0).type;
      // Never seed a previously received empty cell on several replicas: that
      // would reproduce the first-write race. Its creator owns this insertion.
      if (id?.client === doc.clientID && id.clock >= start) paragraph.insert(0, [new Y.XmlText()]);
    }
  }
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

type EntryMatch = { cells: number; characters: number };

/**
 * Align the complete edit, maximizing unchanged cells before substitutions.
 * Character overlap breaks repeated-value ties, such as Ship becoming Ship2.
 */
function alignEntries(
  oldLength: number, newLength: number,
  matchingCells: (oldIndex: number, newIndex: number) => EntryMatch,
): Array<number | null> {
  let maxCharacters = 0;
  const matches = Array.from({ length: oldLength }, (_, oldIndex) => Array.from({ length: newLength }, (_, newIndex) => {
    const match = matchingCells(oldIndex, newIndex);
    maxCharacters = Math.max(maxCharacters, match.characters);
    return match;
  }));
  const stride = newLength + 1;
  const scores = new Float64Array((oldLength + 1) * stride);
  const score = (oldIndex: number, newIndex: number): number => scores[oldIndex * stride + newIndex] ?? 0;
  const pairs = Math.min(oldLength, newLength);
  const characterWeight = pairs + 1;
  // A single unchanged cell outweighs all character overlap; one matching
  // character outweighs all substitutions. Neither can displace a better match.
  const cellWeight = (pairs * maxCharacters + 1) * characterWeight;
  const pairScore = (oldIndex: number, newIndex: number): number => {
    const match = matches[oldIndex]?.[newIndex];
    return (match?.cells ?? 0) * cellWeight + (match?.characters ?? 0) * characterWeight + 1;
  };
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      scores[oldIndex * stride + newIndex] = Math.max(
        pairScore(oldIndex, newIndex) + score(oldIndex + 1, newIndex + 1),
        score(oldIndex + 1, newIndex), score(oldIndex, newIndex + 1),
      );
    }
  }
  const result: Array<number | null> = Array<number | null>(newLength).fill(null);
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLength && newIndex < newLength) {
    const paired = pairScore(oldIndex, newIndex) + score(oldIndex + 1, newIndex + 1);
    if (score(oldIndex, newIndex) === paired) {
      result[newIndex] = oldIndex;
      oldIndex += 1;
      newIndex += 1;
    } else if (score(oldIndex, newIndex) === score(oldIndex + 1, newIndex)) oldIndex += 1;
    else newIndex += 1;
  }
  return result;
}

function matchCell(before: string, after: string): EntryMatch {
  return {
    cells: before === after ? 1 : 0,
    characters: fastDiff(before, after).reduce((count, [operation, text]) => operation === 0 ? count + text.length : count, 0),
  };
}

function countMatchingCells(before: readonly string[], after: readonly string[], columnsChanged = false): EntryMatch {
  // Column changes shift positions. Match surviving cells in order while
  // allowing a neighbouring cell to be edited in the same structural mutation.
  const columns = columnsChanged
    ? alignEntries(before.length, after.length, (oldCol, newCol) => matchCell(before[oldCol] ?? "", after[newCol] ?? ""))
    : after.map((_, column) => column < before.length ? column : null);
  const result: EntryMatch = { cells: 0, characters: 0 };
  columns.forEach((oldCol, newCol) => {
    if (oldCol === null) return;
    const match = matchCell(before[oldCol] ?? "", after[newCol] ?? "");
    result.cells += match.cells;
    result.characters += match.characters;
  });
  return result;
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
  const rowMap = [0, ...alignEntries(
    oldTable.rows.length, newTable.rows.length,
    (oldRow, newRow) => countMatchingCells(oldTable.rows[oldRow] ?? [], newTable.rows[newRow] ?? [], widthChanged),
  ).map((index) => index === null ? null : index + 1)];
  const matchedRows = rowMap.flatMap((oldIndex, newIndex) => oldIndex === null ? [] : [{ oldIndex, newIndex }]);
  const oldColumns = oldTable.header.map((_, col) => matchedRows.map(({ oldIndex }) => oldValues[oldIndex]?.[col] ?? ""));
  const newColumns = newTable.header.map((_, col) => matchedRows.map(({ newIndex }) => newValues[newIndex]?.[col] ?? ""));
  const columnMap = widthChanged
    ? alignEntries(oldColumns.length, newColumns.length, (oldCol, newCol) => countMatchingCells(oldColumns[oldCol] ?? [], newColumns[newCol] ?? []))
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
