/**
 * Repair only on an explicit choice. Rescan the original Y.XmlText and require
 * the same range and targets; deleted, retargeted or already-repaired conflicts
 * write nothing. Clear only the losing mark with format(key:null), preserving
 * text, id, comments, other marks and neighboring ranges. Opening writes nothing.
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
 * A stale or repeated choice returns false without a write; the caller must
 * refresh rather than retry against the old scan.
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
