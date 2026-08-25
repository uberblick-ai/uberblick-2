/**
 * The list's behaviour: its keyboard, and the numbers on its ordered items.
 *
 * The keyboard is Tab and Shift-Tab to change depth, Enter to continue the
 * list, Backspace at the start of an item to leave it. The numbers are a
 * decoration — see {@link listNumberPlugin}.
 *
 * Four bindings, and every one of them is a rule about *one block*, because a
 * list here is a run of adjacent `list-item` blocks rather than a tree (#59).
 * Nothing lifts, sinks or re-parents anything: indenting is an attribute, and
 * continuing a list is a split that keeps the attributes it split from.
 *
 * ## Why plain ProseMirror commands
 *
 * Each binding is a `Command`, so it can be exercised against a real editor
 * state with no keyboard and no DOM — and refusing is a first-class answer. A
 * command that is not about a list item returns false, which is what lets the
 * key fall through to the chain behind it: Enter still splits a paragraph,
 * Backspace still deletes a character, Tab still does whatever the browser does
 * outside a list.
 *
 * The one deliberate exception is Tab *inside* a list at the edge of the range:
 * it returns true having changed nothing, because letting Tab through there
 * would move focus out of the editor mid-list, which is not what a reader
 * pressing it in a list can possibly mean.
 *
 * ## Why the split carries a null id
 *
 * `Transaction.split` copies the node's attributes onto both halves, id
 * included, and duplicate ids break every id-addressed operation in the system.
 * So the new half is given `id: null` and the block-id plugin (block-ids.ts)
 * assigns it a fresh one in the same gesture — the same contract an Enter-split
 * paragraph has always had, stated explicitly rather than relying on the
 * plugin's duplicate repair.
 */

import { Extension } from "@tiptap/core";
import { keymap } from "@tiptap/pm/keymap";
import type { Command, EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { MAX_LIST_INDENT, listNumbers } from "@uberblick/schema";
import { renderableIndent } from "./nodes.js";
import { retypeBlockInTransaction } from "./retype.js";

/** The top-level list item the selection head sits in, with its position. */
function listItemAt(
  state: EditorState,
): { pos: number; node: ProseMirrorNode } | null {
  const { $head } = state.selection;
  // Depth 1 is a top-level block; the document has no other depth.
  if ($head.depth !== 1) return null;
  const node = $head.parent;
  if (node.type.name !== "list-item") return null;
  return { pos: $head.before(1), node };
}

/**
 * Move the item under the caret `delta` levels, clamped to the range the model
 * holds. Handled even when it cannot move — see the module comment on Tab.
 */
export function changeListIndent(delta: number): Command {
  return (state, dispatch) => {
    const item = listItemAt(state);
    if (item === null) return false;
    const current = renderableIndent(item.node.attrs.indent);
    const next = Math.min(MAX_LIST_INDENT, Math.max(0, current + delta));
    if (next !== current) {
      dispatch?.(state.tr.setNodeAttribute(item.pos, "indent", String(next)));
    }
    return true;
  };
}

/**
 * Enter inside a list item: a new item below it, same marker, same depth.
 *
 * ProseMirror's own `splitBlock` would hand the second half the document's
 * *default* block type — a paragraph — which is the one thing a reader pressing
 * Enter in a list does not want.
 */
export const splitListItem: Command = (state, dispatch) => {
  const item = listItemAt(state);
  if (item === null) return false;
  if (dispatch === undefined) return true;

  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  tr.split(tr.selection.from, 1, [
    { type: item.node.type, attrs: { ...item.node.attrs, id: null } },
  ]);
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Backspace at the very start of a list item turns it back into a paragraph —
 * the way out of a list, and the undo of the `- ` that made it one.
 *
 * The re-type goes through the sanctioned path (`setNodeMarkup`, id carried
 * over): the block a reader is leaving keeps every annotation and backlink
 * pointing at it.
 */
export const liftListItem: Command = (state, dispatch) => {
  const item = listItemAt(state);
  if (item === null) return false;
  const { $head, empty } = state.selection;
  if (!empty || $head.parentOffset !== 0) return false;

  const tr = state.tr;
  if (!retypeBlockInTransaction(tr, item.pos, "paragraph")) return false;
  dispatch?.(tr);
  return true;
};

export function listKeymap(): Plugin {
  return keymap({
    Tab: changeListIndent(1),
    "Shift-Tab": changeListIndent(-1),
    Enter: splitListItem,
    Backspace: liftListItem,
  });
}

/* ----------------------------------------------------------------- markers */

/**
 * Put each ordered item's number on the block as `data-number`, which the
 * stylesheet draws as its marker.
 *
 * The number comes from the schema package's {@link listNumbers} — the same
 * call the markdown writer makes — so what a reader sees and what an export
 * writes cannot disagree. Doing it in CSS instead was tried and is wrong: a
 * counter can only be reset by a rule matching some block, and no selector can
 * say "a bullet nested *inside* an ordered item", so a nested bullet restarted
 * the enclosing list's numbering while the export carried on counting.
 *
 * A decoration, so nothing is written to the document: the numbers are display,
 * and they are recomputed from the document on every draw — including for a
 * peer's edit or an agent's, which is what keeps a live list numbered right.
 */
export function listNumberPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state: EditorState): DecorationSet | null {
        const blocks: Array<{ offset: number; node: ProseMirrorNode }> = [];
        state.doc.forEach((node, offset) => {
          blocks.push({ offset, node });
        });
        const numbers = listNumbers(
          blocks.map(({ node }) => ({
            type: node.type.name,
            list: typeof node.attrs.list === "string" ? node.attrs.list : undefined,
            indent: renderableIndent(node.attrs.indent),
          })),
        );

        const decorations: Decoration[] = [];
        for (const [index, { offset, node }] of blocks.entries()) {
          const number = numbers[index];
          if (number === null || number === undefined) continue;
          decorations.push(
            Decoration.node(offset, offset + node.nodeSize, {
              "data-number": String(number),
            }),
          );
        }
        return decorations.length === 0
          ? null
          : DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

/** Tiptap wrapper around the list's keyboard and its markers. */
export const ListBlocks = Extension.create({
  name: "uberblickListBlocks",
  addProseMirrorPlugins() {
    return [listKeymap(), listNumberPlugin()];
  },
});
