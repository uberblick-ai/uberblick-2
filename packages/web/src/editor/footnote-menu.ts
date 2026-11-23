import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { acceptsFootnoteReferences } from "@uberblick/schema";
import { endUndoCapture } from "./blocks.js";
import { footnoteIndex, footnoteRanges } from "./footnotes.js";

export interface FootnoteTrigger {
  doc: PMNode;
  blockId: string;
  from: number;
  to: number;
}

const typingKey = new PluginKey<boolean>("footnoteTyping");

function triggerAt(state: Pick<EditorState, "doc" | "selection" | "storedMarks">, editable: boolean): FootnoteTrigger | null {
  if (!editable || !state.selection.empty) return null;
  const { $head } = state.selection;
  if ($head.depth !== 1 || !acceptsFootnoteReferences($head.parent.type.name) || $head.parentOffset < 2) return null;
  const from = $head.pos - 2;
  if (state.doc.textBetween(from, $head.pos) !== "[^") return null;
  const blocked = (marks: typeof $head.parent.marks): boolean => marks.some((mark) =>
    mark.type.spec.code || ["link", "docLink", "footnoteRef"].includes(mark.type.name));
  if (blocked(state.storedMarks ?? $head.marks())) return null;
  let protectedText = false;
  state.doc.nodesBetween(from, $head.pos, (node) => { protectedText ||= blocked(node.marks); });
  const blockId: unknown = $head.parent.attrs.id;
  return protectedText || typeof blockId !== "string" || blockId === "" ? null
    : { doc: state.doc, blockId, from, to: $head.pos };
}

export function footnoteTriggerAt(editor: Editor): FootnoteTrigger | null {
  return triggerAt(editor.state, editor.isEditable);
}

export function opensFootnoteSession(transaction: Transaction): boolean {
  return transaction.getMeta(typingKey) === true;
}

/** Only native text input can offer an insertion; stored and pasted openers stay text. */
export const FootnoteTyping = Extension.create<{ allowed: () => boolean }>({
  name: "footnoteTyping",
  addOptions: () => ({ allowed: () => true }),
  addProseMirrorPlugins() {
    return [new Plugin({ props: {
      handleTextInput: (view, _from, _to, text, defaultTransaction) => {
        if (!this.options.allowed() || !text.endsWith("^")) return false;
        const tr = defaultTransaction();
        if (triggerAt(tr, this.editor.isEditable) === null) return false;
        view.dispatch(tr.setMeta(typingKey, true));
        return true;
      },
    } })];
  },
});

export function addFootnoteAtTrigger(editor: Editor, trigger: FootnoteTrigger): boolean {
  const live = footnoteTriggerAt(editor);
  if (live === null || live.doc !== trigger.doc || live.from !== trigger.from || live.to !== trigger.to
    || live.blockId !== trigger.blockId) return false;
  const { footnote } = editor.state.schema.nodes;
  const mark = editor.state.schema.marks.footnoteRef;
  if (footnote === undefined || mark === undefined) return false;
  const used = new Set(footnoteRanges(live.doc).map((ref) => ref.label.toLowerCase()));
  live.doc.forEach((node) => { if (node.type.name === "footnote") used.add(String(node.attrs.label).toLowerCase()); });
  let number = 1;
  while (used.has(String(number))) number += 1;
  const label = String(number);
  endUndoCapture(editor.state);
  const tr = editor.state.tr.replaceWith(live.from, live.to,
    editor.state.schema.text(`[^${label}]`, mark.create().addToSet(
      (editor.state.storedMarks ?? editor.state.doc.resolve(live.to).marks()).filter((m) => m.type.name !== "footnoteRef"),
    )));
  const notes = footnoteIndex(tr.doc).notes;
  let at = tr.doc.content.size;
  let trailing = tr.doc.content.size;
  for (let index = tr.doc.childCount - 1; index >= 0; index -= 1) {
    const node = tr.doc.child(index);
    if (node.type.name !== "footnote") break;
    trailing -= node.nodeSize;
  }
  for (const note of notes) {
    if (note.pos < trailing) continue;
    const first = note.references[0];
    if (note.pos < at && (first === undefined || first.from > live.from)) at = note.pos;
  }
  // known limit: concurrent additions can choose the same label; revisit when label allocation is coordinated.
  tr.insert(at, footnote.create({ id: null, label }));
  tr.setSelection(TextSelection.create(tr.doc, at + 1)).setStoredMarks([]).scrollIntoView();
  editor.view.dispatch(tr);
  endUndoCapture(editor.state);
  editor.view.focus();
  return true;
}
