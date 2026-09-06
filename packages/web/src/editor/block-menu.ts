/**
 * The block-insertion menu's model: what it offers, what a typed query matches,
 * and the two document operations behind picking an entry.
 *
 * Everything here is editor-side and pure enough to test without a DOM. The
 * React shell (`ui/BlockMenu.tsx`) owns pixels, focus and keys; this module owns
 * the registry and the transactions.
 *
 * ## One registry, three paths
 *
 * The menu is reached by typing `/` in an empty paragraph (which CONVERTS that
 * block) and by the gutter `+` (which INSERTS a new block below the hovered
 * one). The third path skips the menu: the markdown input rules in
 * `editor/input-rules.ts` convert on the entry's `trigger` (`# `, ```` ``` ````)
 * as it is typed. All three read {@link BLOCK_MENU_ENTRIES}, so a new block type
 * is one entry in that array — never a change to menu or input-rule code.
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
 * {@link slashTriggerAt} answers "does the editor state still describe a slash
 * session?": caret at the end of a top-level paragraph whose whole text is `/`
 * plus a run of non-space characters. Because the answer is recomputed rather
 * than remembered, a session lasts exactly as long as it keeps validating —
 * anything that moves the caret out of that block or stops its text looking like
 * a query closes the menu, and there is no bookkeeping to get wrong. A space
 * ends the session — that is a reader writing prose, not filtering — and `/` in
 * a non-empty block never matches, because the text before it would be in front
 * of the slash.
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
import type { EditorState, Transaction } from "@tiptap/pm/state";
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
  /**
   * The markdown prefix that produces this block — the exact characters a
   * reader types at the start of an empty paragraph (`"# "`, `` "```" ``) — or
   * `null` for a type markdown has no syntax for.
   *
   * One field, three readers: the input rules in `editor/input-rules.ts` fire on
   * it, the filter matches on it, and the menu shows it in its right column
   * (without the trailing space — see {@link triggerHint}). So the shortcut a
   * reader is shown is by construction the shortcut that works, and a new block
   * type gets its input rule by filling this in.
   */
  trigger: string | null;
  /** Extra words the filter matches on, beyond the label and the trigger. */
  keywords: readonly string[];
  type: BlockType;
  attrs: RetypeAttrs;
}

/**
 * The menu, in display order. The whole palette and nothing else — which is the
 * point: this array *is* the block palette as far as a reader is concerned, so
 * the types listed here have to stay the types the schema owns.
 *
 * The trigger column is both the token that selects the entry from a query (`/#`
 * lands on the headings, `/``` ` on Code) and the markdown prefix that converts
 * a block outright — see `editor/input-rules.ts`. Written the way the markdown
 * export writes that block, because that is what a reader will type.
 */
export const BLOCK_MENU_ENTRIES: readonly BlockMenuEntry[] = [
  {
    id: "paragraph",
    label: "Paragraph",
    group: "Text",
    trigger: null,
    keywords: ["text", "plain", "body"],
    type: "paragraph",
    attrs: {},
  },
  {
    id: "heading-1",
    label: "Heading 1",
    group: "Text",
    trigger: "# ",
    keywords: ["h1", "title"],
    type: "heading",
    attrs: { level: 1 },
  },
  {
    id: "heading-2",
    label: "Heading 2",
    group: "Text",
    trigger: "## ",
    keywords: ["h2", "section"],
    type: "heading",
    attrs: { level: 2 },
  },
  {
    id: "heading-3",
    label: "Heading 3",
    group: "Text",
    trigger: "### ",
    keywords: ["h3", "subsection"],
    type: "heading",
    attrs: { level: 3 },
  },
  {
    id: "quote",
    label: "Quote",
    group: "Text",
    trigger: "> ",
    keywords: ["blockquote", "cite", "quotation"],
    type: "quote",
    attrs: {},
  },
  {
    id: "list-bullet",
    label: "Bullet list",
    group: "Lists",
    trigger: "- ",
    keywords: ["ul", "unordered", "bullets", "item"],
    type: "list-item",
    attrs: { list: "bullet" },
  },
  {
    // Only `1. ` converts, not `7. `: the trigger is a literal, and the number
    // a reader types is not stored anyway — a run of items numbers itself on
    // export. Continuing the list is Enter's job, not the input rule's.
    id: "list-ordered",
    label: "Numbered list",
    group: "Lists",
    trigger: "1. ",
    keywords: ["ol", "ordered", "numbers", "item"],
    type: "list-item",
    attrs: { list: "ordered" },
  },
  {
    id: "code",
    label: "Code",
    group: "Source",
    trigger: "```",
    keywords: ["snippet", "pre", "fence"],
    type: "code",
    attrs: {},
  },
  {
    // No trigger: a table is two lines before it is a table, so the shortcut is
    // typing the header row and the delimiter row under it — see table.ts.
    id: "table",
    label: "Table",
    group: "Source",
    trigger: null,
    keywords: ["grid", "gfm", "rows", "columns"],
    type: "table",
    attrs: {},
  },
  {
    id: "mermaid",
    label: "Mermaid",
    group: "Source",
    trigger: null,
    keywords: ["diagram", "chart", "flowchart", "sequence"],
    type: "mermaid",
    attrs: {},
  },
  {
    // No trigger either: a transcript is prose until a `$ ` line makes it one,
    // and `$ ` is far too common a thing to type to convert a block on.
    id: "terminal",
    label: "Terminal demo",
    group: "Source",
    trigger: null,
    keywords: ["console", "command", "cli", "transcript", "prompt", "demo"],
    type: "terminal",
    attrs: {},
  },
];

/**
 * The trigger as a shortcut to *show*, or `null` when there is none. The
 * trailing space is what commits `# ` in the prose; on a menu row it would only
 * read as a typo, so it is trimmed for display and for the filter — `##` still
 * finds Heading 2.
 */
export function triggerHint(entry: BlockMenuEntry): string | null {
  return entry.trigger === null ? null : entry.trigger.trimEnd();
}

/** Everything a query is matched against, lower-cased. */
function haystack(entry: BlockMenuEntry): string[] {
  return [
    entry.label,
    // "heading1" as well as "heading 1", so a query never has to guess whether
    // the label has a space in it.
    entry.label.replace(/\s+/g, ""),
    triggerHint(entry) ?? "",
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
 * Whether `transaction` came from **this reader's keyboard** rather than from
 * somewhere else: a peer's keystroke, an undo or a redo, or a paste, drop or
 * cut.
 *
 * An undo counts as somewhere else, and that is not obvious. `Mod-z` is bound
 * to y-prosemirror's `undo` (`editor/collaboration.ts`), which writes to the
 * Y.Doc; every transaction the sync plugin then makes — a peer's edit and this
 * reader's own undo alike — carries `isChangeOrigin`, so {@link
 * isChangeFromElsewhere} closes both. Measured, not assumed.
 *
 * Necessary for opening a menu, and not sufficient: what is left is this
 * reader's typing, and each menu still has to tell the keystroke that meant the
 * command from one that merely landed where a command would look like it (see
 * {@link opensSlashSession}, and `opensMentionSession` in
 * `editor/mention-menu.ts`). Shared, because "where did this change come from"
 * is one question and two answers to it would drift.
 */
export function isTypedHere(transaction: Transaction): boolean {
  if (!transaction.docChanged) return false;
  if (isChangeFromElsewhere(transaction)) return false;
  const uiEvent = transaction.getMeta("uiEvent");
  return uiEvent !== "paste" && uiEvent !== "drop" && uiEvent !== "cut";
}

/**
 * Whether `transaction` is the gesture that *opens* a slash session: this
 * reader, typing, turning an **empty** paragraph into a slash query.
 *
 * Asked only when no session is open, and deliberately the narrowest question
 * that still admits the gesture. Two wider rules were tried and are wrong:
 *
 * - "the document changed and the state now looks like a session" pops a menu on
 *   a peer's keystroke, a paste, an undo or any programmatic edit — a menu
 *   appearing in the middle of someone else's sentence.
 * - "…or the block already held a shorter query and now holds more of it" reads
 *   sensibly and still misfires: a paragraph *stored* as `/co` is prose, and
 *   clicking into it and typing a letter would open a menu over text that has
 *   been sitting there since last week.
 *
 * Empty-before is the only state in which a leading `/` can only have meant the
 * command. Keeping an already-open session as the query grows is the state's
 * job, not this one's (see {@link slashTriggerAt}).
 */
export function opensSlashSession(
  transaction: Transaction,
  trigger: SlashTrigger,
): boolean {
  // Pasting `/code` into an empty block is content, not a command.
  if (!isTypedHere(transaction)) return false;

  const before = findBlockById(transaction.before, trigger.blockId);
  if (before === null || before.node.type.name !== "paragraph") return false;
  return before.node.textContent === "";
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
 *
 * Shared with the markdown input rules (`editor/input-rules.ts`), which split
 * the same way and for the same reason: the typed `# ` is one step, converting
 * on it is the next.
 */
export function endUndoCapture(state: EditorState): void {
  const undo = yUndoPluginKey.getState(state) as
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
  if (entry.type === "list-item") {
    attrs.list = entry.attrs.list ?? "bullet";
    attrs.indent = String(entry.attrs.indent ?? 0);
  }
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

  endUndoCapture(editor.state);
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

  endUndoCapture(state);
  const at = blockPos + block.nodeSize;
  const tr = state.tr.insert(at, fresh);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}
