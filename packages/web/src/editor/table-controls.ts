/** Table controls act on the live shared row, with independent undo steps. */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import * as Y from "yjs";
import { ySyncPluginKey } from "y-prosemirror";
import { endUndoCapture, findBlockById } from "./block-menu.js";
import { isOrdinaryTable } from "./table.js";

export interface TableRowTarget {
  tableId: string;
  table: Y.XmlElement;
  row: Y.XmlElement;
}

export interface ResolvedTableRow {
  node: ProseMirrorNode;
  pos: number;
  rowIndex: number;
  rowPos: number;
}

export type TableAction = "row-before" | "row-after" | "row-delete" | "column-before" | "column-after";

function sharedTable(editor: Editor, tableId: string): Y.XmlElement | null {
  const sync = ySyncPluginKey.getState(editor.state) as { type?: Y.XmlFragment } | undefined;
  const table = sync?.type?.toArray().find((element) =>
    element instanceof Y.XmlElement && element.getAttribute("id") === tableId,
  );
  return table instanceof Y.XmlElement && table.nodeName === "table" ? table : null;
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
 * Move to a gap in the current table (1 is below the header; length is last).
 * Only the source row is replaced: a PM-level reorder would rewrite every row
 * it passes through y-prosemirror's same-type node matching. Cloning retains
 * formatting and comment marks, with the owner-accepted delete/copy merge limits.
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
