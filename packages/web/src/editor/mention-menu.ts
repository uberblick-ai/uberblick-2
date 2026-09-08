/**
 * The `@` picker's model: when a typed `@` is a mention, what it offers, and the
 * one edit behind picking an entry.
 *
 * Editor-side and pure enough to test without a DOM. The React shell
 * (`ui/MentionMenu.tsx`) owns pixels, focus and keys; the reference itself is
 * made by `editor/doc-links.ts`, through the same {@link replaceWithDocLink} the
 * typed and pasted spellings go through — so a picked reference is the same mark
 * on the same kind of text as one written by hand, and #443's model (text plus a
 * mark, the title resolved once) needs no second implementation to keep in step.
 *
 * ## The trigger is derived, never remembered
 *
 * {@link mentionTriggerAt} answers "does the editor state still describe a
 * mention?": caret in a prose block, and the text immediately before it is an
 * `@` — at the start of the block or after a space — followed by a run of
 * non-space characters. Recomputed rather than remembered, exactly as the block
 * menu's slash session is: a session lasts as long as it keeps validating, so
 * moving the caret away, typing a space, or a peer rewriting the block closes
 * the picker with no bookkeeping to get wrong.
 *
 * That leading-space rule is also what keeps an e-mail address ordinary text:
 * the `@` in `ben@example.com` has a letter in front of it, so it is never a
 * trigger. And a query stops at a space, which means a mention is filtered by
 * **one word** — `@contract` finds "Editorial contract". Multi-word queries
 * would need some other way to end a session, and a session that never ended
 * would take Enter away from a reader writing prose.
 *
 * *Opening* a session is a different question from *having* one — see
 * {@link opensMentionSession}.
 *
 * ## Prose only
 *
 * `code`, `mermaid`, `table` and `terminal` are source text: the schema gives
 * them `code: true` and the comment mark alone, so a `docLink` cannot live in
 * one. The gate here reads that spec rather than listing the names, so a block
 * type's marks and its picker stay one decision.
 *
 * ## The block is named by id, the range is re-derived
 *
 * A ProseMirror position is a number about one version of the document. The
 * session therefore holds the block's **id** and the typed query; when an entry
 * is picked the trigger is recomputed from live state and compared, and the
 * *live* range is what gets replaced. A peer's edit above the block moves every
 * position after it, and a saved one would splice a reference into whatever text
 * had moved into the gap.
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
 * characters that are neither space nor another `@`.
 */
const MENTION_QUERY = /(?:^|\s)@([^\s@]*)$/;

/**
 * How many documents the picker shows at once.
 *
 * A workspace's whole corpus rendered as buttons on every keystroke is work
 * nobody asked for, and a list longer than a card is not read anyway — typing
 * one more character is the faster way through it.
 */
export const MENTION_LIMIT = 8;

/**
 * The mention session the editor state describes, or `null` when there is none.
 *
 * A block with no id yet is not a session: picking an entry has to find this
 * block again, and an id is the only handle that survives an edit above it.
 */
export function mentionTriggerAt(editor: Editor): MentionTrigger | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;

  const { $head } = selection;
  // Depth 1 is a top-level block; this schema nests nothing, so anything else is
  // not a block a reference can be written into.
  if ($head.depth !== 1) return null;

  const block = $head.parent;
  if (block.type.spec.code === true) return null;
  if (typeof block.attrs.id !== "string" || block.attrs.id === "") return null;

  // A leaf stands in as one character (U+FFFC, the object replacement), so the
  // offsets below stay in step with document positions whatever the block turns
  // out to hold — and, being neither a space nor an `@`, it never reads as one.
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
 * Whether this transaction's own writing **ends** at `pos`.
 *
 * That is the shape of a character typed at the caret, and nothing else has it.
 * Each step map reports the range it wrote, in that step's own coordinates, so
 * the range is carried through the steps after it before being compared.
 *
 * - Typing `@`, over a selection or not, writes a range ending exactly at the
 *   caret.
 * - A **deletion writes nothing**, which is the gesture this exists for:
 *   backspacing back onto an `@` that has been sitting in the prose since last
 *   week leaves the caret exactly where a freshly typed one would, and nobody
 *   asked for a picker.
 *
 * A peer's edit, an undo and a redo never reach here — {@link isTypedHere}
 * closes all three, because y-prosemirror writes an undo to the Y.Doc and the
 * sync plugin marks what comes back as a change from elsewhere. A paste it
 * closes by its `uiEvent`.
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
 * Whether `transaction` is the gesture that *opens* a mention session: this
 * reader typing the `@` itself.
 *
 * Three conditions, each ruling out a different way a picker could appear over
 * text nobody was mentioning with.
 *
 * - **This reader's keyboard** ({@link isTypedHere}): not a peer's keystroke,
 *   not an undo or a redo, and not a paste, drop or cut.
 * - **An empty query.** A paragraph that has held `@notes` since last week is
 *   prose; clicking into it and typing a letter must not pop a picker. Only an
 *   `@` with nothing typed after it yet can be the command.
 * - **The `@` is what this transaction wrote** ({@link wroteUpTo}), which is
 *   what tells the keystroke from deleting `notes` back off that week-old
 *   `@notes` — the same prose, reached backwards.
 *
 * Keeping an already-open session alive as the query grows is the state's job,
 * not this one's (see {@link mentionTriggerAt}).
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
 * The documents a query offers, in the directory's own order (by title).
 *
 * Matched on the label — the words the reference will carry — and nothing else.
 * Descriptions and tags are what the corpus listing searches; a mention is a
 * reader reaching for a document *by name*, and a picker that answered `@meta`
 * with every document carrying that tag would be offering something else.
 *
 * The open document is excluded: a reference from a document to itself is a link
 * to where the reader already is.
 */
export function filterMentions(
  candidates: readonly DocLinkCandidate[],
  query: string,
  openDocId: string | null,
): DocLinkCandidate[] {
  // One fold, run over needle and haystack alike, and the same one the Documents
  // page filter runs (see `title-fold.ts`): the two surfaces match these same
  // titles, so a query that finds a document in one has to offer it in the other.
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
 * Replace the typed `@query` with a reference to `docId`, in one transaction.
 * Returns false — having touched nothing — when the session no longer describes
 * the document, or when `docId` is not a document uuid.
 *
 * The refusal is the point. The trigger was read at some earlier moment, and
 * between then and now a peer may have deleted the block, or edited it, or the
 * caret may have left it. So the session is re-derived from live state and
 * compared before the live range is spliced.
 *
 * The label is resolved by `doc-links.ts` from the directory rather than passed
 * in from the row that was clicked: one rule decides what a new reference reads
 * as, whichever door it came through.
 */
export function linkMentionAtTrigger(
  editor: Editor,
  trigger: MentionTrigger,
  docId: string,
  context: DocLinkContext | null,
): boolean {
  const live = mentionTriggerAt(editor);
  if (live === null) return false;
  // The block and the query: what the picker offered was an answer to *this*
  // question in *that* block, and a live state describing anything else is not
  // this session's to replace. Which occurrence it is stays the caller's to
  // watch — `ui/MentionMenu.tsx` closes the session the moment the caret's
  // trigger stops being the one it opened on — and is deliberately not compared
  // here, because a peer's edit above the block moves the position without
  // changing which `@` was meant.
  if (live.blockId !== trigger.blockId) return false;
  if (live.query !== trigger.query) return false;

  // A reader who undoes this means "give me my `@query` back", not "give me back
  // the empty block I started from" — so the reference is its own undo step.
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
