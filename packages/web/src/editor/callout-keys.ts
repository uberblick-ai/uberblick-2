import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { endUndoCapture } from "./blocks.js";
import { retypeBlockInTransaction } from "./retype.js";

export const CalloutBlocks = Extension.create({
  name: "uberblickCalloutBlocks",
  // Caret menus pick first; callout line handling precedes core block splitting.
  priority: 1100,
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleKeyDown: (view, event) => {
          if (!this.editor.isEditable || event.isComposing || event.keyCode === 229 ||
            event.ctrlKey || event.altKey || event.metaKey) return false;
          const { selection } = view.state;
          const { $from, $to } = selection;
          if ($from.depth !== 1 || !$from.sameParent($to) || $from.parent.type.name !== "callout") return false;
          const block = $from.parent;
          const pos = $from.before(1);
          if (event.key === "Backspace" && !event.shiftKey) {
            if (!selection.empty || $from.parentOffset !== 0) return false;
            const tr = view.state.tr;
            if (!retypeBlockInTransaction(tr, pos, "paragraph")) return false;
            endUndoCapture(view.state);
            view.dispatch(tr.scrollIntoView());
            endUndoCapture(view.state);
            return true;
          }
          if (event.key !== "Enter") return false;
          const atEnd = selection.empty && $from.parentOffset === block.content.size;
          if (!event.shiftKey && atEnd && (block.content.size === 0 || block.textContent.endsWith("\n"))) {
            const paragraph = view.state.schema.nodes.paragraph;
            if (paragraph === undefined) return false;
            const tr = view.state.tr;
            if (block.content.size > 0) tr.delete(selection.from - 1, selection.from);
            const after = pos + (tr.doc.nodeAt(pos)?.nodeSize ?? block.nodeSize);
            tr.insert(after, paragraph.create({ id: null }));
            tr.setSelection(TextSelection.create(tr.doc, after + 1));
            endUndoCapture(view.state);
            view.dispatch(tr.scrollIntoView());
            endUndoCapture(view.state);
          } else {
            view.dispatch(view.state.tr.insertText("\n").scrollIntoView());
          }
          return true;
        },
      },
    })];
  },
});
