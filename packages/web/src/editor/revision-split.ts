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
import { canonicalDocumentUuid, compareJsonSources, compareRevisions, isExternalHref } from "@uberblick/schema";
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
import { ListBlocks } from "./list-keys.js";
import { chartCollections, copiedContent, copyNode, markTree, revisionPalette, revisionSchema, visibleNodes } from "./revision-view.js";
import { CodeHighlighting } from "./syntax-highlighting.js";
import { TerminalBlocks } from "./terminal.js";
import { ToggleHeadings } from "./toggle-headings.js";
import { WireframeBlocks } from "./wireframe.js";

export type RevisionSide = "before" | "after";
export type RevisionRowKind = "unchanged" | "changed" | "added" | "removed" | "folded";

export interface RevisionSideCell {
  /** Captions above the block: what kind of change, fields, data. */
  labels: string[];
  filler: boolean;
  /** The other side's block spans this cell; it carries no mark of its own. */
  spanned?: boolean;
}

export interface RevisionRow {
  kind: RevisionRowKind;
  /** The row's place in the full comparison; a folded run's first row. */
  at: number;
  /** The heading this row shows, for fold labels. */
  heading?: string;
  /** A folded run: the full model's first row and how many rows it hides. */
  fold?: { run: number; count: number };
  /** Any visible difference: text, fields, rows, cells or data. Folding and change navigation use this. */
  changed: boolean;
  before: RevisionSideCell;
  after: RevisionSideCell;
}

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

function cellFields(change: RevisionBlockComparison): string[] {
  const fields = [...change.fields];
  for (const row of change.rows ?? []) {
    for (const cell of row.cells ?? []) {
      for (const field of cell.fields) fields.push(`row ${(row.afterIndex ?? row.beforeIndex ?? 0) + 1}, column ${cell.column + 1}: ${field}`);
    }
  }
  return fields;
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

export interface RevisionFolding {
  /** Fold unchanged runs at all. */
  collapse: boolean;
  /** Runs shown again, by their first row. */
  expanded: ReadonlySet<number>;
}

/**
 * Runs of at least two rows without any change, each more than one row from a
 * change; the row next to a change stays as context.
 */
export function unchangedRuns(rows: readonly Pick<RevisionRow, "changed">[]): { start: number; end: number }[] {
  const quiet = rows.map((row, index) => !row.changed && !rows[index - 1]?.changed && !rows[index + 1]?.changed);
  const runs: { start: number; end: number }[] = [];
  quiet.forEach((value, index) => {
    if (!value) return;
    const last = runs.at(-1);
    if (last?.end === index - 1) last.end = index;
    else runs.push({ start: index, end: index });
  });
  return runs.filter((run) => run.end > run.start);
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
  const fields = cellFields(change);
  const data = (node: PMNode | undefined): string[] => node === undefined ? [] : chartCollections(node, comparison).map((name) => `Data changed: ${name}`);
  const changedLabel = fields.length > 0 ? [`Changed: ${fields.join(", ")}`] : [];
  const kind: RevisionRowKind = newNode === undefined ? "removed" : oldNode === undefined ? "added" : change.kind === "unchanged" ? "unchanged" : "changed";
  const beforeLabels = oldNode === undefined ? [] : [...(kind === "removed" ? ["Removed block"] : changedLabel), ...data(oldNode)];
  const afterLabels = newNode === undefined ? [] : [...(kind === "added" ? ["Added block"] : changedLabel), ...data(newNode)];
  const shown = newNode ?? oldNode;
  return {
    row: {
      kind,
      at,
      ...(shown?.type.name === "heading" && shown.textContent !== "" ? { heading: shown.textContent } : {}),
      changed: kind !== "unchanged" || fields.length > 0 || change.spans.length > 0 || beforeLabels.length > 0 || afterLabels.length > 0,
      before: { labels: beforeLabels, filler: oldNode === undefined },
      after: { labels: afterLabels, filler: newNode === undefined },
    },
    left: oldNode === undefined ? filler() : kind === "removed" ? markTree(oldNode, "removed") : sideNode(oldNode, change, "before"),
    right: newNode === undefined ? filler() : kind === "added" ? markTree(newNode, "added") : sideNode(newNode, change, "after"),
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

const MARK: Record<RevisionRowKind, string> = { unchanged: "", changed: "~", added: "+", removed: "−", folded: "" };
const revisionRows = new PluginKey<readonly RevisionRow[]>("revisionSideRows");

/** Side-scoped interaction and row widgets: captions and the spacers the aligner sizes. */
function sidePresentation(rows: readonly RevisionRow[], side: RevisionSide, docLinks: DocLinkContext | null): Extension {
  return Extension.create({
    name: "revisionSide",
    priority: 2000,
    addKeyboardShortcuts() {
      return {
        "Mod-a": () => this.editor.commands.selectAll(),
        Enter: () => {
          const { selection } = this.editor.state;
          if (!selection.empty) return false;
          const marks = selection.$from.marks();
          const docId = canonicalDocumentUuid(marks.find((mark) => mark.type.name === "docLink")?.attrs.docId);
          if (docId !== null && docLinks !== null) {
            if (docLinks.lookup(docId).state !== "deleted") docLinks.open(docId);
            return true;
          }
          const href = marks.find((mark) => mark.type.name === "link")?.attrs.href;
          if (!isExternalHref(href)) return false;
          window.open(href, "_blank", "noopener,noreferrer");
          return true;
        },
      };
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
          handleDOMEvents: {
            // Leave focus navigation and fold-button activation to the browser.
            keydown: (_view, event) => event.key === "Tab" ||
              event.target instanceof Element && event.target.closest(".ub-revision-fold-button") !== null,
            keypress: (_view, event) => event.target instanceof Element && event.target.closest(".ub-revision-fold-button") !== null,
          },
          transformCopied: (slice) => new Slice(copiedContent(slice.content), slice.openStart, slice.openEnd),
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.forEach((node, pos, index) => {
              const row = revisionRows.getState(state)?.[index];
              if (row === undefined) return;
              const cell = row[side];
              const tint = row.kind;
              decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                class: `ub-revision-row ub-revision-row-${tint}`, "data-revision-row": tint, "data-revision-mark": cell.filler || cell.spanned === true ? "" : MARK[row.kind],
              }));
              decorations.push(Decoration.widget(pos, () => {
                const start = window.document.createElement("div");
                start.className = "ub-revision-row-start";
                start.dataset.row = String(index);
                // Stable across folding, so motion can match a row before and after.
                start.dataset.key = `${row.kind === "folded" ? "fold" : "row"}-${row.at}`;
                if (cell.labels.length > 0) {
                  const label = start.appendChild(window.document.createElement("span"));
                  label.className = "ub-revision-fields";
                  label.textContent = cell.labels.join(" · ");
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
      GitHubLinks.configure({ settings: workspaceSettings }), InlineIcons, ToggleHeadings,
    ],
    content,
    // Native editing hosts contain selection; Tiptap's read-only renderers and transaction guard prevent editing.
    editable: false,
    enableCoreExtensions: { editable: false },
    editorProps: {
      editable: () => true,
      attributes: { role: "textbox", "aria-label": side === "before" ? "Before this revision" : "This revision", "aria-readonly": "true", "aria-multiline": "true", inputmode: "none" },
      handleDOMEvents: { beforeinput: (_view, event) => { event.preventDefault(); return true; } },
    },
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

function sideRows(view: EditorView): SideRows {
  const origin = view.dom.getBoundingClientRect().top;
  const starts = [...view.dom.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-start")];
  const ends = [...view.dom.querySelectorAll<HTMLElement>(":scope > .ub-revision-row-end")];
  const tops = starts.map((element) => element.getBoundingClientRect().top - origin);
  const last = ends.at(-1);
  if (last !== undefined) tops.push(last.getBoundingClientRect().bottom - origin);
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
  return {
    get model() { return model; },
    before, after, align,
    expand: (run) => {
      const index = model.rows.findIndex((row) => row.fold?.run === run);
      const fold = model.rows[index]?.fold;
      if (fold === undefined) return;
      expanded.add(run);
      const next = revisionSplitModel(options.before, options.after, { collapse: true, expanded });
      const start = next.rows.findIndex((row) => row.at === run);
      for (const [editor, content] of [[before, next.before], [after, next.after]] as const) {
        let position = 0;
        for (let row = 0; row < index; row += 1) position += editor.state.doc.child(row).nodeSize;
        const replacement = Fragment.fromArray((content.content ?? []).slice(start, start + fold.count).map((node) => editor.schema.nodeFromJSON(node)));
        editor.view.dispatch(editor.state.tr.replaceWith(position, position + editor.state.doc.child(index).nodeSize, replacement)
          .setMeta(revisionRows, next.rows));
      }
      model = next;
      observeRows();
      alignRevisionSides(before.view, after.view);
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
