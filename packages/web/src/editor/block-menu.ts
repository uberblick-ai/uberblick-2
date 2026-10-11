/**
 * Keep menu entries and Markdown input rules in one registry. Conversion consumes
 * the slash query and retypes the same block in one transaction, preserving its
 * id; insertion gives a new block a null id for BlockIds to fill in that gesture.
 *
 * Custom slash/mention matching stays local: @tiptap/suggestion would still need
 * these matchers plus integration machinery. Reconsider when a framework can
 * express the same transaction-origin and session rules directly.
 *
 * Resolve every target by id against live state: remote edits make saved
 * positions point at other blocks. The React shell owns focus and keys.
 */

import { tableFromRows } from "./table.js";
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
   * The literal Markdown prefix, or null when none exists. Input rules, matching
   * and shortcut display share this field; display trims its committing space.
   */
  trigger: string | null;
  /** Extra words the filter matches on, beyond the label and the trigger. */
  keywords: readonly string[];
  type: BlockType;
  attrs: RetypeAttrs;
  /** Ordinary source text authored when this entry is picked. */
  initialText?: string;
}

/**
 * Keep the displayed palette aligned with schema-owned block types. Triggers
 * use the spellings accepted by Markdown input rules and export.
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
    // Only literal `1. ` converts; export computes numbering and Enter continues lists.
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
    keywords: ["diagram", "flowchart", "sequence"],
    type: "mermaid",
    attrs: {},
  },
  {
    // `$ ` is ordinary prose too, so it must not trigger transcript conversion.
    id: "terminal",
    label: "Terminal demo",
    group: "Source",
    trigger: null,
    keywords: ["console", "command", "cli", "transcript", "prompt", "demo"],
    type: "terminal",
    attrs: {},
  },
  {
    id: "chart",
    label: "Line chart",
    group: "Source",
    trigger: null,
    keywords: ["chart", "trend", "data", "series", "graph"],
    type: "chart",
    attrs: {},
  },
  {
    id: "data-table",
    label: "Data table",
    group: "Source",
    trigger: null,
    keywords: ["data", "records", "collection", "rows", "columns"],
    type: "chart",
    attrs: {},
    initialText: JSON.stringify({
      version: 1,
      type: "table",
      collection: "records",
      columns: [{ field: "value", format: "text" }],
    }, null, 2),
  },
];

/**
 * Trim the committing space for display and filtering; keep it in input rules.
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
 * Empty queries offer the whole registry in order. No matches closes the menu
 * so slash-prefixed prose can continue without a picker.
 */
export function filterBlockMenu(query: string): BlockMenuEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...BLOCK_MENU_ENTRIES];
  return BLOCK_MENU_ENTRIES.filter((entry) =>
    haystack(entry).some((term) => term !== "" && term.includes(needle)),
  );
}

/**
 * Keep the block id rather than a position, which remote edits can invalidate.
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
 * Require an identified top-level paragraph, a caret at its end and only a
 * slash plus non-space query text. Re-derive this on each state change.
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
 * Only local typing may open a picker. Yjs undo/redo returns through ySync with
 * isChangeOrigin, just like remote edits; paste, drop and cut also stay prose.
 */
export function isTypedHere(transaction: Transaction): boolean {
  if (!transaction.docChanged) return false;
  if (isChangeFromElsewhere(transaction)) return false;
  const uiEvent = transaction.getMeta("uiEvent");
  return uiEvent !== "paste" && uiEvent !== "drop" && uiEvent !== "cut";
}

/**
 * Only typing into an empty paragraph opens slash mode. Editing stored /query
 * prose must not open it; slashTriggerAt keeps an existing session alive.
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
 * Separate conversion from typing: undo must restore the typed trigger, not the
 * empty paragraph. Yjs otherwise coalesces both within its capture interval.
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
 * Re-derive and compare the live block id and query before consuming the slash
 * and retyping in one transaction. A stale session changes nothing; choosing
 * Paragraph still consumes the query even when retyping is a no-op.
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
  if (entry.type === "table") {
    const emptied = tr.doc.nodeAt(found.pos);
    if (emptied === null) return false;
    tr.replaceWith(found.pos, found.pos + emptied.nodeSize,
      tableFromRows(editor.state.schema, [["", "", ""], ["", "", ""], ["", "", ""]], live.blockId));
  } else {
    retypeBlockInTransaction(tr, found.pos, entry.type, entry.attrs);
    if (entry.initialText !== undefined) tr.insertText(entry.initialText, contentStart);
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(contentStart)));

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/**
 * Resolve the anchor id again and insert below it in one undo step, with the
 * caret inside. A deleted anchor must refuse rather than insert elsewhere.
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
  const fresh = entry.type === "table"
    ? tableFromRows(state.schema, [["", "", ""], ["", "", ""], ["", "", ""]], null)
    : nodeType.createAndFill(attrsForNewBlock(entry),
      entry.initialText === undefined ? undefined : state.schema.text(entry.initialText));
  if (fresh === null) return false;

  endUndoCapture(state);
  const at = blockPos + block.nodeSize;
  const tr = state.tr.insert(at, fresh);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));

  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}
