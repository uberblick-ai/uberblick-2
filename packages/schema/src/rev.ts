/**
 * Per-block content revisions.
 *
 * A `rev` is a cheap, dependency-free content hash of everything a caller can
 * change about a block: its type, its text and its type-specific attributes. It
 * is a change detector, not a version counter and not a checksum — two
 * different revs mean the block differs, and a matching rev means the caller is
 * looking at the same content it read.
 *
 * Deliberately not cryptographic: 64 bits from two independent 32-bit hashes
 * (FNV-1a and djb2), which is ample for optimistic concurrency and costs
 * nothing. Marks are excluded on purpose — annotating a block must not
 * invalidate an edit a caller has already prepared.
 */

import type { BlockType, HeadingLevel } from "./types.js";

export interface RevInput {
  type: BlockType;
  text: string;
  level?: HeadingLevel | undefined;
  language?: string | undefined;
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
 * The rev of a block's content. Stable across processes and platforms: it reads
 * UTF-16 code units, exactly what Yjs indexes. Fields are JSON-encoded before
 * hashing so no field value can be confused with a field boundary.
 */
export function blockRev(input: RevInput): string {
  const canonical = JSON.stringify([
    input.type,
    input.level ?? null,
    input.language ?? null,
    input.text,
  ]);
  return `${hex8(fnv1a32(canonical))}${hex8(djb2(canonical))}`;
}
