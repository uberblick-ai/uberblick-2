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
 */

import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
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

/** An open slash session: which block it belongs to, and what has been typed. */
export interface SlashTrigger {
  /** Position of the top-level block holding the caret. */
  blockPos: number;
  /** The block's id, so the shell can tell one session from the next. */
  blockId: string | null;
  /** What was typed after the `/`. */
  query: string;
}

/** `/` plus a run of non-space characters, and nothing else in the block. */
const SLASH_QUERY = /^\/(\S*)$/;

/**
 * The slash session the editor state describes, or `null` when there is none.
 * See the module comment for why this is derived rather than remembered.
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

  return {
    blockPos: $head.before(1),
    blockId: typeof block.attrs.id === "string" ? block.attrs.id : null,
    query: match[1] ?? "",
  };
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
 * false when the trigger no longer describes a block — the caret moved between
 * the click and the handler.
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
  const tr = editor.state.tr;
  const block = tr.doc.nodeAt(trigger.blockPos);
  if (block === null) return false;

  const contentStart = trigger.blockPos + 1;
  tr.delete(contentStart, contentStart + block.content.size);
  retypeBlockInTransaction(tr, trigger.blockPos, entry.type, entry.attrs);
  tr.setSelection(TextSelection.near(tr.doc.resolve(contentStart)));

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/**
 * Insert an empty block of `entry`'s type directly below the block at
 * `blockPos`, with the caret inside it. One transaction, so one undo step.
 */
export function insertBlockBelow(
  editor: Editor,
  blockPos: number,
  entry: BlockMenuEntry,
): boolean {
  const { state } = editor;
  const block = state.doc.nodeAt(blockPos);
  if (block === null) return false;

  const nodeType = state.schema.nodes[entry.type];
  if (nodeType === undefined) return false;
  const fresh = nodeType.createAndFill(attrsForNewBlock(entry));
  if (fresh === null) return false;

  const at = blockPos + block.nodeSize;
  const tr = state.tr.insert(at, fresh);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}
