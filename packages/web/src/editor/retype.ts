/**
 * Retype with setNodeMarkup, preserving the block id and marked text rather
 * than deleting/reinserting its logical identity. y-prosemirror still replaces
 * the underlying element/text because node names differ: concurrent edits to
 * the replaced text can be lost.
 */

import type { Transaction } from "@tiptap/pm/state";
import { BLOCK_TYPES } from "@uberblick/schema";
import type { BlockType, HeadingLevel, ListStyle } from "@uberblick/schema";
import { renderableIndent } from "./nodes.js";

export interface RetypeAttrs {
  /** Heading level, 1–6. Ignored for other types. */
  level?: HeadingLevel;
  /** Code language. Ignored for other types. */
  language?: string;
  /** List marker. Ignored for other types. */
  list?: ListStyle;
  /** List depth, 0–3. Ignored for other types. */
  indent?: number;
}

function attrString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Refuse missing blocks, unchanged types/attrs and unsupported content without
 * mutating tr or throwing. validContent checks marks too: prose-to-source must
 * not strip formatting to fit. Read tr.doc so earlier slash-consumption steps
 * and retyping compose into the same undo transaction.
 */
export function retypeBlockInTransaction(
  tr: Transaction,
  pos: number,
  type: BlockType,
  attrs: RetypeAttrs = {},
): boolean {
  const node = tr.doc.nodeAt(pos);
  if (node === null) return false;
  const currentType = node.type.name;
  if (currentType === "card" || type === "card" || currentType === "figma" || type === "figma") return false;
  if (!(BLOCK_TYPES as readonly string[]).includes(currentType)) return false;

  const nodeType = tr.doc.type.schema.nodes[type];
  if (nodeType === undefined) return false;

  // Attributes are strings, matching what the schema package stores — see
  // editor/nodes.ts. The id is carried over, never regenerated.
  const next: Record<string, unknown> = { id: node.attrs.id };
  if (type === "heading") {
    next.level = String(
      attrs.level ??
        (currentType === "heading" ? attrString(node.attrs.level) ?? "1" : "1"),
    );
  }
  if (type === "code") {
    next.language =
      attrs.language ??
      (currentType === "code" ? attrString(node.attrs.language) : null);
  }
  if (type === "list-item") {
    const wasItem = currentType === "list-item";
    next.list =
      attrs.list ?? (wasItem ? attrString(node.attrs.list) ?? "bullet" : "bullet");
    next.indent = String(
      attrs.indent ?? (wasItem ? renderableIndent(node.attrs.indent) : 0),
    );
  }

  // Normalize absent attrs to null so no-ops do not become writes.
  const unchanged =
    currentType === type &&
    (next.level ?? null) === attrString(node.attrs.level) &&
    (next.language ?? null) === attrString(node.attrs.language) &&
    (next.list ?? null) === attrString(node.attrs.list) &&
    (next.indent ?? null) === attrString(node.attrs.indent);
  if (unchanged) return false;

  if (!nodeType.validContent(node.content)) return false;

  tr.setNodeMarkup(pos, nodeType, next);
  return true;
}
