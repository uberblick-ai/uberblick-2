/**
 * The one write that ends a link conflict: the person picks a survivor, and the
 * unchosen mark is cleared from exactly that range.
 *
 * The palette gate refuses to bind a document holding a range that a merge left
 * carrying both `link` and `docLink` (`palette.ts` says why), and that refusal
 * stays — nothing here repairs anything on its own. Opening such a document
 * writes nothing; only an activation does, and only after it has re-read live
 * state.
 *
 * ## Why the re-read is not optional
 *
 * A control is rendered from a scan, and the document keeps moving underneath
 * it: a remote replica can retarget the range, resolve the conflict itself, or
 * delete the block between the render and the click. So the click does not
 * trust what it was rendered from. It rescans the very `Y.XmlText` the scan
 * anchored on and requires the same range with the same two targets still on
 * it; anything else writes nothing and the caller refreshes its list. That
 * makes a stale or repeated activation a no-op rather than a write that clears
 * a mark somebody else has just placed.
 *
 * ## Why it clears rather than rewrites
 *
 * `format` with one key set to `null` removes exactly that key over exactly
 * that range. The text, the block's `id`, the comment anchors, every other mark
 * and every link on a neighbouring range are not mentioned by the write, so
 * they cannot be touched by it — and no other fallback reason is normalised on
 * the way past. It is also the same write the schema package already makes when
 * `setInlineLink` retargets a merged range (`blocks.ts`), so the raw state a
 * repair leaves behind is a shape the model already produces.
 */

import { linkConflictsIn } from "./palette.js";
import type { LinkConflict } from "./palette.js";

/** Which of the two targets the person chose to keep. */
export type LinkSurvivor = "link" | "docLink";

/** The mark a choice clears — the other one. */
const CLEARS: Record<LinkSurvivor, Record<string, null>> = {
  docLink: { link: null },
  link: { docLink: null },
};

/**
 * Clear the unchosen mark from one conflicting range, if it is still there.
 *
 * Returns whether a write was made: `false` means live state no longer holds
 * this exact conflict — already repaired, retargeted, or gone with its block —
 * and the caller should re-read rather than retry.
 */
export function repairLinkConflict(
  conflict: LinkConflict,
  keep: LinkSurvivor,
): boolean {
  const ydoc = conflict.text.doc;
  if (ydoc === null) return false;
  const live = linkConflictsIn(conflict.text).some(
    (range) =>
      range.start === conflict.start &&
      range.end === conflict.end &&
      range.href === conflict.href &&
      range.docId === conflict.docId,
  );
  if (!live) return false;
  ydoc.transact(() => {
    conflict.text.format(conflict.start, conflict.end - conflict.start, CLEARS[keep]);
  });
  return true;
}
