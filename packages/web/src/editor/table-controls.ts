/** Table controls act on live shared targets, with independent undo steps. */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import * as Y from "yjs";
import { ySyncPluginKey } from "y-prosemirror";
import { endUndoCapture, findBlockById } from "./blocks.js";
import { isOrdinaryTable } from "./table.js";

export interface TableRowTarget {
  tableId: string;
  table: Y.XmlElement;
  row: Y.XmlElement;
}

interface ResolvedTableRow {
  node: ProseMirrorNode;
  pos: number;
  rowIndex: number;
  rowPos: number;
}

export interface TableColumnTarget {
  tableId: string;
  table: Y.XmlElement;
  cell: Y.XmlElement;
}

interface ResolvedTableColumn {
  node: ProseMirrorNode;
  pos: number;
  columnIndex: number;
}

export type TableAction = "row-before" | "row-after" | "row-delete" | "column-before" | "column-after";

function sharedTable(editor: Editor, tableId: string): Y.XmlElement | null {
  const sync = ySyncPluginKey.getState(editor.state) as { type?: Y.XmlFragment } | undefined;
  const table = sync?.type?.toArray().find((element) =>
    element instanceof Y.XmlElement && element.getAttribute("id") === tableId,
  );
  return table instanceof Y.XmlElement && table.nodeName === "table" ? table : null;
}

/** Shared and rendered rows must agree before an exact shared-cell edit. */
function columnTable(editor: Editor, tableId: string): { table: Y.XmlElement; node: ProseMirrorNode; pos: number } | null {
  if (!editor.isEditable) return null;
  const table = sharedTable(editor, tableId);
  const found = findBlockById(editor.state.doc, tableId);
  if (table === null || found === null || !isOrdinaryTable(found.node) || table.length !== found.node.childCount) return null;
  const width = found.node.child(0).childCount;
  const rows = table.toArray();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow" || row.length !== width) return null;
    for (const cell of row.toArray()) {
      if (!(cell instanceof Y.XmlElement) || cell.nodeName !== (index === 0 ? "tableHeader" : "tableCell")) return null;
    }
  }
  return { ...found, table };
}

/** A column follows its original shared header cell through other edits. */
export function tableColumnTargets(editor: Editor, tableId: string): TableColumnTarget[] | null {
  const live = columnTable(editor, tableId);
  if (live === null) return null;
  const header = live.table.get(0) as Y.XmlElement;
  return header.toArray().map((cell) => ({ tableId, table: live.table, cell: cell as Y.XmlElement }));
}

/** Re-resolve the header identity rather than the position that replaced it. */
export function resolveTableColumn(editor: Editor, target: TableColumnTarget): ResolvedTableColumn | null {
  const live = columnTable(editor, target.tableId);
  if (live === null || live.table !== target.table) return null;
  const header = live.table.get(0) as Y.XmlElement;
  const columnIndex = header.toArray().indexOf(target.cell);
  return columnIndex < 0 ? null : { node: live.node, pos: live.pos, columnIndex };
}

/** Preserve surviving cell identities even when neighbouring content is equal. */
export function deleteTableColumn(editor: Editor, target: TableColumnTarget): boolean {
  const live = resolveTableColumn(editor, target);
  const doc = target.table.doc;
  if (live === null || live.node.child(0).childCount === 1 || doc === null) return false;
  endUndoCapture(editor.state);
  doc.transact(() => {
    for (const row of target.table.toArray()) (row as Y.XmlElement).delete(live.columnIndex, 1);
  }, ySyncPluginKey);
  endUndoCapture(editor.state);
  return true;
}

/** Clone only the chosen cells so identical neighbours keep their identities. */
export function moveTableColumn(editor: Editor, target: TableColumnTarget, direction: -1 | 1): boolean {
  const live = resolveTableColumn(editor, target);
  const doc = target.table.doc;
  if (live === null || doc === null || (direction !== -1 && direction !== 1)) return false;
  const destination = live.columnIndex + direction;
  if (destination < 0 || destination >= live.node.child(0).childCount) return false;
  const rows = target.table.toArray() as Y.XmlElement[];
  const copies = rows.map((row) => ({ row, cell: (row.get(live.columnIndex) as Y.XmlElement).clone() }));
  const header = copies[0];
  if (header === undefined) return false;
  endUndoCapture(editor.state);
  doc.transact(() => {
    copies.forEach(({ row, cell }) => {
      row.delete(live.columnIndex, 1);
      row.insert(destination, [cell]);
    });
  }, ySyncPluginKey);
  endUndoCapture(editor.state);

  // The deleted header cannot anchor the caret in its newly inserted copy.
  const moved = resolveTableColumn(editor, { ...target, cell: header.cell });
  if (moved !== null) {
    let cellTextPos = moved.pos + 4;
    for (let index = 0; index < moved.columnIndex; index += 1) cellTextPos += moved.node.child(0).child(index).nodeSize;
    editor.commands.setTextSelection(cellTextPos);
  }
  return true;
}

/** Keep the Yjs type itself: remote transactions can replace every PM node. */
export function tableRowTarget(editor: Editor, tableId: string, rowIndex: number): TableRowTarget | null {
  if (!editor.isEditable || !Number.isInteger(rowIndex) || rowIndex < 0) return null;
  const table = sharedTable(editor, tableId);
  if (table === null || rowIndex >= table.length) return null;
  const row = table.get(rowIndex);
  if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow") return null;
  const target = { tableId, table, row };
  return resolveTableRow(editor, target) === null ? null : target;
}

/** Read all overlay targets with one shape check, rather than once per row. */
export function tableRowTargets(editor: Editor, tableId: string): TableRowTarget[] | null {
  if (!editor.isEditable) return null;
  const table = sharedTable(editor, tableId);
  const found = findBlockById(editor.state.doc, tableId);
  if (table === null || found === null || !isOrdinaryTable(found.node) || table.length !== found.node.childCount) return null;
  const targets: TableRowTarget[] = [];
  for (const row of table.toArray()) {
    if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow") return null;
    targets.push({ tableId, table, row });
  }
  return targets;
}

/** Re-resolve on every transaction and immediately before a control writes. */
export function resolveTableRow(editor: Editor, target: TableRowTarget): ResolvedTableRow | null {
  if (!editor.isEditable || sharedTable(editor, target.tableId) !== target.table) return null;
  const found = findBlockById(editor.state.doc, target.tableId);
  if (found === null || !isOrdinaryTable(found.node) || target.table.length !== found.node.childCount) return null;
  // A position or relative position can land on the row that moved into a
  // deletion's gap. Membership of the original shared row cannot do that.
  const rowIndex = target.table.toArray().indexOf(target.row);
  if (rowIndex < 0 || rowIndex >= found.node.childCount) return null;
  let rowPos = found.pos + 1;
  for (let index = 0; index < rowIndex; index += 1) rowPos += found.node.child(index).nodeSize;
  return { ...found, rowIndex, rowPos };
}

/**
 * Move only the source row: PM reordering rewrites intervening same-type rows.
 * Cloning preserves text, formatting and comments; delete/copy merge limits
 * remain those described in Editing in the web editor.
 * Gaps range from below header to end.
 */
export function moveTableRow(editor: Editor, target: TableRowTarget, gap: number): boolean {
  const live = resolveTableRow(editor, target);
  if (live === null || live.rowIndex === 0 || !Number.isInteger(gap) || gap < 1 || gap > live.node.childCount) return false;
  // Both gaps bordering the source have the same order after removing it.
  if (gap === live.rowIndex || gap === live.rowIndex + 1) return false;
  const doc = target.table.doc;
  if (doc === null) return false;
  const copy = target.row.clone();
  const destination = gap > live.rowIndex ? gap - 1 : gap;
  endUndoCapture(editor.state);
  doc.transact(() => {
    target.table.delete(live.rowIndex, 1);
    target.table.insert(destination, [copy]);
  }, ySyncPluginKey);
  endUndoCapture(editor.state);

  // The binding restores a selection relative to the deleted source, which
  // cannot follow its copy. Resolve the new identity after its synchronous sync.
  const moved = resolveTableRow(editor, { ...target, row: copy });
  if (moved !== null) editor.commands.setTextSelection(moved.rowPos + 3);
  return true;
}

/** One normal shared edit, bounded by undo capture on both sides. */
export function actOnTable(editor: Editor, target: TableRowTarget, column: number, action: TableAction): boolean {
  const live = resolveTableRow(editor, target);
  if (live === null || !Number.isInteger(column) || column < 0 || column >= live.node.child(0).childCount) return false;
  if (live.rowIndex === 0 && (action === "row-before" || action === "row-delete")) return false;
  let cellTextPos = live.rowPos + 3;
  for (let index = 0; index < column; index += 1) cellTextPos += live.node.child(live.rowIndex).child(index).nodeSize;

  // Selection and command share one transaction; clicking a stale target does
  // not move the caret, and intermediate mixed headers never reach the guard.
  let chain = editor.chain().setTextSelection(cellTextPos);
  switch (action) {
    case "row-before": chain = chain.addRowBefore(); break;
    case "row-after": chain = chain.addRowAfter(); break;
    case "row-delete": chain = chain.deleteRow(); break;
    case "column-before": chain = chain.addColumnBefore(); break;
    case "column-after": chain = chain.addColumnAfter(); break;
  }
  const succeeded = chain.command(({ tr, commands }) => {
    let changed = findBlockById(tr.doc, target.tableId);
    if (changed !== null && (action === "column-before" || action === "column-after")) {
      const header = changed.node.child(0);
      let hasHeader = false;
      let hasBody = false;
      header.forEach((cell) => {
        hasHeader ||= cell.type.name === "tableHeader";
        hasBody ||= cell.type.name === "tableCell";
      });
      // prosemirror-tables puts a body cell at a header-only table's outer
      // edge. Its public header command fixes that within this same edit. It
      // is a toggle, so an already complete header must never pass through it.
      if (hasHeader && hasBody) commands.toggleHeaderRow();
      changed = findBlockById(tr.doc, target.tableId);
    }
    if (!tr.docChanged || changed === null || !isOrdinaryTable(changed.node)) {
      // Tiptap dispatches a chain even when a command returned false.
      tr.setMeta("preventDispatch", true);
      return false;
    }
    endUndoCapture(editor.state);
    return true;
  }).run();
  if (succeeded) endUndoCapture(editor.state);
  return succeeded;
}
