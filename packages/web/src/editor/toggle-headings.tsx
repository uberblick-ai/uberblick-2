import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { Collapsible, CollapsibleTrigger } from "../ui/shadcn/collapsible.js";
import { Button } from "../ui/shadcn/button.js";

interface Section {
  pos: number;
  node: PMNode;
  from: number;
  to: number;
}
interface FoldState {
  sections: Section[];
  expanded: Set<number>;
}
const folds = new PluginKey<FoldState>("toggleHeadings");
type FoldAction = { positions: number[]; expanded: boolean };

function sections(doc: PMNode): Section[] {
  const result: Section[] = [];
  const open: Section[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level);
    while (open.length > 0 && Number(open[open.length - 1]?.node.attrs.level) >= level) {
      const previous = open.pop();
      if (previous !== undefined) previous.to = pos;
    }
    const section = { node, pos, from: pos + node.nodeSize, to: doc.content.size };
    open.push(section);
    if (node.textContent.startsWith("> ")) result.push(section);
  });
  return result;
}

function containing(state: FoldState, pos: number): Section[] {
  return state.sections.filter((section) => !state.expanded.has(section.pos) && section.from <= pos && pos < section.to);
}

function setExpanded(view: EditorView, positions: number[], expanded: boolean): void {
  const state = folds.getState(view.state);
  if (state === undefined) return;
  const tr = view.state.tr.setMeta(folds, { positions, expanded } satisfies FoldAction);
  if (!expanded) {
    const section = state.sections.find((candidate) => positions.includes(candidate.pos) &&
      (candidate.from <= tr.selection.head && tr.selection.head < candidate.to ||
        candidate.from <= tr.selection.anchor && tr.selection.anchor < candidate.to));
    if (section !== undefined) tr.setSelection(TextSelection.create(tr.doc, section.from - 1));
  }
  view.dispatch(tr.setMeta("addToHistory", false));
}

const views = new WeakMap<HTMLElement, EditorView>();

/** Reveal distributed flat blocks before an existing comment or presence action scrolls. */
export function revealFoldedTarget(target: HTMLElement): void {
  const editor = target.closest<HTMLElement>(".ProseMirror");
  const view = editor === null ? undefined : views.get(editor);
  if (view === undefined) return;
  const state = folds.getState(view.state);
  if (state === undefined) return;
  const positions = containing(state, view.posAtDOM(target, 0)).map((section) => section.pos);
  if (positions.length > 0) setExpanded(view, positions, true);
}

function visibleSelection(state: EditorState, pos: number, direction: number): Selection {
  const fold = folds.getState(state);
  if (fold === undefined) return Selection.near(state.doc.resolve(pos), direction);
  const hidden = containing(fold, pos)[0];
  if (hidden === undefined) return Selection.near(state.doc.resolve(pos), direction);
  if (direction > 0 && hidden.to < state.doc.content.size) {
    return Selection.near(state.doc.resolve(hidden.to), 1);
  }
  return TextSelection.create(state.doc, hidden.from - 1);
}

function deletesFoldedNeighbor(state: EditorState, forward: boolean): boolean {
  if (!state.selection.empty) return false;
  const { $head } = state.selection;
  if (!$head.parent.isTextblock || $head.depth !== 1 ||
    $head.parentOffset !== (forward ? $head.parent.content.size : 0)) return false;
  const fold = folds.getState(state);
  if (fold === undefined) return false;
  const neighbor = forward ? $head.after(1) : $head.before(1) - 1;
  return containing(fold, neighbor).length > 0;
}

export const ToggleHeadings = Extension.create({
  name: "uberblickToggleHeadings",
  addProseMirrorPlugins() {
    const mounts = new Map<HTMLElement, { root: Root; pos: () => number | undefined }>();
    const render = (view: EditorView, mount: { root: Root; pos: () => number | undefined }): void => {
      const pos = mount.pos();
      const fold = folds.getState(view.state);
      const section = fold?.sections.find((candidate) => pos !== undefined && candidate.pos === pos - 1);
      if (section === undefined || fold === undefined) return;
      const expanded = fold.expanded.has(section.pos);
      const label = section.node.textContent.slice(2).trim() || "section";
      // Content remains in ProseMirror's flat tree. Radix owns the trigger's
      // native activation and expanded state; decorations project visibility.
      mount.root.render(<Collapsible asChild open={expanded} onOpenChange={(open) => {
        const current = mount.pos();
        if (current !== undefined) setExpanded(view, [current - 1], open);
      }}><span><CollapsibleTrigger asChild
        aria-controls={undefined}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      ><Button variant="outline" size="icon" className="ub-toggle-heading-button">
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </Button></CollapsibleTrigger></span></Collapsible>);
    };
    return [new Plugin<FoldState>({
      key: folds,
      state: {
        init: (_config, state) => ({ sections: sections(state.doc), expanded: new Set() }),
        apply(tr, previous) {
          const nextSections = tr.docChanged ? sections(tr.doc) : previous.sections;
          const expanded = new Set<number>();
          for (const pos of previous.expanded) {
            const mapped = tr.mapping.mapResult(pos, 1);
            if (!mapped.deleted && nextSections.some((section) => section.pos === mapped.pos)) expanded.add(mapped.pos);
          }
          const action = tr.getMeta(folds) as FoldAction | undefined;
          for (const pos of action?.positions ?? []) {
            if (action?.expanded) expanded.add(pos);
            else expanded.delete(pos);
          }
          return { sections: nextSections, expanded };
        },
      },
      props: {
        handleKeyDown: (view, event) => {
          return (event.key === "Backspace" || event.key === "Delete") &&
            deletesFoldedNeighbor(view.state, event.key === "Delete");
        },
        handleDOMEvents: {
          beforeinput: (view, event) => {
            const input = event as InputEvent;
            if ((input.inputType === "deleteContentBackward" || input.inputType === "deleteContentForward") &&
              deletesFoldedNeighbor(view.state, input.inputType === "deleteContentForward")) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
        decorations: (state) => {
          const fold = folds.getState(state);
          if (fold === undefined) return null;
          const result: Decoration[] = [];
          state.doc.forEach((node, pos) => {
            if (containing(fold, pos).length > 0) result.push(Decoration.node(pos, pos + node.nodeSize, {
              "data-toggle-folded": "true", class: "ub-toggle-folded",
            }));
          });
          for (const section of fold.sections) {
            const { pos, node } = section;
            result.push(Decoration.node(pos, pos + node.nodeSize, { "data-toggle-heading": "true" }));
            const editing = this.editor.isEditable && this.editor.isFocused &&
              state.selection.$head.depth === 1 && state.selection.$head.before(1) === pos;
            if (!editing) result.push(Decoration.inline(pos + 1, pos + 3, {
              class: "ub-toggle-heading-marker", "aria-hidden": "true",
            }));
            result.push(Decoration.widget(pos + 1, (view, getPos) => {
              const dom = document.createElement("span");
              dom.className = "ub-toggle-heading-control";
              dom.contentEditable = "false";
              const mount = { root: createRoot(dom), pos: getPos };
              mounts.set(dom, mount);
              render(view, mount);
              return dom;
            }, {
              key: `toggle-heading:${node.attrs.id ?? pos}`, side: -1,
              stopEvent: () => true,
              ignoreSelection: true,
              destroy: (dom) => {
                const mount = mounts.get(dom as HTMLElement);
                mount?.root.unmount();
                mounts.delete(dom as HTMLElement);
              },
            }));
          }
          return DecorationSet.create(state.doc, result);
        },
      },
      appendTransaction(transactions, oldState, state) {
        if (!transactions.some((tr) => tr.selectionSet)) return null;
        const fold = folds.getState(state);
        if (fold === undefined) return null;
        const { head, anchor } = state.selection;
        if (containing(fold, head).length === 0 && containing(fold, anchor).length === 0) return null;
        const direction = head >= oldState.selection.head ? 1 : -1;
        const visibleHead = visibleSelection(state, head, direction);
        const visibleAnchor = visibleSelection(state, anchor, direction);
        const selection = state.selection.empty ? visibleHead
          : TextSelection.between(visibleAnchor.$anchor, visibleHead.$head);
        return state.tr.setSelection(selection).setMeta("addToHistory", false);
      },
      view: (view) => {
        views.set(view.dom, view);
        return {
          update: () => { for (const mount of mounts.values()) render(view, mount); },
          destroy: () => { views.delete(view.dom); },
        };
      },
    })];
  },
});
