/** Revision presentation is a ProseMirror projection with no Yjs binding. */
import { Editor, Extension, Mark, Node as TiptapNode, getSchema } from "@tiptap/core";
import type { Extensions, JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  COMMENT_MARK, canonicalDocumentUuid, compareRevisions, getBlocksFragment, isExternalHref,
} from "@uberblick/schema";
import type { RevisionBlockComparison, RevisionComparison, TextSpan } from "@uberblick/schema";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import type * as Y from "yjs";
import { AblaufBlocks, ablaufBlockView } from "./ablauf.js";
import { JsonTreeBlocks } from "./json-tree.js";
import { RevisionJsonCompare, RevisionJsonPlaceholder } from "./json-compare-view.js";
import { CardBlocks } from "./card.js";
import { ChartBlocks, chartBlockView } from "./chart.js";
import { DocLinks } from "./doc-links.js";
import type { DocLinkContext } from "./doc-links.js";
import { ExternalLinks } from "./external-links.js";
import { GitHubLinks } from "./github-links.js";
import { InlineIcons } from "./inline-icons.js";
import { PersonMentions } from "./person-mentions.js";
import { ListBlocks } from "./list-keys.js";
import { PROSE_MARKS } from "./marks.js";
import { ChartBlock, paletteExtensions } from "./nodes.js";
import { findForeignBlocks } from "./palette.js";
import { unchangedRuns } from "./revision-rows.js";
import type { RevisionFolding, RevisionRow, RevisionRowKind, RevisionSide } from "./revision-rows.js";
import { CodeHighlighting } from "./syntax-highlighting.js";
import { TerminalBlocks } from "./terminal.js";
import { ToggleHeadings } from "./toggle-headings.js";
import { WireframeBlocks } from "./wireframe.js";

export const SOURCE_NODES = new Set(["code", "terminal", "chart"]);
const INLINE_NODES = new Set(["paragraph", "heading", "list-item", "quote", "callout", ...SOURCE_NODES]);

const Added = Mark.create({
  name: "revisionAdded",
  excludes: "revisionAdded",
  renderHTML: () => ["mark", { class: "ub-revision-added", "data-revision-change": "added" }, 0],
});
const Removed = Mark.create({
  name: "removed",
  excludes: "removed",
  renderHTML: () => ["s", { class: "ub-revision-removed", "data-revision-change": "removed" }, 0],
});

/** An empty cell opposite an added or removed block in the side-by-side view. */
const Filler = TiptapNode.create({
  name: "revisionFiller",
  group: "block",
  atom: true,
  selectable: false,
  parseHTML: () => [],
  renderHTML: () => ["div", { class: "ub-revision-filler", "aria-hidden": "true" }],
});

/** A run of unchanged blocks shown as one bar; clicking it shows the run again. */
const Fold = TiptapNode.create({
  name: "revisionFold",
  group: "block",
  atom: true,
  selectable: false,
  addAttributes: () => ({ run: { default: 0 }, count: { default: 0 }, headings: { default: "" }, headingLevel: { default: null } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ["div", { class: "ub-revision-fold" }, ["button", {
    type: "button", class: "ub-revision-fold-button", "data-fold": String(node.attrs.run),
    "aria-label": `Show ${node.attrs.count} unchanged blocks${node.attrs.headings ? `: ${node.attrs.headings}` : ""}`,
  }, `${node.attrs.count} unchanged blocks${node.attrs.headings ? ` · ${node.attrs.headings}` : ""}`]],
});

/** Drawings read the selected revision's source, while its contentDOM shows the diff. */
function drawingNode(node: PMNode): PMNode {
  return typeof node.attrs.revisionSource === "string"
    ? node.type.create(node.attrs, node.attrs.revisionSource ? node.type.schema.text(node.attrs.revisionSource) : [], node.marks)
    : node;
}

export function revisionPalette(ydoc: Y.Doc | null, before: Y.Doc | null = null): Extensions {
  return [...paletteExtensions.map((base) => {
    const extension = base.name === "chart" ? ChartBlock.configure({ ydoc }) : base;
    if (!(extension instanceof TiptapNode) || !INLINE_NODES.has(extension.name)) return extension;
    const marks = `${SOURCE_NODES.has(extension.name) ? COMMENT_MARK : PROSE_MARKS} revisionAdded removed`;
    if (!SOURCE_NODES.has(extension.name)) return extension.extend({ marks });
    return extension.extend({
      marks,
      addAttributes() {
        return {
          ...this.parent?.(), revisionSource: { default: null, rendered: false },
          ...(this.name === "code" ? {
            revisionOtherSource: { default: null, rendered: false }, revisionSide: { default: null, rendered: false },
          } : {}),
          ...(this.name === "chart" ? { revisionRemoved: { default: false, rendered: false } } : {}),
        };
      },
      addNodeView() {
        const render = this.parent?.();
        if (render == null) throw new Error("Revision source requires its ordinary node view");
        return (props) => {
          const { revisionOtherSource, revisionSide } = props.node.attrs;
          // A removed chart's mapping and collection belong to the same predecessor.
          const selected = this.name === "code" && props.node.attrs.language === "ablauf"
            && typeof revisionOtherSource === "string" && (revisionSide === "before" || revisionSide === "after")
            ? ablaufBlockView({ source: revisionOtherSource, side: revisionSide })
            : this.name === "chart" && props.node.attrs.revisionRemoved === true && before !== null
            ? chartBlockView(before) : render;
          const view = selected({ ...props, node: drawingNode(props.node) });
          const update = view.update;
          view.update = (node, decorations, inner) => node.attrs.revisionOtherSource === revisionOtherSource && node.attrs.revisionSide === revisionSide
            && (update?.(drawingNode(node), decorations, inner) ?? false);
          return view;
        };
      },
    });
  }), Added, Removed, Filler, Fold, RevisionJsonCompare, RevisionJsonPlaceholder];
}

export const revisionSchema = getSchema(revisionPalette(null));

export function copyNode(node: PMNode, content: readonly PMNode[], marks = node.marks): PMNode {
  return node.type.create(node.attrs, content, marks);
}

function withoutComments(node: PMNode): PMNode {
  const marks = node.marks.filter((mark) => mark.type.name !== COMMENT_MARK);
  if (node.isText) return node.mark(marks);
  const children: PMNode[] = [];
  node.forEach((child) => { children.push(withoutComments(child)); });
  const attrs = SOURCE_NODES.has(node.type.name) ? { ...node.attrs, revisionSource: node.textContent } : node.attrs;
  return node.type.create(attrs, children, marks);
}

export function visibleNodes(doc: Y.Doc): PMNode[] {
  const fragment = getBlocksFragment(doc);
  if (findForeignBlocks(fragment).length > 0) throw new Error("This revision contains unsupported content");
  const parsed = yXmlFragmentToProseMirrorRootNode(fragment, revisionSchema);
  const nodes: PMNode[] = [];
  const seen = new Set<string>();
  parsed.forEach((node) => {
    const id: unknown = node.attrs.id;
    if (typeof id === "string" && id.length > 0) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    nodes.push(withoutComments(node));
  });
  return nodes;
}

export function markTree(node: PMNode, kind: "added" | "removed"): PMNode {
  if (node.isText) {
    const mark = revisionSchema.marks[kind === "added" ? "revisionAdded" : "removed"];
    if (mark === undefined) throw new Error("Revision mark is missing");
    return node.mark([...node.marks, mark.create()]);
  }
  const children: PMNode[] = [];
  node.forEach((child) => { children.push(markTree(child, kind)); });
  return copyNode(node, children);
}

function inlineChanges(before: PMNode, after: PMNode, spans: readonly TextSpan[]): PMNode {
  const children: PMNode[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  for (const span of spans) {
    const removed = span.kind === "removed";
    const source = removed ? before : after;
    const offset = removed ? oldOffset : newOffset;
    source.content.cut(offset, offset + span.text.length).forEach((node) => {
      children.push(span.kind === "unchanged" ? node : markTree(node, span.kind));
    });
    if (span.kind !== "added") oldOffset += span.text.length;
    if (!removed) newOffset += span.text.length;
  }
  return copyNode(after, children);
}

function tableChanges(before: PMNode, after: PMNode, change: RevisionBlockComparison): PMNode {
  if (change.rows === undefined || change.rows.length === 0) return after;
  const rows: PMNode[] = [];
  for (const row of change.rows) {
    const oldRow = row.beforeIndex === undefined ? undefined : before.maybeChild(row.beforeIndex);
    const newRow = row.afterIndex === undefined ? undefined : after.maybeChild(row.afterIndex);
    if (row.kind === "removed" && oldRow) { rows.push(markTree(oldRow, "removed")); continue; }
    if (row.kind === "added" && newRow) { rows.push(markTree(newRow, "added")); continue; }
    if (!newRow) continue;
    if (!oldRow || !row.cells) { rows.push(newRow); continue; }
    const cells: PMNode[] = [];
    for (let column = 0; column < Math.max(oldRow.childCount, newRow.childCount); column += 1) {
      const cell = newRow.maybeChild(column);
      const oldCell = oldRow.maybeChild(column);
      if (!cell) {
        if (oldCell) cells.push(markTree(oldCell, "removed"));
        continue;
      }
      if (!oldCell) { cells.push(markTree(cell, "added")); continue; }
      const comparison = row.cells?.find((entry) => entry.column === column);
      const oldText = oldCell.firstChild;
      const newText = cell.firstChild;
      cells.push(oldText && newText && comparison && comparison.spans.length > 0
        ? copyNode(cell, [inlineChanges(oldText, newText, comparison.spans)]) : cell);
    }
    rows.push(copyNode(newRow, cells));
  }
  return copyNode(after, rows);
}

export interface RevisionBlockDetails {
  kind: RevisionRowKind;
  /** Stable comparison row; a paired visual contributes two blocks to it. */
  at: number;
  side?: RevisionSide;
  fields: string[];
  widthsOnly: boolean;
  dataCollections: string[];
  showSource: boolean;
}

export function isColumnWidthsOnly(change: RevisionBlockComparison): boolean {
  return change.fields.length === 1 && change.fields[0] === "columnWidths"
    && change.spans.every((span) => span.kind === "unchanged")
    && change.rows !== undefined && change.rows.length > 0
    && change.rows.every((row) => row.kind === "unchanged" && (row.cells ?? []).every((cell) =>
      cell.kind === "unchanged" && cell.fields.length === 0 && cell.spans.every((span) => span.kind === "unchanged")));
}

export function revisionFields(change: RevisionBlockComparison): string[] {
  const fields = change.fields.map((field) => field === "columnWidths" ? "column widths" : field);
  for (const row of change.rows ?? []) {
    for (const cell of row.cells ?? []) {
      for (const field of cell.fields) fields.push(`row ${(row.afterIndex ?? row.beforeIndex ?? 0) + 1}, column ${cell.column + 1}: ${field}`);
    }
  }
  return fields;
}

export function columnWidthsCaption(node: PMNode): HTMLSpanElement {
  const label = document.createElement("span");
  label.className = "ub-revision-fields ub-revision-widths-only";
  label.setAttribute("role", "note");
  label.textContent = "Only column widths changed";
  let width = 0;
  let fixed = true;
  node.firstChild?.forEach((cell) => {
    const saved = cell.attrs.colwidth?.[0];
    if (typeof saved === "number") width += saved;
    else fixed = false;
  });
  // Match the framework table's fixed width; unsized columns fill the pane.
  if (fixed && width > 0) label.style.width = `${width}px`;
  return label;
}

export interface RevisionViewModel {
  content: JSONContent;
  comparison: RevisionComparison | null;
  blocks: RevisionBlockDetails[];
  rows: RevisionRow[];
  runs: number[];
}

export function chartCollections(node: PMNode, comparison: RevisionComparison | null): string[] {
  if (node.type.name !== "chart" || comparison === null) return [];
  try {
    const mapping: unknown = JSON.parse(node.attrs.revisionSource ?? node.textContent);
    const collection = mapping !== null && typeof mapping === "object" && "collection" in mapping ? mapping.collection : null;
    return comparison.data.some((change) => change.name === collection) ? [String(collection)] : [];
  } catch { return []; }
}

function visualBlock(node: PMNode): boolean {
  return node.type.name === "chart" || node.type.name === "code" && ["ablauf", "wireframe", "json-tree"].includes(String(node.attrs.language));
}

function pairedVisuals(before: PMNode, after: PMNode): { node: PMNode; side: RevisionSide; kind: "added" | "removed" }[] {
  const ablauf = before.type.name === "code" && after.type.name === "code"
    && before.attrs.language === "ablauf" && after.attrs.language === "ablauf" && before.textContent !== after.textContent;
  const version = (own: PMNode, other: PMNode, side: RevisionSide): PMNode => ablauf
    ? own.type.create({ ...own.attrs, revisionOtherSource: other.textContent, revisionSide: side }, own.content, own.marks)
    : visualBlock(own) ? own : markTree(own, side === "before" ? "removed" : "added");
  return [{ node: version(before, after, "before"), side: "before", kind: "removed" },
    { node: version(after, before, "after"), side: "after", kind: "added" }];
}

function comparisonRow(change: RevisionBlockComparison, before: PMNode | undefined, after: PMNode | undefined,
  node: PMNode, comparison: RevisionComparison | null, at: number): RevisionRow {
  const changed = change.kind !== "unchanged" || revisionFields(change).length > 0
    || change.spans.some((span) => span.kind !== "unchanged")
    || [before, after].some((entry) => entry !== undefined && chartCollections(entry, comparison).length > 0);
  return {
    kind: changed && change.kind === "unchanged" ? "changed" : change.kind,
    at, changed,
    ...(node.type.name === "heading" && node.textContent !== "" ? { heading: node.textContent } : {}),
    before: { labels: [], filler: before === undefined }, after: { labels: [], filler: after === undefined },
    ...(changed && (visualBlock(node) || before !== undefined && visualBlock(before)) ? { separateChange: true } : {}),
  };
}

function foldInlineRows(rows: RevisionRow[], nodes: PMNode[], blocks: RevisionBlockDetails[],
  runs: { start: number; end: number }[], folding: RevisionFolding): { rows: RevisionRow[]; nodes: PMNode[]; blocks: RevisionBlockDetails[] } {
  const shown = { rows: [] as RevisionRow[], nodes: [] as PMNode[], blocks: [] as RevisionBlockDetails[] };
  const collapsed = new Map(runs.filter((run) => folding.collapse && !folding.expanded.has(run.start)).map((run) => [run.start, run]));
  let nodeIndex = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const run = collapsed.get(index);
    if (run !== undefined) {
      const count = run.end - run.start + 1;
      const headings = rows.slice(run.start, run.end + 1).flatMap((entry) => entry.heading === undefined ? [] : [entry.heading]).join(", ");
      const hidden = nodes.slice(nodeIndex, nodeIndex + count);
      const levels = hidden.filter((entry) => entry.type.name === "heading").map((entry) => Number(entry.attrs.level));
      const fold = revisionSchema.nodes.revisionFold;
      if (fold === undefined) throw new Error("Revision fold is missing");
      shown.nodes.push(fold.create({ run: run.start, count, headings, headingLevel: levels.length === 0 ? null : Math.min(...levels) }));
      shown.rows.push({ kind: "folded", at: run.start, changed: false, fold: { run: run.start, count },
        before: { labels: [], filler: false }, after: { labels: [], filler: false } });
      shown.blocks.push({ kind: "folded", at: run.start, fields: [], widthsOnly: false, dataCollections: [], showSource: false });
      nodeIndex += count;
      index = run.end;
      continue;
    }
    shown.rows.push(row);
    while (blocks[nodeIndex]?.at === row.at) {
      const block = blocks[nodeIndex];
      const node = nodes[nodeIndex];
      if (block !== undefined && node !== undefined) { shown.blocks.push(block); shown.nodes.push(node); }
      nodeIndex += 1;
    }
  }
  return shown;
}

export function revisionViewModel(before: Y.Doc | null, after: Y.Doc,
  folding: RevisionFolding = { collapse: false, expanded: new Set() }): RevisionViewModel {
  const oldNodes = before === null ? [] : visibleNodes(before);
  const newNodes = visibleNodes(after);
  const comparison = before === null ? null : compareRevisions(before, after);
  const changes = comparison?.blocks ?? newNodes.map((_, index): RevisionBlockComparison => ({ kind: "unchanged", afterIndex: index, fields: [], spans: [] }));
  const nodes: PMNode[] = [];
  const blocks: RevisionBlockDetails[] = [];
  const rows: RevisionRow[] = [];
  const append = (node: PMNode, kind: RevisionRowKind, fields: string[], widthsOnly = false, side?: RevisionSide): void => {
    // A removed and an added copy can share authored identity; the live editor stays mounted too.
    nodes.push(node.type.create({
      ...node.attrs, id: `revision-${nodes.length}-${node.attrs.id ?? ""}`,
      ...(node.type.name === "chart" ? { revisionRemoved: kind === "removed" } : {}),
    }, node.content, node.marks));
    blocks.push({
      kind, at: rows.length - 1, ...(side === undefined ? {} : { side }), fields, widthsOnly, dataCollections: chartCollections(node, comparison),
      showSource: SOURCE_NODES.has(node.type.name) && !visualBlock(node) && kind !== "unchanged",
    });
  };
  for (const change of changes) {
    const oldNode = change.beforeIndex === undefined ? undefined : oldNodes[change.beforeIndex];
    const newNode = change.afterIndex === undefined ? undefined : newNodes[change.afterIndex];
    let node = newNode ?? oldNode;
    if (node === undefined) throw new Error("Revision comparison refers to missing content");
    const fields = revisionFields(change);
    const row = comparisonRow(change, oldNode, newNode, node, comparison, rows.length);
    rows.push(row);
    if (oldNode && newNode && row.changed && (visualBlock(oldNode) || visualBlock(newNode))) {
      for (const version of pairedVisuals(oldNode, newNode)) append(version.node, version.kind, fields, false, version.side);
      continue;
    }
    // These comparisons intentionally have no shared text address space.
    if (oldNode && newNode && (change.fields.includes("content") || change.fields.includes("columns"))) {
      append(markTree(oldNode, "removed"), "removed", fields);
      append(markTree(newNode, "added"), "added", fields);
      continue;
    }
    if (change.kind === "removed" || change.kind === "added") node = markTree(node, change.kind);
    else if (oldNode && newNode && change.spans.length > 0 && oldNode.isTextblock && newNode.isTextblock) node = inlineChanges(oldNode, newNode, change.spans);
    else if (oldNode?.type.name === "table" && newNode?.type.name === "table") node = tableChanges(oldNode, newNode, change);
    append(node, change.kind, fields, node.type.name === "table" && isColumnWidthsOnly(change));
  }
  const runs = before === null ? [] : unchangedRuns(rows);
  const shown = foldInlineRows(rows, nodes, blocks, runs, folding);
  const content = revisionSchema.topNodeType.create(null, shown.nodes.length ? Fragment.fromArray(shown.nodes) : revisionSchema.nodes.paragraph?.create()).toJSON() as JSONContent;
  return { content, comparison, blocks: shown.blocks, rows: shown.rows, runs: runs.map((run) => run.start) };
}

export function copiedContent(content: Fragment): Fragment {
  const nodes: PMNode[] = [];
  content.forEach((node) => {
    if (node.type.name === "revisionFiller" || node.type.name === "revisionFold") return;
    if (node.type.name === "revisionJsonCompare" || node.type.name === "revisionJsonPlaceholder") {
      const code = revisionSchema.nodes.code;
      const text = String(node.type.name === "revisionJsonCompare" ? node.attrs.after : node.attrs.before);
      if (code !== undefined) nodes.push(code.create({ language: "json-tree" }, text === "" ? [] : revisionSchema.text(text)));
      return;
    }
    const marks = node.marks.filter((mark) => mark.type.name !== "removed" && mark.type.name !== "revisionAdded");
    nodes.push(node.isText ? node.mark(marks) : node.type.create(
      { ...node.attrs, ...("id" in node.attrs ? { id: null } : {}) },
      copiedContent(node.content), marks,
    ));
  });
  return Fragment.fromArray(nodes);
}

const revisionRows = new PluginKey<RevisionViewModel>("revisionInlineRows");

function blockLabels(block: RevisionBlockDetails): string[] {
  const version = block.side === "before" ? "Before" : block.side === "after" ? "After"
    : block.kind === "added" ? "Added block" : block.kind === "removed" ? "Removed block" : null;
  return [
    ...(version === null ? [] : [version]),
    ...(block.fields.length ? [`Changed: ${block.fields.join(", ")}`] : []),
    ...block.dataCollections.map((name) => `Data changed: ${name}`),
  ];
}

function revisionPresentation(model: RevisionViewModel, docLinks: DocLinkContext | null): Extension {
  return Extension.create({
    name: "revisionPresentation",
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
        state: { init: () => model, apply: (transaction, current) => transaction.getMeta(revisionRows) ?? current },
        filterTransaction: (transaction) => !transaction.docChanged || transaction.getMeta(revisionRows) !== undefined,
        props: {
          handleDOMEvents: {
            keydown: (_view, event) => event.key === "Tab" ||
              event.target instanceof Element && event.target.closest(".ub-revision-fold-button") !== null,
            keypress: (_view, event) => event.target instanceof Element && event.target.closest(".ub-revision-fold-button") !== null,
          },
          transformCopied: (slice) => new Slice(copiedContent(slice.content), slice.openStart, slice.openEnd),
          decorations(state) {
            const decorations: Decoration[] = [];
            const current = revisionRows.getState(state);
            if (current === undefined) return null;
            const rowIndices = new Map(current.rows.map((row, index) => [row.at, index]));
            state.doc.forEach((node, pos, index) => {
              const block = current.blocks[index];
              if (!block) return;
              const rowIndex = rowIndices.get(block.at);
              const row = rowIndex === undefined ? undefined : current.rows[rowIndex];
              const classes = [`ub-revision-block-${block.kind}`, "ub-revision-row", `ub-revision-row-${row?.kind ?? block.kind}`];
              if (block.showSource) classes.push("ub-revision-source-changed", "ub-ablauf-editing", "ub-json-tree-editing", "ub-wireframe-editing", "ub-terminal-editing", "ub-chart-editing");
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: classes.join(" "), "data-revision-block": block.kind,
                "data-revision-row": row?.kind ?? block.kind }));
              const labels = blockLabels(block);
              const first = current.blocks[index - 1]?.at !== block.at;
              const last = current.blocks[index + 1]?.at !== block.at;
              if (first || labels.length > 0) decorations.push(Decoration.widget(pos, () => {
                const start = document.createElement(first ? "div" : "span");
                if (first && row !== undefined) {
                  start.className = "ub-revision-row-start";
                  start.dataset.row = String(rowIndex);
                  start.dataset.key = `${row.kind === "folded" ? "fold" : "row"}-${row.at}`;
                }
                if (labels.length > 0) {
                  const label = block.widthsOnly ? columnWidthsCaption(node) : document.createElement("span");
                  if (!block.widthsOnly) { label.className = "ub-revision-fields"; label.textContent = labels.join(" · "); }
                  start.appendChild(label);
                }
                return start;
              }, { side: -1, key: `revision-row-start:${index}:${block.kind}:${block.at}:${labels.join("|")}`, ignoreSelection: true }));
              if (last) decorations.push(Decoration.widget(pos + node.nodeSize, () => {
                const end = document.createElement("div");
                end.className = "ub-revision-row-end";
                end.dataset.row = String(rowIndex);
                end.setAttribute("aria-hidden", "true");
                return end;
              }, { side: -2, key: `revision-row-end:${index}:${block.kind}:${block.at}`, ignoreSelection: true }));
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

export interface CreateRevisionEditorOptions {
  element: Element | null;
  before: Y.Doc | null;
  after: Y.Doc;
  docLinks?: DocLinkContext | null;
  workspaceSettings?: Y.Doc | null;
  folding?: RevisionFolding;
  onExpand?: (run: number) => void;
}

export interface RevisionInline {
  model: RevisionViewModel;
  editor: Editor;
  expand: (run: number) => void;
  setCollapse: (collapse: boolean) => void;
  destroy: () => void;
}

export function createRevisionInline(options: CreateRevisionEditorOptions): RevisionInline {
  let model = revisionViewModel(options.before, options.after, options.folding);
  const expanded = new Set(options.folding?.expanded);
  const editor = new Editor({
    element: options.element,
    extensions: [
      ...revisionPalette(options.after, options.before), revisionPresentation(model, options.docLinks ?? null),
      CodeHighlighting, ListBlocks, CardBlocks, TerminalBlocks, ChartBlocks, WireframeBlocks, AblaufBlocks, JsonTreeBlocks,
      DocLinks.configure({ context: options.docLinks ?? null }), ExternalLinks,
      GitHubLinks.configure({ settings: options.workspaceSettings ?? null }), InlineIcons, PersonMentions, ToggleHeadings,
    ],
    content: model.content,
    editable: false,
    enableCoreExtensions: { editable: false },
    editorProps: {
      editable: () => true,
      attributes: { role: "textbox", "aria-label": "Revision comparison", "aria-readonly": "true", "aria-multiline": "true", inputmode: "none" },
      handleDOMEvents: { beforeinput: (_view, event) => { event.preventDefault(); return true; } },
    },
    enableContentCheck: true,
    injectCSS: false,
  });
  // A default text caret in the first chart would open its source on arrival.
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  const apply = (next: RevisionViewModel): void => {
    const transaction = editor.state.tr;
    for (const run of [...model.runs].reverse()) {
      const oldFold = model.rows.find((row) => row.at === run)?.fold;
      const newFold = next.rows.find((row) => row.at === run)?.fold;
      if ((oldFold === undefined) === (newFold === undefined)) continue;
      const index = model.blocks.findIndex((block) => block.at === run);
      const start = next.blocks.findIndex((block) => block.at === run);
      let position = 0;
      for (let node = 0; node < index; node += 1) position += editor.state.doc.child(node).nodeSize;
      let end = position;
      for (let node = index; node < index + (oldFold === undefined ? newFold?.count ?? 0 : 1); node += 1) end += editor.state.doc.child(node).nodeSize;
      const replacement = Fragment.fromArray((next.content.content ?? []).slice(start, start + (oldFold?.count ?? 1))
        .map((node) => editor.schema.nodeFromJSON(node)));
      transaction.replaceWith(position, end, replacement);
    }
    editor.view.dispatch(transaction.setMeta(revisionRows, next));
    model = next;
  };
  const inline: RevisionInline = {
    get model() { return model; }, editor,
    expand: (run) => {
      if (!model.rows.some((row) => row.fold?.run === run)) return;
      expanded.add(run);
      apply(revisionViewModel(options.before, options.after, { collapse: true, expanded }));
    },
    setCollapse: (collapse) => {
      expanded.clear();
      apply(revisionViewModel(options.before, options.after, { collapse, expanded }));
    },
    destroy: () => { editor.destroy(); },
  };
  const expand = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>(".ub-revision-fold-button") : null;
    if (button === null) return;
    event.preventDefault();
    const run = Number(button.dataset.fold);
    if (options.onExpand !== undefined) options.onExpand(run);
    else inline.expand(run);
  };
  editor.view.dom.addEventListener("click", expand);
  editor.on("destroy", () => { editor.view.dom.removeEventListener("click", expand); });
  return inline;
}

export function createRevisionEditor(options: CreateRevisionEditorOptions): Editor {
  return createRevisionInline(options).editor;
}
