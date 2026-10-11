import { MAX_LIST_INDENT } from "./types.js";

/**
 * Structural input accepts schema blocks and editor node attributes, so both
 * renderers use the same numbering without sharing their block types.
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
 * Numbers are display state, never stored on list items. A counter per depth
 * restarts on entry or style change; a non-list block ends all counters.
 * Results parallel `blocks`, with null for bullets and non-list blocks.
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
