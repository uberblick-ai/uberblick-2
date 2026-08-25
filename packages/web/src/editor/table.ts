/**
 * The table block: GFM source, drawn as a real table (#59).
 *
 * A `table` block is a text-source block — its Y.XmlText holds GFM table
 * markdown and nothing else, exactly like `code` and `mermaid`. Stock Tiptap's
 * table extensions were rejected for that reason: their nested cell tree has no
 * block-scoped text, so an agent could not edit a table with `edit_block`, which
 * is the contract the whole model rests on. GFM is what an agent writes anyway.
 *
 * Three pieces, and the split matters:
 *
 * - **{@link tableBlockView}**, the NodeView, holds both representations at
 *   once: a `<table>` it draws from the source, and the editable source itself.
 *   Which one is shown is CSS, keyed off a class.
 * - **{@link tableEditingPlugin}** puts that class on the table block the
 *   selection is in. So the rendering is what a reader sees, and the source is
 *   what they get the moment their caret is in the block — click to edit, the
 *   same gesture a code block has, with no mode to remember and nothing stored
 *   about which table is "open".
 * - **{@link tableFromTextPlugin}** is the two doors a table comes in through:
 *   typing a header row, Enter, then a delimiter row; and pasting GFM text. Both
 *   are `prosemirror-view` props, so they fire for this reader's own gestures
 *   and never for a peer's edit or an agent's write — the same origin discipline
 *   the markdown input rules keep (see input-rules.ts).
 *
 * The rendering is *presentation over state that is already true*: it draws the
 * source and never writes to the document. An agent's `edit_block` rewriting one
 * cell arrives as an ordinary update, and `update` redraws — live, with nothing
 * to synchronise.
 */

import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { parseGfmTable } from "@uberblick/schema";
import { endUndoCapture, findBlockById } from "./block-menu.js";
import { retypeBlockInTransaction } from "./retype.js";

/** On the block whose source the reader is editing. */
export const EDITING_CLASS = "ub-table-editing";

/* ------------------------------------------------------------------ drawing */

/**
 * Draw `source` into `target` as a table, and answer whether it was one.
 *
 * A cell's text goes in as text: a source block carries no inline marks, so
 * `**bold**` in a cell is four asterisks and a word — on screen as in the model.
 */
function drawTable(target: HTMLElement, source: string): boolean {
  const parsed = parseGfmTable(source);
  target.replaceChildren();
  if (parsed === null) return false;

  const table = document.createElement("table");
  const head = table.appendChild(document.createElement("thead"));
  const headRow = head.appendChild(document.createElement("tr"));
  for (const [column, cell] of parsed.header.entries()) {
    const th = headRow.appendChild(document.createElement("th"));
    th.textContent = cell;
    const align = parsed.align[column];
    if (align !== null && align !== undefined) th.style.textAlign = align;
  }

  const body = table.appendChild(document.createElement("tbody"));
  for (const row of parsed.rows) {
    const tr = body.appendChild(document.createElement("tr"));
    for (const [column, cell] of row.entries()) {
      const td = tr.appendChild(document.createElement("td"));
      td.textContent = cell;
      const align = parsed.align[column];
      if (align !== null && align !== undefined) td.style.textAlign = align;
    }
  }

  target.appendChild(table);
  return true;
}

/* ----------------------------------------------------------------- nodeview */

/**
 * `<div class="ub-table" data-block-type="table">` holding the drawn table and
 * the source that produced it.
 *
 * Source text that is not a table yet — a half-typed one, or an agent's edit
 * mid-flight — sets `data-parsed="false"`, which is what keeps the source
 * visible instead of showing a reader an empty box with their text hidden
 * inside it.
 */
export const tableBlockView: NodeViewRenderer = ({
  node,
  editor,
  getPos,
}: NodeViewRendererProps): NodeView => {
  let current: ProseMirrorNode = node;

  const dom = document.createElement("div");
  dom.className = "ub-table";
  dom.setAttribute("data-block-type", "table");

  const rendered = document.createElement("div");
  rendered.className = "ub-table-render";
  rendered.contentEditable = "false";

  const contentDOM = document.createElement("pre");
  contentDOM.className = "ub-table-source";

  dom.append(rendered, contentDOM);

  const draw = (from: ProseMirrorNode): void => {
    dom.setAttribute("data-parsed", String(drawTable(rendered, from.textContent)));
    if (typeof from.attrs.id === "string") dom.setAttribute("id", from.attrs.id);
    else dom.removeAttribute("id");
  };
  draw(current);

  // Clicking the drawing is how a reader opens the source. The caret has to be
  // put there explicitly: the drawing is `contenteditable="false"`, so the
  // browser's own click handling would land on a node selection instead, and
  // the reader would have selected a block rather than opened it.
  const open = (event: Event): void => {
    event.preventDefault();
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined) return;
    const { view } = editor;
    const inside = view.state.doc.resolve(pos + 1);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(inside)));
    view.focus();
  };
  rendered.addEventListener("mousedown", open);

  return {
    dom,
    contentDOM,
    update(updated: ProseMirrorNode): boolean {
      if (updated.type !== current.type) return false;
      // See source-chrome.ts: a contentDOM the browser's editing engine has
      // taken out of the tree cannot be patched in place.
      if (contentDOM.parentNode !== dom) return false;
      current = updated;
      draw(current);
      return true;
    },
    // Only the drawing's own click. Everything else — including a click in the
    // source — must reach ProseMirror and place the caret.
    stopEvent: (event: Event): boolean =>
      event.type === "mousedown" &&
      event.target instanceof Node &&
      rendered.contains(event.target),
    // The drawing is ours, redrawn from the document on every update; nothing
    // in it is content. Mutations inside the source are ProseMirror's and are
    // deliberately not ignored — see the warning in source-chrome.ts.
    ignoreMutation: (mutation: { target: Node }): boolean =>
      rendered.contains(mutation.target),
    destroy: () => rendered.removeEventListener("mousedown", open),
  };
};

/* ------------------------------------------------------------------ editing */

/** The top-level `table` block the selection is in, or null. */
function tableAt(state: EditorState): { pos: number; node: ProseMirrorNode } | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    return selection.node.type.name === "table"
      ? { pos: selection.from, node: selection.node }
      : null;
  }
  const { $head } = selection;
  if ($head.depth !== 1) return null;
  const node = $head.parent;
  return node.type.name === "table" ? { pos: $head.before(1), node } : null;
}

/**
 * Mark the table block the selection sits in, so the stylesheet can show its
 * source and hide its drawing.
 *
 * Derived from the state on every draw rather than remembered, for the reason
 * the block menu gives about its slash session: a mode nobody stores cannot get
 * out of step with the document.
 */
export function tableEditingPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state: EditorState): DecorationSet | null {
        const table = tableAt(state);
        if (table === null) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(table.pos, table.pos + table.node.nodeSize, {
            class: EDITING_CLASS,
          }),
        ]);
      },
    },
  });
}

/* -------------------------------------------------------------------- doors */

/** Whether `header` and `delimiter` are the first two lines of a GFM table. */
function opensTable(header: string, delimiter: string): boolean {
  return parseGfmTable(`${header}\n${delimiter}`) !== null;
}

/**
 * Whether any of `node`'s text carries a mark.
 *
 * The typed conversion rewrites one paragraph's text and deletes another, and
 * neither operation can carry a mark across honestly: an annotation anchored in
 * the header would lose the characters it is anchored to, and one in the
 * delimiter row would go with the block. Inline formatting cannot come either —
 * a table is source text, so `comment` is the only mark it may hold.
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
  const tr = view.state.tr;
  const contentStart = found.pos + 1;
  tr.replaceWith(
    contentStart,
    contentStart + found.node.content.size,
    source === "" ? [] : view.state.schema.text(source),
  );
  if (!retypeBlockInTransaction(tr, found.pos, "table")) return false;

  if (dropBlockId !== null) {
    const drop = findBlockById(tr.doc, dropBlockId);
    if (drop !== null) tr.delete(drop.pos, drop.pos + drop.node.nodeSize);
  }
  // At the *end* of the source, which is where the reader's hands are: a
  // delimiter row is already a valid one at `| --- | -`, so the conversion can
  // land mid-row and the rest of what they type has to carry on after it.
  tr.setSelection(TextSelection.near(tr.doc.resolve(contentStart + source.length)));
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
 * **Pasted** is GFM table text on the clipboard. It is handled here rather than
 * left to ProseMirror's plain-text parser, which folds the newlines out of it
 * and hands back a single line of pipes.
 */
export function tableFromTextPlugin(): Plugin {
  return new Plugin({
    props: {
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
        if (!opensTable(header.textContent, delimiter)) return false;
        // Nothing anchored or formatted is silently rewritten away — see
        // {@link carriesMarks}. The keystroke is then plain typing, which is
        // what returning false leaves it as.
        if (carriesMarks(header) || carriesMarks(block)) return false;

        const headerId = header.attrs.id;
        const delimiterId = block.attrs.id;
        if (typeof headerId !== "string" || headerId === "") return false;
        if (typeof delimiterId !== "string" || delimiterId === "") return false;

        // The typed character first, so undo has something to give back.
        view.dispatch(defaultTransaction());
        convertToTable(
          view,
          headerId,
          delimiterId,
          `${header.textContent}\n${delimiter}`,
        );
        return true;
      },

      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
        if (!opensTable(lines[0] ?? "", lines[1] ?? "")) return false;

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

        return convertToTable(view, blockId, null, lines.join("\n"));
      },
    },
  });
}

/** Tiptap wrapper around the table block's two plugins. */
export const TableBlocks = Extension.create({
  name: "uberblickTableBlocks",
  addProseMirrorPlugins() {
    return [tableEditingPlugin(), tableFromTextPlugin()];
  },
});
