/** The interactive tree a json-tree block and its full-screen viewer share. */
import { formatJsonSource } from "@uberblick/schema";
import type { JsonSourceNode } from "@uberblick/schema";
import { toast } from "sonner";
import { writeToClipboard } from "./source-chrome.js";
import { ROW_PAGE, children, foldable, itemCount, jsonTreeRows, subtreePaths } from "./json-tree-rows.js";
import type { JsonTreeItem, JsonTreeRow } from "./json-tree-rows.js";

/** What a reader opened; never document state. */
export interface JsonTreeViewState {
  open: Map<string, boolean>;
  wrapped: Set<string>;
  limit: number;
  /** Where a path without a choice of its own stands: the first view, everything, or the root alone. */
  fallback: "first" | "all" | "root";
}

export function jsonTreeViewState(fallback: JsonTreeViewState["fallback"] = "first"): JsonTreeViewState {
  return { open: new Map(), wrapped: new Set(), limit: ROW_PAGE, fallback };
}

/** A search hit: a key or a scalar value, with the containers that hold it. */
export interface JsonTreeMatch { path: string; part: "key" | "value"; ancestors: string[] }

export function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function scalarText(node: JsonSourceNode): string {
  switch (node.kind) {
    case "string": case "number": return node.raw;
    case "boolean": return String(node.value);
    case "null": return "null";
    case "object": return "{}";
    case "array": return "[]";
  }
}

function scalarClass(node: JsonSourceNode): string {
  if (node.kind === "string") return "ub-json-string";
  if (node.kind === "number") return "ub-json-number";
  return node.kind === "boolean" || node.kind === "null" ? "ub-json-literal" : "ub-json-punct";
}

/** Append text with every case-insensitive occurrence of a lowercase `query` marked. */
export function appendMatches(element: HTMLElement, text: string, query: string, current: boolean): void {
  if (query === "") { element.append(text); return; }
  const lower = text.toLowerCase();
  let at = 0;
  for (let found = lower.indexOf(query); found !== -1; found = lower.indexOf(query, found + query.length)) {
    if (found > at) element.append(text.slice(at, found));
    const mark = document.createElement("mark");
    mark.className = current ? "ub-json-match ub-json-match-current" : "ub-json-match";
    mark.textContent = text.slice(found, found + query.length);
    element.append(mark);
    at = found + query.length;
  }
  if (at < text.length) element.append(text.slice(at));
}

/** Text with every case-insensitive occurrence of `query` marked. */
function marked(className: string, text: string, query: string, current: boolean): HTMLSpanElement {
  const element = span(className, "");
  appendMatches(element, text, query, current);
  return element;
}

function preview(item: JsonTreeItem): HTMLSpanElement {
  const element = span("ub-json-preview", " … ");
  // Array items have no key to tell them apart, so they show their first scalar.
  if (item.type !== "value" || item.node.kind !== "object" || typeof item.key !== "number") return element;
  const first = item.node.entries.find((entry) => !["object", "array"].includes(entry.value.kind));
  if (first === undefined) return element;
  element.replaceChildren(" ", span("ub-json-key", first.rawKey), span("ub-json-punct", ": "),
    span(scalarClass(first.value), scalarText(first.value)), span("ub-json-punct", ", … "));
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

interface RowHighlight { query: string; current: "key" | "value" | null }

function rowElement(row: JsonTreeRow, open: boolean, wrapped: boolean, highlight: RowHighlight): HTMLElement {
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
  if (row.form === "close") {
    element.append(span("ub-json-punct", `${brackets(item)[1]}${row.comma ? "," : ""}`));
    return element;
  }
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
  else if (item.rawKey !== undefined) {
    element.append(marked("ub-json-key", item.rawKey, highlight.query, highlight.current === "key"), span("ub-json-punct", ": "));
  }
  if (row.form === "leaf") {
    if (wrapped) element.dataset.wrapped = "true";
    element.append(marked(scalarClass(item.node), scalarText(item.node), highlight.query, highlight.current === "value"));
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

/** Every key and scalar value containing `query` (lowercase), in document order. */
export function jsonTreeMatches(root: JsonTreeItem, query: string): JsonTreeMatch[] {
  if (query === "") return [];
  const matches: JsonTreeMatch[] = [];
  const visit = (item: JsonTreeItem, ancestors: string[]): void => {
    if (item.type === "value" && item.rawKey?.toLowerCase().includes(query)) matches.push({ path: item.path, part: "key", ancestors });
    if (item.type === "value" && !foldable(item) && scalarText(item.node).toLowerCase().includes(query)) {
      matches.push({ path: item.path, part: "value", ancestors });
    }
    if (!foldable(item)) return;
    const inside = [...ancestors, item.path];
    for (const child of children(item)) visit(child, inside);
  };
  visit(root, []);
  return matches;
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
  const copyValue = document.createElement("button");
  copyValue.type = "button";
  copyValue.textContent = "Copy value";
  copyValue.setAttribute("aria-label", "Copy this value");
  copyValue.className = "ub-json-copy-value";
  copyValue.tabIndex = -1;
  const place = (row: HTMLElement | null): void => {
    if (row === null || row.dataset.path === undefined) { copyValue.remove(); return; }
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
  copyValue.addEventListener("mousedown", (event) => event.preventDefault());
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

export interface JsonTreePanel {
  /** The `role=tree` element. */
  element: HTMLElement;
  /** Show a tree, or nothing; `defaults` are the paths the first view opens. */
  show: (root: JsonTreeItem | null, defaults?: Set<string>) => void;
  /** Forget fold choices and open everything, or only the root. */
  openAll: (open: boolean) => void;
  /** Highlight `query` and return its matches. */
  search: (query: string) => JsonTreeMatch[];
  /** Open the match's containers, mark it current and scroll to it. */
  reveal: (match: JsonTreeMatch | null) => void;
  /** Focus the row a reader last used. */
  focus: () => void;
}

export function jsonTreePanel(state: JsonTreeViewState): JsonTreePanel {
  const tree = document.createElement("div");
  tree.className = "ub-json-tree-rows";
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "JSON tree");
  let root: JsonTreeItem | null = null;
  let defaults = new Set<string>();
  let rows: JsonTreeRow[] = [];
  let active = "";
  let query = "";
  let current: JsonTreeMatch | null = null;

  const isOpen = (path: string): boolean => {
    const chosen = state.open.get(path);
    if (chosen !== undefined) return chosen;
    if (state.fallback === "all") return true;
    return state.fallback === "root" ? path === root?.path : defaults.has(path);
  };
  const render = (): void => {
    if (root === null) { rows = []; tree.replaceChildren(); return; }
    const hadFocus = tree.contains(document.activeElement);
    rows = jsonTreeRows(root, isOpen, state.limit);
    const elements = rows.map((row) => {
      if (row.form === "more") return rowElement(row, false, false, { query: "", current: null });
      const here = current !== null && current.path === row.item.path && row.form !== "close" ? current.part : null;
      return rowElement(row, isOpen(row.item.path), row.form === "leaf" && state.wrapped.has(row.item.path), { query, current: here });
    });
    tree.replaceChildren(...elements);
    const focusable = elements.find((element) => element.dataset.path === active && element.hasAttribute("role"))
      ?? elements.find((element) => element.hasAttribute("role"));
    if (focusable === undefined) return;
    focusable.tabIndex = 0;
    if (hadFocus) focusable.focus({ preventScroll: true });
  };
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

  return {
    element: tree,
    show: (next, nextDefaults = new Set()) => { root = next; defaults = nextDefaults; render(); },
    openAll: (open) => {
      state.open.clear();
      state.fallback = open ? "all" : "root";
      render();
    },
    search: (text) => {
      query = text.toLowerCase();
      current = null;
      const matches = root === null ? [] : jsonTreeMatches(root, query);
      render();
      return matches;
    },
    reveal: (match) => {
      current = match;
      if (match !== null) {
        for (const path of match.ancestors) state.open.set(path, true);
        active = match.path;
      }
      render();
      // A match past the built rows needs more of them.
      while (match !== null && root !== null && itemAt(match.path) === null && rows.at(-1)?.form === "more") {
        state.limit += ROW_PAGE;
        render();
      }
      tree.querySelector(".ub-json-match-current")?.scrollIntoView({ block: "center" });
    },
    focus: () => {
      (tree.querySelector<HTMLElement>('[tabindex="0"]') ?? tree).focus({ preventScroll: true });
    },
  };
}
