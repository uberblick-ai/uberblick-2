import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { CARD_NODE_NAMES, CARD_PARTS } from "@uberblick/schema";
import { endUndoCapture } from "./blocks.js";
import { emojiForName, loadedEmojiData, loadEmojiData } from "./emoji-data.js";
import type { EmojiEntry } from "./emoji-data.js";

export interface EmojiTrigger {
  doc: ProseMirrorNode;
  blockId: string;
  parentFrom: number;
  from: number;
  to: number;
  query: string;
}

const typingKey = new PluginKey<{ from: number; to: number }>("emojiTyping");
const cardParts = new Set<string>(CARD_PARTS.map((part) => CARD_NODE_NAMES[part]));

function triggerAt(state: Pick<EditorState, "doc" | "selection" | "storedMarks">, editable: boolean, complete: boolean): EmojiTrigger | null {
  if (!editable || !state.selection.empty) return null;
  const { $head } = state.selection;
  const nested = $head.parent.type.name === "paragraph" && (
    $head.depth === 4 && $head.node(1).type.name === "table"
      && ["tableCell", "tableHeader"].includes($head.node(3).type.name)
    || $head.depth === 3 && (
      $head.node(1).type.name === "card" && cardParts.has($head.node(2).type.name)
      || $head.node(1).type.name === "figma" && $head.node(2).type.name === "figmaCaption"
    )
  );
  if ($head.depth !== 1 && !nested || !$head.parent.isTextblock || $head.parent.type.spec.code) return null;
  if ((state.storedMarks ?? $head.marks()).some((mark) => mark.type.spec.code)) return null;
  const blockId = $head.node(1).attrs.id;
  if (typeof blockId !== "string" || blockId === "") return null;
  const before = $head.parent.textBetween(0, $head.parentOffset, undefined, "\ufffc");
  const match = (complete ? /(?:^|\s):([a-z0-9_+-]+):$/i : /(?:^|\s):([a-z0-9_+-]*)$/i).exec(before);
  if (match === null) return null;
  const query = match[1] ?? "";
  const from = $head.pos - query.length - (complete ? 2 : 1);
  let code = false;
  state.doc.nodesBetween(from, $head.pos, (node) => {
    if (node.marks.some((mark) => mark.type.spec.code)) code = true;
  });
  return code ? null : { doc: state.doc, blockId, parentFrom: $head.start(), from, to: $head.pos, query };
}

export function emojiTriggerAt(editor: Editor, complete = false): EmojiTrigger | null {
  return triggerAt(editor.state, editor.isEditable, complete);
}

export function isEmojiTyping(transaction: Transaction): boolean {
  return transaction.getMeta(typingKey) !== undefined;
}

export function opensEmojiSession(transaction: Transaction, trigger: EmojiTrigger): boolean {
  const typed = transaction.getMeta(typingKey) as { from: number; to: number } | undefined;
  return typed !== undefined && typed.from <= trigger.from && typed.to === trigger.to;
}

export function pickEmojiAtTrigger(editor: Editor, trigger: EmojiTrigger, entry: EmojiEntry, complete = false): boolean {
  const live = emojiTriggerAt(editor, complete);
  if (live === null || live.doc !== trigger.doc || live.from !== trigger.from || live.to !== trigger.to
    || live.parentFrom !== trigger.parentFrom || live.blockId !== trigger.blockId || live.query !== trigger.query) return false;
  endUndoCapture(editor.state);
  editor.view.dispatch(editor.state.tr.insertText(entry.text, live.from, live.to));
  endUndoCapture(editor.state);
  editor.view.focus();
  return true;
}

/** A slow first download may finish after more prose; never replace a revised token. */
function convertWhenLoaded(editor: Editor, trigger: EmojiTrigger): void {
  let from = trigger.from;
  let to = trigger.to;
  let valid = true;
  const carry = ({ transaction }: { transaction: Transaction }): void => {
    for (const map of transaction.mapping.maps) {
      map.forEach((oldFrom, oldTo) => {
        if (oldFrom < to && oldTo > from || oldFrom === oldTo && from < oldFrom && oldFrom < to) valid = false;
      });
      from = map.map(from, 1);
      to = map.map(to, -1);
    }
  };
  const cleanup = (): void => {
    editor.off("transaction", carry);
    editor.off("destroy", cleanup);
    valid = false;
  };
  editor.on("transaction", carry);
  editor.on("destroy", cleanup);
  void loadEmojiData().then((entries) => {
    if (!valid || editor.isDestroyed || !editor.isEditable) return;
    const emoji = emojiForName(entries, trigger.query);
    const { doc } = editor.state;
    if (emoji === undefined || doc.textBetween(from, to, undefined, "\ufffc") !== `:${trigger.query}:`) return;
    const $from = doc.resolve(from);
    if ($from.depth === 0 || $from.node(1).attrs.id !== trigger.blockId || $from.parent.type.spec.code) return;
    let code = false;
    doc.nodesBetween(from, to, (node) => { if (node.marks.some((mark) => mark.type.spec.code)) code = true; });
    if (code) return;
    endUndoCapture(editor.state);
    editor.view.dispatch(editor.state.tr.insertText(emoji, from, to));
    endUndoCapture(editor.state);
  }).catch(() => {}).finally(cleanup);
}

/** Only the view's text-input door can open a session or convert a full name. */
export const EmojiTyping = Extension.create({
  name: "uberblickEmojiTyping",
  addProseMirrorPlugins() {
    return [new Plugin({ props: {
      handleTextInput: (view, from, _to, text, defaultTransaction) => {
        const tr = defaultTransaction();
        const next = { doc: tr.doc, selection: tr.selection, storedMarks: tr.storedMarks };
        const full = text.endsWith(":") ? triggerAt(next, this.editor.isEditable, true) : null;
        const trigger = full ?? triggerAt(next, this.editor.isEditable, false);
        if (trigger === null) return false;
        tr.setMeta(typingKey, { from, to: from + text.length });
        view.dispatch(tr);
        if (full !== null) {
          const typed = emojiTriggerAt(this.editor, true);
          if (typed === null) return true;
          const convert = (entries: Awaited<ReturnType<typeof loadEmojiData>>): void => {
            if (this.editor.isDestroyed) return;
            const emoji = emojiForName(entries, typed.query);
            if (emoji !== undefined) pickEmojiAtTrigger(this.editor, typed, { id: emoji, label: typed.query, text: emoji }, true);
          };
          const entries = loadedEmojiData();
          if (entries !== null) convert(entries);
          else convertWhenLoaded(this.editor, typed);
        } else void loadEmojiData().catch(() => {});
        return true;
      },
    } })];
  },
});
