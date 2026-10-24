/** The comparison grid a spanning json-tree block and its full-screen view share. */
import { compareJsonSources, jsonComparisonOpenPaths, jsonComparisonRows } from "@uberblick/schema";
import type { JsonCompareNode, JsonComparePiece, JsonCompareRow, JsonSourceNode } from "@uberblick/schema";

/** What a reader opened in one comparison, for the life of the tab; the block and its full-screen view share it. */
interface CompareState { collapse: boolean; open: Map<string, boolean> }
const compareStates = new Map<string, CompareState>();

function compareState(key: string): CompareState {
  let state = compareStates.get(key);
  if (state === undefined) {
    state = { collapse: true, open: new Map() };
    compareStates.set(key, state);
  }
  return state;
}

const PIECE_CLASS: Record<JsonComparePiece["role"], string> = {
  key: "ub-json-key", punct: "ub-json-punct", string: "ub-json-string", number: "ub-json-number",
  literal: "ub-json-literal", count: "ub-json-count", note: "ub-json-compare-note",
};
const OPEN_CHANGE = "ub-json-open-change";
/** Pieces a search looks in: what a reader would call keys and values. */
const SEARCHED = new Set<JsonComparePiece["role"]>(["key", "string", "number", "literal"]);

/** The gutter sign for one side of a row, as the document's rows show it. */
function sign(node: JsonCompareNode, side: "before" | "after", form: string): string {
  if (form === "close") return "";
  if (node.kind === "added") return side === "after" ? "+" : "";
  if (node.kind === "removed") return side === "before" ? "−" : "";
  if (node.kind === "changed" || node.kind === "type-changed") return "~";
  // A folded container that hides a change says so.
  return form === "closed" && node.kind === "unchanged" && node.changedWithin ? "~" : "";
}

/** A row the ruler marks and change navigation visits; a folded container that hides a change counts. */
function changeKind(row: JsonCompareRow): "added" | "removed" | "changed" | null {
  if (row.type === "run" || row.form === "close") return null;
  const { node } = row;
  if (node.kind === "added" || node.kind === "removed") return node.kind;
  if (node.kind !== "unchanged") return "changed";
  return row.form === "closed" && node.changedWithin ? "changed" : null;
}

/** Where a lowercase query falls in each piece; a match may span pieces of one value that a change split. */
function pieceMatches(pieces: JsonComparePiece[], query: string, compact = false): [number, number][][] {
  const result = pieces.map((): [number, number][] => []);
  if (query === "") return result;
  // The compact value is one piece, separate from its key separator and trailing comma.
  const compactValue = compact ? (pieces[0]?.role === "key" ? 2 : 0) : -1;
  for (let start = 0; start < pieces.length;) {
    const role = pieces[start]?.role;
    let end = start + 1;
    while (end < pieces.length && pieces[end]?.role === role && start !== compactValue && end !== compactValue) end++;
    if (role !== undefined && (SEARCHED.has(role) || start === compactValue)) {
      const text = pieces.slice(start, end).map((piece) => piece.text).join("").toLowerCase();
      const found: [number, number][] = [];
      for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) found.push([at, at + query.length]);
      let offset = 0;
      for (let index = start; index < end; index++) {
        const length = pieces[index]?.text.length ?? 0;
        result[index] = found.filter(([from, to]) => from < offset + length && to > offset)
          .map(([from, to]): [number, number] => [Math.max(from, offset) - offset, Math.min(to, offset + length) - offset]);
        offset += length;
      }
    }
    start = end;
  }
  return result;
}

function appendMatches(element: HTMLElement, text: string, ranges: [number, number][], current: boolean): void {
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) element.append(text.slice(at, from));
    const mark = document.createElement("mark");
    mark.className = current ? "ub-json-match ub-json-match-current" : "ub-json-match";
    mark.textContent = text.slice(from, to);
    element.append(mark);
    at = to;
  }
  if (at < text.length) element.append(text.slice(at));
}

function cell(row: JsonCompareRow, side: "before" | "after", open: boolean, search: { query: string; current: boolean }): HTMLElement {
  const element = document.createElement("div");
  element.className = `ub-json-compare-cell ub-json-compare-${side}`;
  element.style.setProperty("--json-depth", String(row.depth));
  if (row.type === "run") {
    element.dataset.chrome = "true";
    const bar = document.createElement("button");
    bar.type = "button";
    bar.contentEditable = "false";
    bar.className = "ub-json-compare-run";
    bar.dataset.key = row.id;
    bar.textContent = row.label;
    element.append(bar);
    return element;
  }
  const pieces = row[side];
  if (pieces === null) {
    element.classList.add("ub-json-compare-filler");
    element.setAttribute("aria-hidden", "true");
    return element;
  }
  const { node, form } = row;
  element.dataset.kind = node.kind;
  element.dataset.mark = sign(node, side, form);
  if (form === "open" || form === "closed") {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.contentEditable = "false";
    toggle.className = "ub-json-toggle";
    toggle.textContent = open ? "▾" : "▸";
    toggle.dataset.key = node.path;
    toggle.setAttribute("aria-label", open ? "Fold" : "Unfold");
    toggle.setAttribute("aria-expanded", String(open));
    element.append(toggle);
  }
  const matches = pieceMatches(pieces, search.query, node.kind === "type-changed");
  pieces.forEach((piece, index) => {
    const part = document.createElement(piece.mark === true ? "mark" : "span");
    part.className = PIECE_CLASS[piece.role];
    if (piece.mark === true) part.classList.add(side === "before" ? "ub-json-compare-removed" : "ub-json-compare-added");
    if (piece.role === "note" || piece.role === "count") part.dataset.chrome = "true";
    appendMatches(part, piece.text, matches[index] ?? [], search.current);
    element.append(part);
  });
  return element;
}

/** Copy one pane's selected lines as plain JSON text. */
function paneText(grid: HTMLElement, selection: Selection): string | null {
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  const pane = anchor?.closest(".ub-json-compare-pane");
  if (pane == null || !grid.contains(pane)) return null;
  if (selection.rangeCount === 0) return "";
  const selected = selection.getRangeAt(0);
  const lines: string[] = [];
  for (const each of pane.querySelectorAll<HTMLElement>(".ub-json-compare-cell")) {
    if (!selected.intersectsNode(each) || each.classList.contains("ub-json-compare-filler") || each.dataset.chrome === "true") continue;
    const clipped = document.createRange();
    clipped.selectNodeContents(each);
    if (selected.compareBoundaryPoints(Range.START_TO_START, clipped) > 0) clipped.setStart(selected.startContainer, selected.startOffset);
    if (selected.compareBoundaryPoints(Range.END_TO_END, clipped) < 0) clipped.setEnd(selected.endContainer, selected.endOffset);
    const fragment = clipped.cloneContents();
    fragment.querySelectorAll('[data-chrome="true"], .ub-json-toggle').forEach((chrome) => { chrome.remove(); });
    const text = fragment.textContent ?? "";
    if (text === "") continue;
    const depth = Number(each.style.getPropertyValue("--json-depth"));
    const indent = selected.comparePoint(each, 0) === 0 ? "  ".repeat(depth) : "";
    lines.push(`${indent}${text}`);
  }
  return lines.join("\n");
}

/** A search hit: a node whose key or displayed value contains the query on either side, with the nodes that hold it. */
export interface JsonCompareMatch { path: string; chain: JsonCompareNode[] }

function scalarText(node: JsonSourceNode | null): string {
  if (node === null) return "";
  switch (node.kind) {
    case "string": case "number": return node.raw;
    case "boolean": return String(node.value);
    case "null": return "null";
    case "object": case "array": return "";
  }
}

function compareMatches(root: JsonCompareNode, query: string): JsonCompareMatch[] {
  const matches: JsonCompareMatch[] = [];
  if (query === "") return matches;
  const hit = (text: string | number | null): boolean => typeof text === "string" && text.toLowerCase().includes(query);
  const visit = (node: JsonCompareNode, chain: JsonCompareNode[]): void => {
    const here = [...chain, node];
    // A type change is one leaf whose compact value can still contain nested keys and values.
    const leaf = node.kind === "type-changed"
      ? jsonComparisonRows(node, { isOpen: () => false, collapseUnchanged: false })[0] : undefined;
    const compact = leaf?.type === "node" && [leaf.before, leaf.after].some((pieces) =>
      pieces !== null && pieceMatches(pieces, query, true).some((ranges) => ranges.length > 0));
    if (compact || hit(node.beforeKey) || hit(node.afterKey) || hit(scalarText(node.before)) || hit(scalarText(node.after))) {
      matches.push({ path: node.path, chain: here });
    }
    for (const child of node.children) visit(child, here);
  };
  visit(root, []);
  return matches;
}

export interface JsonComparePanel {
  /** The grid of two panes, before and after, that share rows. */
  grid: HTMLElement;
  /** The Collapse unchanged switch, for whichever bar shows the panel. */
  collapse: HTMLElement;
  /** Draw the comparison of two texts; false when they cannot be compared. */
  show: (before: string, after: string) => boolean;
  /** Draw again after the other view of the same comparison changed what is open. */
  render: () => void;
  /** Highlight a lowercase query on both sides and return its matches. */
  search: (query: string) => JsonCompareMatch[];
  /** Open what holds the match, mark it current and scroll to it. */
  reveal: (match: JsonCompareMatch | null) => void;
}

/** The comparison grid and its switch; the inline block and the full-screen view each hold one. */
export function jsonComparePanel(key: string, rendered: () => void = () => {}): JsonComparePanel {
  const grid = document.createElement("div");
  grid.className = "ub-json-compare-grid ub-code";
  const label = document.createElement("label");
  label.className = "ub-json-compare-collapse";
  label.textContent = "Collapse unchanged";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("role", "switch");
  toggle.className = "ub-history-switch";
  label.append(toggle);
  let root: JsonCompareNode | null = null;
  let query = "";
  let current: JsonCompareMatch | null = null;
  const state = compareState(key);

  const isOpen = (path: string, defaults: Set<string>): boolean =>
    state.open.get(path) ?? (path.startsWith("run:") ? false : defaults.has(path));
  const rowsFor = (node: JsonCompareNode): JsonCompareRow[] => {
    const defaults = jsonComparisonOpenPaths(node, state.collapse);
    return jsonComparisonRows(node, { isOpen: (path) => isOpen(path, defaults), collapseUnchanged: state.collapse });
  };
  const render = (): void => {
    toggle.checked = state.collapse;
    toggle.setAttribute("aria-checked", String(state.collapse));
    if (root === null) { grid.replaceChildren(); rendered(); return; }
    const defaults = jsonComparisonOpenPaths(root, state.collapse);
    const rows = rowsFor(root);
    grid.style.gridTemplateRows = `repeat(${rows.length}, auto)`;
    grid.replaceChildren(...(["before", "after"] as const).map((side) => {
      const pane = document.createElement("div");
      pane.className = "ub-json-compare-pane";
      pane.dataset.side = side;
      // Native editing hosts contain selection; input is blocked below.
      pane.contentEditable = "true";
      pane.tabIndex = 0;
      pane.setAttribute("role", "textbox");
      pane.setAttribute("aria-label", side === "before" ? "Before JSON" : "After JSON");
      pane.setAttribute("aria-readonly", "true");
      pane.setAttribute("aria-multiline", "true");
      pane.setAttribute("inputmode", "none");
      pane.style.gridRow = `1 / span ${rows.length}`;
      let previous = false;
      pane.append(...rows.map((row) => {
        const open = row.type === "node" && isOpen(row.node.path, defaults);
        const here = { query, current: current !== null && row.type === "node" && row.form !== "close" && row.node.path === current.path };
        const line = cell(row, side, open, here);
        if (side === "before") return line;
        // The after cell carries its row's place: what the ruler marks and change navigation steps through.
        const change = changeKind(row);
        if (row.type === "node") {
          if (row.form !== "close") line.dataset.path = row.node.path;
          if (change !== null && row.form === "closed") line.dataset.folded = "true";
        }
        // A run of change rows is one change.
        if (change !== null) {
          line.dataset.change = change;
          if (!previous) line.dataset.changeStart = "true";
        }
        previous = change !== null;
        return line;
      }));
      return pane;
    }));
    rendered();
  };

  toggle.addEventListener("change", () => {
    state.collapse = toggle.checked;
    state.open.clear();
    render();
  });
  grid.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-key]") : null;
    if (target === null) return;
    const key = target.dataset.key ?? "";
    const opened = target.classList.contains("ub-json-compare-run") || target.getAttribute("aria-expanded") !== "true";
    const side = target.closest<HTMLElement>("[data-side]")?.dataset.side;
    const focused = target === document.activeElement;
    state.open.set(key, opened);
    render();
    if (focused) {
      const pane = [...grid.querySelectorAll<HTMLElement>("[data-side]")].find((each) => each.dataset.side === side);
      const control = [...pane?.querySelectorAll<HTMLElement>("[data-key]") ?? []].find((each) => each.dataset.key === key);
      (control ?? pane)?.focus({ preventScroll: true });
    }
  });
  for (const type of ["beforeinput", "paste", "drop"]) grid.addEventListener(type, (event) => event.preventDefault());
  // Select-all would climb to the editor around the panes, so it selects the pane the caret is in.
  grid.addEventListener("keydown", (event) => {
    const pane = event.target instanceof Element ? event.target.closest(".ub-json-compare-pane") : null;
    if (pane === null || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
    event.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(pane);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  });
  grid.addEventListener(OPEN_CHANGE, (event) => {
    const path = event instanceof CustomEvent ? String(event.detail) : "";
    const open = (node: JsonCompareNode): void => {
      if (node.children.length === 0 || !node.changedWithin) return;
      state.open.set(node.path, true);
      node.children.forEach(open);
    };
    const find = (node: JsonCompareNode): JsonCompareNode | null =>
      node.path === path ? node : node.children.reduce<JsonCompareNode | null>((found, child) => found ?? find(child), null);
    const node = root === null ? null : find(root);
    if (node === null) return;
    open(node);
    render();
  });
  grid.addEventListener("copy", (event) => {
    const selection = document.getSelection();
    const text = selection === null ? null : paneText(grid, selection);
    if (text === null || event.clipboardData === null) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
  });

  return {
    grid,
    collapse: label,
    show: (before, after) => {
      const result = compareJsonSources(before, after);
      root = result.ok ? result.root : null;
      render();
      return root !== null;
    },
    render,
    search: (text) => {
      query = text;
      current = null;
      render();
      return root === null ? [] : compareMatches(root, query);
    },
    reveal: (match) => {
      current = match;
      if (match !== null && root !== null) {
        for (const node of match.chain.slice(0, -1)) state.open.set(node.path, true);
        // A match inside a run of unchanged keys opens that run.
        for (const row of rowsFor(root)) {
          if (row.type === "run" && row.nodes.some((node) => match.chain.includes(node))) state.open.set(row.id, true);
        }
      }
      render();
      const at = grid.querySelector(".ub-json-match-current")
        ?? [...grid.querySelectorAll<HTMLElement>(".ub-json-compare-after[data-path]")].find((each) => each.dataset.path === match?.path);
      at?.scrollIntoView({ block: "center" });
    },
  };
}

/** The spanning comparison that follows a row's start marker in the side-by-side view, if that row has one. */
export function spanningComparison(rowStart: Element): HTMLElement | null {
  const next = rowStart.nextElementSibling;
  return next instanceof HTMLElement && next.classList.contains("ub-json-compare") ? next : null;
}

/** The rows inside a comparison that start a change, in order, by their after cells. */
export function jsonChangeStarts(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".ub-json-compare-after[data-change-start]")];
}

/** Every row inside a comparison with a change, with its kind, for the ruler. */
export function jsonChangeRows(container: Element): { element: HTMLElement; kind: "added" | "removed" | "changed" }[] {
  return [...container.querySelectorAll<HTMLElement>(".ub-json-compare-after[data-change]")].map((element) => ({
    element, kind: element.dataset.change === "added" || element.dataset.change === "removed" ? element.dataset.change : "changed",
  }));
}

/** Open a folded container that change navigation reached, down to the changes inside it. */
export function openFoldedChange(row: HTMLElement): void {
  if (row.dataset.folded !== "true") return;
  row.dispatchEvent(new CustomEvent(OPEN_CHANGE, { bubbles: true, detail: row.dataset.path ?? "" }));
}
