/**
 * Match schema-owned nodes, attributes and marks exactly: updateYFragment drops
 * undeclared attributes and a wider palette writes unreadable shapes.
 *
 * Refuse binding before y-prosemirror can delete unknown elements or texts with
 * unknown marks. Scan recursively: disallowed/invalid marks, unsafe link values
 * and non-string inserts can change meaning or disappear on the next edit.
 * Link/docLink overlaps also need the reader's precedence: y-prosemirror builds
 * both marks without honoring excludes and would render nested anchors.
 *
 * No catch-all schema node can preserve these shapes. Leave all foreign content
 * untouched and show the read-only fallback instead.
 */

import * as Y from "yjs";
import { isBlockType, readsAsMark, isSupportedCard, isSupportedFigma, isSupportedTable, structuredInlineParts } from "@uberblick/schema";
import type { CardPart } from "@uberblick/schema";
import { uberblickSchema } from "./create-editor.js";

/**
 * Distinguish an overlap of supported link marks from an unsupported mark so
 * the fallback can offer the correct recovery.
 */
export const LINK_CONFLICT = "#conflict:link+docLink";

/** Content in the `blocks` fragment that the palette cannot render. */
export interface ForeignBlock {
  /** Position of the *top-level* element in the fragment, in document order. */
  index: number;
  /**
   * Unknown nodes, stray #text/#hook, undeclared #mark:<name>, non-string #embed,
   * or a supported-link overlap. Link conflicts require a choice, not support.
   */
  nodeName: string;
  /** The element's `id` attribute, when it has one. */
  id: string | null;
  /** First 80 characters of the element's text, for the loud placeholder. */
  preview: string;
}

function previewOf(child: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  const text = child instanceof Y.XmlElement ? child.toString() : String(child);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** Whether `blockName`'s node type allows `mark`, read off the editor's schema. */
function blockAllowsMark(blockName: string, mark: string): boolean {
  const node = uberblickSchema.nodes[blockName];
  const type = uberblickSchema.marks[mark];
  return node !== undefined && type !== undefined && node.allowsMarkType(type);
}

/**
 * Allow only string-inserting Y.XmlText children with valid marks permitted by
 * the parent block; known block names alone are insufficient.
 */
function foreignInsideBlock(
  blockName: string,
  child: Y.XmlElement | Y.XmlText | Y.XmlHook,
): string | null {
  if (child instanceof Y.XmlElement) return child.nodeName;
  if (!(child instanceof Y.XmlText)) return "#hook";
  for (const op of child.toDelta() as Array<{
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }>) {
    // Embeds have no ProseMirror equivalent, so binding drops them from the
    // editor state and the next edit writes the text back without them.
    if (typeof op.insert !== "string") return "#embed";
    for (const [mark, value] of Object.entries(op.attributes ?? {})) {
      if (!blockAllowsMark(blockName, mark)) return `#mark:${mark}`;
      // Match reader validity; y-prosemirror otherwise promotes invalid attrs into marks.
      if (!readsAsMark(mark, value)) return `#mark:${mark}`;
      // Match reader precedence: y-prosemirror ignores excludes and would bind
      // both links. Retain the CRDT marks until an explicit choice resolves them.
      if (mark === "link" && readsAsMark("docLink", op.attributes?.docLink)) {
        return LINK_CONFLICT;
      }
    }
  }
  return null;
}

function isEditorBlockType(name: string): boolean {
  return isBlockType(name) && uberblickSchema.nodes[name] !== undefined;
}

/** Undefined denotes prose; null denotes a supported non-prose shape. */
function shapeProblem(child: Y.XmlElement): string | null | undefined {
  switch (child.nodeName) {
    case "divider": return child.length === 0 ? null : "#divider-shape";
    case "figma": return isSupportedFigma(child) ? null : "#figma-shape";
    case "table": return isSupportedTable(child) ? null : "#table-shape";
    case "card": return isSupportedCard(child) ? null : "#card-shape";
    default: return undefined;
  }
}

/**
 * Return one offender per top-level block. Stray text/hooks are foreign because
 * the doc schema accepts block+ only; an empty result permits binding.
 */
export function findForeignBlocks(fragment: Y.XmlFragment): ForeignBlock[] {
  const foreign: ForeignBlock[] = [];
  const children = fragment.toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    if (!(child instanceof Y.XmlElement)) {
      foreign.push({
        index,
        nodeName: child instanceof Y.XmlText ? "#text" : "#hook",
        id: null,
        preview: previewOf(child),
      });
      continue;
    }
    const id = child.getAttribute("id") ?? null;
    if (!isEditorBlockType(child.nodeName)) {
      foreign.push({ index, nodeName: child.nodeName, id, preview: previewOf(child) });
      continue;
    }
    const shape = shapeProblem(child);
    if (shape !== undefined) {
      const nodeName = shape ?? (hasStructuredLinkConflicts(child) ? LINK_CONFLICT : null);
      if (nodeName !== null) foreign.push({ index, nodeName, id, preview: previewOf(child) });
      continue;
    }
    for (const inner of child.toArray()) {
      const nodeName = foreignInsideBlock(child.nodeName, inner);
      if (nodeName === null) continue;
      // One entry per block: the count in the banner is a block count.
      foreign.push({ index, nodeName, id, preview: previewOf(child) });
      break;
    }
  }
  return foreign;
}

/**
 * Retain the live Y.XmlText handle for repairs: concurrent retypes can duplicate
 * block ids and blocks can contain multiple text children. Ids and indices are
 * display keys, not write targets.
 */
interface LinkConflictRange {
  /** Start of the range, in Yjs format indices — an embed counts as one. */
  start: number;
  /** End of the range, exclusive. */
  end: number;
  /** The range's own characters: which words on screen carry both marks. */
  label: string;
  /** The external target. */
  href: string;
  /** The referenced document's uuid. */
  docId: string;
}

export interface LinkConflict extends LinkConflictRange {
  /** Position of the *top-level* element in the fragment, in document order. */
  index: number;
  /** Position of the text child inside the block or the cell's paragraph. */
  textIndex: number;
  /** Position of the table cell, absent for prose. Display, never lookup. */
  cell?: { row: number; column: number };
  /** Structured prose part, absent for other block types. Display, never lookup. */
  part?: CardPart | "caption";
  /** The element's `id` attribute, when it has one. Display, never lookup. */
  blockId: string | null;
  /** The text holding the range, and the handle the repair writes through. */
  text: Y.XmlText;
}

/** The two targets of one delta op, when it carries both link marks. */
function linkPair(op: {
  insert?: unknown;
  attributes?: Record<string, unknown>;
}): { href: string; docId: string } | null {
  if (typeof op.insert !== "string") return null;
  const attributes = op.attributes ?? {};
  // Only reader-valid marks can participate in a conflict.
  if (!readsAsMark("link", attributes.link)) return null;
  if (!readsAsMark("docLink", attributes.docLink)) return null;
  return {
    href: (attributes.link as { href: string }).href,
    docId: (attributes.docLink as { docId: string }).docId,
  };
}

/**
 * Merge adjacent delta ops only when href/docId agree, ignoring other marks.
 * Use this same range definition for listing and repair re-reads.
 */
export function linkConflictsIn(text: Y.XmlText): LinkConflictRange[] {
  const ranges: LinkConflictRange[] = [];
  let offset = 0;
  let open: { start: number; label: string; href: string; docId: string } | null =
    null;
  const close = (end: number): void => {
    if (open !== null) ranges.push({ ...open, end });
    open = null;
  };
  for (const op of text.toDelta() as Array<{
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }>) {
    const pair = linkPair(op);
    if (open !== null && (pair === null || pair.href !== open.href || pair.docId !== open.docId)) {
      close(offset);
    }
    if (pair !== null) {
      if (open === null) open = { start: offset, label: "", ...pair };
      open.label += op.insert as string;
    }
    // An embed is one index to Yjs' formatter, so it is one index here too:
    // these offsets are what `Y.XmlText.format` is called with.
    offset += typeof op.insert === "string" ? op.insert.length : 1;
  }
  close(offset);
  return ranges;
}

/**
 * Scan all conflicts separately from findForeignBlocks, whose first-offender
 * limit would hide repairs. Only prose permitting both marks can be repaired;
 * the same pair in source is a disallowed-mark problem.
 */
function hasStructuredLinkConflicts(child: Y.XmlElement): boolean {
  return structuredInlineParts(child).some(({ texts }) => texts.some((text) => linkConflictsIn(text).length > 0));
}

function structuredLinkConflicts(child: Y.XmlElement, index: number, blockId: string | null): LinkConflict[] {
  return structuredInlineParts(child).flatMap((entry) => entry.texts.flatMap((text, textIndex) =>
    linkConflictsIn(text).map((range) => ({
      ...range, index, textIndex, blockId, text,
      ...(entry.kind === "table" ? { cell: { row: entry.row, column: entry.column } } : { part: entry.part }),
    })),
  ));
}

export function findLinkConflicts(fragment: Y.XmlFragment): LinkConflict[] {
  const conflicts: LinkConflict[] = [];
  const children = fragment.toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!(child instanceof Y.XmlElement)) continue;
    if (!isBlockType(child.nodeName)) continue;
    const blockId = child.getAttribute("id") ?? null;
    if (child.nodeName === "card" || child.nodeName === "figma" || child.nodeName === "table") {
      conflicts.push(...structuredLinkConflicts(child, index, blockId));
      continue;
    }
    if (!blockAllowsMark(child.nodeName, "link")) continue;
    if (!blockAllowsMark(child.nodeName, "docLink")) continue;
    const innerNodes = child.toArray();
    for (let textIndex = 0; textIndex < innerNodes.length; textIndex += 1) {
      const inner = innerNodes[textIndex];
      if (!(inner instanceof Y.XmlText)) continue;
      for (const range of linkConflictsIn(inner)) {
        conflicts.push({ ...range, index, textIndex, blockId, text: inner });
      }
    }
  }
  return conflicts;
}

/**
 * Separate unsupported shapes from supported-link conflicts and their recovery.
 * Archived content offers no repair; decided content needs a new record and
 * cannot regain editing by repair or restore.
 */
export function describeForeignBlocks(
  foreign: ForeignBlock[],
  options: { repairable?: boolean; decision?: boolean } = {},
): string {
  if (foreign.length === 0) return "";
  const blocks = (count: number): string =>
    `${count} block${count === 1 ? "" : "s"}`;
  const conflicting = foreign.filter((block) => block.nodeName === LINK_CONFLICT);
  const unsupported = foreign.filter((block) => block.nodeName !== LINK_CONFLICT);
  const sentences: string[] = [];
  if (unsupported.length > 0) {
    const names = [...new Set(unsupported.map((block) => block.nodeName))].join(
      ", ",
    );
    sentences.push(
      `${blocks(unsupported.length)} of unsupported type (${names}) — editing is disabled so nothing gets destroyed.`,
    );
  }
  if (conflicting.length > 0) {
    sentences.push(
      options.decision
        ? `${blocks(conflicting.length)} with conflicting external and document links on one range — both are retained; decision content is read-only in the web.`
        : options.repairable === false
        ? `${blocks(conflicting.length)} with conflicting external and document links on one range — both are retained; restore this document to choose which link each range keeps.`
        : `${blocks(conflicting.length)} with conflicting external and document links on one range — both are retained; choose below which link each range keeps, and editing resumes.`,
    );
  }
  return sentences.join(" ");
}
