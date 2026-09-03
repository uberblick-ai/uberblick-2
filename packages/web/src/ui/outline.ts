/**
 * The "on this page" outline: a pure derivation of the document's heading
 * blocks, plus its subscription.
 *
 * Nothing is stored for the outline. It is `getBlocks()` filtered to headings of
 * level 1-2, in document order, which is why a remote edit needs no extra
 * plumbing to show up — the document is the model.
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
 * Call `onChange` with a fresh outline whenever it could have changed. Returns
 * the unsubscribe.
 *
 * Deep, not shallow: a heading's text lives in the Y.XmlText one level below the
 * fragment, so a shallow observer sees a heading being added but never a heading
 * being retitled — including by a remote client.
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
export function scrollBlockIntoView(blockId: string): void {
  document
    .getElementById(blockId)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}
