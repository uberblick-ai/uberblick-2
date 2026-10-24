/**
 * A changed json-tree block in the side-by-side comparison: one block across
 * both columns. The panes share grid rows but keep separate selection hosts.
 */
import { Node as TiptapNode } from "@tiptap/core";
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { compareJsonSources, jsonComparisonOpenPaths, jsonComparisonRows } from "@uberblick/schema";
import type { JsonCompareNode, JsonComparePiece, JsonCompareRow } from "@uberblick/schema";

/** What a reader opened in one comparison, for the life of the tab. */
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

/** The gutter sign for one side of a row, as the document's rows show it. */
function sign(node: JsonCompareNode, side: "before" | "after", form: string): string {
  if (form === "close") return "";
  if (node.kind === "added") return side === "after" ? "+" : "";
  if (node.kind === "removed") return side === "before" ? "−" : "";
  return node.kind === "changed" || node.kind === "type-changed" ? "~" : "";
}

function cell(row: JsonCompareRow, side: "before" | "after", open: boolean): HTMLElement {
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
  for (const piece of pieces) {
    const part = document.createElement(piece.mark === true ? "mark" : "span");
    part.className = PIECE_CLASS[piece.role];
    if (piece.mark === true) part.classList.add(side === "before" ? "ub-json-compare-removed" : "ub-json-compare-added");
    if (piece.role === "note" || piece.role === "count") part.dataset.chrome = "true";
    part.textContent = piece.text;
    element.append(part);
  }
  return element;
}

/** Copy one pane's selected lines as plain JSON text. */
function paneText(grid: HTMLElement, selection: Selection): string | null {
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  const pane = anchor?.closest(".ub-json-compare-pane");
  if (pane == null || !grid.contains(pane)) return null;
  const lines: string[] = [];
  for (const each of pane.querySelectorAll<HTMLElement>(".ub-json-compare-cell")) {
    if (!selection.containsNode(each, true) || each.classList.contains("ub-json-compare-filler") || each.dataset.chrome === "true") continue;
    const depth = Number(each.style.getPropertyValue("--json-depth"));
    const text = [...each.children].filter((child) => child instanceof HTMLElement && child.dataset.chrome !== "true"
      && !child.classList.contains("ub-json-toggle")).map((child) => child.textContent).join("");
    lines.push(`${"  ".repeat(depth)}${text}`);
  }
  return lines.join("\n");
}

function jsonCompareView({ node }: NodeViewRendererProps): NodeView {
  let current: PMNode = node;
  const dom = document.createElement("div");
  dom.className = "ub-json-compare";
  dom.contentEditable = "false";
  const bar = document.createElement("div");
  bar.className = "ub-json-compare-bar";
  const label = document.createElement("label");
  label.className = "ub-json-compare-collapse";
  label.textContent = "Collapse unchanged";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("role", "switch");
  toggle.className = "ub-history-switch";
  label.append(toggle);
  bar.append(label);
  const grid = document.createElement("div");
  grid.className = "ub-json-compare-grid ub-code";
  dom.append(bar, grid);

  const render = (): void => {
    const result = compareJsonSources(String(current.attrs.before), String(current.attrs.after));
    if (!result.ok) { grid.replaceChildren(); return; }
    const state = compareState(String(current.attrs.key));
    toggle.checked = state.collapse;
    toggle.setAttribute("aria-checked", String(state.collapse));
    const defaults = jsonComparisonOpenPaths(result.root, state.collapse);
    const isOpen = (key: string): boolean => state.open.get(key) ?? (key.startsWith("run:") ? false : defaults.has(key));
    const rows = jsonComparisonRows(result.root, { isOpen, collapseUnchanged: state.collapse });
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
      pane.append(...rows.map((row) => {
        const line = cell(row, side, row.type === "node" && isOpen(row.node.path));
        if (side === "after" && row.type === "node" && row.node.kind !== "unchanged" && row.form !== "close") line.dataset.change = "true";
        return line;
      }));
      return pane;
    }));
  };

  toggle.addEventListener("change", () => {
    const state = compareState(String(current.attrs.key));
    state.collapse = toggle.checked;
    state.open.clear();
    render();
  });
  grid.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-key]") : null;
    if (target === null) return;
    const key = target.dataset.key ?? "";
    const state = compareState(String(current.attrs.key));
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
  grid.addEventListener("copy", (event) => {
    const selection = document.getSelection();
    const text = selection === null ? null : paneText(grid, selection);
    if (text === null || event.clipboardData === null) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
  });
  render();

  return {
    dom,
    update(updated: PMNode): boolean {
      if (updated.type !== current.type) return false;
      const changed = updated.attrs.before !== current.attrs.before || updated.attrs.after !== current.attrs.after;
      current = updated;
      if (changed) render();
      return true;
    },
    stopEvent: () => true,
    ignoreMutation: () => true,
  };
}

/** The spanning comparison's node, after the side-by-side's placeholder on the left. */
export const RevisionJsonCompare = TiptapNode.create({
  name: "revisionJsonCompare",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes: () => ({ before: { default: "" }, after: { default: "" }, key: { default: "" } }),
  parseHTML: () => [],
  renderHTML: () => ["div", { class: "ub-json-compare" }],
  renderText: ({ node }) => String(node.attrs.after),
  addNodeView: () => jsonCompareView,
});

/** The empty left cell under the spanning comparison; the aligner gives it its height. */
export const RevisionJsonPlaceholder = TiptapNode.create({
  name: "revisionJsonPlaceholder",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes: () => ({ before: { default: "" } }),
  parseHTML: () => [],
  renderHTML: () => ["div", { class: "ub-json-compare-placeholder", "aria-hidden": "true" }],
  renderText: ({ node }) => String(node.attrs.before),
});
