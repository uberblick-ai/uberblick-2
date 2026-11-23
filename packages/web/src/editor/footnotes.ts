import { Extension } from "@tiptap/core";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { COMMENT_MARK, acceptsFootnoteReferences, footnoteReferences } from "@uberblick/schema";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import type { ProsemirrorBinding } from "y-prosemirror";
import type * as Y from "yjs";
import { revealFoldedTarget } from "./toggle-headings.js";

export interface FootnoteReference {
  from: number;
  to: number;
  label: string;
  number: number;
  key: string;
  marks: readonly Mark[];
  fold?: number;
}

export interface FootnoteNote {
  pos: number;
  node: PMNode;
  label: string;
  number?: number;
  references: FootnoteReference[];
  key: string;
  fold?: number;
}

const indices = new WeakMap<PMNode, { references: FootnoteReference[]; notes: FootnoteNote[] }>();

/** Derived projection; labels and literal reference characters stay in the document. */
export function footnoteIndex(doc: PMNode): { references: FootnoteReference[]; notes: FootnoteNote[] } {
  const cached = indices.get(doc);
  if (cached !== undefined) return cached;
  const references: FootnoteReference[] = [];
  const notes: FootnoteNote[] = [];
  const numbers = new Map<string, number>();
  const scan = (node: PMNode, pos: number, blockKey: string, fold?: number): void => {
    if (node.type.name === "footnote") {
      notes.push({ pos, node, label: String(node.attrs.label), references: [], key: blockKey, ...(fold === undefined ? {} : { fold }) });
      return;
    }
    if (!acceptsFootnoteReferences(node.type.name)) return;
    const runs: { from: number; to: number; marks: readonly Mark[] }[] = [];
    let text = "";
    node.forEach((child, offset) => {
      const marked = child.isText && child.marks.some((mark) => mark.type.name === "footnoteRef") &&
        !child.marks.some((mark) => mark.type.spec.code || mark.type.name === "link" || mark.type.name === "docLink");
      text += marked ? child.text : "\ufffc".repeat(child.nodeSize);
      runs.push({ from: offset, to: offset + child.nodeSize, marks: child.marks });
    });
    for (const range of footnoteReferences(text)) {
      const touched = runs.filter((run) => run.from < range.to && range.from < run.to);
      if (touched.length === 0 || touched.some((run) => !run.marks.some((mark) => mark.type.name === "footnoteRef") ||
        run.marks.some((mark) => mark.type.spec.code || mark.type.name === "link" || mark.type.name === "docLink"))) continue;
      const label = range.label.toLowerCase();
      const number = numbers.get(label) ?? numbers.size + 1;
      numbers.set(label, number);
      const marks = [...(touched[0]?.marks ?? [])].filter((mark) => mark.type.name !== "footnoteRef");
      for (const run of touched) {
        for (const mark of run.marks) {
          if (mark.type.name === COMMENT_MARK && !marks.some((existing) => existing.eq(mark))) marks.push(mark);
        }
      }
      references.push({ from: pos + 1 + range.from, to: pos + 1 + range.to, label: range.label, number,
        key: `${blockKey}:${range.from}`, marks, ...(fold === undefined ? {} : { fold }) });
    }
  };
  // known limit: moving references leaves notes in stored order; revisit when automatic note ordering is required.
  doc.forEach((node, pos, index) => {
    if (node.type.name === "revisionFold") {
      const hidden = node.attrs.footnoteBlocks as readonly Record<string, unknown>[];
      for (const [offset, json] of (hidden ?? []).entries()) {
        const child = doc.type.schema.nodeFromJSON(json);
        scan(child, pos, String(child.attrs.id ?? `fold-${node.attrs.run}-${offset}`), Number(node.attrs.run));
      }
    } else scan(node, pos, String(node.attrs.id ?? index));
  });
  const byLabel = new Map<string, FootnoteReference[]>();
  for (const reference of references) {
    const label = reference.label.toLowerCase();
    const matching = byLabel.get(label) ?? [];
    matching.push(reference);
    byLabel.set(label, matching);
  }
  const seen = new Set<string>();
  for (const note of notes) {
    const label = note.label.toLowerCase();
    if (seen.has(label)) continue;
    seen.add(label);
    note.references = byLabel.get(label) ?? [];
    const number = numbers.get(label);
    if (note.references.length > 0 && number !== undefined) note.number = number;
  }
  const index = { references, notes };
  indices.set(doc, index);
  return index;
}

export function footnoteRanges(doc: PMNode): FootnoteReference[] {
  return footnoteIndex(doc).references.filter((reference) => reference.fold === undefined);
}

let nextView = 0;

function referenceHint(element: HTMLAnchorElement, number: number, editable: boolean): void {
  element.title = `Footnote ${number}`;
  if (!editable) return;
  const apple = /Mac|iPad|iPhone/.test(element.ownerDocument.defaultView?.navigator.platform ?? "");
  element.title += ` · ${apple ? "Cmd" : "Ctrl"}+Enter beside the reference`;
  element.setAttribute("aria-keyshortcuts", apple ? "Meta+Enter" : "Control+Enter");
}

function footnoteGlyph(owner: Document, text: string): HTMLSpanElement {
  const glyph = owner.createElement("span");
  glyph.className = "ub-footnote-glyph";
  glyph.textContent = text;
  return glyph;
}

export const Footnotes = Extension.create<{ history: boolean }>({
  name: "uberblickFootnotes",
  priority: 2500,
  addOptions: () => ({ history: false }),
  addProseMirrorPlugins() {
    const prefix = `ub-footnote-${nextView++}`;
    const returns = new Map<string, { key: string; from: number; to: number; relative?: Y.RelativePosition }>();
    const canEdit = (): boolean => this.editor.isEditable;
    const binding = (view: EditorView): ProsemirrorBinding | undefined =>
      (ySyncPluginKey.getState(view.state) as { binding?: ProsemirrorBinding } | undefined)?.binding;
    const referenceId = (key: string): string => `${prefix}-ref-${encodeURIComponent(key)}`;
    const noteId = (key: string): string => `${prefix}-note-${encodeURIComponent(key)}`;
    const follow = (view: EditorView, key: string, kind: "note" | "reference", origin?: string): boolean => {
      let model = footnoteIndex(view.state.doc);
      let target = kind === "note" ? model.notes.find((note) => note.key === key) : model.references.find((reference) => reference.key === key);
      if (target === undefined) return false;
      if (target.fold !== undefined) {
        view.dom.querySelector<HTMLButtonElement>(`.ub-revision-fold-button[data-fold="${target.fold}"]`)?.click();
        model = footnoteIndex(view.state.doc);
        target = kind === "note" ? model.notes.find((note) => note.key === key) : model.references.find((reference) => reference.key === key);
        if (target === undefined || target.fold !== undefined) return false;
      }
      if (kind === "note" && origin !== undefined) {
        const reference = model.references.find((entry) => entry.key === origin);
        if (reference !== undefined) {
          const sync = binding(view);
          returns.set(key, { key: origin, from: reference.from, to: reference.to,
            ...(sync === undefined ? {} : { relative: absolutePositionToRelativePosition(reference.from + 1, sync.type, sync.mapping) as Y.RelativePosition }) });
        }
      }
      const element = view.dom.ownerDocument.getElementById(kind === "note" ? noteId(key) : referenceId(key));
      if (!(element instanceof HTMLElement) || !view.dom.contains(element)) return false;
      revealFoldedTarget(element);
      element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (canEdit()) {
        const position = "pos" in target ? target.pos + 1 : target.to;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)).scrollIntoView());
        view.focus();
      } else {
        const backlink = origin === undefined ? ".ub-footnote-backlink" : `.ub-footnote-backlink[href="#${referenceId(origin)}"]`;
        const link = kind === "note" ? element.parentElement?.querySelector<HTMLElement>(backlink) : element;
        link?.focus({ preventScroll: true });
      }
      return true;
    };
    const atCaret = (view: EditorView): boolean => {
      const { selection } = view.state;
      if (!(selection instanceof TextSelection) || !selection.empty) return false;
      const model = footnoteIndex(view.state.doc);
      const reference = model.references.find((entry) => entry.fold === undefined && entry.from <= selection.head && selection.head <= entry.to);
      if (reference !== undefined) {
        const note = model.notes.find((entry) => entry.number === reference.number);
        return note === undefined ? false : follow(view, note.key, "note", reference.key);
      }
      const note = model.notes.find((entry) => entry.fold === undefined && entry.pos < selection.head && selection.head < entry.pos + entry.node.nodeSize);
      if (note === undefined) return false;
      const origin = returns.get(note.key);
      const sync = binding(view);
      const absolute = origin?.relative === undefined || sync === undefined ? null
        : relativePositionToAbsolutePosition(sync.doc, sync.type, origin.relative, sync.mapping);
      const back = note.references.find((entry) => absolute === null ? entry.key === origin?.key : entry.from < absolute && absolute < entry.to)
        ?? note.references[0];
      return back === undefined ? false : follow(view, back.key, "reference");
    };
    const shortcut = (view: EditorView, event: KeyboardEvent): boolean => {
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing) return false;
      if (event.target instanceof Element && event.target.closest(".ub-footnote-reference, .ub-footnote-backlink") !== null) return false;
      const apple = /Mac|iPad|iPhone/.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? "");
      const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      return (canEdit() ? mod : this.options.history && !event.metaKey && !event.ctrlKey) && atCaret(view);
    };
    return [new Plugin({
      state: {
        init: () => null,
        apply(transaction) {
          if (transaction.docChanged && returns.size > 0) {
            const references = footnoteRanges(transaction.doc);
            for (const [key, origin] of returns) {
              if (origin.relative !== undefined) continue;
              const from = transaction.mapping.map(origin.from, 1);
              const to = transaction.mapping.map(origin.to, -1);
              const reference = references.find((entry) => entry.from === from && entry.to === to);
              if (reference === undefined) returns.delete(key);
              else returns.set(key, { key: reference.key, from, to });
            }
          }
          return null;
        },
      },
      props: {
        handleKeyDown: shortcut,
        decorations(state) {
          const { references, notes } = footnoteIndex(state.doc);
          const result: Decoration[] = [];
          for (const reference of references) {
            if (reference.fold !== undefined) continue;
            const note = notes.find((entry) => entry.number === reference.number);
            result.push(Decoration.inline(reference.from, reference.to, { class: "ub-footnote-source", "aria-hidden": "true" }));
            result.push(Decoration.widget(reference.to, (view) => {
              const element = view.dom.ownerDocument.createElement(note === undefined ? "span" : "a");
              element.className = `ub-footnote-reference${note === undefined ? " ub-footnote-unmatched" : ""}`;
              element.id = referenceId(reference.key);
              element.dataset.footnoteNumber = String(reference.number);
              element.dataset.footnoteLabel = reference.label;
              element.contentEditable = "false";
              element.append(footnoteGlyph(view.dom.ownerDocument, `${reference.number}${note === undefined ? "?" : ""}`));
              element.setAttribute("aria-label", `Footnote ${reference.number}${note === undefined ? ": note missing" : ""}`);
              if (element instanceof HTMLAnchorElement && note !== undefined) {
                element.href = `#${noteId(note.key)}`;
                element.tabIndex = canEdit() ? -1 : 0;
                referenceHint(element, reference.number, canEdit());
                element.addEventListener("mousedown", (event) => { if (canEdit()) event.preventDefault(); });
                element.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); follow(view, note.key, "note", reference.key); });
              }
              return element;
            }, { side: -1, key: `footnote-ref:${reference.key}:${reference.number}:${note?.key ?? "missing"}:${canEdit()}`,
              marks: reference.marks, stopEvent: () => true, ignoreSelection: true }));
          }
          let trailing = state.doc.content.size;
          for (let index = state.doc.childCount - 1; index >= 0; index -= 1) {
            const node = state.doc.child(index);
            if (node.type.name !== "footnote") break;
            trailing -= node.nodeSize;
          }
          for (const note of notes) {
            if (note.fold !== undefined) continue;
            if (note.pos === trailing) result.push(Decoration.node(note.pos, note.pos + note.node.nodeSize, { class: "ub-footnotes-start" }));
            result.push(Decoration.widget(note.pos + 1, (view) => {
              const element = view.dom.ownerDocument.createElement("span");
              element.className = note.number === undefined ? "ub-footnote-unused" : "ub-footnote-number";
              element.id = noteId(note.key);
              element.contentEditable = "false";
              element.textContent = note.number === undefined ? `${note.label} · unused ` : `${note.number} `;
              element.setAttribute("aria-label", note.number === undefined ? `Unused footnote ${note.label}` : `Footnote ${note.number}`);
              return element;
            }, { side: -1, key: `footnote-note:${note.key}:${note.number ?? "unused"}`, stopEvent: () => true, ignoreSelection: true }));
            note.references.forEach((reference, index) => {
              result.push(Decoration.widget(note.pos + note.node.nodeSize - 1, (view) => {
                const element = view.dom.ownerDocument.createElement("a");
                element.className = "ub-footnote-backlink";
                element.contentEditable = "false";
                element.href = `#${referenceId(reference.key)}`;
                element.tabIndex = canEdit() ? -1 : 0;
                element.append(footnoteGlyph(view.dom.ownerDocument, note.references.length === 1 ? "↩" : `↩ ${index < 26 ? String.fromCharCode(97 + index) : index + 1}`));
                element.setAttribute("aria-label", `Back to footnote ${reference.number} reference ${index + 1}`);
                element.addEventListener("mousedown", (event) => { if (canEdit()) event.preventDefault(); });
                element.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); follow(view, reference.key, "reference"); });
                return element;
              }, { side: 1, key: `footnote-back:${note.key}:${reference.key}:${index}:${note.references.length}:${canEdit()}`,
                stopEvent: () => true, ignoreSelection: true }));
            });
          }
          return DecorationSet.create(state.doc, result);
        },
      },
    })];
  },
});
