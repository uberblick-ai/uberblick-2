/**
 * Official TableKit nodes and interactions, with Uberblick's storage limits.
 * Cells are one paragraph, and table state lives only in the Yjs cell tree.
 */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Table as TiptapTable, TableCell, TableHeader, TableRow, TableKit, TableView } from "@tiptap/extension-table";
import type { TableOptions } from "@tiptap/extension-table";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { columnResizing, columnResizingPluginKey, ResizeState, updateColumnsOnResize } from "@tiptap/pm/tables";
import { InvalidTableError, isSupportedColumnWidth, parseTableInput } from "@uberblick/schema";
import type { GfmTable } from "@uberblick/schema";
import { blockShapeGuard, endUndoCapture, findBlockById, isPlainPart } from "./blocks.js";
import { singleLine } from "./table-text.js";

function inTable(state: EditorState): boolean {
  return state.selection.$from.depth > 1 && state.selection.$from.node(1).type.name === "table";
}

// Keep TableKit's attribute defaults exactly: y-prosemirror stores numbers and
// omits null attributes. Opening a structured table must not rewrite it. Alignment
// is deliberately absent; this baseline does not store it.
const cellAttributes = () => ({
  colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null },
});

// ProseMirror can reuse a table view for a different stable block. TableKit
// refreshes its columns on update; mirror our identity too, as other blocks do.
class IdentifiedTableView extends TableView {
  constructor(node: ProseMirrorNode, cellMinWidth: number, view: EditorView) {
    super(node, cellMinWidth, view, { class: "ub-table", "data-block-type": "table", id: node.attrs.id });
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    // TipTap leaves an old inline width when a column becomes unsized.
    updateColumnsOnResize(node, this.colgroup, this.table, this.cellMinWidth);
    if (typeof node.attrs.id === "string") this.table.id = node.attrs.id;
    else this.table.removeAttribute("id");
    return true;
  }
}

/** Keep the framework drag, while following live room permissions. */
function tableResizing(editor: Editor, options: TableOptions): Plugin {
  const resize = columnResizing({
    handleWidth: options.handleWidth, cellMinWidth: options.cellMinWidth,
    defaultCellMinWidth: options.cellMinWidth, View: options.View,
    lastColumnResizable: options.lastColumnResizable,
  });
  const state = resize.spec.state;
  if (!state) throw new Error("Column resizing requires framework plugin state");
  const props = resize.props;
  const canResize = (editorState: EditorState, active = columnResizingPluginKey.getState(editorState)?.activeHandle ?? -1): boolean => {
    if (!editor.isEditable) return false;
    if (active < 0) return true;
    if (active > editorState.doc.content.size) return false;
    const cell = editorState.doc.resolve(active);
    return cell.depth > 0 && isOrdinaryTable(cell.node(-1));
  };
  return new Plugin({
    ...resize.spec,
    state: {
      ...state,
      apply(tr, previous, oldState, newState) {
        const next = state.apply(tr, previous, oldState, newState);
        return canResize(newState, next.activeHandle) && !(next.activeHandle < 0 && next.dragging)
          ? next : new ResizeState(-1, false);
      },
    },
    props: {
      ...props,
      attributes: (state) => editor.isEditable
        ? (typeof props.attributes === "function" ? props.attributes(state) : props.attributes) ?? {} : {},
      decorations: (state) => editor.isEditable ? props.decorations?.call(resize, state) : null,
      handleDOMEvents: {
        ...props.handleDOMEvents,
        mousedown(view, event) {
          if (!canResize(view.state)) return false;
          if ((columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1) >= 0) endUndoCapture(view.state);
          return props.handleDOMEvents?.mousedown?.call(resize, view, event) ?? false;
        },
      },
    },
    view: () => ({
      update(view, previous) {
        const before = columnResizingPluginKey.getState(previous);
        const current = columnResizingPluginKey.getState(view.state);
        if (before?.dragging && !current?.dragging) endUndoCapture(view.state);
        // setEditable changes view props without a transaction. Clear an active
        // drag before its window mouseup listener can save a width.
        if (current && current.activeHandle >= 0 && !canResize(view.state)) {
          view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 }));
          view.state.doc.forEach((node, pos) => {
            if (node.type.name !== "table") return;
            const wrapper = view.nodeDOM(pos) as HTMLElement | null;
            const table = wrapper?.querySelector("table");
            const colgroup = table?.querySelector("colgroup");
            if (table && colgroup) updateColumnsOnResize(node, colgroup, table, options.cellMinWidth);
          });
        }
      },
    }),
  });
}

export const Table = TiptapTable.extend({
  addAttributes() {
    return { id: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("id") } };
  },
  addProseMirrorPlugins() {
    return [tableResizing(this.editor, this.options), ...(this.parent?.() ?? []).filter((plugin) =>
      plugin.spec.key !== columnResizingPluginKey,
    ).map((plugin) => {
      // Stock tableEditing calls fixTables after local AND remote edits. Two
      // replicas padding the same ragged CRDT merge insert duplicate cells.
      // Keep its public plugin spec (selection, arrows, pointer handling and
      // decorations), but never repair table structure as a side effect.
      const { appendTransaction: _repair, ...spec } = plugin.spec;
      return new Plugin(spec);
    })];
  },
}).configure({
  resizable: true, renderWrapper: true, cellMinWidth: 120,
  View: IdentifiedTableView,
  HTMLAttributes: { class: "ub-table", "data-block-type": "table" },
});

export const TableNodes = TableKit.extend({
  addExtensions() {
    return [Table,
      TableRow,
      TableCell.extend({ content: "paragraph", addAttributes: cellAttributes }),
      TableHeader.extend({ content: "paragraph", addAttributes: cellAttributes }),
    ];
  },
});

/** Build the ordinary, rectangular shape for the menu and GFM doors. */
export function tableFromRows(schema: Schema, rows: readonly string[][], id: string | null): ProseMirrorNode {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return schema.node("table", { id }, rows.map((row, index) =>
    schema.node("tableRow", null, Array.from({ length: width }, (_, column) =>
      schema.node(index === 0 ? "tableHeader" : "tableCell", null,
        schema.node("paragraph", null, row[column] ? schema.text(singleLine(row[column] ?? "")) : [])),
    )),
  ));
}

function validTable(node: ProseMirrorNode, allowRagged: boolean): boolean {
  if (node.childCount === 0) return false;
  const width = node.child(0).childCount;
  for (let row = 0; row < node.childCount; row += 1) {
    const cells = node.child(row);
    if (cells.type.name !== "tableRow" || cells.childCount === 0 || (!allowRagged && cells.childCount !== width)) return false;
    for (let col = 0; col < cells.childCount; col += 1) {
      const cell = cells.child(col);
      if (cell.type.name !== (row === 0 ? "tableHeader" : "tableCell") || cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1 ||
        !isSupportedColumnWidth(cell.attrs.colwidth) || !isPlainPart(cell) || /[\r\n]/.test(cell.textContent)) return false;
    }
  }
  return true;
}

/** The ordinary shape structural controls may change without triggering repair. */
export function isOrdinaryTable(node: ProseMirrorNode): boolean {
  return node.type.name === "table" && validTable(node, false);
}

/** A table that was already ragged may stay ragged; every other shape stays ordinary. */
function tableShapeGuard(): Plugin {
  return blockShapeGuard("table", (node, state) => {
    const before = typeof node.attrs.id === "string" ? findBlockById(state.doc, node.attrs.id)?.node : undefined;
    return validTable(node, before?.type.name === "table" && !validTable(before, false));
  });
}

function tableEnterPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.key !== "Enter" || event.isComposing || !inTable(view.state)) return false;
        // A cell has one line. Neither Enter spelling creates a second block.
        return true;
      },
    },
  });
}

/** Use the schema's exact-one-table write rule at every GFM door. */
function tableInput(source: string): GfmTable | null {
  try {
    return parseTableInput(source);
  } catch (error) {
    if (error instanceof InvalidTableError) return null;
    throw error;
  }
}

/** Whether `header` and `delimiter` are the first two lines of a GFM table. */
function opensTable(header: string, delimiter: string): boolean {
  return tableInput(`${header}\n${delimiter}`) !== null;
}

/**
 * Refuse typed conversion when either paragraph carries a mark. Rewriting the
 * header and deleting the delimiter cannot preserve their annotation offsets;
 * literal GFM does not infer formatting across cells. Keep marked text intact.
 */
function carriesMarks(node: ProseMirrorNode): boolean {
  let marked = false;
  node.descendants((child) => {
    if (child.marks.length > 0) marked = true;
    return !marked;
  });
  return marked;
}

/**
 * Convert in one transaction/undo step, preserving the header block id and
 * deleting the delimiter block. A missing target changes nothing.
 */
function convertToTable(
  view: EditorView,
  blockId: string,
  dropBlockId: string | null,
  source: string,
): boolean {
  const found = findBlockById(view.state.doc, blockId);
  if (found === null) return false;

  endUndoCapture(view.state);
  const parsed = tableInput(source);
  if (parsed === null) return false;
  const tr = view.state.tr;
  tr.replaceWith(found.pos, found.pos + found.node.nodeSize,
    tableFromRows(view.state.schema, [parsed.header, ...parsed.rows], blockId));
  if (dropBlockId !== null) {
    const drop = findBlockById(tr.doc, dropBlockId);
    if (drop !== null) tr.delete(drop.pos, drop.pos + drop.node.nodeSize);
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(found.pos + 4)));
  view.dispatch(tr);
  return true;
}

/**
 * Dispatch typed delimiter completion before conversion so undo restores it;
 * marked paragraphs refuse conversion. Plain-text paste must be exactly one GFM
 * table: PM's default parser collapses its lines, while mixed documents must
 * retain ordinary paste behavior.
 */
function tableFromTextPlugin(): Plugin {
  return new Plugin({
    props: {
      transformPastedHTML(html, view) {
        if (!/<table[\s>]/i.test(html)) return html;
        const dom = document.implementation.createHTMLDocument().body;
        dom.innerHTML = html;
        const parser = ProseMirrorDOMParser.fromSchema(view.state.schema);
        for (const table of dom.querySelectorAll("table")) {
          // An outer table already includes its nested tables' text.
          if (!dom.contains(table)) continue;
          const replacement = document.createDocumentFragment();
          const cells: HTMLElement[] = [
            ...(table.caption === null ? [] : [table.caption]),
            ...Array.from(table.rows).flatMap((row) => Array.from(row.cells)),
          ];
          for (const cell of cells) {
            // Let the ordinary parser retain HTML block boundaries and handle
            // line breaks. Only table content loses its formatting/structure;
            // surrounding headings, lists and link marks use normal rich paste.
            const parsed = parser.parse(cell);
            for (const line of parsed.textBetween(0, parsed.content.size, "\n").split(/\r\n?|\n/)) {
              const paragraph = document.createElement("p");
              paragraph.textContent = line;
              replacement.appendChild(paragraph);
            }
          }
          table.replaceWith(replacement);
        }
        return dom.innerHTML;
      },
      handleKeyDown(view, event) {
        if (event.key !== "Enter" || event.isComposing) return false;
        const { $from } = view.state.selection;
        if ($from.depth !== 1 || $from.parent.type.name !== "paragraph" || !view.state.selection.empty) return false;
        const index = $from.index(0);
        if (index === 0) return false;
        const header = view.state.doc.child(index - 1);
        const delimiter = $from.parent;
        if (header.type.name !== "paragraph" || carriesMarks(header) || carriesMarks(delimiter) || !opensTable(header.textContent, delimiter.textContent)) return false;
        if (typeof header.attrs.id !== "string" || typeof delimiter.attrs.id !== "string") return false;
        return convertToTable(view, header.attrs.id, delimiter.attrs.id, `${header.textContent}\n${delimiter.textContent}`);
      },
      handleTextInput(view, from, to, text, defaultTransaction) {
        if (view.composing || from !== to) return false;
        const $from = view.state.doc.resolve(from);
        if ($from.depth !== 1) return false;
        const block = $from.parent;
        if (block.type.name !== "paragraph") return false;
        if ($from.parentOffset !== block.content.size) return false;

        const delimiter = block.textContent + text;
        const index = $from.index(0);
        if (index === 0) return false;
        const header = view.state.doc.child(index - 1);
        if (header.type.name !== "paragraph") return false;
        if (!delimiter.trimEnd().endsWith("|") || !opensTable(header.textContent, delimiter)) return false;

        const headerId = header.attrs.id;
        const delimiterId = block.attrs.id;
        if (typeof headerId !== "string" || headerId === "") return false;
        if (typeof delimiterId !== "string" || delimiterId === "") return false;

        // The typed character first, so undo has something to give back.
        view.dispatch(defaultTransaction());

        // Inspect marks after typing: stored marks land on the new character.
        // Refusal keeps that dispatched keystroke, so return true either way.
        const typed = findBlockById(view.state.doc, headerId);
        const typedDelimiter = findBlockById(view.state.doc, delimiterId);
        if (typed === null || typedDelimiter === null) return true;
        if (carriesMarks(typed.node) || carriesMarks(typedDelimiter.node)) {
          return true;
        }

        convertToTable(
          view,
          headerId,
          delimiterId,
          `${typed.node.textContent}\n${typedDelimiter.node.textContent}`,
        );
        return true;
      },

      handlePaste(view, event) {
        if (inTable(view.state)) {
          const plain = event.clipboardData?.getData("text/plain") ?? "";
          view.dispatch(view.state.tr.insertText(singleLine(plain)).scrollIntoView());
          return true;
        }
        // transformPastedHTML turns only HTML tables into text paragraphs.
        // Let the standard rich-paste path insert that slice, including any
        // surrounding blocks and marks, rather than treating its plain text as
        // an exact-GFM-table clipboard.
        const html = event.clipboardData?.getData("text/html") ?? "";
        if (/<table[\s>]/i.test(html)) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const source = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
        // Require the schema's exact-one-table boundary; mixed prose falls through
        // to ordinary paste instead of becoming unauthored table rows.
        if (tableInput(source) === null) return false;

        const $from = view.state.selection.$from;
        if ($from.depth !== 1) return false;
        const block = $from.parent;
        // Into an empty block only: pasting a table into the middle of a
        // sentence is content, and replacing the sentence is not what the
        // reader asked for.
        if (block.type.name !== "paragraph" || block.content.size !== 0) {
          return false;
        }
        const blockId = block.attrs.id;
        if (typeof blockId !== "string" || blockId === "") return false;

        return convertToTable(view, blockId, null, source);
      },
    },
  });
}

/** Integration behavior; TableKit itself supplies navigation and row commands. */
export const TableBlocks = Extension.create({
  name: "uberblickTableBlocks",
  priority: 1100,
  addProseMirrorPlugins() {
    return [tableShapeGuard(), tableEnterPlugin(), tableFromTextPlugin()];
  },
});
