/**
 * Derive headings at levels 1–2 in document order; the outline stores no
 * separate state.
 */

import type * as Y from "yjs";
import { getBlocks, getBlocksFragment } from "@uberblick/schema";
import type { HeadingLevel } from "@uberblick/schema";

/** Deepest heading level the outline shows. Below this the outline is noise. */
export const OUTLINE_MAX_LEVEL = 2;

export interface OutlineEntry {
  /** The block id — also the heading element's DOM id, which is how clicks scroll. */
  id: string;
  level: HeadingLevel;
  text: string;
}

/** Heading blocks of level 1-2, in document order. */
export function outlineFromDoc(ydoc: Y.Doc): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const block of getBlocks(ydoc)) {
    if (block.type !== "heading") continue;
    const level = block.level ?? 1;
    if (level > OUTLINE_MAX_LEVEL) continue;
    out.push({ id: block.id, level, text: block.text });
  }
  return out;
}

/**
 * Observe deeply so nested heading text edits, including remote renames,
 * refresh the outline. Return the unsubscribe.
 */
export function observeOutline(
  ydoc: Y.Doc,
  onChange: (outline: OutlineEntry[]) => void,
): () => void {
  const fragment = getBlocksFragment(ydoc);
  const read = (): void => onChange(outlineFromDoc(ydoc));
  read();
  fragment.observeDeep(read);
  return () => fragment.unobserveDeep(read);
}

/** Scroll a block into view by its id. A no-op when the block is not rendered. */
export function scrollBlockIntoView(blockId: string, inset = 16): void {
  const block = document.getElementById(blockId);
  const pane = block?.closest<HTMLElement>(".ub-document-pane");
  if (block === null || block === undefined || pane === null || pane === undefined) return;
  pane.scrollTo({ top: pane.scrollTop + block.getBoundingClientRect().top - pane.getBoundingClientRect().top - inset, behavior: "instant" });
}
