/**
 * Non-cryptographic 64-bit content detector (FNV-1a + djb2), not a version or
 * checksum. Type, text and attributes participate; prose marks and thread
 * anchors do not. Table text is marked GFM, so cell formatting affects its rev.
 * Annotations never invalidate prepared edits.
 */

import type { BlockType, HeadingLevel, ListIndent, ListStyle } from "./types.js";

export interface RevInput {
  type: BlockType;
  text: string;
  level?: HeadingLevel | undefined;
  language?: string | undefined;
  list?: ListStyle | undefined;
  indent?: ListIndent | undefined;
  variant?: string | undefined;
  icon?: string | undefined;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = Math.imul(hash, 33) + input.charCodeAt(i);
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/**
 * UTF-16 indexing matches Yjs across processes/platforms. JSON field boundaries
 * prevent ambiguous concatenation before hashing.
 */
export function blockRev(input: RevInput): string {
  const fields: unknown[] = input.type === "divider" ? ["divider"] : [
    input.type,
    input.level ?? null,
    input.language ?? null,
    input.list ?? null,
    input.indent ?? null,
    input.text,
  ];
  if (input.type === "callout") fields.push(input.variant ?? null, input.icon ?? null);
  const canonical = JSON.stringify(fields);
  return `${hex8(fnv1a32(canonical))}${hex8(djb2(canonical))}`;
}
