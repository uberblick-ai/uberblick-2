/** The tree is derived chrome; ProseMirror owns the ordinary code source. */
import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, Selection, TextSelection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import { formatJsonSource, parseJsonSource } from "@uberblick/schema";
import type { JsonSourceNode, JsonSourceResult } from "@uberblick/schema";
import { toast } from "sonner";
import { endUndoCapture } from "./blocks.js";
import {
  blockCaption, carriesComment, chromeFilters, codeBlockChrome, copyButton, selectedBlock, sourceEditingPlugin, writeToClipboard,
} from "./source-chrome.js";
import {
  ROW_PAGE, firstView, foldable, itemCount, jsonTreeRows, rootItem, subtreePaths,
} from "./json-tree-rows.js";
import type { JsonTreeItem, JsonTreeRow } from "./json-tree-rows.js";

/** Re-render the tree this long after typing stops. */
const RENDER_DELAY = 200;
/** Say the JSON is invalid only once typing has paused this long. */
const NOTE_DELAY = 1500;

/** What a reader opened, per block, for the life of the tab; never document state. */
interface ViewState { open: Map<string, boolean>; wrapped: Set<string>; limit: number }
const viewStates = new Map<string, ViewState>();

function viewState(id: unknown): ViewState {
  const fresh = (): ViewState => ({ open: new Map(), wrapped: new Set(), limit: ROW_PAGE });
  if (typeof id !== "string" || id === "") return fresh();
  let state = viewStates.get(id);
  if (state === undefined) {
    state = fresh();
    viewStates.set(id, state);
  }
  return state;
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function scalar(node: JsonSourceNode): HTMLSpanElement {
  switch (node.kind) {
    case "string": return span("ub-json-string", node.raw);
    case "number": return span("ub-json-number", node.raw);
    case "boolean": return span("ub-json-literal", String(node.value));
    case "null": return span("ub-json-literal", "null");
    case "object": return span("ub-json-punct", "{}");
    case "array": return span("ub-json-punct", "[]");
  }
}

function preview(item: JsonTreeItem): HTMLSpanElement {
  const element = span("ub-json-preview", " … ");
  // Array items have no key to tell them apart, so they show their first scalar.
  if (item.type !== "value" || item.node.kind !== "object" || typeof item.key !== "number") return element;
  const first = item.node.entries.find((entry) => !["object", "array"].includes(entry.value.kind));
  if (first === undefined) return element;
  element.replaceChildren(" ", span("ub-json-key", first.rawKey), span("ub-json-punct", ": "), scalar(first.value), span("ub-json-punct", ", … "));
  return element;
}

function brackets(item: JsonTreeItem): [string, string] {
  return item.type === "value" && item.node.kind === "object" ? ["{", "}"] : ["[", "]"];
}

/** The JSON a row's Copy value writes. */
function valueText(item: JsonTreeItem): string {
  return item.type === "group"
    ? formatJsonSource({ ...item.node, items: item.node.items.slice(item.start, item.end) })
    : formatJsonSource(item.node);
}

function closeRow(element: HTMLElement, item: JsonTreeItem, comma: boolean): HTMLElement {
  element.append(span("ub-json-punct", `${brackets(item)[1]}${comma ? "," : ""}`));
  return element;
}

function rowElement(row: JsonTreeRow, open: boolean, wrapped: boolean): HTMLElement {
  const element = document.createElement("div");
  element.className = "ub-json-row";
  element.style.setProperty("--json-depth", String(row.depth));
  if (row.form === "more") {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ub-json-more";
    more.textContent = "Show more";
    element.append(more);
    return element;
  }
  const { item } = row;
  element.dataset.form = row.form;
  if (row.form === "close") return closeRow(element, item, row.comma);
  element.dataset.path = item.path;
  element.setAttribute("role", "treeitem");
  element.setAttribute("aria-level", String(row.depth + 1));
  element.tabIndex = -1;
  if (foldable(item)) {
    element.setAttribute("aria-expanded", String(open));
    const toggle = span("ub-json-toggle", open ? "▾" : "▸");
    toggle.setAttribute("aria-hidden", "true");
    element.append(toggle);
  }
  if (item.type === "group") element.append(span("ub-json-group", `${item.path.slice(item.path.lastIndexOf("["))} `));
  else if (item.rawKey !== undefined) element.append(span("ub-json-key", item.rawKey), span("ub-json-punct", ": "));
  if (row.form === "leaf") {
    if (wrapped) element.dataset.wrapped = "true";
    element.append(scalar(item.node));
  } else if (row.form === "open") {
    element.append(span("ub-json-punct", brackets(item)[0]));
    return element;
  } else {
    const [start, end] = brackets(item);
    element.append(span("ub-json-punct", start), preview(item), span("ub-json-punct", end));
  }
  if (row.comma) element.append(span("ub-json-punct", ","));
  if (row.form === "closed") element.append(span("ub-json-count", itemCount(item)));
  return element;
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
function jsonTreeChrome(source: () => string) {
  const dom = document.createElement("div");
  dom.className = "ub-code ub-json-tree";
  const panel = document.createElement("div");
  panel.className = "ub-json-tree-panel";
  panel.contentEditable = "false";
  const tree = document.createElement("div");
  tree.className = "ub-json-tree-rows";
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "JSON tree");
  const duplicates = span("ub-json-tree-note", "Some objects repeat a key; every occurrence is shown.");
  duplicates.hidden = true;
  const copy = copyButton(source).element;
  copy.setAttribute("aria-label", "Copy JSON");
  const edit = button("Edit", "Edit JSON");
  const toolbar = document.createElement("div");
  toolbar.className = "ub-figure-toolbar";
  toolbar.contentEditable = "false";
  toolbar.append(copy, edit);
  panel.append(tree, toolbar, duplicates);

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
  note.setAttribute("aria-live", "polite");
  sourceFrame.append(header.row, contentDOM, note);
  dom.append(panel, sourceFrame);
  for (const control of [edit, done]) control.addEventListener("mousedown", (event) => event.preventDefault());
  return { dom, panel, tree, duplicates, edit, sourceFrame, header: header.row, done, contentDOM, note };
}

/** ARIA tree keys: arrows move and fold, Home and End jump, Enter and Space toggle. */
function treeKeys(tree: HTMLElement, toggle: (path: string, subtree: boolean) => void, focused: (path: string) => void) {
  return (event: KeyboardEvent): void => {
    const elements = [...tree.querySelectorAll<HTMLElement>(".ub-json-row[role=treeitem]")];
    const index = elements.indexOf(document.activeElement as HTMLElement);
    const element = elements[index];
    if (element === undefined) return;
    const path = element.dataset.path ?? "";
    const expanded = element.getAttribute("aria-expanded");
    const move = (to: number): void => {
      const next = elements[Math.max(0, Math.min(elements.length - 1, to))];
      if (next === undefined) return;
      element.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      focused(next.dataset.path ?? "");
    };
    const level = (candidate: HTMLElement): number => Number(candidate.getAttribute("aria-level"));
    switch (event.key) {
      case "ArrowDown": move(index + 1); break;
      case "ArrowUp": move(index - 1); break;
      case "Home": move(0); break;
      case "End": move(elements.length - 1); break;
      case "ArrowRight":
        if (expanded === "false") toggle(path, false);
        else if (expanded === "true") move(index + 1);
        break;
      case "ArrowLeft":
        if (expanded === "true") toggle(path, false);
        else {
          const parent = elements.slice(0, index).findLastIndex((candidate) => level(candidate) < level(element));
          if (parent >= 0) move(parent);
        }
        break;
      case "Enter":
      case " ":
        if (expanded !== null) toggle(path, event.altKey);
        break;
      default: return;
    }
    event.preventDefault();
  };
}

/** One Copy value button follows the row under the pointer or focus. */
function followingCopyValue(tree: HTMLElement, itemAt: (path: string) => JsonTreeItem | null): void {
  const copyValue = button("Copy value", "Copy this value");
  copyValue.className = "ub-json-copy-value";
  copyValue.tabIndex = -1;
  const place = (row: HTMLElement | null): void => {
    if (row === null || row.dataset.form === "close" || row.dataset.path === undefined) { copyValue.remove(); return; }
    copyValue.dataset.path = row.dataset.path;
    if (copyValue.parentElement !== row) row.append(copyValue);
  };
  tree.addEventListener("mouseover", (event) => {
    place(event.target instanceof Element ? event.target.closest<HTMLElement>(".ub-json-row") : null);
  });
  tree.addEventListener("mouseleave", () => { if (!tree.contains(document.activeElement)) copyValue.remove(); });
  tree.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement && event.target.classList.contains("ub-json-row")) place(event.target);
  });
  copyValue.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const item = itemAt(copyValue.dataset.path ?? "");
    if (item === null) return;
    void writeToClipboard(valueText(item)).then((copied) => {
      toast[copied ? "success" : "error"](copied ? "Value copied" : "Couldn't copy the value.", { id: "clipboard" });
    });
  });
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
  /** The last valid tree, kept while the text is invalid. */
  let shown: { root: JsonTreeItem; defaults: Set<string>; duplicates: boolean } | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  let rows: JsonTreeRow[] = [];
  let active = "";
  const state = viewState(node.attrs.id);
  const chrome = jsonTreeChrome(() => current.textContent);
  const { dom, tree, note } = chrome;

  const editing = (): boolean => selectedBlock(editor.state, "code")?.pos === getPos();
  const isOpen = (path: string): boolean => state.open.get(path) ?? shown?.defaults.has(path) ?? false;

  const render = (): void => {
    if (parsed.ok && shown?.root.node !== parsed.value) {
      const root = rootItem(parsed.value);
      shown = { root, defaults: firstView(root), duplicates: parsed.duplicateKeys };
    }
    dom.dataset.json = parsed.ok ? "valid" : shown === null ? "invalid" : "stale";
    chrome.duplicates.hidden = shown?.duplicates !== true;
    if (shown === null) { tree.replaceChildren(); return; }
    const hadFocus = tree.contains(document.activeElement);
    rows = jsonTreeRows(shown.root, isOpen, state.limit);
    const elements = rows.map((row) => row.form === "more" ? rowElement(row, false, false)
      : rowElement(row, isOpen(row.item.path), row.form === "leaf" && state.wrapped.has(row.item.path)));
    tree.replaceChildren(...elements);
    const focusable = elements.find((element) => element.dataset.path === active && element.hasAttribute("role"))
      ?? elements.find((element) => element.hasAttribute("role"));
    if (focusable === undefined) return;
    focusable.tabIndex = 0;
    if (hadFocus) focusable.focus({ preventScroll: true });
  };

  const showNote = (): void => {
    note.textContent = parsed.ok ? "" : `Not valid JSON: line ${parsed.line}, column ${parsed.column} (${parsed.message})`;
  };
  const syncNote = (): void => {
    // Typing is debounced into calm; an invalid block nobody is editing says so at once.
    if (parsed.ok) note.textContent = "";
    else if (!editing() && editor.isEditable) showNote();
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

  chrome.edit.addEventListener("click", (event) => {
    event.preventDefault();
    const pos = getPos();
    if (!editor.isEditable || pos === undefined) return;
    replaceSource(editor, pos, current, formatted(), (doc) => TextSelection.near(doc.resolve(pos + 1)));
    editor.view.focus();
  });
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
    (tree.querySelector<HTMLElement>('[tabindex="0"]') ?? tree).focus({ preventScroll: true });
  });

  const itemAt = (path: string): JsonTreeItem | null => {
    for (const row of rows) if (row.form !== "more" && row.item.path === path) return row.item;
    return null;
  };
  const toggle = (path: string, subtree: boolean): void => {
    const item = itemAt(path);
    if (item === null || !foldable(item)) return;
    const next = !isOpen(path);
    for (const each of subtree ? subtreePaths(item) : [path]) state.open.set(each, next);
    active = path;
    render();
  };

  tree.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".ub-json-more") != null) { state.limit += ROW_PAGE; render(); return; }
    const row = target?.closest<HTMLElement>(".ub-json-row[data-path]");
    if (row == null) return;
    const path = row.dataset.path ?? "";
    active = path;
    if (row.dataset.form === "leaf" && target?.closest(".ub-json-string") != null) {
      if (!state.wrapped.delete(path)) state.wrapped.add(path);
      render();
    } else if (row.dataset.form === "open" || row.dataset.form === "closed") toggle(path, event.altKey);
  });
  tree.addEventListener("keydown", treeKeys(tree, toggle, (path) => { active = path; }));
  followingCopyValue(tree, itemAt);

  const sync = (): void => {
    codeBlockChrome.sync(current, dom);
    chrome.edit.hidden = !editor.isEditable;
    chrome.done.hidden = !editor.isEditable;
    dom.dataset.annotated = String(carriesComment(current));
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
          showNote();
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
      editor.off("transaction", sync);
      editor.off("update", sync);
    },
  };
}

export const JsonTreeBlocks = Extension.create({
  name: "uberblickJsonTreeBlocks",
  addProseMirrorPlugins() { return [sourceEditingPlugin("code", "ub-json-tree-editing")]; },
});
