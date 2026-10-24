/** The tree is derived chrome; ProseMirror owns the ordinary code source. */
import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NodeView } from "@tiptap/pm/view";
import { formatJsonSource, parseJsonSource } from "@uberblick/schema";
import type { JsonSourceResult } from "@uberblick/schema";
import { ySyncPluginKey } from "y-prosemirror";
import { endUndoCapture } from "./blocks.js";
import {
  blockCaption, carriesComment, chromeFilters, codeBlockChrome, copyButton, selectedBlock,
} from "./source-chrome.js";
import { jsonTreePanel, jsonTreeViewState, span } from "./json-tree-panel.js";
import type { JsonTreeViewState } from "./json-tree-panel.js";
import { firstView, rootItem } from "./json-tree-rows.js";
import type { JsonTreeItem } from "./json-tree-rows.js";
import { openJsonTreeViewer } from "./json-tree-viewer.js";
import type { JsonTreeViewerHandle } from "./json-tree-viewer.js";

/** Re-render the tree this long after typing stops. */
const RENDER_DELAY = 200;
/** Say the JSON is invalid only once typing has paused this long. */
const NOTE_DELAY = 1500;
const editingKey = new PluginKey<boolean>("jsonTreeEditing");

/** What a reader opened, per block, for the life of the tab. */
const viewStates = new Map<string, JsonTreeViewState>();

function viewState(id: unknown): JsonTreeViewState {
  if (typeof id !== "string" || id === "") return jsonTreeViewState();
  let state = viewStates.get(id);
  if (state === undefined) {
    state = jsonTreeViewState();
    viewStates.set(id, state);
  }
  return state;
}

export function jsonTreeBlockView(): NodeViewRenderer {
  return jsonTreeNodeView;
}

function button(label: string, ariaLabel: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.setAttribute("aria-label", ariaLabel);
  return element;
}

/** The view's elements: the tree panel, and the source frame that holds contentDOM. */
function jsonTreeChrome(source: () => string, state: JsonTreeViewState) {
  const dom = document.createElement("div");
  dom.className = "ub-code ub-json-tree";
  const panel = document.createElement("div");
  panel.className = "ub-json-tree-panel";
  panel.contentEditable = "false";
  const tree = jsonTreePanel(state);
  const duplicates = span("ub-json-tree-note", "Some objects repeat a key; every occurrence is shown.");
  duplicates.hidden = true;
  const copy = copyButton(source).element;
  copy.setAttribute("aria-label", "Copy JSON");
  const edit = button("Edit", "Edit JSON");
  const expand = button("Expand", "Expand JSON tree");
  const toolbar = document.createElement("div");
  toolbar.className = "ub-figure-toolbar";
  toolbar.contentEditable = "false";
  toolbar.append(copy, edit, expand);
  panel.append(tree.element, toolbar, duplicates);

  const sourceFrame = document.createElement("div");
  sourceFrame.className = "ub-json-tree-source-frame ub-block-frame";
  const header = blockCaption("");
  const caption = span("ub-code-caption", "");
  caption.append(span("ub-code-caption-text", "JSON tree"));
  header.label.append(caption);
  const done = button("Done", "Done editing JSON");
  header.actions.append(done);
  const contentDOM = document.createElement("pre");
  contentDOM.className = "ub-json-tree-source";
  const note = document.createElement("p");
  note.className = "ub-json-tree-validity";
  note.contentEditable = "false";
  // No aria-live: a modal's aria-hidden pass walks into live regions, and that
  // would mark the source ProseMirror owns, which rebuilds this view.
  sourceFrame.append(header.row, contentDOM, note);
  dom.append(panel, sourceFrame);
  for (const control of [edit, done, expand]) control.addEventListener("mousedown", (event) => event.preventDefault());
  return { dom, panel, tree, duplicates, edit, expand, sourceFrame, header: header.row, done, contentDOM, note };
}

/** Replace the block's text with `text` and move the selection, as one undo step. */
function replaceSource(editor: NodeViewRendererProps["editor"], pos: number, node: PMNode, text: string | null, select: (doc: PMNode) => Selection): void {
  const transaction = editor.state.tr;
  if (text !== null) {
    endUndoCapture(editor.state);
    transaction.insertText(text, pos + 1, pos + 1 + node.content.size);
  }
  transaction.setSelection(select(transaction.doc));
  editor.view.dispatch(transaction);
  if (text !== null) endUndoCapture(editor.state);
}

function jsonTreeNodeView({ node, editor, getPos }: NodeViewRendererProps): NodeView {
  let current: PMNode = node;
  let parsed: JsonSourceResult = parseJsonSource(current.textContent);
  /** The last valid tree, kept for the next typing pause. */
  let shown: { root: JsonTreeItem; duplicates: boolean } | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  let viewer: JsonTreeViewerHandle | null = null;
  const chrome = jsonTreeChrome(() => current.textContent, viewState(node.attrs.id));
  const { dom, tree, note } = chrome;

  const editing = (): boolean => editingKey.getState(editor.state) === true && selectedBlock(editor.state, "code")?.pos === getPos();

  const syncDisplay = (): void => {
    const stale = shown !== null && (noteTimer !== null || editing());
    dom.dataset.json = parsed.ok ? "valid" : stale ? "stale" : "invalid";
  };

  const render = (): void => {
    if (parsed.ok && shown?.root.node !== parsed.value) {
      const root = rootItem(parsed.value);
      shown = { root, duplicates: parsed.duplicateKeys };
      tree.show(root, firstView(root));
      viewer?.update(root, editor.isEditable);
    }
    syncDisplay();
    chrome.duplicates.hidden = shown?.duplicates !== true;
  };

  const syncNote = (): void => {
    // Local and remote text edits share the pause; initially invalid source has no pending edit.
    note.textContent = parsed.ok || !editor.isEditable || noteTimer !== null ? ""
      : `Not valid JSON: line ${parsed.line}, column ${parsed.column} (${parsed.message})`;
  };
  const reparse = (): void => {
    if (renderTimer !== null) clearTimeout(renderTimer);
    renderTimer = null;
    parsed = parseJsonSource(current.textContent);
    render();
    syncNote();
  };

  /** Two-space text for valid JSON; null when unchanged or when a comment's anchors would move. */
  const formatted = (): string | null => {
    if (renderTimer !== null) reparse();
    if (!editor.isEditable || !parsed.ok || carriesComment(current)) return null;
    const text = formatJsonSource(parsed.value);
    return text === current.textContent ? null : text;
  };

  const startEditing = (): void => {
    const pos = getPos();
    if (!editor.isEditable || pos === undefined) return;
    replaceSource(editor, pos, current, formatted(), (doc) => TextSelection.near(doc.resolve(pos + 1)));
    editor.view.focus();
  };
  chrome.edit.addEventListener("click", (event) => { event.preventDefault(); startEditing(); });
  chrome.done.addEventListener("click", (event) => {
    event.preventDefault();
    const pos = getPos();
    if (pos === undefined) return;
    // Leave the source without editing the document further. A document holding
    // only this block has no text cursor outside it, so use its whole selection.
    replaceSource(editor, pos, current, formatted(), (doc) => {
      const size = doc.nodeAt(pos)?.nodeSize ?? 0;
      return Selection.findFrom(doc.resolve(pos + size), 1, true) ?? Selection.findFrom(doc.resolve(pos), -1, true) ?? new AllSelection(doc);
    });
    tree.focus();
  });

  const openViewer = (): void => {
    if (shown === null) return;
    viewer?.close();
    viewer = openJsonTreeViewer({
      root: shown.root, source: () => current.textContent, editable: editor.isEditable,
      openEdit: startEditing,
      returnFocus: () => { if (!dom.isConnected) return false; tree.focus(); return true; },
    });
  };
  chrome.expand.addEventListener("click", (event) => { event.preventDefault(); openViewer(); });
  // Touch has no hover toolbar: a tap on the tree opens the viewer.
  tree.element.addEventListener("click", (event) => {
    if ((event instanceof PointerEvent && event.pointerType === "touch") || matchMedia("(pointer: coarse)").matches) openViewer();
  });

  let wasEditing = false;
  const sync = (): void => {
    const isEditing = editing();
    if (wasEditing && !isEditing) {
      if (renderTimer !== null) reparse();
      // Leaving this view's source settles invalid text immediately.
      if (!parsed.ok) { shown = null; tree.show(null); render(); }
    }
    wasEditing = isEditing;
    codeBlockChrome.sync(current, dom);
    chrome.edit.hidden = !editor.isEditable;
    chrome.done.hidden = !editor.isEditable;
    dom.dataset.annotated = String(carriesComment(current));
    syncDisplay();
    syncNote();
  };
  editor.on("transaction", sync);
  editor.on("update", sync);
  sync();
  render();

  return {
    dom,
    contentDOM: chrome.contentDOM,
    update(updated: PMNode): boolean {
      if (updated.type !== current.type || updated.attrs.language !== "json-tree" || chrome.contentDOM.parentNode !== chrome.sourceFrame) return false;
      const changed = updated.textContent !== current.textContent;
      current = updated;
      if (changed) {
        if (renderTimer !== null) clearTimeout(renderTimer);
        renderTimer = setTimeout(reparse, RENDER_DELAY);
        // Every keystroke restarts the pause, so the note never flashes mid-word.
        if (noteTimer !== null) clearTimeout(noteTimer);
        noteTimer = setTimeout(() => {
          noteTimer = null;
          if (renderTimer !== null) reparse();
          syncDisplay();
          syncNote();
        }, NOTE_DELAY);
      }
      sync();
      return true;
    },
    // sync also runs on editor events, outside an update, so its attributes are chrome too.
    ...chromeFilters(dom, [chrome.panel, chrome.header, note], ["id", "data-language", "data-annotated", "data-json"]),
    destroy: () => {
      if (renderTimer !== null) clearTimeout(renderTimer);
      if (noteTimer !== null) clearTimeout(noteTimer);
      viewer?.close();
      editor.off("transaction", sync);
      editor.off("update", sync);
    },
  };
}

export const JsonTreeBlocks = Extension.create({
  name: "uberblickJsonTreeBlocks",
  addProseMirrorPlugins() {
    return [new Plugin<boolean>({
      key: editingKey,
      state: {
        init: () => false,
        apply(transaction, editing, oldState, state) {
          const block = selectedBlock(state, "code");
          if (block?.node.attrs.language !== "json-tree") return false;
          // Initial content and remote edits can put the default caret in this
          // block; only a local selection or edit opens its source.
          const sync = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
          const textChanged = transaction.docChanged && block.node.textContent !== selectedBlock(oldState, "code")?.node.textContent;
          return editing || (sync?.isChangeOrigin !== true && (transaction.selectionSet || textChanged));
        },
      },
      props: {
        decorations(state) {
          if (editingKey.getState(state) !== true) return null;
          const block = selectedBlock(state, "code");
          if (block === null) return null;
          return DecorationSet.create(state.doc, [Decoration.node(block.pos, block.pos + block.node.nodeSize, {
            class: "ub-json-tree-editing",
          })]);
        },
      },
    })];
  },
});
