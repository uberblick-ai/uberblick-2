import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { findWebAddresses } from "@uberblick/schema";
import { ySyncPluginKey } from "y-prosemirror";
import { endUndoCapture } from "./blocks.js";

interface Range { from: number; to: number }
interface Address extends Range { href: string }

const typedKey = new PluginKey<Range | null>("uberblickTypedWebAddress");

/** Match only newly written prose; existing targets and source stay untouched. */
function addresses(doc: PMNode, range: Range): Address[] {
  const result: Address[] = [];
  const link = doc.type.schema.marks.link;
  if (link === undefined) return result;
  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!node.isTextblock) return !node.type.spec.code;
    if (node.type.spec.code || !node.type.allowsMarkType(link)) return false;
    const protectedRanges: Range[] = [];
    node.forEach((child, offset) => {
      const blocked = child.marks.some((mark) => mark.type.spec.code || mark.type.name === "link" || mark.type.name === "docLink");
      if (!child.isText || blocked) protectedRanges.push({ from: offset, to: offset + child.nodeSize });
    });
    const source = node.textBetween(0, node.content.size, "", "\n");
    for (const match of findWebAddresses(source)) {
      const from = pos + 1 + match.from;
      const to = pos + 1 + match.to;
      if (from < range.from || to > range.to || protectedRanges.some((part) => part.from < match.to && match.from < part.to)) continue;
      result.push({ from, to, href: match.href });
    }
    return false;
  });
  return result;
}

function convert(view: EditorView, matches: Address[]): void {
  const link = view.state.schema.marks.link;
  if (link === undefined || matches.length === 0) return;
  endUndoCapture(view.state);
  const tr = view.state.tr.setMeta(typedKey, true);
  for (const match of matches) tr.addMark(match.from, match.to, link.create({ href: match.href }));
  view.dispatch(tr);
  endUndoCapture(view.state);
}

function typedAddresses(state: EditorState, before: number): Address[] {
  const typed = typedKey.getState(state);
  return typed == null ? [] : addresses(state.doc, { from: typed.from, to: Math.min(before, typed.to) });
}

export const WebAddresses = Extension.create({
  name: "uberblickWebAddresses",
  // Block shortcuts run first; normal inline rules still receive their input.
  priority: 1050,
  addProseMirrorPlugins() {
    let input: { from: number; to: number; text: string } | null = null;
    let finishingEnter = false;
    const editor = this.editor;
    return [new Plugin<Range | null>({
      key: typedKey,
      state: {
        init: () => null,
        apply(tr: Transaction, previous: Range | null): Range | null {
          if (!tr.docChanged) return previous;
          const typed = input;
          input = null;
          const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
          if (sync?.isChangeOrigin === true) return null;
          if (tr.getMeta(typedKey)) return previous;
          if (typed === null || typed.from + typed.text.length > tr.doc.content.size ||
            tr.doc.textBetween(typed.from, typed.from + typed.text.length) !== typed.text) return null;
          const added = { from: typed.from, to: typed.from + typed.text.length };
          const mapped = previous === null ? null : {
            from: tr.mapping.map(previous.from, 1), to: tr.mapping.map(previous.to, -1),
          };
          return mapped !== null && added.from <= mapped.to && mapped.from <= added.to
            ? { from: Math.min(mapped.from, added.from), to: Math.max(mapped.to, added.to) } : added;
        },
      },
      props: {
        handleTextInput(view, from, to, text, defaultTransaction) {
          if (!view.editable || view.composing) return false;
          input = { from, to, text };
          if (!/[\s>]/.test(text)) return false;
          // Only a completely typed address qualifies; a stored plain address
          // and a link returned to text by Undo have no typing provenance.
          const typed = typedKey.getState(view.state);
          const start = typed != null && from <= typed.to && typed.from <= to ? typed.from : from;
          const possible = addresses(
            defaultTransaction().doc,
            { from: start, to: from + text.length },
          ).filter((match) => match.to < from + text.length);
          if (possible.length === 0) return false;
          view.dispatch(defaultTransaction());
          convert(view, possible);
          return true;
        },
        handleKeyDown(view, event) {
          if (finishingEnter || !view.editable || event.key !== "Enter" || event.isComposing || event.keyCode === 229 ||
            event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !view.state.selection.empty) return false;
          const matches = typedAddresses(view.state, view.state.selection.from);
          if (matches.length === 0) return false;
          finishingEnter = true;
          try { editor.commands.keyboardShortcut("Enter"); }
          finally { finishingEnter = false; }
          convert(view, matches);
          return true;
        },
      },
    })];
  },
  onTransaction({ transaction, appendedTransactions }) {
    if (!this.editor.isEditable || transaction.getMeta("uiEvent") !== "paste" && !transaction.getMeta("webAddressPaste")) return;
    // Tiptap has finished its formatting paste rules and ySync has stored the
    // paste before this event, so adding links gets its own Yjs undo capture.
    const maps = [...transaction.mapping.maps, ...appendedTransactions.flatMap((tr) => tr.mapping.maps)];
    const matches: Address[] = [];
    transaction.mapping.maps.forEach((map, index) => {
      map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
        if (newFrom === newTo) return;
        let from = newFrom;
        let to = newTo;
        for (const subsequent of maps.slice(index + 1)) {
          from = subsequent.map(from, 1);
          to = subsequent.map(to, -1);
        }
        if (from < to) matches.push(...addresses(this.editor.state.doc, { from, to }));
      });
    });
    convert(this.editor.view, matches);
  },
});
