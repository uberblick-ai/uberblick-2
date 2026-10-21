import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { normalizeFigmaLink } from "@uberblick/schema";
import { slashTriggerAt } from "./block-menu.js";
import { endUndoCapture, findBlockById } from "./blocks.js";
import type { SlashTrigger } from "./block-menu.js";

export interface FigmaDraft {
  blockId: string;
  mode: "replace" | "below";
  slot: HTMLDivElement;
}

const draftKey = new PluginKey<FigmaDraft | null>("figmaDraft");

export function currentFigmaDraft(editor: Editor): FigmaDraft | null {
  return draftKey.getState(editor.state) ?? null;
}

/** The placeholder is a view decoration, so invalid drafts never reach Yjs. */
export function startFigmaDraft(editor: Editor, blockId: string, trigger?: SlashTrigger): boolean {
  if (!editor.isEditable) return false;
  const found = findBlockById(editor.state.doc, blockId);
  if (found === null) return false;
  const live = trigger === undefined ? null : slashTriggerAt(editor);
  if (trigger !== undefined && (live?.blockId !== blockId || live.query !== trigger.query)) return false;
  const existing = currentFigmaDraft(editor);
  if (existing?.blockId === blockId && existing.mode === (trigger === undefined ? "below" : "replace")) {
    existing.slot.querySelector("input")?.focus();
    return true;
  }
  const slot = editor.view.dom.ownerDocument.createElement("div");
  slot.className = "ub-figma ub-block-frame";
  slot.dataset.figmaDraft = "true";
  slot.contentEditable = "false";
  const draft: FigmaDraft = { blockId, mode: trigger === undefined ? "below" : "replace", slot };
  const tr = editor.state.tr;
  if (trigger !== undefined) {
    endUndoCapture(editor.state);
    tr.delete(found.pos + 1, found.pos + 1 + found.node.content.size);
  }
  editor.view.dispatch(tr.setMeta(draftKey, { draft }));
  return true;
}

export function discardFigmaDraft(editor: Editor): void {
  if (editor.isDestroyed || currentFigmaDraft(editor) === null) return;
  editor.view.dispatch(editor.state.tr.setMeta(draftKey, { draft: null }));
}

interface FigmaValues {
  url: string;
  title: string | null;
  height: string | null;
}

function figmaNode(schema: Schema, values: FigmaValues, id: string | null): PMNode | null {
  const figma = schema.nodes.figma;
  const caption = schema.nodes.figmaCaption;
  const paragraph = schema.nodes.paragraph;
  if (figma === undefined || caption === undefined || paragraph === undefined) return null;
  return figma.create({ id, ...values }, caption.create(null, paragraph.create()));
}

export function commitFigmaDraft(editor: Editor, draft: FigmaDraft, values: FigmaValues): boolean {
  if (!editor.isEditable || currentFigmaDraft(editor) !== draft) return false;
  const found = findBlockById(editor.state.doc, draft.blockId);
  if (found === null) return false;
  const url = normalizeFigmaLink(values.url).url;
  const fresh = figmaNode(editor.schema, { ...values, url }, draft.mode === "replace" ? draft.blockId : null);
  if (fresh === null) return false;
  endUndoCapture(editor.state);
  const at = draft.mode === "replace" ? found.pos : found.pos + found.node.nodeSize;
  const tr = editor.state.tr;
  if (draft.mode === "replace") tr.replaceWith(at, at + found.node.nodeSize, fresh);
  else tr.insert(at, fresh);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)));
  editor.view.dispatch(tr.setMeta(draftKey, { draft: null }));
  endUndoCapture(editor.state);
  return true;
}

function draftDecorations(state: EditorState): DecorationSet | null {
  const draft = draftKey.getState(state);
  if (draft === undefined || draft === null) return null;
  const found = findBlockById(state.doc, draft.blockId);
  if (found === null) return null;
  const at = draft.mode === "replace" ? found.pos : found.pos + found.node.nodeSize;
  const decorations = [Decoration.widget(at, draft.slot, {
    key: `figma-draft:${draft.blockId}:${draft.mode}`, side: -1,
    stopEvent: () => true, ignoreSelection: true,
  })];
  if (draft.mode === "replace") decorations.push(Decoration.node(found.pos, found.pos + found.node.nodeSize, { style: "display: none" }));
  return DecorationSet.create(state.doc, decorations);
}

/** Keep paste and its conversion in separate Yjs undo captures. */
export function pasteFigmaLink(editor: Editor, source: string): boolean {
  const { selection } = editor.state;
  if (!editor.isEditable || !selection.empty || selection.$from.depth !== 1 ||
    selection.$from.parent.type.name !== "paragraph" || selection.$from.parent.content.size !== 0) return false;
  const text = source.trim();
  if (!/^https:\/\/\S+$/.test(text)) return false;
  let url: string;
  try { url = normalizeFigmaLink(text).url; } catch { return false; }
  const fresh = figmaNode(editor.schema, { url, title: null, height: null }, selection.$from.parent.attrs.id);
  if (fresh === null) return false;
  endUndoCapture(editor.state);
  const link = editor.schema.marks.link;
  const pasted = editor.schema.text(text, link === undefined ? [] : [link.create({ href: text })]);
  editor.view.dispatch(editor.state.tr.replaceSelectionWith(pasted, false).setMeta("paste", true).setMeta("uiEvent", "paste"));
  endUndoCapture(editor.state);
  const pos = editor.state.selection.$from.before(1);
  const paragraph = editor.state.doc.nodeAt(pos);
  if (paragraph === null) return false;
  const tr = editor.state.tr.replaceWith(pos, pos + paragraph.nodeSize, fresh);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 3)));
  editor.view.dispatch(tr);
  endUndoCapture(editor.state);
  return true;
}

export const FigmaCreation = Extension.create({
  name: "figmaCreation",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin<FigmaDraft | null>({
      key: draftKey,
      state: {
        init: () => null,
        apply(tr, previous) {
          const meta = tr.getMeta(draftKey) as { draft: FigmaDraft | null } | undefined;
          const draft = meta === undefined ? previous : meta.draft;
          if (draft === null) return null;
          const found = findBlockById(tr.doc, draft.blockId);
          if (found === null || (draft.mode === "replace" && (found.node.type.name !== "paragraph" || found.node.content.size !== 0))) return null;
          return draft;
        },
      },
      props: {
        decorations: draftDecorations,
        handlePaste: (_view, event) => pasteFigmaLink(editor, event.clipboardData?.getData("text/plain") ?? ""),
      },
    })];
  },
});
