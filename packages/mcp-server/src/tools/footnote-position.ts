import type { Block } from "@uberblick/schema";
import { ToolError } from "../failures.js";

type PositionedBlock = Pick<Block, "id" | "type">;

/** Legacy notes before the last body block do not constrain an unrelated placement. */
export function footnotePositionFailure(
  remaining: readonly PositionedBlock[],
  placed: readonly Pick<Block, "type">[],
  afterBlockId: string | null,
): { entry: number; afterBlockId: string | null } | null {
  let boundary = remaining.length;
  while (boundary > 0 && remaining[boundary - 1]?.type === "footnote") boundary -= 1;
  const position = afterBlockId === null ? 0 : remaining.findIndex(block => block.id === afterBlockId) + 1;
  const bodyAnchor = remaining[boundary - 1]?.id ?? null;
  const noteAnchor = remaining[remaining.length - 1]?.id ?? null;
  const recoveryAnchor = placed.some(block => block.type !== "footnote") ? bodyAnchor : noteAnchor;
  let notesStarted = false;
  for (const [index, block] of placed.entries()) {
    if (block.type === "footnote") {
      if (position < boundary) return { entry: index + 1, afterBlockId: recoveryAnchor };
      notesStarted = true;
    } else if (notesStarted || position > boundary) {
      return { entry: index + 1, afterBlockId: bodyAnchor };
    }
  }
  return null;
}

export function footnotePositionError(afterBlockId: string | null, entry?: number): ToolError {
  const anchor = JSON.stringify(afterBlockId);
  return new ToolError("footnote_position", `${entry === undefined ? "" : `Entry ${entry}: `}Footnotes must remain after the other blocks. Nothing was written.`, {
    ...(entry === undefined ? {} : { entry_index: entry }),
    after_block_id: afterBlockId,
    recoveryClass: "manual",
    recovery: `Place body blocks before the trailing notes and footnotes among those notes. Use after_block_id: ${anchor}; in a mixed batch, put all body blocks before the footnotes. Nothing was written.`,
  });
}
