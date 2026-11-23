import { Extension } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { acceptsFootnoteReferences } from "@uberblick/schema";
import { endUndoCapture } from "./blocks.js";
import { footnoteRanges } from "./footnotes.js";

function inNote($pos: ResolvedPos): boolean {
  return $pos.depth === 1 && $pos.parent.type.name === "footnote";
}

function selectionTouchesNote(state: EditorState): boolean {
  if (inNote(state.selection.$from)) return true;
  let touches = false;
  state.doc.forEach((node, pos) => {
    if (node.type.name === "footnote" && pos < state.selection.to && state.selection.from < pos + node.nodeSize) touches = true;
  });
  return touches;
}

function protectedMarks(state: EditorState): boolean {
  return (state.storedMarks ?? state.selection.$from.marks()).some((mark) =>
    ["inlineCode", "link", "docLink"].includes(mark.type.name));
}

function referenceDestination(state: EditorState, decisionAnswer: boolean): boolean {
  const { $from, $to } = state.selection;
  return !decisionAnswer && $from.depth === 1 && $to.depth === 1 &&
    acceptsFootnoteReferences($from.parent.type.name) && !protectedMarks(state);
}

function withoutReferences(content: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  content.forEach((node) => {
    const marks = node.marks.filter((mark) => mark.type.name !== "footnoteRef");
    nodes.push((node.isLeaf ? node : node.copy(withoutReferences(node.content))).mark(marks));
  });
  return Fragment.fromArray(nodes);
}

/** Nested prose and protected inline spans never gain reference semantics. */
function sanitizeReferences(content: Fragment, topLevel = true): Fragment {
  const nodes: ProseMirrorNode[] = [];
  content.forEach((node) => {
    if (node.isText) {
      const protectedText = node.marks.some((mark) => ["inlineCode", "link", "docLink"].includes(mark.type.name));
      nodes.push(protectedText ? node.mark(node.marks.filter((mark) => mark.type.name !== "footnoteRef")) : node);
      return;
    }
    const allowed = topLevel && acceptsFootnoteReferences(node.type.name);
    nodes.push(node.copy(allowed ? sanitizeReferences(node.content, false) : withoutReferences(node.content)));
  });
  return Fragment.fromArray(nodes);
}

/** A note always receives inline content, including when a whole note is copied. */
function notePaste(slice: Slice, state: EditorState): Slice {
  const textblocks: ProseMirrorNode[] = [];
  slice.content.descendants((node) => {
    if (!node.isTextblock) return true;
    textblocks.push(node);
    return false;
  });
  const single = textblocks.length === 1 ? textblocks[0] : undefined;
  const inline = slice.content.childCount > 0 && slice.content.firstChild?.isInline === true
    ? slice.content : single?.content;
  if (inline !== undefined && !/[\r\n]/.test(inline.textBetween(0, inline.size))) {
    return new Slice(withoutReferences(inline), 0, 0);
  }
  const text = (textblocks.length > 0
    ? textblocks.map((node) => node.textContent).filter((text) => text !== "").join(" ")
    : slice.content.textBetween(0, slice.content.size, " ", " ")).replace(/[\r\n]+/g, " ");
  return new Slice(text === "" ? Fragment.empty : Fragment.from(state.schema.text(text)), 0, 0);
}

function atomicSelection(state: EditorState, previous: EditorState): TextSelection | null {
  const selection = state.selection;
  // Isolating notes admit native gap cursors, which could create ordinary blocks beside the notes.
  if (selection instanceof GapCursor) {
    const { $head } = selection;
    if ($head.nodeBefore?.type.name === "footnote") return TextSelection.create(state.doc, $head.pos - 1);
    if ($head.nodeAfter?.type.name === "footnote") return TextSelection.create(state.doc, $head.pos + 1);
  }
  if (!(selection instanceof TextSelection)) return null;
  let { anchor, head } = selection;
  const forward = anchor <= head;
  const references = footnoteRanges(state.doc);
  const atHead = references.find((range) => range.from < head && head < range.to);
  if (selection.empty && atHead !== undefined) {
    const direction = head - previous.selection.head;
    const before = direction < 0 || direction === 0 && head - atHead.from < atHead.to - head;
    anchor = head = before ? atHead.from : atHead.to;
  } else if (!selection.empty) {
    const atAnchor = references.find((range) => range.from < anchor && anchor < range.to);
    if (atAnchor !== undefined) anchor = forward ? atAnchor.from : atAnchor.to;
    if (atHead !== undefined) head = forward ? atHead.to : atHead.from;
  }
  return anchor === selection.anchor && head === selection.head ? null : TextSelection.create(state.doc, anchor, head);
}

/** Selections crossing a note boundary remove the entire note block. */
function deletionRange(state: EditorState): { from: number; to: number } {
  let { from, to } = state.selection;
  if (state.selection.empty) return { from, to };
  for (const reference of footnoteRanges(state.doc)) {
    if (reference.from < from && from < reference.to) from = reference.from;
    if (reference.from < to && to < reference.to) to = reference.to;
  }
  state.doc.forEach((node, pos) => {
    if (node.type.name !== "footnote" || to <= pos || from >= pos + node.nodeSize) return;
    if (from > pos && to < pos + node.nodeSize) return;
    from = Math.min(from, pos);
    to = Math.max(to, pos + node.nodeSize);
  });
  return { from, to };
}

function deleteSelection(view: EditorView): boolean {
  if (view.state.selection.empty) return false;
  const range = deletionRange(view.state);
  if (range.from === view.state.selection.from && range.to === view.state.selection.to) return false;
  view.dispatch(view.state.tr.delete(range.from, range.to).scrollIntoView());
  return true;
}

function deleteKey(view: EditorView, backward: boolean): boolean {
  const { state } = view;
  if (!state.selection.empty) return deleteSelection(view);
  const { $from } = state.selection;
  for (const range of footnoteRanges(state.doc)) {
    if ((backward && range.to === $from.pos) || (!backward && range.from === $from.pos)) {
      view.dispatch(state.tr.delete(range.from, range.to).scrollIntoView());
      return true;
    }
  }
  if (inNote($from)) {
    if (backward && $from.parent.content.size === 0) {
      endUndoCapture(state);
      const tr = state.tr.delete($from.before(), $from.after());
      view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min($from.before(), tr.doc.content.size)), -1)).scrollIntoView());
      endUndoCapture(view.state);
      return true;
    }
    return backward ? $from.parentOffset === 0 : $from.parentOffset === $from.parent.content.size;
  }
  // A body paragraph cannot absorb the first note with forward deletion.
  if (!backward && $from.depth === 1 && $from.parentOffset === $from.parent.content.size) {
    return state.doc.resolve($from.after()).nodeAfter?.type.name === "footnote";
  }
  return false;
}

function arrowKey(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" || event.altKey || event.ctrlKey || event.metaKey) return false;
  const { state } = view;
  if (!(state.selection instanceof TextSelection) || !state.selection.empty && !event.shiftKey) return false;
  const forward = event.key === "ArrowRight";
  const range = footnoteRanges(state.doc).find((reference) =>
    forward ? reference.from === state.selection.head : reference.to === state.selection.head);
  if (range === undefined) return false;
  const head = forward ? range.to : range.from;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, event.shiftKey ? state.selection.anchor : head, head)).scrollIntoView());
  return true;
}

export const FootnoteEditing = Extension.create<{ decisionAnswer: () => boolean }>({
  name: "footnoteEditing",
  priority: 1200,
  addOptions: () => ({ decisionAnswer: () => false }),
  addProseMirrorPlugins() {
    const { decisionAnswer } = this.options;
    return [new Plugin({
      appendTransaction(_transactions, oldState, newState) {
        const selection = atomicSelection(newState, oldState);
        return selection === null ? null : newState.tr.setSelection(selection);
      },
      props: {
        transformPasted(slice, view) {
          if (inNote(view.state.selection.$from) && view.state.selection.$from.sameParent(view.state.selection.$to)) return notePaste(slice, view.state);
          return new Slice(referenceDestination(view.state, decisionAnswer())
            ? sanitizeReferences(slice.content) : withoutReferences(slice.content), slice.openStart, slice.openEnd);
        },
        handlePaste(view, event, slice) {
          if (!view.editable) return false;
          const { $from, $to } = view.state.selection;
          const plain = event.clipboardData?.getData("text/plain") ?? "";
          if (inNote($from) && $from.sameParent($to) && /[\r\n]/.test(plain)) {
            const text = plain.replace(/[\r\n]+/g, " ");
            view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.text(text), false).scrollIntoView());
            return true;
          }
          const range = deletionRange(view.state);
          if (range.from === view.state.selection.from && range.to === view.state.selection.to) return false;
          view.dispatch(view.state.tr.delete(range.from, range.to).replaceSelection(slice)
            .setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
          return true;
        },
        handleDrop(view, event, slice, moved) {
          if (!view.editable) return false;
          const target = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (target === null || !inNote(view.state.doc.resolve(target.pos))) return false;
          const range = deletionRange(view.state);
          if (moved && range.from <= target.pos && target.pos <= range.to) return true;
          const tr = view.state.tr;
          if (moved) tr.delete(range.from, range.to);
          const pos = tr.mapping.map(target.pos);
          const inline = notePaste(slice, view.state);
          tr.replaceRange(pos, pos, inline);
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + inline.content.size))
            .setMeta("uiEvent", "drop").scrollIntoView());
          return true;
        },
        handleKeyDown(view, event) {
          if (!view.editable || event.isComposing || view.composing) return false;
          if (arrowKey(view, event)) return true;
          if (event.key === "Enter" && selectionTouchesNote(view.state)) return true;
          if (event.key === "Backspace" || event.key === "Delete") return deleteKey(view, event.key === "Backspace");
          return false;
        },
        handleTextInput(view, from, to, text) {
          const range = deletionRange(view.state);
          if (range.from === from && range.to === to) return false;
          view.dispatch(view.state.tr.insertText(text, range.from, range.to).scrollIntoView());
          return true;
        },
        handleDOMEvents: {
          beforeinput(view, event) {
            if (!view.editable || event.isComposing || view.composing) return false;
            if ((event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") && selectionTouchesNote(view.state)) {
              event.preventDefault();
              return true;
            }
            if (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward" || event.inputType === "deleteByCut") {
              const handled = event.inputType === "deleteByCut" ? deleteSelection(view) : deleteKey(view, event.inputType === "deleteContentBackward");
              if (handled) event.preventDefault();
              return handled;
            }
            return false;
          },
          cut(view, event) {
            if (!view.editable || view.state.selection.empty || event.clipboardData === null) return false;
            const range = deletionRange(view.state);
            if (range.from === view.state.selection.from && range.to === view.state.selection.to) return false;
            const copied = view.serializeForClipboard(view.state.doc.slice(range.from, range.to));
            event.clipboardData.setData("text/html", copied.dom.innerHTML);
            event.clipboardData.setData("text/plain", copied.text);
            event.preventDefault();
            view.dispatch(view.state.tr.delete(range.from, range.to).setMeta("uiEvent", "cut").scrollIntoView());
            return true;
          },
        },
      },
    })];
  },
});
