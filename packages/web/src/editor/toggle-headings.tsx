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
  expanded: Set<string>;
}
const folds = new PluginKey<FoldState>("toggleHeadings");
type FoldAction = { positions: number[]; expanded: boolean };

function sections(doc: PMNode): Section[] {
  const result: Section[] = [];
  const open: Section[] = [];
  doc.forEach((node, pos) => {
    const heading = node.type.name === "heading";
    // A revision bar retains the section boundaries of the headings it replaced.
    const foldedLevel = node.type.name === "revisionFold" ? node.attrs.headingLevel : null;
    if (!heading && foldedLevel === null) return;
    const level = Number(heading ? node.attrs.level : foldedLevel);
    while (open.length > 0 && Number(open[open.length - 1]?.node.attrs.level) >= level) {
      const previous = open.pop();
      if (previous !== undefined) previous.to = pos;
    }
    if (!heading) return;
    const section = { node, pos, from: pos + node.nodeSize, to: doc.content.size };
    open.push(section);
    if (node.textContent.startsWith("> ")) result.push(section);
  });
  return result;
}

function containing(state: FoldState, pos: number): Section[] {
  return state.sections.filter((section) => !state.expanded.has(section.node.attrs.id) && section.from <= pos && pos < section.to);
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
  const near = Selection.near(state.doc.resolve(pos), direction);
  const fold = folds.getState(state);
  if (fold === undefined) return near;
  // A node selection can end at the document boundary, where near() searches
  // backward into its folded last block rather than finding visible content.
  const hidden = containing(fold, pos)[0] ?? containing(fold, near.head)[0];
  if (hidden === undefined) return near;
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

function syncTextSelection(view: EditorView): void {
  const dom = view.dom.ownerDocument.getSelection();
  if (!view.editable || !view.hasFocus() || !(view.state.selection instanceof TextSelection) || dom?.rangeCount !== 1 ||
    dom.anchorNode === null || dom.focusNode === null ||
    !view.dom.contains(dom.anchorNode) || !view.dom.contains(dom.focusNode)) return;
  // Node-view chrome can hold a native caret that ProseMirror deliberately ignores.
  for (const node of [dom.anchorNode, dom.focusNode]) {
    for (let element = node.nodeType === 1 ? node as HTMLElement : node.parentElement;
      element !== null && element !== view.dom; element = element.parentElement) {
      if (element.contentEditable === "false") return;
    }
  }
  // Native caret movement can precede selectionchange. Both deletion guards
  // must use the current caret, including Home's position before the widget.
  const $anchor = view.state.doc.resolve(view.posAtDOM(dom.anchorNode, dom.anchorOffset, 1));
  const $head = view.state.doc.resolve(view.posAtDOM(dom.focusNode, dom.focusOffset, 1));
  if (!$anchor.parent.inlineContent || !$head.parent.inlineContent) return;
  const selection = TextSelection.between($anchor, $head);
  if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection));
}

function deleteLeadingMarker(view: EditorView): boolean {
  const { selection } = view.state;
  const { $head } = selection;
  if (!view.editable || !selection.empty || $head.depth !== 1 || $head.parentOffset !== 0 ||
    $head.parent.type.name !== "heading" || !$head.parent.textContent.startsWith("> ")) return false;
  // Native Home can leave the DOM caret before the noneditable widget. Delete
  // must remove the literal character rather than deleting and restoring chrome.
  view.dispatch(view.state.tr.delete(selection.from, selection.from + 1));
  return true;
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
      const expanded = fold.expanded.has(section.node.attrs.id);
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
          const expanded = new Set<string>();
          const action = tr.getMeta(folds) as FoldAction | undefined;
          // Yjs peer edits and undo replace the whole ProseMirror document.
          // Block ids survive those replacements; mapped positions do not.
          for (const { node, pos } of nextSections) {
            const id = node.attrs.id;
            if (typeof id !== "string" || id === "") continue;
            if (action?.positions.includes(pos) ? action.expanded : previous.expanded.has(id)) expanded.add(id);
          }
          return { sections: nextSections, expanded };
        },
      },
      props: {
        handleKeyDown: (view, event) => {
          if ((event.key === "Delete" || event.key === "Backspace") && !event.isComposing) syncTextSelection(view);
          if (event.key === "Delete" && !event.altKey && !event.ctrlKey && !event.metaKey &&
            !event.shiftKey && !event.isComposing && deleteLeadingMarker(view)) return true;
          return (event.key === "Backspace" || event.key === "Delete") &&
            deletesFoldedNeighbor(view.state, event.key === "Delete");
        },
        handleDOMEvents: {
          beforeinput: (view, event) => {
            const input = event as InputEvent;
            if ((input.inputType === "deleteContentBackward" || input.inputType === "deleteContentForward") &&
              !input.isComposing) syncTextSelection(view);
            if (input.inputType === "deleteContentForward" && !input.isComposing && deleteLeadingMarker(view)) {
              event.preventDefault();
              return true;
            }
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
        if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
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
