/**
 * Block-level markdown input rules: `# `, `## `, `### `, `> `, `- `, `1. `,
 * ```` ``` ````.
 *
 * Type the prefix at the start of an empty paragraph and the block becomes that
 * type. Which prefixes exist is not decided here — every one comes from the
 * `trigger` field of {@link BLOCK_MENU_ENTRIES}, the same array the slash menu
 * and the gutter `+` read. Giving a new block type its input rule is filling in
 * that one field; there is no list to keep in step.
 *
 * ## Why not `textblockTypeInputRule`
 *
 * Tiptap ships one, and it is a trap here: it `setBlockType`s the range, which
 * ProseMirror implements by *replacing* the node. A replaced node is a new node,
 * so it gets a fresh block id — and the block-identity invariant is that a type change
 * preserves the id, because every annotation anchor, backlink and `edit_block`
 * call in the system addresses blocks by it. So the conversion goes through the
 * sanctioned `retypeBlockInTransaction` (`setNodeMarkup`, id carried over), the
 * same path the slash menu uses.
 *
 * ## Why two dispatches, and not one
 *
 * The gesture is "I typed `# `, and then it became a heading" — two things, and
 * undo has to be able to give the reader back the first. So the keystroke is
 * dispatched as the plain typing it is, then the undo capture is closed, then
 * the conversion goes out as a transaction of its own. One undo leaves a
 * paragraph holding a literal `# `, which is the only way to *write* one.
 *
 * Composing both into a single transaction would not do: the typed space would
 * be deleted in the same transaction that inserted it, so undo would restore
 * `#` — and typing the space again would convert again, with no way out. It also
 * has to be two *dispatches* rather than two transactions, because y-prosemirror
 * writes the whole of one dispatch into Yjs as one transaction, and an undo step
 * is a Yjs transaction.
 *
 * ## Why there is no origin check
 *
 * The menu asks whether a transaction is local typing (`opensSlashSession`)
 * because it watches every transaction. This does not have to ask: ProseMirror
 * calls `handleTextInput` only for text this reader typed into the DOM. A remote
 * update, a paste, a drop, an undo and an agent's `edit_block` all arrive as
 * dispatched transactions and never reach here — which is the origin discipline,
 * enforced by the door rather than by a check behind it.
 */

import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  BLOCK_MENU_ENTRIES,
  endUndoCapture,
  findBlockById,
} from "./block-menu.js";
import type { BlockMenuEntry } from "./block-menu.js";
import { retypeBlockInTransaction } from "./retype.js";

/**
 * The entry whose trigger is exactly `text`, or `null`.
 *
 * Exact equality against the block's whole content, not a prefix match: it is
 * what makes a mid-text `#` impossible to fire on, and it is the honest reading
 * of "at the start of an empty paragraph".
 *
 * Every trigger is a literal, the ordered list's `1. ` included: typing `7. `
 * writes `7. `, because the number is not stored — a run of items numbers itself
 * on export — and the way to reach item seven is to press Enter six times. A
 * registry field for *patterns* would buy nothing else.
 */
export function entryForTrigger(text: string): BlockMenuEntry | null {
  return BLOCK_MENU_ENTRIES.find((entry) => entry.trigger === text) ?? null;
}

/**
 * The conversion this keystroke completes, or `null`.
 *
 * The block is named by **id**, for the reason the module comment in
 * block-menu.ts gives: the keystroke is dispatched before the conversion, and a
 * position resolved before that dispatch is a number about the earlier document.
 * A block with no id yet is not converted — the block-id plugin assigns one on
 * the next transaction, so this is a state nothing lingers in, and acting on an
 * unnamed block is exactly what the invariant forbids.
 */
function conversionFor(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): { blockId: string; entry: BlockMenuEntry } | null {
  // An input method mid-composition is not finished typing; taking the
  // keystroke here would commit half a character.
  if (view.composing) return null;
  // Typing over a selection is replacing prose, not opening a fresh block.
  if (from !== to) return null;

  const $from = view.state.doc.resolve(from);
  // Depth 1 is a top-level block; the palette has no nesting. Paragraph only:
  // converting from anything else is what the menu is for.
  if ($from.depth !== 1) return null;
  const block = $from.parent;
  if (block.type.name !== "paragraph") return null;
  // The caret has to be at the end of what is there, or the prefix is not a
  // prefix — there is text in front of it.
  if ($from.parentOffset !== block.content.size) return null;

  const entry = entryForTrigger(block.textContent + text);
  if (entry === null) return null;
  const blockId = block.attrs.id;
  if (typeof blockId !== "string" || blockId === "") return null;

  return { blockId, entry };
}

/**
 * Take the keystroke as typing, then convert on it as a separate undo step.
 * Returns true either way once the trigger has matched: the text is in the
 * document, so ProseMirror must not insert it a second time.
 */
function convertOnTrigger(
  view: EditorView,
  blockId: string,
  entry: BlockMenuEntry,
  typed: () => Transaction,
): boolean {
  view.dispatch(typed());
  endUndoCapture(view.state);

  const found = findBlockById(view.state.doc, blockId);
  if (found === null) return true;

  const tr = view.state.tr;
  const contentStart = found.pos + 1;
  tr.delete(contentStart, contentStart + found.node.content.size);
  // Refused only if the target type cannot hold the content — it is empty by
  // the line above, so this is a guard, not a path. Leaving the typed prefix as
  // text is the safe answer if it ever is one.
  if (!retypeBlockInTransaction(tr, found.pos, entry.type, entry.attrs)) {
    return true;
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(contentStart)));
  view.dispatch(tr);
  return true;
}

export function blockInputRulePlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text, defaultTransaction) {
        const conversion = conversionFor(view, from, to, text);
        if (conversion === null) return false;
        return convertOnTrigger(
          view,
          conversion.blockId,
          conversion.entry,
          defaultTransaction,
        );
      },
    },
  });
}

/** Tiptap wrapper around {@link blockInputRulePlugin}. */
export const BlockInputRules = Extension.create({
  name: "uberblickBlockInputRules",
  addProseMirrorPlugins() {
    return [blockInputRulePlugin()];
  },
});
