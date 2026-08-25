/**
 * Ordered-list numbering: one rule, for the two things that draw a marker.
 *
 * The model stores `"ordered"`, never a number — a run of adjacent `list-item`
 * blocks is the list, and what each item is *called* is display. Two things
 * have to work that out: the markdown writer, which emits `1.`, `2.`, and the
 * editor, which shows the reader the same markers. They must agree, so the rule
 * lives here and neither of them owns a second copy of it.
 *
 * The rule: a counter per indent level. An item ends every level deeper than
 * its own, and starts its own level again whenever that level changes style or
 * is entered afresh. Anything that is not a list item ends the run entirely.
 */

import { MAX_LIST_INDENT } from "./types.js";

/**
 * What the rule needs to know about a block. {@link Block} satisfies it, and so
 * does a ProseMirror node's attributes — deliberately structural, because the
 * editor's blocks are not this package's blocks.
 */
export interface ListMarkerInput {
  /** The block's type name. Anything but `"list-item"` ends the run. */
  type: string;
  /** `"ordered"` or `"bullet"`; anything else reads as a bullet. */
  list?: string | undefined;
  /** Nesting depth; clamped to 0–{@link MAX_LIST_INDENT}. */
  indent?: number | undefined;
}

interface OpenLevel {
  ordered: boolean;
  count: number;
}

/**
 * The number each ordered list item is written with, parallel to `blocks`:
 * `null` for every block that is not one.
 */
export function listNumbers(
  blocks: readonly ListMarkerInput[],
): Array<number | null> {
  const run: OpenLevel[] = [];
  return blocks.map((block) => {
    if (block.type !== "list-item") {
      run.length = 0;
      return null;
    }
    const indent = Math.min(
      Math.max(Math.trunc(block.indent ?? 0), 0),
      MAX_LIST_INDENT,
    );
    const ordered = block.list === "ordered";
    // Levels deeper than this item ended with the item that opened them.
    if (run.length > indent + 1) run.length = indent + 1;
    const level = run[indent];
    if (level === undefined || level.ordered !== ordered) {
      run[indent] = { ordered, count: 1 };
    } else {
      level.count += 1;
    }
    return ordered ? (run[indent]?.count ?? 1) : null;
  });
}
