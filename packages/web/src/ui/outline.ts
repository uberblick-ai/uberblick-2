/**
 * The "on this page" outline: a pure derivation of the document's heading
 * blocks, plus its subscription.
 *
 * Nothing is stored for the outline. It is `getBlocks()` filtered to headings of
 * level 1-3, in document order, which is why a remote edit needs no extra
 * plumbing to show up — the document is the model.
 */

import type * as Y from "yjs";
import { getBlocks, getBlocksFragment } from "@uberblick/schema";
import type { HeadingLevel } from "@uberblick/schema";

/** Deepest heading level the outline shows. Below this the outline is noise. */
export const OUTLINE_MAX_LEVEL = 3;

export interface OutlineEntry {
  /** The block id — also the heading element's DOM id, which is how clicks scroll. */
  id: string;
  level: HeadingLevel;
  text: string;
}

/** Heading blocks of level 1-3, in document order. */
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
 * The outline entries that should carry a changed-block dot (#120).
 *
 * The outline lists headings and the marks are on blocks, so the two have to be
 * mapped onto each other. The mapping is **the nearest entry at or above the
 * changed block, in document order**: a changed heading dots its own entry, and
 * a changed paragraph, code or mermaid block dots the entry of the section it
 * sits in. That is the section a reader would have to open to find it, which is
 * what the dot is telling them to do.
 *
 * Two consequences worth naming rather than hiding:
 *
 * - A block under a heading too deep to be listed (level 4-6) dots the nearest
 *   *listed* heading above it, because that is the deepest entry there is.
 * - A block before the first heading has no entry above it and gets no dot. Its
 *   gutter line still shows; the document's first screen is the one place a
 *   reader does not need the rail to find something.
 */
export function outlineDots(
  ydoc: Y.Doc,
  changed: ReadonlySet<string>,
): Set<string> {
  const dots = new Set<string>();
  if (changed.size === 0) return dots;
  let section: string | null = null;
  for (const block of getBlocks(ydoc)) {
    const listed =
      block.type === "heading" && (block.level ?? 1) <= OUTLINE_MAX_LEVEL;
    if (listed) section = block.id;
    if (!changed.has(block.id)) continue;
    const entry = listed ? block.id : section;
    if (entry !== null) dots.add(entry);
  }
  return dots;
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
