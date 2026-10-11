/**
 * Read literal triggers from BLOCK_MENU_ENTRIES. Retype via setNodeMarkup so
 * the original block id and anchors survive; textblockTypeInputRule replaces it.
 *
 * Dispatch the completed prefix first, close undo capture, then dispatch its
 * conversion. y-prosemirror folds one dispatch into one Yjs transaction, so two
 * steps in one dispatch cannot let undo restore the literal prefix.
 *
 * handleTextInput admits local DOM typing only; remote edits, paste/drop and
 * undo never reach this path.
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
 * Match the whole paragraph against a literal registry trigger, including 1.
 * for ordered lists. Mid-text prefixes and other authored numbers stay prose.
 */
export function entryForTrigger(text: string): BlockMenuEntry | null {
  return BLOCK_MENU_ENTRIES.find((entry) => entry.trigger === text) ?? null;
}

/**
 * Return an identified block: typing dispatches before conversion, so saved
 * positions can become stale. Unidentified blocks must wait for BlockIds.
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
  // If retyping refuses, keep the already-dispatched prefix as prose.
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
