import type * as Y from "yjs";
import fastDiff from "fast-diff";
import { attributesOf, inlinePlainText } from "./marks.js";
import type { InlineMarkSet, InlineRun } from "./types.js";

/** One mark set per UTF-16 character, matching Yjs and fast-diff offsets. */
function characterMarks(runs: readonly InlineRun[]): InlineMarkSet[] {
  return runs.flatMap((run) => Array<InlineMarkSet>(run.text.length).fill(run.marks));
}

/** Only mark keys whose projected values the caller changed. */
function changedMarks(before: InlineMarkSet, after: InlineMarkSet): Record<string, unknown> {
  const previous = attributesOf(before) ?? {};
  const next = attributesOf(after) ?? {};
  const changes: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = next[key] ?? null;
  }
  return changes;
}

/** Diff projected characters and mark keys, leaving comment anchors untouched. */
export function spliceInlineText(text: Y.XmlText, oldRuns: readonly InlineRun[], newRuns: readonly InlineRun[], offset = 0): void {
  const oldValue = inlinePlainText(oldRuns);
  const newValue = inlinePlainText(newRuns);
  const oldMarks = characterMarks(oldRuns);
  const newMarks = characterMarks(newRuns);
  let oldOffset = 0;
  let newOffset = 0;
  for (const [op, chunk] of fastDiff(oldValue, newValue)) {
    if (op === 0) {
      let start = 0;
      while (start < chunk.length) {
        const changes = changedMarks(oldMarks[oldOffset + start] ?? {}, newMarks[newOffset + start] ?? {});
        const signature = JSON.stringify(changes);
        let end = start + 1;
        while (end < chunk.length && JSON.stringify(changedMarks(oldMarks[oldOffset + end] ?? {}, newMarks[newOffset + end] ?? {})) === signature) end += 1;
        if (Object.keys(changes).length > 0) text.format(offset + start, end - start, changes);
        start = end;
      }
      offset += chunk.length;
      oldOffset += chunk.length;
      newOffset += chunk.length;
    } else if (op === -1) {
      text.delete(offset, chunk.length);
      oldOffset += chunk.length;
    } else {
      let start = 0;
      while (start < chunk.length) {
        const marks = newMarks[newOffset + start] ?? {};
        const signature = JSON.stringify(marks);
        let end = start + 1;
        while (end < chunk.length && JSON.stringify(newMarks[newOffset + end] ?? {}) === signature) end += 1;
        text.insert(offset + start, chunk.slice(start, end), attributesOf(marks) ?? {});
        start = end;
      }
      offset += chunk.length;
      newOffset += chunk.length;
    }
  }
}
