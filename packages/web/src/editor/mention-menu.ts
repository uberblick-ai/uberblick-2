/**
 * Keep mention trigger/session matching aligned with block-menu.ts. A picked
 * reference uses replaceWithDocLink, matching typed and pasted references.
 * The shared schema is workspace-independent; the shell supplies directory
 * context without opening target rooms.
 */

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { endUndoCapture, isTypedHere } from "./block-menu.js";
import { replaceWithDocLink } from "./doc-links.js";
import type { DocLinkCandidate, DocLinkContext } from "./doc-links.js";
import { foldForTitleMatch } from "../title-fold.js";

/** An open mention session: the block it belongs to, what was typed, and where. */
export interface MentionTrigger {
  blockId: string;
  /** What was typed after the `@`. */
  query: string;
  /** The `@` itself, in current document positions. */
  from: number;
  /** The caret, which is where the query ends. */
  to: number;
}

/**
 * `@` at the start of the text before the caret or after a space, then a run of
 * characters that are neither space nor another `@`; e-mail addresses never
 * trigger. Multi-word queries would need another terminator to return Enter
 * to prose.
 */
const MENTION_QUERY = /(?:^|\s)@([^\s@]*)$/;

/**
 * Bound per-keystroke rendering; further typing narrows the directory candidates.
 */
export const MENTION_LIMIT = 8;

/**
 * Require an identified top-level prose block. Recompute the live range so edits
 * above the block cannot redirect an insertion. Space, caret departure or a
 * rewritten trigger closes the session rather than retaining a saved mode.
 */
export function mentionTriggerAt(editor: Editor): MentionTrigger | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;

  const { $head } = selection;
  // Depth 1 is a top-level block; this schema nests nothing, so anything else is
  // not a block a reference can be written into.
  if ($head.depth !== 1) return null;

  const block = $head.parent;
  // Read the source-text spec so picker admission stays aligned with its marks.
  if (block.type.spec.code === true) return null;
  if (typeof block.attrs.id !== "string" || block.attrs.id === "") return null;

  // Count leaf nodes as one U+FFFC so text offsets track document positions.
  const before = block.textBetween(0, $head.parentOffset, undefined, "￼");
  const match = MENTION_QUERY.exec(before);
  if (match === null) return null;

  const query = match[1] ?? "";
  return {
    blockId: block.attrs.id,
    query,
    from: $head.pos - query.length - 1,
    to: $head.pos,
  };
}

/**
 * Match a written range ending at the caret, mapping through subsequent steps.
 * Deletion back to a stored @ writes nothing and must not open a picker.
 * isTypedHere separately excludes remote edits, undo/redo and clipboard edits.
 */
function wroteUpTo(transaction: Transaction, pos: number): boolean {
  let matched = false;
  transaction.mapping.maps.forEach((map, index) => {
    const after = transaction.mapping.slice(index + 1);
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      if (newTo <= newFrom) return;
      if (after.map(newTo, 1) === pos) matched = true;
    });
  });
  return matched;
}

/**
 * Only typing the @ itself opens a session: require local typing, an empty
 * query and a written range ending at the caret. Editing stored @query prose
 * or deleting back to its @ must not open one.
 */
export function opensMentionSession(
  transaction: Transaction,
  trigger: MentionTrigger,
): boolean {
  if (!isTypedHere(transaction)) return false;
  if (trigger.query !== "") return false;
  return wroteUpTo(transaction, trigger.to);
}

/**
 * Match directory labels only, preserving title order and excluding the open
 * document. Description/tag matches would offer references by a different name.
 */
export function filterMentions(
  candidates: readonly DocLinkCandidate[],
  query: string,
  openDocId: string | null,
): DocLinkCandidate[] {
  // Use the Documents page's title fold for both query and candidates.
  const needle = foldForTitleMatch(query);
  const found: DocLinkCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.docId === openDocId) continue;
    if (!foldForTitleMatch(candidate.label).includes(needle)) continue;
    found.push(candidate);
    if (found.length === MENTION_LIMIT) break;
  }
  return found;
}

/**
 * Re-derive the live block/query and range before replacing @query in one
 * transaction. Refuse stale sessions and invalid UUIDs without a write; resolve
 * the label through doc-links.ts rather than the clicked row.
 */
export function linkMentionAtTrigger(
  editor: Editor,
  trigger: MentionTrigger,
  docId: string,
  context: DocLinkContext | null,
): boolean {
  const live = mentionTriggerAt(editor);
  if (live === null) return false;
  // MentionMenu watches occurrence changes. Compare id/query here, allowing
  // remote edits above this block to shift the live range.
  if (live.blockId !== trigger.blockId) return false;
  if (live.query !== trigger.query) return false;

  // Undo restores @query separately from the preceding typing.
  endUndoCapture(editor.state);
  const tr = editor.state.tr;
  if (
    !replaceWithDocLink(
      tr,
      editor.state.schema,
      { from: live.from, to: live.to },
      docId,
      null,
      context,
    )
  ) {
    return false;
  }
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}
