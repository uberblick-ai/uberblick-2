import { keymap } from "@tiptap/pm/keymap";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { endUndoCapture } from "./blocks.js";

function isChecklist(list: unknown): boolean {
  return list === "unchecked" || list === "checked";
}

function toggle(view: EditorView, pos: number, canEdit: () => boolean): boolean {
  const item = view.state.doc.nodeAt(pos);
  if (!canEdit() || item?.type.name !== "list-item" || !isChecklist(item.attrs.list)) return false;
  endUndoCapture(view.state);
  view.dispatch(view.state.tr.setNodeAttribute(pos, "list", item.attrs.list === "checked" ? "unchecked" : "checked"));
  endUndoCapture(view.state);
  return true;
}

/** View-only native markers; the document and clipboard retain flat list items. */
export function checklistPlugins(canEdit: () => boolean): Plugin[] {
  const mounts = new Map<HTMLElement, { input: HTMLInputElement; pos: () => number | undefined }>();
  const refresh = (view: EditorView): void => {
    for (const [label, mount] of mounts) {
      const pos = mount.pos();
      const item = pos === undefined || pos < 1 || pos > view.state.doc.content.size
        ? null : view.state.doc.nodeAt(pos - 1);
      mount.input.checked = item?.attrs.list === "checked";
      mount.input.disabled = !canEdit() || !isChecklist(item?.attrs.list);
      label.dataset.disabled = String(mount.input.disabled);
    }
  };
  return [keymap({
    "Mod-Enter": (_state, _dispatch, view) => {
      if (view === undefined) return false;
      const { selection } = view.state;
      return selection instanceof TextSelection && selection.empty && selection.$head.depth === 1
        ? toggle(view, selection.$head.before(1), canEdit) : false;
    },
  }), new Plugin({
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.forEach((node, pos) => {
          if (node.type.name !== "list-item" || !isChecklist(node.attrs.list)) return;
          decorations.push(Decoration.widget(pos + 1, (view, getPos) => {
            const label = view.dom.ownerDocument.createElement("label");
            label.className = "ub-checklist-control";
            label.contentEditable = "false";
            // Keep the text caret and editor undo bindings through native activation.
            label.addEventListener("mousedown", (event) => event.preventDefault());
            const input = view.dom.ownerDocument.createElement("input");
            input.type = "checkbox";
            input.tabIndex = -1;
            input.setAttribute("aria-label", "Checklist item");
            const apple = /Mac|iPad|iPhone/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
            input.title = `Toggle checklist item · ${apple ? "Cmd" : "Ctrl"}+Enter from the item`;
            input.setAttribute("aria-keyshortcuts", apple ? "Meta+Enter" : "Control+Enter");
            input.addEventListener("change", () => {
              const current = getPos();
              if (current !== undefined && view.dom.contains(input)) toggle(view, current - 1, canEdit);
              refresh(view);
            });
            label.append(input);
            mounts.set(label, { input, pos: getPos });
            refresh(view);
            return label;
          }, {
            key: `checklist:${node.attrs.id ?? pos}`, side: -1,
            stopEvent: () => true, ignoreSelection: true,
            destroy: (dom) => { mounts.delete(dom as HTMLElement); },
          }));
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
    view: (view) => ({ update: () => { refresh(view); } }),
  })];
}
