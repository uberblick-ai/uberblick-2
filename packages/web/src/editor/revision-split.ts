/**
 * The side-by-side comparison: the predecessor and the selected revision as
 * two read-only projections whose top-level blocks pair row by row. Each side
 * is its own editor, so a selection never crosses sides, and each binds its
 * charts and data tables to its own document's data.
 */
import { Editor, Extension } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { compareJsonSources, compareRevisions } from "@uberblick/schema";
import type { RevisionBlockComparison, RevisionComparison, TextSpan } from "@uberblick/schema";
import type * as Y from "yjs";
import { AblaufBlocks } from "./ablauf.js";
import { CardBlocks } from "./card.js";
import { ChartBlocks } from "./chart.js";
import { DocLinks } from "./doc-links.js";
import type { DocLinkContext } from "./doc-links.js";
import { ExternalLinks } from "./external-links.js";
import { GitHubLinks } from "./github-links.js";
import { InlineIcons } from "./inline-icons.js";
import { PersonMentions } from "./person-mentions.js";
import { ListBlocks } from "./list-keys.js";
import { unchangedRuns } from "./revision-rows.js";
import type { RevisionFolding, RevisionRow, RevisionRowKind, RevisionSide } from "./revision-rows.js";
import { revisionFoldTransaction, revisionKeyboardShortcuts, revisionNativeKeyboardEvents, revisionReadOnlyProps } from "./revision-editor.js";
import { chartCollections, columnWidthsCaption, copiedContent, copyNode, isColumnWidthsOnly, markTree, revisionFields, revisionPalette, revisionSchema, visibleNodes } from "./revision-view.js";
import { CodeHighlighting } from "./syntax-highlighting.js";
import { TerminalBlocks } from "./terminal.js";
import { ToggleHeadings } from "./toggle-headings.js";
import { WireframeBlocks } from "./wireframe.js";

export { unchangedRuns } from "./revision-rows.js";
export type { RevisionFolding, RevisionRow, RevisionRowKind, RevisionSide, RevisionSideCell } from "./revision-rows.js";

export interface RevisionSplitModel {
  comparison: RevisionComparison;
  /** The rows shown, with folded runs as single rows. */
  rows: RevisionRow[];
  /** Every folded or foldable run, by its first row in the full comparison. */
  runs: number[];
  before: JSONContent;
  after: JSONContent;
}

function filler(): PMNode {
  const type = revisionSchema.nodes.revisionFiller;
  if (type === undefined) throw new Error("Revision filler is missing");
  return type.create();
}

/** One side of a word comparison: that side's text, with only its own changes marked. */
function sideText(node: PMNode, spans: readonly TextSpan[], side: RevisionSide): PMNode {
  const own = side === "before" ? "removed" : "added";
  const other = side === "before" ? "added" : "removed";
  const children: PMNode[] = [];
  let offset = 0;
  for (const span of spans) {
    if (span.kind === other) continue;
    node.content.cut(offset, offset + span.text.length).forEach((child) => {
      children.push(span.kind === "unchanged" ? child : markTree(child, own));
    });
    offset += span.text.length;
  }
  return copyNode(node, children);
}

function sideTable(node: PMNode, change: RevisionBlockComparison, side: RevisionSide): PMNode {
  if (change.rows === undefined || change.rows.length === 0) return node;
  const own = side === "before" ? "removed" : "added";
  const rows: PMNode[] = [];
  for (const row of change.rows) {
    const index = side === "before" ? row.beforeIndex : row.afterIndex;
    const current = index === undefined ? undefined : node.maybeChild(index);
    if (current == null) continue;
    if (row.kind === own) { rows.push(markTree(current, own)); continue; }
    if (!row.cells) { rows.push(current); continue; }
    const cells: PMNode[] = [];
    current.forEach((cell, _offset, column) => {
      const comparison = row.cells?.find((entry) => entry.column === column);
      const text = cell.firstChild;
      cells.push(comparison === undefined ? cell
        : comparison.spans.length === 0 && comparison.fields.length === 0 && text === null ? markTree(cell, own)
        : text !== null && comparison.spans.length > 0 ? copyNode(cell, [sideText(text, comparison.spans, side)]) : cell);
    });
    rows.push(copyNode(current, cells));
  }
  return copyNode(node, rows);
}

function sideNode(node: PMNode, change: RevisionBlockComparison, side: RevisionSide): PMNode {
  const own = side === "before" ? "removed" : "added";
  // These comparisons have no shared text address space: the whole side changed.
  if (change.fields.includes("content") || change.fields.includes("columns")) return markTree(node, own);
  if (change.spans.length > 0 && node.isTextblock) return sideText(node, change.spans, side);
  if (node.type.name === "table") return sideTable(node, change, side);
  return node;
}

function identified(node: PMNode, index: number): PMNode {
  // The live editor stays mounted beside these projections; identities never repeat.
  return node.type.name === "revisionFiller" || node.type.name === "revisionFold" ? node
    : node.type.create({ ...node.attrs, id: `revision-${index}-${node.attrs.id ?? ""}` }, node.content, node.marks);
}

function document(nodes: PMNode[], rows: readonly RevisionRow[]): JSONContent {
  return revisionSchema.topNodeType.create(null, Fragment.fromArray(nodes.map((node, index) => identified(node, rows[index]?.at ?? index)))).toJSON() as JSONContent;
}

function foldNode(run: number, count: number, headings: string, nodes: readonly PMNode[]): PMNode {
  const type = revisionSchema.nodes.revisionFold;
  if (type === undefined) throw new Error("Revision fold is missing");
  const levels = nodes.filter((node) => node.type.name === "heading").map((node) => Number(node.attrs.level));
  return type.create({ run, count, headings, headingLevel: levels.length === 0 ? null : Math.min(...levels) });
}

function sourceText(node: PMNode): string {
  return typeof node.attrs.revisionSource === "string" ? node.attrs.revisionSource : node.textContent;
}

/**
 * A changed json-tree block that is valid on both sides spans both columns: the
 * left keeps a placeholder the aligner pads, the right draws the comparison.
 */
function jsonRow(change: RevisionBlockComparison, oldNode: PMNode | undefined, newNode: PMNode | undefined, at: number):
  { row: RevisionRow; left: PMNode; right: PMNode } | null {
  if (oldNode === undefined || newNode === undefined || change.kind === "unchanged") return null;
  if (oldNode.type.name !== "code" || newNode.type.name !== "code") return null;
  if (oldNode.attrs.language !== "json-tree" || newNode.attrs.language !== "json-tree") return null;
  const before = sourceText(oldNode);
  const after = sourceText(newNode);
  if (before === after || !compareJsonSources(before, after).ok) return null;
  const compare = revisionSchema.nodes.revisionJsonCompare;
  const placeholder = revisionSchema.nodes.revisionJsonPlaceholder;
  if (compare === undefined || placeholder === undefined) return null;
  return {
    row: {
      kind: "changed", at, changed: true,
      before: { labels: [], filler: false, spanned: true }, after: { labels: [], filler: false, spanned: true },
    },
    left: placeholder.create({ before }),
    right: compare.create({ before, after, key: `${String(newNode.attrs.id ?? "")}:${before.length}:${after.length}` }),
  };
}

/** One comparison entry as a row and the block each side shows for it. */
function splitRow(change: RevisionBlockComparison, oldNode: PMNode | undefined, newNode: PMNode | undefined,
  comparison: RevisionComparison, at: number): { row: RevisionRow; left: PMNode; right: PMNode } {
  const fields = revisionFields(change);
  const widthsOnly = oldNode?.type.name === "table" && newNode?.type.name === "table" && isColumnWidthsOnly(change);
  const data = (node: PMNode | undefined): string[] => node === undefined ? [] : chartCollections(node, comparison).map((name) => `Data changed: ${name}`);
  const changedLabel = fields.length > 0 ? [`Changed: ${fields.join(", ")}`] : [];
  const kind: RevisionRowKind = newNode === undefined ? "removed" : oldNode === undefined ? "added" : change.kind === "unchanged" ? "unchanged" : "changed";
  const beforeLabels = oldNode === undefined || widthsOnly ? [] : [...(kind === "removed" ? ["Removed block"] : changedLabel), ...data(oldNode)];
  const afterLabels = newNode === undefined ? [] : widthsOnly ? ["Only column widths changed"] : [...(kind === "added" ? ["Added block"] : changedLabel), ...data(newNode)];
  const shown = newNode ?? oldNode;
  const pairedAblauf = oldNode?.type.name === "code" && newNode?.type.name === "code"
    && oldNode.attrs.language === "ablauf" && newNode.attrs.language === "ablauf" && sourceText(oldNode) !== sourceText(newNode);
  const drawingSide = (node: PMNode, side: RevisionSide): PMNode => {
    const own = sideNode(node, change, side);
    if (!pairedAblauf) return own;
    return own.type.create({ ...own.attrs, revisionSide: side,
      revisionOtherSource: sourceText(side === "before" ? newNode : oldNode) }, own.content, own.marks);
  };
  return {
    row: {
      kind,
      at,
      ...(shown?.type.name === "heading" && shown.textContent !== "" ? { heading: shown.textContent } : {}),
      changed: kind !== "unchanged" || fields.length > 0 || change.spans.length > 0 || beforeLabels.length > 0 || afterLabels.length > 0,
      before: { labels: beforeLabels, filler: oldNode === undefined },
      after: { labels: afterLabels, filler: newNode === undefined, widthsOnly },
    },
    left: oldNode === undefined ? filler() : kind === "removed" ? markTree(oldNode, "removed") : drawingSide(oldNode, "before"),
    right: newNode === undefined ? filler() : kind === "added" ? markTree(newNode, "added") : drawingSide(newNode, "after"),
  };
}

export function revisionSplitModel(before: Y.Doc, after: Y.Doc,
  folding: RevisionFolding = { collapse: false, expanded: new Set() }): RevisionSplitModel {
  const oldNodes = visibleNodes(before);
  const newNodes = visibleNodes(after);
  const comparison = compareRevisions(before, after);
  const rows: RevisionRow[] = [];
  const left: PMNode[] = [];
  const right: PMNode[] = [];
  for (const change of comparison.blocks) {
    const oldNode = change.beforeIndex === undefined ? undefined : oldNodes[change.beforeIndex];
    const newNode = change.afterIndex === undefined ? undefined : newNodes[change.afterIndex];
    if (oldNode === undefined && newNode === undefined) throw new Error("Revision comparison refers to missing content");
    const split = jsonRow(change, oldNode, newNode, rows.length) ?? splitRow(change, oldNode, newNode, comparison, rows.length);
    rows.push(split.row);
    left.push(split.left);
    right.push(split.right);
  }
  const runs = unchangedRuns(rows);
  const shown = folding.collapse ? foldRows(rows, left, right, runs.filter((run) => !folding.expanded.has(run.start)))
    : { rows, left, right };
  return { comparison, rows: shown.rows, runs: runs.map((run) => run.start), before: document(shown.left, shown.rows), after: document(shown.right, shown.rows) };
}

/** Replaces each run with one bar row, the same bar on both sides. */
function foldRows(rows: readonly RevisionRow[], left: readonly PMNode[], right: readonly PMNode[],
  runs: readonly { start: number; end: number }[]): { rows: RevisionRow[]; left: PMNode[]; right: PMNode[] } {
  const shown = { rows: [] as RevisionRow[], left: [] as PMNode[], right: [] as PMNode[] };
  let run = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const current = runs[run];
    const row = rows[index];
    const l = left[index];
    const r = right[index];
    if (row === undefined || l === undefined || r === undefined) continue;
    if (current === undefined || index < current.start) { shown.rows.push(row); shown.left.push(l); shown.right.push(r); continue; }
    const count = current.end - current.start + 1;
    const headings = rows.slice(current.start, current.end + 1).flatMap((entry) => entry.heading === undefined ? [] : [entry.heading]).join(", ");
    shown.rows.push({ kind: "folded", at: current.start, changed: false, fold: { run: current.start, count },
      before: { labels: [], filler: false }, after: { labels: [], filler: false } });
    shown.left.push(foldNode(current.start, count, headings, left.slice(current.start, current.end + 1)));
    shown.right.push(foldNode(current.start, count, headings, right.slice(current.start, current.end + 1)));
    index = current.end;
    run += 1;
  }
  return shown;
}

const revisionRows = new PluginKey<readonly RevisionRow[]>("revisionSideRows");

/** Side-scoped interaction and row widgets: captions and the spacers the aligner sizes. */
function sidePresentation(rows: readonly RevisionRow[], side: RevisionSide, docLinks: DocLinkContext | null): Extension {
  return Extension.create({
    name: "revisionSide",
    priority: 2000,
    addKeyboardShortcuts() {
      return revisionKeyboardShortcuts(this.editor, docLinks);
    },
    addProseMirrorPlugins() {
      return [new Plugin({
        key: revisionRows,
        state: {
          init: () => rows,
          apply: (transaction, current) => transaction.getMeta(revisionRows) ?? current,
        },
        filterTransaction: (transaction) => !transaction.docChanged || transaction.getMeta(revisionRows) !== undefined,
        props: {
          handleDOMEvents: revisionNativeKeyboardEvents,
          transformCopied: (slice) => new Slice(copiedContent(slice.content), slice.openStart, slice.openEnd),
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.forEach((node, pos, index) => {
              const row = revisionRows.getState(state)?.[index];
              if (row === undefined) return;
              const cell = row[side];
              const tint = row.kind;
              decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                class: `ub-revision-row ub-revision-row-${tint}`, "data-revision-row": tint,
              }));
              decorations.push(Decoration.widget(pos, () => {
                const start = window.document.createElement("div");
                start.className = "ub-revision-row-start";
                start.dataset.row = String(index);
                // Stable across folding, so motion can match a row before and after.
                start.dataset.key = `${row.kind === "folded" ? "fold" : "row"}-${row.at}`;
                if (cell.labels.length > 0) {
                  if (cell.widthsOnly) start.appendChild(columnWidthsCaption(node));
                  else {
                    const label = start.appendChild(window.document.createElement("span"));
                    label.className = "ub-revision-fields";
                    label.textContent = cell.labels.join(" · ");
                  }
                }
                return start;
              }, { side: -1, key: `revision-row-start:${index}:${row.kind}:${row.at}:${cell.labels.join("|")}`, ignoreSelection: true }));
              decorations.push(Decoration.widget(pos + node.nodeSize, () => {
                const end = window.document.createElement("div");
                end.className = `ub-revision-row-end${cell.filler ? " ub-revision-row-filler" : ""}`;
                end.dataset.row = String(index);
                end.setAttribute("aria-hidden", "true");
                return end;
              }, { side: -2, key: `revision-row-end:${index}:${row.kind}:${row.at}`, ignoreSelection: true }));
            });
            return DecorationSet.create(state.doc, decorations);
          },
          handlePaste: () => true,
          handleDrop: () => true,
        },
      })];
    },
  });
}

function sideEditor(element: Element, content: JSONContent, data: Y.Doc, rows: readonly RevisionRow[], side: RevisionSide,
  docLinks: DocLinkContext | null, workspaceSettings: Y.Doc | null): Editor {
  const editor = new Editor({
    element,
    extensions: [
      // Each side binds its charts to its own document; no predecessor override is needed.
      ...revisionPalette(data), sidePresentation(rows, side, docLinks),
      CodeHighlighting, ListBlocks, CardBlocks, TerminalBlocks, ChartBlocks, WireframeBlocks, AblaufBlocks,
      DocLinks.configure({ context: docLinks }), ExternalLinks,
      GitHubLinks.configure({ settings: workspaceSettings }), InlineIcons, PersonMentions, ToggleHeadings,
    ],
    content,
    editable: false,
    enableCoreExtensions: { editable: false },
    editorProps: revisionReadOnlyProps(side === "before" ? "Before this revision" : "This revision"),
    enableContentCheck: true,
    injectCSS: false,
  });
  // A default text caret in the first chart would open its source on arrival.
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  return editor;
}

interface SideRows {
  /** Row start widgets' tops, then the document's end, relative to the side's top. */
  tops: number[];
  /** Each row's end spacer and the padding it holds. */
  ends: HTMLElement[];
  padding: number[];
}

function rowTranslation(element: HTMLElement): number {
  // Fold motion translates each widget independently; padding belongs to the settled layout.
  const transform = getComputedStyle(element).transform;
  return !transform || transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
}

function sideRows(view: EditorView): SideRows {
  const origin = view.dom.getBoundingClientRect().top;
  const starts = [...view.dom.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-start")];
  const ends = [...view.dom.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-end")];
  const tops = starts.map((element) => element.getBoundingClientRect().top - rowTranslation(element) - origin);
  const last = ends.at(-1);
  if (last !== undefined) tops.push(last.getBoundingClientRect().bottom - rowTranslation(last) - origin);
  return { tops, ends, padding: ends.map((element) => Number.parseFloat(element.style.height) || 0) };
}

/**
 * Pads the shorter side at the end of each row until every row starts at the
 * same height on both sides. Each pass reads all positions, then writes; a
 * pass changes nothing once the sides agree, so resize feedback settles.
 */
export function alignRevisionSides(left: EditorView, right: EditorView): boolean {
  let changed = false;
  for (let pass = 0; pass < 4; pass += 1) {
    const sides = [sideRows(left), sideRows(right)] as const;
    const count = Math.min(sides[0].tops.length, sides[1].tops.length);
    const shift = [0, 0];
    let moved = false;
    for (let row = 1; row < count; row += 1) {
      const difference = ((sides[0].tops[row] ?? 0) + (shift[0] ?? 0)) - ((sides[1].tops[row] ?? 0) + (shift[1] ?? 0));
      if (Math.abs(difference) <= 0.5) continue;
      // Shrink the taller side's own padding first, then pad the shorter side.
      const taller = difference > 0 ? 0 : 1;
      const tall = sides[taller];
      const short = sides[1 - taller as 0 | 1];
      const held = tall.padding[row - 1] ?? 0;
      const reduce = Math.min(held, Math.abs(difference));
      tall.padding[row - 1] = held - reduce;
      shift[taller] = (shift[taller] ?? 0) - reduce;
      const rest = Math.abs(difference) - reduce;
      if (rest > 0) {
        short.padding[row - 1] = (short.padding[row - 1] ?? 0) + rest;
        shift[1 - taller] = (shift[1 - taller] ?? 0) + rest;
      }
      moved = true;
    }
    if (!moved) break;
    changed = true;
    for (const side of sides) {
      side.ends.forEach((element, row) => { element.style.height = `${side.padding[row] ?? 0}px`; });
    }
  }
  return changed;
}

export interface RevisionSplit {
  model: RevisionSplitModel;
  before: Editor;
  after: Editor;
  expand: (run: number) => void;
  setCollapse: (collapse: boolean) => void;
  align: () => void;
  destroy: () => void;
}

export interface CreateRevisionSplitOptions {
  beforeElement: Element;
  afterElement: Element;
  before: Y.Doc;
  after: Y.Doc;
  docLinks?: DocLinkContext | null;
  workspaceSettings?: Y.Doc | null;
  folding?: RevisionFolding;
  /** A fold bar was pressed: show that run again. */
  onExpand?: (run: number) => void;
}

export function createRevisionSplit(options: CreateRevisionSplitOptions): RevisionSplit {
  let model = revisionSplitModel(options.before, options.after, options.folding);
  const expanded = new Set(options.folding?.expanded);
  const before = sideEditor(options.beforeElement, model.before, options.before, model.rows, "before", options.docLinks ?? null, options.workspaceSettings ?? null);
  const after = sideEditor(options.afterElement, model.after, options.after, model.rows, "after", options.docLinks ?? null, options.workspaceSettings ?? null);
  let frame = 0;
  const align = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { alignRevisionSides(before.view, after.view); });
  };
  // Drawings, images and fonts load late; either side growing realigns both.
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
  const observeRows = (): void => {
    observer?.disconnect();
    for (const view of [before.view, after.view]) {
      view.dom.querySelectorAll(":scope > :not(.ub-revision-row-start, .ub-revision-row-end)").forEach((element) => { observer?.observe(element, { box: "border-box" }); });
    }
  };
  observeRows();
  const expand = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>(".ub-revision-fold-button") : null;
    if (button === null) return;
    event.preventDefault();
    options.onExpand?.(Number(button.dataset.fold));
  };
  for (const view of [before.view, after.view]) view.dom.addEventListener("click", expand);
  alignRevisionSides(before.view, after.view);
  const apply = (next: RevisionSplitModel): void => {
    for (const [editor, content] of [[before, next.before], [after, next.after]] as const) {
      const transaction = revisionFoldTransaction(editor, model, next, content);
      editor.view.dispatch(transaction.setMeta(revisionRows, next.rows));
    }
    model = next;
    observeRows();
    alignRevisionSides(before.view, after.view);
  };
  return {
    get model() { return model; },
    before, after, align,
    expand: (run) => {
      const index = model.rows.findIndex((row) => row.fold?.run === run);
      const fold = model.rows[index]?.fold;
      if (fold === undefined) return;
      expanded.add(run);
      apply(revisionSplitModel(options.before, options.after, { collapse: true, expanded }));
    },
    setCollapse: (collapse) => {
      expanded.clear();
      apply(revisionSplitModel(options.before, options.after, { collapse, expanded }));
    },
    destroy: () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      for (const view of [before.view, after.view]) view.dom.removeEventListener("click", expand);
      before.destroy();
      after.destroy();
    },
  };
}
