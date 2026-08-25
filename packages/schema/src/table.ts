/**
 * GFM tables, read out of the one thing that stores them: the block's text.
 *
 * A `table` block is a **text-source block**, like `code` and `mermaid` — its
 * Y.XmlText holds GFM table markdown and nothing else. That is the whole design
 * (#59): a table has no second representation, so an agent edits it with
 * `edit_block` in the format it already writes, and a renderer that wants rows
 * and cells parses them out of the source every time it draws.
 *
 * This module is that parser, and it is the only definition of the format in
 * the codebase — the markdown reader uses it to recognise a table, and the web
 * editor uses it to draw one. Dependency-free and line-based, like the rest of
 * the markdown module.
 *
 * What is deliberately not here: cell-level inline formatting. A source block
 * carries no inline marks, so a cell's text is its text — `**bold**` in a cell
 * is four asterisks and a word, in the model and on screen alike.
 */

/** A column's alignment, from its delimiter cell. `null` is the default. */
export type ColumnAlign = "left" | "center" | "right" | null;

/** GFM table source, parsed into what a renderer needs. */
export interface GfmTable {
  header: string[];
  align: ColumnAlign[];
  /** Body rows, each padded to the header's column count — GFM's own rule. */
  rows: string[][];
}

/** `---`, `:--`, `--:` or `:-:`, the four shapes of a delimiter cell. */
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * One row's cells. Pipes separate; a backslash escapes one into the cell text;
 * a pipe at either end of the line is decoration rather than an empty cell.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) cells.pop();
  return cells.map((cell) => cell.trim());
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
  const lines = source.replace(/\s+$/, "").split("\n");
  const headerLine = lines[0] ?? "";
  const delimiterLine = lines[1] ?? "";
  if (lines.length < 2 || !headerLine.includes("|")) return null;

  const header = splitRow(headerLine);
  const delimiters = splitRow(delimiterLine);
  if (header.length === 0 || delimiters.length !== header.length) return null;
  if (!delimiters.every((cell) => DELIMITER_CELL.test(cell))) return null;

  const rows = lines
    .slice(2)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const cells = splitRow(line);
      // Short rows are padded and long ones truncated, which is what GFM does.
      return header.map((_, column) => cells[column] ?? "");
    });

  return { header, align: delimiters.map(alignOf), rows };
}
