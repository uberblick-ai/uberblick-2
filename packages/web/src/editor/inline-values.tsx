import { Extension } from "@tiptap/core";
import type { Mark, Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { COMMENT_MARK, acceptsFootnoteReferences, getMetaMap, parseValueSource, prepareValue, scanValueSources } from "@uberblick/schema";
import type { DocData, ValueConfig } from "@uberblick/schema";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type * as Y from "yjs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/shadcn/tooltip.js";
import { endUndoCapture } from "./blocks.js";
import { tableCellFormatter } from "./table-data.js";
import { bindDocView } from "./view-bindings.js";

export interface InlineValueRange { from: number; to: number; source: string; marks: readonly Mark[] }
const cached = new WeakMap<PMNode, InlineValueRange[]>();

function valueContext($pos: ResolvedPos): boolean {
  return $pos.depth === 1 && acceptsFootnoteReferences($pos.parent.type.name) ||
    $pos.depth === 4 && $pos.node(1).type.name === "table" &&
    ["tableCell", "tableHeader"].includes($pos.node(3).type.name) && $pos.parent.type.name === "paragraph";
}

function protectedText(marks: readonly Mark[]): boolean {
  // known limit: changed values show source text in history diffs; revisit when comparisons project whole values separately.
  return marks.some((mark) => mark.type.spec.code || ["link", "docLink", "revisionAdded", "removed"].includes(mark.type.name));
}

/** Values remain ordinary text; context and decorations supply their meaning. */
export function inlineValueRanges(doc: PMNode): InlineValueRange[] {
  const previous = cached.get(doc);
  if (previous !== undefined) return previous;
  const result: InlineValueRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return !node.type.spec.code;
    if (!valueContext(doc.resolve(pos + 1))) return false;
    const runs: { from: number; to: number; marks: readonly Mark[] }[] = [];
    let text = "";
    node.forEach((child, offset) => {
      text += child.isText && !protectedText(child.marks) ? child.text : "\ufffc".repeat(child.nodeSize);
      runs.push({ from: offset, to: offset + child.nodeSize, marks: child.marks });
    });
    for (const range of scanValueSources(text)) {
      const touched = runs.filter((run) => run.from < range.to && range.from < run.to);
      if (touched.some((run) => protectedText(run.marks))) continue;
      const marks = [...(touched[0]?.marks ?? [])].filter((mark) => mark.type.name !== "footnoteRef");
      for (const run of touched) for (const mark of run.marks) {
        if (mark.type.name === COMMENT_MARK && !marks.some((existing) => existing.eq(mark))) marks.push(mark);
      }
      result.push({ ...range, from: pos + 1 + range.from, to: pos + 1 + range.to, marks });
    }
    return false;
  });
  cached.set(doc, result);
  return result;
}

export function valueDescription(config: ValueConfig): string {
  const filter = Object.entries(config.filter).map(([field, value]) => `${field} = ${JSON.stringify(value)}`).join(", ");
  const format = config.format === "text" ? "" : `, ${config.format}`;
  const decimals = config.decimals === undefined ? "" : `, ${config.decimals} ${config.decimals === 1 ? "decimal" : "decimals"}`;
  const unit = config.unit ? `, ${config.unit}` : "";
  return `${config.collection} › ${filter} › ${config.field}${format}${decimals}${unit}`;
}

function ValueWidget({ text, description, state, selected, focus }: {
  text: string; description: string; state: string; selected: string | null; focus: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected !== null) setOpen(true);
    else if (trigger.current !== trigger.current?.ownerDocument.activeElement) setOpen(false);
  }, [selected]);
  return <TooltipProvider><Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger ref={trigger} type="button" className="ub-inline-value" data-value-state={state}
      aria-label={`${text} · ${description}`} title={description} onFocus={focus}>{text}</TooltipTrigger>
    <TooltipContent>{description}</TooltipContent>
  </Tooltip></TooltipProvider>;
}

function atomicSelection(state: EditorState, previous: EditorState): TextSelection | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection)) return null;
  let { anchor, head } = selection;
  const forward = anchor <= head;
  const ranges = inlineValueRanges(state.doc);
  const atHead = ranges.find((range) => range.from < head && head < range.to);
  if (selection.empty && atHead !== undefined) {
    const direction = head - previous.selection.head;
    const before = direction < 0 || direction === 0 && head - atHead.from < atHead.to - head;
    anchor = head = before ? atHead.from : atHead.to;
  } else if (!selection.empty) {
    const atAnchor = ranges.find((range) => range.from < anchor && anchor < range.to);
    if (atAnchor !== undefined) anchor = forward ? atAnchor.from : atAnchor.to;
    if (atHead !== undefined) head = forward ? atHead.to : atHead.from;
  }
  return anchor === selection.anchor && head === selection.head ? null : TextSelection.create(state.doc, anchor, head);
}

function deleteValue(view: EditorView, backward: boolean): boolean {
  const { selection } = view.state;
  const range = inlineValueRanges(view.state.doc).find((value) => selection.empty
    ? backward ? value.to === selection.head : value.from === selection.head
    : selection.from < value.to && value.from < selection.to);
  if (range === undefined) return false;
  endUndoCapture(view.state);
  view.dispatch((selection.empty ? view.state.tr.delete(range.from, range.to) : view.state.tr.deleteSelection()).scrollIntoView());
  endUndoCapture(view.state);
  return true;
}

export const InlineValues = Extension.create<{
  ydoc: Y.Doc | null; decisionAnswer: () => boolean;
}>({
  name: "uberblickInlineValues",
  // Protect source punctuation before ordinary formatting and typing shortcuts.
  priority: 1200,
  addOptions: () => ({ ydoc: null, decisionAnswer: () => false }),
  addProseMirrorPlugins() {
    const { ydoc, decisionAnswer } = this.options;
    const editor = this.editor;
    const enabled = (): boolean => !decisionAnswer() && (ydoc === null || getMetaMap(ydoc).get("kind") !== "decision");
    const mounts = new Map<HTMLElement, { root: Root; range: InlineValueRange; view: EditorView }>();
    let data: DocData | null = null;
    let readError: unknown;
    const refresh = (): void => {
      for (const [element, mount] of mounts) {
        const parsed = parseValueSource(mount.range.source);
        const projection = parsed.ok && readError !== undefined
          ? { status: "collection-unusable" as const, message: "Value collection cannot be read." }
          : prepareValue(mount.range.source, data);
        const cell = projection.status === "ready" ? tableCellFormatter(projection.config)(projection.record) : null;
        const text = projection.status === "ready" ? cell?.text ?? "" : projection.message;
        const description = parsed.ok ? valueDescription(parsed.config) : mount.range.source;
        const { selection } = mount.view.state;
        const touches = mount.view.hasFocus() && selection instanceof TextSelection && (selection.empty
          ? selection.head === mount.range.from || selection.head === mount.range.to
          : selection.from < mount.range.to && mount.range.from < selection.to);
        const selected = touches ? `${selection.anchor}:${selection.head}` : null;
        element.dataset.valueSource = mount.range.source;
        mount.root.render(<ValueWidget text={text} description={description} state={cell?.state ?? projection.status} selected={selected}
          focus={() => {
            mount.view.dispatch(mount.view.state.tr.setSelection(TextSelection.create(mount.view.state.doc, mount.range.from, mount.range.to)));
          }} />);
      }
    };
    return [new Plugin({
      appendTransaction(_transactions, oldState, state) {
        if (!enabled() || !editor.isEditable) return null;
        const selection = atomicSelection(state, oldState);
        return selection === null ? null : state.tr.setSelection(selection);
      },
      props: {
        decorations: (state) => {
          if (!enabled()) return DecorationSet.empty;
          const decorations: Decoration[] = [];
          for (const range of inlineValueRanges(state.doc)) {
            decorations.push(Decoration.inline(range.from, range.to, { class: "ub-inline-value-source", "aria-hidden": "true" }));
            decorations.push(Decoration.widget(range.to, (view) => {
              const element = view.dom.ownerDocument.createElement("span");
              element.className = "ub-inline-value-mount";
              element.contentEditable = "false";
              const root = createRoot(element);
              mounts.set(element, { root, range, view });
              element.addEventListener("mousedown", (event) => {
                if (!view.editable) return;
                event.preventDefault();
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
                view.focus();
                refresh();
              });
              refresh();
              return element;
            }, { side: -1, key: JSON.stringify([range.from, range.source, range.marks.map((mark) => mark.toJSON())]),
              marks: range.marks, stopEvent: (event) => !["keydown", "cut", "copy", "beforeinput"].includes(event.type), ignoreSelection: true,
              destroy: (node) => { const mount = mounts.get(node as HTMLElement); mounts.delete(node as HTMLElement); mount?.root.unmount(); },
            }));
          }
          return DecorationSet.create(state.doc, decorations);
        },
        handleTextInput(view, from, to, text, defaultTransaction) {
          if (!view.editable || view.composing) return false;
          const $from = view.state.doc.resolve(from);
          if (!valueContext($from) || !$from.sameParent(view.state.doc.resolve(to)) || protectedText(view.state.storedMarks ?? $from.marks())) return false;
          let unprotected = "";
          $from.parent.forEach((node) => {
            unprotected += node.isText && !protectedText(node.marks) ? node.text : "\ufffc".repeat(node.nodeSize);
          });
          const prefix = unprotected.slice(0, $from.parentOffset) + text;
          const source = scanValueSources(prefix, { includeIncomplete: true }).find((range) => range.to === prefix.length);
          if (source === undefined) return false;
          view.dispatch(defaultTransaction());
          return true;
        },
        handleKeyDown(view, event) {
          if (!view.editable || !enabled() || event.isComposing || view.composing) return false;
          const focused = event.target instanceof Element && event.target.closest(".ub-inline-value-mount");
          if (event.key === "Backspace" || event.key === "Delete") {
            const handled = deleteValue(view, event.key === "Backspace");
            if (handled && focused) view.focus();
            return handled;
          }
          if (!["ArrowLeft", "ArrowRight"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return false;
          const { selection } = view.state;
          if (focused && !event.shiftKey) {
            const head = event.key === "ArrowRight" ? selection.to : selection.from;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, head)).scrollIntoView());
            view.focus();
            return true;
          }
          if (!(selection instanceof TextSelection) || !selection.empty && !event.shiftKey) return false;
          const forward = event.key === "ArrowRight";
          const range = inlineValueRanges(view.state.doc).find((value) => forward ? value.from === selection.head : value.to === selection.head);
          if (range === undefined) return false;
          const head = forward ? range.to : range.from;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, event.shiftKey ? selection.anchor : head, head)).scrollIntoView());
          return true;
        },
        handleDOMEvents: {
          focus: () => { refresh(); return false; }, blur: () => { refresh(); return false; },
          beforeinput(view, event) {
            if (!view.editable || !enabled() || event.isComposing || view.composing) return false;
            if (event.inputType !== "deleteContentBackward" && event.inputType !== "deleteContentForward") return false;
            const handled = deleteValue(view, event.inputType === "deleteContentBackward");
            if (handled) event.preventDefault();
            return handled;
          },
          cut(view, event) {
            const { selection } = view.state;
            if (!view.editable || !enabled() || selection.empty || event.clipboardData === null ||
                !inlineValueRanges(view.state.doc).some((range) => selection.from < range.to && range.from < selection.to)) return false;
            const copied = view.serializeForClipboard(selection.content());
            event.clipboardData.setData("text/html", copied.dom.innerHTML);
            event.clipboardData.setData("text/plain", copied.text);
            event.preventDefault();
            endUndoCapture(view.state);
            view.dispatch(view.state.tr.deleteSelection().setMeta("uiEvent", "cut").scrollIntoView());
            endUndoCapture(view.state);
            view.focus();
            return true;
          },
        },
      },
      view(view) {
        let binding: ReturnType<typeof bindDocView> | null = null;
        const update = (): void => {
          const active = enabled() && inlineValueRanges(view.state.doc).length > 0;
          if (active && binding === null) {
            binding = bindDocView(ydoc, (next, error) => { data = next; readError = error; refresh(); });
            binding.schedule();
          } else if (!active && binding !== null) {
            binding.destroy(); binding = null; data = null; readError = undefined;
          }
          refresh();
        };
        update();
        return { update, destroy: () => { binding?.destroy(); } };
      },
    })];
  },
});
