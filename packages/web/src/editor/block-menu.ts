/**
 * The block-insertion menu's model: what it offers, what a typed query matches,
 * and the two document operations behind picking an entry.
 *
 * Everything here is editor-side and pure enough to test without a DOM. The
 * React shell (`ui/BlockMenu.tsx`) owns pixels, focus and keys; this module owns
 * the registry and the transactions.
 *
 * ## One registry, two paths
 *
 * The menu is reached by typing `/` in an empty paragraph (which CONVERTS that
 * block) and by the gutter `+` (which INSERTS a new block below the hovered
 * one). Both read {@link BLOCK_MENU_ENTRIES}, so a new block type is one entry
 * in that array — never a change to menu code.
 *
 * ## The two operations, and why each is a single transaction
 *
 * `/heading` is two edits — drop the typed `/query`, then re-type the block —
 * and a reader who presses undo means "put my slash back", not "put my slash
 * back, twice". So {@link convertBlockAtTrigger} builds one transaction holding
 * both steps, which is also why the re-type is `retypeBlockInTransaction`
 * rather than a second dispatch. The gutter path is one `insert` step for the
 * same reason.
 *
 * The convert path goes through the sanctioned re-type (`setNodeMarkup`, id
 * carried over) rather than replacing the block: the invariant in CLAUDE.md is
 * that a type change keeps the block id, and an id churned here would orphan
 * every reference to that block. The insert path is the opposite case — a block
 * that did not exist before — so it is created with a null id and the block-id
 * plugin assigns a fresh one in the same gesture.
 *
 * ## The trigger is derived, never remembered
 *
 * {@link slashTriggerAt} answers "is a slash menu open right now?" from the
 * editor state alone: caret at the end of a top-level paragraph whose whole text
 * is `/` plus a run of non-space characters. Derived state means the menu closes
 * itself when a remote edit, an undo or a click moves the caret away, with no
 * bookkeeping to get wrong. A space ends the session — that is a reader writing
 * prose, not filtering — and `/` in a non-empty block never matches, because the
 * text before it would be in front of the slash.
 *
 * *Opening* a session is a different question from *having* one, and is asked of
 * the transaction rather than the state — see {@link opensSlashSession}.
 *
 * ## Blocks are named by id, positions are not to be trusted
 *
 * A session and a gutter target both name their block by **id**. A ProseMirror
 * position is a number about one version of the document: a peer deleting a
 * block above shifts every position after it, and a peer deleting the block
 * *itself* leaves the old position pointing at its successor. Acting on that
 * would edit the wrong block while looking, to the reader, like it worked. So
 * both operations re-resolve the id against live state and refuse when it is
 * gone (see {@link findBlockById}).
 */

import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import type { BlockType } from "@uberblick/schema";
import { retypeBlockInTransaction } from "./retype.js";
import type { RetypeAttrs } from "./retype.js";

export interface BlockMenuEntry {
  /** Stable key, for React and for tests. */
  id: string;
  /** What the reader sees. */
  label: string;
  /** The heading it is listed under. Consecutive entries share one heading. */
  group: string;
  /** The markdown-flavoured shortcut shown in the right column, or `null`. */
  hint: string | null;
  /** Extra words the filter matches on, beyond the label and the hint. */
  keywords: readonly string[];
  type: BlockType;
  attrs: RetypeAttrs;
}

/**
 * The menu, in display order. The whole palette and nothing else — which is the
 * point: this array *is* the block palette as far as a reader is concerned, so
 * the types listed here have to stay the types the schema owns.
 *
 * The hint column is the token that selects the entry from a query (`/#` lands
 * on the headings, `/``` ` on Code), written the way the markdown export writes
 * that block. It is not a promise about typing `# ` in the prose: this editor
 * has no block-level input rules yet.
 */
export const BLOCK_MENU_ENTRIES: readonly BlockMenuEntry[] = [
  {
    id: "paragraph",
    label: "Paragraph",
    group: "Text",
    hint: null,
    keywords: ["text", "plain", "body"],
    type: "paragraph",
    attrs: {},
  },
  {
    id: "heading-1",
    label: "Heading 1",
    group: "Text",
    hint: "#",
    keywords: ["h1", "title"],
    type: "heading",
    attrs: { level: 1 },
  },
  {
    id: "heading-2",
    label: "Heading 2",
    group: "Text",
    hint: "##",
    keywords: ["h2", "section"],
    type: "heading",
    attrs: { level: 2 },
  },
  {
    id: "heading-3",
    label: "Heading 3",
    group: "Text",
    hint: "###",
    keywords: ["h3", "subsection"],
    type: "heading",
    attrs: { level: 3 },
  },
  {
    id: "code",
    label: "Code",
    group: "Source",
    hint: "```",
    keywords: ["snippet", "pre", "fence"],
    type: "code",
    attrs: {},
  },
  {
    id: "mermaid",
    label: "Mermaid",
    group: "Source",
    hint: null,
    keywords: ["diagram", "chart", "flowchart", "sequence"],
    type: "mermaid",
    attrs: {},
  },
];

/** Everything a query is matched against, lower-cased. */
function haystack(entry: BlockMenuEntry): string[] {
  return [
    entry.label,
    // "heading1" as well as "heading 1", so a query never has to guess whether
    // the label has a space in it.
    entry.label.replace(/\s+/g, ""),
    entry.hint ?? "",
    ...entry.keywords,
  ].map((term) => term.toLowerCase());
}

/**
 * The entries a query matches, in registry order. An empty query matches
 * everything; nothing matching is a real answer — the shell closes the menu, so
 * a reader typing prose after a slash gets their prose.
 */
export function filterBlockMenu(query: string): BlockMenuEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...BLOCK_MENU_ENTRIES];
  return BLOCK_MENU_ENTRIES.filter((entry) =>
    haystack(entry).some((term) => term !== "" && term.includes(needle)),
  );
}

/**
 * An open slash session. The block is named by **id**, not by position: a
 * position is a number about a document that has since changed, and acting on a
 * stale one would edit whichever block moved into that gap.
 */
export interface SlashTrigger {
  /** The block the session belongs to. */
  blockId: string;
  /** What was typed after the `/`. */
  query: string;
}

/** `/` plus a run of non-space characters, and nothing else in the block. */
const SLASH_QUERY = /^\/(\S*)$/;

/** The top-level block carrying `id`, with its current position. */
export function findBlockById(
  doc: ProseMirrorNode,
  id: string,
): { pos: number; node: ProseMirrorNode } | null {
  let pos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const node = doc.child(index);
    if (node.attrs.id === id) return { pos, node };
    pos += node.nodeSize;
  }
  return null;
}

/**
 * The slash session the editor state describes, or `null` when there is none.
 * See the module comment for why this is derived rather than remembered.
 *
 * A block with no id yet is not a session: everything the menu does later has to
 * find this block again, and an id is the only handle that survives an edit
 * somewhere above it. The block-id plugin assigns one in the same transaction,
 * so this is a state nothing lingers in.
 */
export function slashTriggerAt(editor: Editor): SlashTrigger | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;

  const { $head } = selection;
  // Depth 1 is a top-level block; the palette has no nesting, so anything else
  // is not a block this menu can act on.
  if ($head.depth !== 1) return null;

  const block = $head.parent;
  if (block.type.name !== "paragraph") return null;
  // Filtering happens at the end of what was typed. A caret parked before the
  // text is a reader editing prose that merely starts with a slash.
  if ($head.parentOffset !== block.content.size) return null;

  const match = SLASH_QUERY.exec(block.textContent);
  if (match === null) return null;
  if (typeof block.attrs.id !== "string" || block.attrs.id === "") return null;

  return { blockId: block.attrs.id, query: match[1] ?? "" };
}

/** Whether `transaction` is a remote change, an undo or a redo — not typing. */
function isChangeFromElsewhere(transaction: Transaction): boolean {
  const sync = transaction.getMeta(ySyncPluginKey) as
    | { isChangeOrigin?: boolean }
    | undefined;
  return sync?.isChangeOrigin === true;
}

/**
 * Whether `transaction` is the gesture that *opens* a slash session: this
 * reader, typing, into a block that was empty (the `/`) or already held a
 * shorter query (the next character of it).
 *
 * Opening on "the document changed and the state now looks like a session" was
 * too generous by a mile: a peer appending to a paragraph that reads `/co`, a
 * paste, an undo, or any programmatic edit would pop a menu nobody asked for —
 * on a *remote* keystroke, in the middle of someone else's sentence. So the
 * question is asked of the transaction, not of the state it produced. Keeping an
 * already-open session is still the state's job (see `slashTriggerAt`).
 */
export function opensSlashSession(
  transaction: Transaction,
  trigger: SlashTrigger,
): boolean {
  if (!transaction.docChanged) return false;
  if (isChangeFromElsewhere(transaction)) return false;
  // Pasting `/code` into an empty block is content, not a command.
  const uiEvent = transaction.getMeta("uiEvent");
  if (uiEvent === "paste" || uiEvent === "drop" || uiEvent === "cut") return false;

  const before = findBlockById(transaction.before, trigger.blockId);
  if (before === null || before.node.type.name !== "paragraph") return false;

  const was = before.node.textContent;
  const now = `/${trigger.query}`;
  // The `/` went into an empty paragraph, which is the gesture this menu is for.
  if (was === "") return true;
  // Or it extended a query the reader had already started: the block held a
  // slash session's text before, and holds more of it now.
  return SLASH_QUERY.test(was) && now.startsWith(was);
}

/**
 * Close the UndoManager's current stack item, so what follows is undone on its
 * own.
 *
 * Yjs merges edits made within half a second into one undoable step, which is
 * right for typing and wrong here: typing `/he` and pressing Enter takes well
 * under that, and a reader who undoes the conversion means "give me my slash
 * back", not "give me my empty block back". The boundary belongs in the command
 * because the reader's gesture is where it is — a test that arranges it is
 * testing itself.
 */
function endUndoCapture(editor: Editor): void {
  const undo = yUndoPluginKey.getState(editor.state) as
    | { undoManager?: { stopCapturing: () => void } }
    | undefined;
  undo?.undoManager?.stopCapturing();
}

/** Node attributes for a *new* block: a null id, which the block-id plugin fills. */
function attrsForNewBlock(entry: BlockMenuEntry): Record<string, unknown> {
  const attrs: Record<string, unknown> = { id: null };
  // Strings, like everything the schema stores — see editor/nodes.ts.
  if (entry.type === "heading") attrs.level = String(entry.attrs.level ?? 1);
  if (entry.type === "code") attrs.language = entry.attrs.language ?? null;
  return attrs;
}

/**
 * Consume the typed `/query` and re-type its block, in one transaction. Returns
 * false — having touched nothing — when the session no longer describes the
 * document.
 *
 * The refusal is the point. The trigger this is called with was read at some
 * earlier moment, and between then and now a peer may have deleted the block, or
 * edited it, or the caret may have left it. So the session is re-derived from
 * live state and compared: same block, same query, caret still in it. A stale
 * *position* would have resolved to whichever block moved into that gap and
 * deleted its content instead — the worst kind of bug, because the reader's own
 * gesture looks like it worked.
 *
 * The re-type itself may decline (picking Paragraph while already in one), and
 * that is not a failure: the slash still has to go, which is the reader's whole
 * request.
 */
export function convertBlockAtTrigger(
  editor: Editor,
  trigger: SlashTrigger,
  entry: BlockMenuEntry,
): boolean {
  const live = slashTriggerAt(editor);
  if (live === null) return false;
  if (live.blockId !== trigger.blockId || live.query !== trigger.query) return false;

  const found = findBlockById(editor.state.doc, live.blockId);
  if (found === null) return false;

  endUndoCapture(editor);
  const tr = editor.state.tr;
  const contentStart = found.pos + 1;
  tr.delete(contentStart, contentStart + found.node.content.size);
  retypeBlockInTransaction(tr, found.pos, entry.type, entry.attrs);
  tr.setSelection(TextSelection.near(tr.doc.resolve(contentStart)));

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/**
 * Insert an empty block of `entry`'s type directly below the block with id
 * `blockId`, with the caret inside it. One transaction, so one undo step.
 *
 * By id for the same reason as the conversion above: the menu was opened over a
 * block, and by the time an entry is picked that block may have moved or gone.
 * Returns false when it has gone, rather than inserting somewhere arbitrary.
 */
export function insertBlockBelow(
  editor: Editor,
  blockId: string,
  entry: BlockMenuEntry,
): boolean {
  const { state } = editor;
  const found = findBlockById(state.doc, blockId);
  if (found === null) return false;
  const { pos: blockPos, node: block } = found;

  const nodeType = state.schema.nodes[entry.type];
  if (nodeType === undefined) return false;
  const fresh = nodeType.createAndFill(attrsForNewBlock(entry));
  if (fresh === null) return false;

  endUndoCapture(editor);
  const at = blockPos + block.nodeSize;
  const tr = state.tr.insert(at, fresh);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}
