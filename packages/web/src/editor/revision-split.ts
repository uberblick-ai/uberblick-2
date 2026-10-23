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
import { AllSelection, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { compareRevisions } from "@uberblick/schema";
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
export type RevisionRowKind = "unchanged" | "changed" | "added" | "removed";

export interface RevisionSideCell {
  /** Captions above the block: what kind of change, fields, data. */
  labels: string[];
  filler: boolean;
}

export interface RevisionRow {
  kind: RevisionRowKind;
  /** Any visible difference: text, fields, rows, cells or data. Folding and change navigation use this. */
  changed: boolean;
  before: RevisionSideCell;
  after: RevisionSideCell;
}

export interface RevisionSplitModel {
  comparison: RevisionComparison;
  rows: RevisionRow[];
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
  return node.type.name === "revisionFiller" ? node
    : node.type.create({ ...node.attrs, id: `revision-${index}-${node.attrs.id ?? ""}` }, node.content, node.marks);
}

function document(nodes: PMNode[]): JSONContent {
  return revisionSchema.topNodeType.create(null, Fragment.fromArray(nodes.map(identified))).toJSON() as JSONContent;
}

export function revisionSplitModel(before: Y.Doc, after: Y.Doc): RevisionSplitModel {
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
    const fields = cellFields(change);
    const data = (node: PMNode | undefined): string[] => node === undefined ? [] : chartCollections(node, comparison).map((name) => `Data changed: ${name}`);
    const changedLabel = fields.length > 0 ? [`Changed: ${fields.join(", ")}`] : [];
    const kind: RevisionRowKind = newNode === undefined ? "removed" : oldNode === undefined ? "added" : change.kind === "unchanged" ? "unchanged" : "changed";
    const beforeLabels = oldNode === undefined ? [] : [...(kind === "removed" ? ["Removed block"] : changedLabel), ...data(oldNode)];
    const afterLabels = newNode === undefined ? [] : [...(kind === "added" ? ["Added block"] : changedLabel), ...data(newNode)];
    left.push(oldNode === undefined ? filler() : kind === "removed" ? markTree(oldNode, "removed") : sideNode(oldNode, change, "before"));
    right.push(newNode === undefined ? filler() : kind === "added" ? markTree(newNode, "added") : sideNode(newNode, change, "after"));
    rows.push({
      kind,
      changed: kind !== "unchanged" || fields.length > 0 || change.spans.length > 0 || beforeLabels.length > 0 || afterLabels.length > 0,
      before: { labels: beforeLabels, filler: oldNode === undefined },
      after: { labels: afterLabels, filler: newNode === undefined },
    });
  }
  return { comparison, rows, before: document(left), after: document(right) };
}

const MARK: Record<RevisionRowKind, string> = { unchanged: "", changed: "~", added: "+", removed: "−" };

/** Row widgets: an end spacer the aligner sizes, and the captions above each block. */
function sidePresentation(rows: readonly RevisionRow[], side: RevisionSide): Extension {
  return Extension.create({
    name: "revisionSide",
    priority: 2000,
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction: (transaction) => !transaction.docChanged,
        props: {
          transformCopied: (slice) => new Slice(copiedContent(slice.content), slice.openStart, slice.openEnd),
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.forEach((node, pos, index) => {
              const row = rows[index];
              if (row === undefined) return;
              const cell = row[side];
              const tint = row.kind === "unchanged" ? "unchanged" : row.kind === "changed" ? "changed" : row.kind;
              decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                class: `ub-revision-row ub-revision-row-${tint}`, "data-revision-row": tint, "data-revision-mark": cell.filler ? "" : MARK[row.kind],
              }));
              decorations.push(Decoration.widget(pos, () => {
                const start = window.document.createElement("div");
                start.className = "ub-revision-row-start";
                start.dataset.row = String(index);
                if (cell.labels.length > 0) {
                  const label = start.appendChild(window.document.createElement("span"));
                  label.className = "ub-revision-fields";
                  label.textContent = cell.labels.join(" · ");
                }
                return start;
              }, { side: -1, key: `revision-row-start:${index}:${cell.labels.join("|")}`, ignoreSelection: true }));
              decorations.push(Decoration.widget(pos + node.nodeSize, () => {
                const end = window.document.createElement("div");
                end.className = `ub-revision-row-end${cell.filler ? " ub-revision-row-filler" : ""}`;
                end.dataset.row = String(index);
                end.setAttribute("aria-hidden", "true");
                return end;
              }, { side: -2, key: `revision-row-end:${index}`, ignoreSelection: true }));
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
      ...revisionPalette(data), sidePresentation(rows, side),
      CodeHighlighting, ListBlocks, CardBlocks, TerminalBlocks, ChartBlocks, WireframeBlocks, AblaufBlocks,
      DocLinks.configure({ context: docLinks }), ExternalLinks,
      GitHubLinks.configure({ settings: workspaceSettings }), InlineIcons, ToggleHeadings,
    ],
    content,
    editable: false,
    enableContentCheck: true,
    injectCSS: false,
  });
  editor.setOptions({ editorProps: { attributes: { "aria-label": side === "before" ? "Before this revision" : "This revision" } } });
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
}

export function createRevisionSplit(options: CreateRevisionSplitOptions): RevisionSplit {
  const model = revisionSplitModel(options.before, options.after);
  const before = sideEditor(options.beforeElement, model.before, options.before, model.rows, "before", options.docLinks ?? null, options.workspaceSettings ?? null);
  const after = sideEditor(options.afterElement, model.after, options.after, model.rows, "after", options.docLinks ?? null, options.workspaceSettings ?? null);
  let frame = 0;
  const align = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { alignRevisionSides(before.view, after.view); });
  };
  // Drawings, images and fonts load late; either side growing realigns both.
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
  for (const view of [before.view, after.view]) {
    view.dom.querySelectorAll(":scope > :not(.ub-revision-row-start, .ub-revision-row-end)").forEach((element) => { observer?.observe(element, { box: "border-box" }); });
  }
  alignRevisionSides(before.view, after.view);
  return {
    model, before, after, align,
    destroy: () => { cancelAnimationFrame(frame); observer?.disconnect(); before.destroy(); after.destroy(); },
  };
}
