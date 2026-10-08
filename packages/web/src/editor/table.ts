/**
 * Official TableKit nodes and interactions, with Uberblick's storage limits.
 * Cells are one paragraph, and table state lives only in the Yjs cell tree.
 */
import { Extension } from "@tiptap/core";
import { Table as TiptapTable, TableCell, TableHeader, TableRow, TableKit, TableView } from "@tiptap/extension-table";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";
import { InvalidTableError, parseTableInput, TABLE_CELL_MARKS } from "@uberblick/schema";
import type { GfmTable } from "@uberblick/schema";
import { endUndoCapture, findBlockById } from "./block-menu.js";

const CELL_MARKS = new Set<string>(TABLE_CELL_MARKS);
const singleLine = (text: string): string => text.replace(/[\r\n]+/g, " ");

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
  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    if (typeof node.attrs.id === "string") this.table.id = node.attrs.id;
    else this.table.removeAttribute("id");
    return true;
  }
}

export const Table = TiptapTable.extend({
  addAttributes() {
    return { id: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute("id") } };
  },
  addProseMirrorPlugins() {
    return (this.parent?.() ?? []).map((plugin) => {
      // Stock tableEditing calls fixTables after local AND remote edits. Two
      // replicas padding the same ragged CRDT merge insert duplicate cells.
      // Keep its public plugin spec (selection, arrows, pointer handling and
      // decorations), but never repair table structure as a side effect.
      const { appendTransaction: _repair, ...spec } = plugin.spec;
      return new Plugin(spec);
    });
  },
}).configure({
  resizable: false, renderWrapper: true, cellMinWidth: 120,
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
      if (cell.type.name !== (row === 0 ? "tableHeader" : "tableCell") || cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1 || cell.attrs.colwidth !== null || cell.childCount !== 1) return false;
      const paragraph = cell.child(0);
      if (paragraph.type.name !== "paragraph" || paragraph.attrs.id !== null) return false;
      let valid = true;
      paragraph.forEach((text) => {
        if (!text.isText || /[\r\n]/.test(text.text ?? "") || text.marks.some((mark) => !CELL_MARKS.has(mark.type.name))) valid = false;
      });
      if (!valid) return false;
    }
  }
  return true;
}

/** The ordinary shape structural controls may change without triggering repair. */
export function isOrdinaryTable(node: ProseMirrorNode): boolean {
  return node.type.name === "table" && validTable(node, false);
}

function tableLimitsPlugin(): Plugin {
  return new Plugin({
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(ySyncPluginKey)?.isChangeOrigin === true) return true;
      let valid = true;
      tr.doc.forEach((node) => {
        if (node.type.name !== "table") return;
        const before = typeof node.attrs.id === "string" ? findBlockById(state.doc, node.attrs.id)?.node : undefined;
        const ragged = before?.type.name === "table" && !validTable(before, false);
        if (!validTable(node, ragged)) valid = false;
      });
      return valid;
    },
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
 * Whether any of `node`'s text carries a mark.
 *
 * The typed conversion rewrites one paragraph's text and deletes another, and
 * neither operation can carry a mark across honestly: an annotation anchored in
 * the header would lose the characters it is anchored to, and one in the
 * delimiter row would go with the block. This GFM door treats inline markdown
 * literally and therefore does not guess how prose formatting maps to cells.
 *
 * So a marked paragraph is not converted at all. Refusing is the whole fix: the
 * reader keeps their text, their thread and their formatting, and the table is
 * still one block menu entry (or one paste) away. Remapping the anchors instead
 * would mean offset arithmetic across a merge of two blocks, which is a lot of
 * machinery to make a rare gesture slightly smoother.
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
 * Turn the block at `blockId` into a table holding `source`, in one transaction
 * and one undo step. Returns false, having touched nothing, when the block is
 * gone.
 *
 * The *header's* block is the one that becomes the table, so the table inherits
 * an id that already exists rather than taking a new one — and the delimiter
 * row's block, which was only ever syntax, goes.
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
 * The two ways a table arrives: typed, and pasted.
 *
 * **Typed** is a delimiter row completed directly under a header row — the only
 * moment two paragraphs become one table. The keystroke is taken as the typing
 * it is and the conversion follows as its own undo step, so one undo gives the
 * reader back what they wrote; the same two-dispatch shape, and the same reason,
 * as the markdown input rules. A paragraph carrying any mark is left alone —
 * see {@link carriesMarks}.
 *
 * **Pasted** is a clipboard that is *exactly* one GFM table. It is handled here
 * rather than left to ProseMirror's plain-text parser, which folds the newlines
 * out of it and hands back a single line of pipes — but a clipboard that merely
 * begins with a table is a document, and falls through to the ordinary paste.
 */
export function tableFromTextPlugin(): Plugin {
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

        // Marks are read from the state the reader has actually produced, and
        // only from it: a stored mark — bold left switched on — lands *on the
        // character just typed*, so it does not exist in any state older than
        // this dispatch. Nothing anchored or formatted is rewritten away, so a
        // marked paragraph keeps what it is; see {@link carriesMarks}. The
        // keystroke stands either way, which is what the `true` is for.
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
        // The *whole* clipboard has to be one table, not merely start as one.
        // A table with prose under it is a document, and swallowing that prose
        // into the block would store it as rows of a table nobody wrote — so it
        // falls through to the ordinary paste, which keeps it as the blocks it
        // is. The schema's writer adds block-boundary validation to its shared
        // GFM reader, so web and agent writes accept the same input.
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
    return [tableLimitsPlugin(), tableFromTextPlugin()];
  },
});
