/**
 * Keep mention trigger/session matching aligned with block-menu.ts. A picked
 * reference uses replaceWithDocLink, matching typed and pasted references.
 * The shared schema is workspace-independent; the shell supplies directory
 * context without opening target rooms.
 */

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { endUndoCapture, isTypedHere } from "./blocks.js";
import { replaceWithDocLink } from "./doc-links.js";
import type { DocLinkCandidate, DocLinkContext } from "./doc-links.js";
import { CARD_NODE_NAMES, CARD_PARTS } from "@uberblick/schema";
import { mentionCandidates } from "../mentions.js";

/** An open mention session: the block it belongs to, what was typed, and where. */
export interface MentionTrigger {
  blockId: string;
  /** The document in which this range was validated; stale picks never write. */
  doc: ProseMirrorNode;
  /** Cell or prose-part boundaries carried through steps; top-level prose uses its block id. */
  cell: { from: number; to: number } | null;
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

const cardParts = new Set<string>(CARD_PARTS.map((part) => CARD_NODE_NAMES[part]));

/**
 * Admit identified prose blocks and paragraphs in editable table cells.
 * Recompute the live range so edits cannot redirect an insertion. Space, caret
 * departure or a rewritten trigger closes the session rather than retaining a
 * saved mode.
 */
export function mentionTriggerAt(editor: Editor): MentionTrigger | null {
  if (!editor.isEditable) return null;
  const { selection } = editor.state;
  if (!selection.empty) return null;

  const { $head } = selection;
  const inCell = $head.depth === 4 && $head.node(1).type.name === "table"
    && $head.node(2).type.name === "tableRow"
    && ($head.node(3).type.name === "tableCell" || $head.node(3).type.name === "tableHeader")
    && $head.parent.type.name === "paragraph";
  const inPart = $head.depth === 3 && $head.parent.type.name === "paragraph" && (
    $head.node(1).type.name === "card" && cardParts.has($head.node(2).type.name)
    || $head.node(1).type.name === "figma" && $head.node(2).type.name === "figmaCaption"
  );
  if ($head.depth !== 1 && !inCell && !inPart) return null;

  const block = $head.parent;
  // Read the source-text spec so picker admission stays aligned with its marks.
  if (!block.isTextblock || block.type.spec.code === true) return null;
  if ((editor.state.storedMarks ?? $head.marks()).some((mark) => mark.type.spec.code)) return null;
  const blockId = $head.node(1).attrs.id;
  if (typeof blockId !== "string" || blockId === "") return null;

  // Count leaf nodes as one U+FFFC so text offsets track document positions.
  const before = block.textBetween(0, $head.parentOffset, undefined, "￼");
  const match = MENTION_QUERY.exec(before);
  if (match === null) return null;

  const query = match[1] ?? "";
  let code = false;
  editor.state.doc.nodesBetween($head.pos - query.length - 1, $head.pos, (node) => {
    if (node.marks.some((mark) => mark.type.spec.code)) code = true;
  });
  if (code) return null;
  return {
    blockId,
    doc: editor.state.doc,
    cell: inCell ? { from: $head.before(3), to: $head.after(3) }
      : inPart ? { from: $head.before(2), to: $head.after(2) } : null,
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
  return mentionCandidates(candidates, [], query, openDocId)
    .flatMap((candidate) => candidate.kind === "document" ? [{ docId: candidate.docId, label: candidate.label }] : []);
}

function liveMention(editor: Editor, trigger: MentionTrigger): MentionTrigger | null {
  const live = mentionTriggerAt(editor);
  if (live === null || live.doc !== trigger.doc || live.from !== trigger.from || live.to !== trigger.to
    || live.blockId !== trigger.blockId || live.query !== trigger.query
    || live.cell?.from !== trigger.cell?.from || live.cell?.to !== trigger.cell?.to) return null;
  return live;
}

/** A picked person is ordinary text with the usual formatting inheritance. */
export function personMentionAtTrigger(
  editor: Editor,
  trigger: MentionTrigger,
  username: string,
  members: readonly string[],
): boolean {
  const live = liveMention(editor, trigger);
  const current = members.find((member) => member.toLowerCase() === username.toLowerCase());
  if (live === null || current === undefined) return false;
  endUndoCapture(editor.state);
  editor.view.dispatch(editor.state.tr.insertText(`@${current}`, live.from, live.to));
  endUndoCapture(editor.state);
  editor.view.focus();
  return true;
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
  const live = liveMention(editor, trigger);
  if (live === null) return false;

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
