/** Revision presentation is a ProseMirror projection with no Yjs binding. */
import { Editor, Extension, Mark, Node as TiptapNode, getSchema } from "@tiptap/core";
import type { Extensions, JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AllSelection, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  COMMENT_MARK, compareRevisions, getBlocksFragment,
} from "@uberblick/schema";
import type { RevisionBlockComparison, RevisionComparison, TextSpan } from "@uberblick/schema";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import type * as Y from "yjs";
import { AblaufBlocks } from "./ablauf.js";
import { JsonTreeBlocks } from "./json-tree.js";
import { CardBlocks } from "./card.js";
import { ChartBlocks, chartBlockView } from "./chart.js";
import { DocLinks } from "./doc-links.js";
import type { DocLinkContext } from "./doc-links.js";
import { ExternalLinks } from "./external-links.js";
import { GitHubLinks } from "./github-links.js";
import { InlineIcons } from "./inline-icons.js";
import { ListBlocks } from "./list-keys.js";
import { PROSE_MARKS } from "./marks.js";
import { ChartBlock, paletteExtensions } from "./nodes.js";
import { findForeignBlocks } from "./palette.js";
import { CodeHighlighting } from "./syntax-highlighting.js";
import { TerminalBlocks } from "./terminal.js";
import { ToggleHeadings } from "./toggle-headings.js";
import { WireframeBlocks } from "./wireframe.js";

export const SOURCE_NODES = new Set(["code", "terminal", "chart"]);
const INLINE_NODES = new Set(["paragraph", "heading", "list-item", "quote", ...SOURCE_NODES]);

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
  addAttributes: () => ({ run: { default: 0 }, count: { default: 0 }, headings: { default: "" } }),
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
          ...(this.name === "chart" ? { revisionRemoved: { default: false, rendered: false } } : {}),
        };
      },
      addNodeView() {
        const render = this.parent?.();
        if (render == null) throw new Error("Revision source requires its ordinary node view");
        return (props) => {
          // A removed chart's mapping and collection belong to the same predecessor.
          const selected = this.name === "chart" && props.node.attrs.revisionRemoved === true && before !== null
            ? chartBlockView(before) : render;
          const view = selected({ ...props, node: drawingNode(props.node) });
          const update = view.update;
          view.update = (node, decorations, inner) => update?.(drawingNode(node), decorations, inner) ?? false;
          return view;
        };
      },
    });
  }), Added, Removed, Filler, Fold];
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
  kind: RevisionBlockComparison["kind"];
  fields: string[];
  dataCollections: string[];
  showSource: boolean;
}

export interface RevisionViewModel {
  content: JSONContent;
  comparison: RevisionComparison | null;
  blocks: RevisionBlockDetails[];
}

export function chartCollections(node: PMNode, comparison: RevisionComparison | null): string[] {
  if (node.type.name !== "chart" || comparison === null) return [];
  try {
    const mapping: unknown = JSON.parse(node.attrs.revisionSource ?? node.textContent);
    const collection = mapping !== null && typeof mapping === "object" && "collection" in mapping ? mapping.collection : null;
    return comparison.data.some((change) => change.name === collection) ? [String(collection)] : [];
  } catch { return []; }
}

export function revisionViewModel(before: Y.Doc | null, after: Y.Doc): RevisionViewModel {
  const oldNodes = before === null ? [] : visibleNodes(before);
  const newNodes = visibleNodes(after);
  const comparison = before === null ? null : compareRevisions(before, after);
  const changes = comparison?.blocks ?? newNodes.map((_, index): RevisionBlockComparison => ({ kind: "unchanged", afterIndex: index, fields: [], spans: [] }));
  const nodes: PMNode[] = [];
  const blocks: RevisionBlockDetails[] = [];
  const append = (node: PMNode, kind: RevisionBlockComparison["kind"], fields: string[]): void => {
    // A removed and an added copy can share authored identity; the live editor stays mounted too.
    nodes.push(node.type.create({
      ...node.attrs, id: `revision-${nodes.length}-${node.attrs.id ?? ""}`,
      ...(node.type.name === "chart" ? { revisionRemoved: kind === "removed" } : {}),
    }, node.content, node.marks));
    blocks.push({
      kind, fields, dataCollections: chartCollections(node, comparison),
      showSource: SOURCE_NODES.has(node.type.name) && kind !== "unchanged",
    });
  };
  for (const change of changes) {
    const oldNode = change.beforeIndex === undefined ? undefined : oldNodes[change.beforeIndex];
    const newNode = change.afterIndex === undefined ? undefined : newNodes[change.afterIndex];
    let node = newNode ?? oldNode;
    if (node === undefined) throw new Error("Revision comparison refers to missing content");
    // These comparisons intentionally have no shared text address space.
    if (oldNode && newNode && (change.fields.includes("content") || change.fields.includes("columns"))) {
      append(markTree(oldNode, "removed"), "removed", change.fields);
      append(markTree(newNode, "added"), "added", change.fields);
      continue;
    }
    if (change.kind === "removed" || change.kind === "added") node = markTree(node, change.kind);
    else if (oldNode && newNode && change.spans.length > 0 && oldNode.isTextblock && newNode.isTextblock) node = inlineChanges(oldNode, newNode, change.spans);
    else if (oldNode?.type.name === "table" && newNode?.type.name === "table") node = tableChanges(oldNode, newNode, change);
    const fields = [...change.fields];
    for (const row of change.rows ?? []) {
      for (const cell of row.cells ?? []) {
        for (const field of cell.fields) fields.push(`row ${(row.afterIndex ?? row.beforeIndex ?? 0) + 1}, column ${cell.column + 1}: ${field}`);
      }
    }
    append(node, change.kind, fields);
  }
  const content = revisionSchema.topNodeType.create(null, nodes.length ? Fragment.fromArray(nodes) : revisionSchema.nodes.paragraph?.create()).toJSON() as JSONContent;
  return { content, comparison, blocks };
}

export function copiedContent(content: Fragment): Fragment {
  const nodes: PMNode[] = [];
  content.forEach((node) => {
    if (node.type.name === "revisionFiller" || node.type.name === "revisionFold") return;
    const marks = node.marks.filter((mark) => mark.type.name !== "removed" && mark.type.name !== "revisionAdded");
    nodes.push(node.isText ? node.mark(marks) : node.type.create(
      { ...node.attrs, ...("id" in node.attrs ? { id: null } : {}) },
      copiedContent(node.content), marks,
    ));
  });
  return Fragment.fromArray(nodes);
}

function revisionPresentation(blocks: readonly RevisionBlockDetails[]): Extension {
  return Extension.create({
    name: "revisionPresentation",
    priority: 2000,
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction: (transaction) => !transaction.docChanged,
        props: {
          transformCopied: (slice) => new Slice(copiedContent(slice.content), slice.openStart, slice.openEnd),
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.forEach((node, pos, index) => {
              const block = blocks[index];
              if (!block) return;
              const classes = [`ub-revision-block-${block.kind}`];
              if (block.showSource) classes.push("ub-revision-source-changed", "ub-ablauf-editing", "ub-json-tree-editing", "ub-wireframe-editing", "ub-terminal-editing", "ub-chart-editing");
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: classes.join(" "), "data-revision-block": block.kind }));
              const labels = [
                ...(block.kind === "added" ? ["Added block"] : block.kind === "removed" ? ["Removed block"] : []),
                ...(block.fields.length ? [`Changed: ${block.fields.join(", ")}`] : []),
                ...block.dataCollections.map((name) => `Data changed: ${name}`),
              ];
              if (labels.length) decorations.push(Decoration.widget(pos, () => {
                const label = document.createElement("span");
                label.className = "ub-revision-fields";
                label.textContent = labels.join(" · ");
                return label;
              }, { side: -1, key: `revision-details:${index}` }));
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
}

export function createRevisionEditor(options: CreateRevisionEditorOptions): Editor {
  const model = revisionViewModel(options.before, options.after);
  const editor = new Editor({
    element: options.element,
    extensions: [
      ...revisionPalette(options.after, options.before), revisionPresentation(model.blocks),
      CodeHighlighting, ListBlocks, CardBlocks, TerminalBlocks, ChartBlocks, WireframeBlocks, AblaufBlocks, JsonTreeBlocks,
      DocLinks.configure({ context: options.docLinks ?? null }), ExternalLinks,
      GitHubLinks.configure({ settings: options.workspaceSettings ?? null }), InlineIcons, ToggleHeadings,
    ],
    content: model.content,
    editable: false,
    enableContentCheck: true,
    injectCSS: false,
  });
  // A default text caret in the first chart would open its source on arrival.
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  return editor;
}
