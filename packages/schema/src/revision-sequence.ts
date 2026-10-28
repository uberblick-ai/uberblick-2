export type SequencePair = { before: number; after: number };
export type TextSpan = {
  kind: "unchanged" | "added" | "removed";
  text: string;
};

type SequenceItem = { id?: string; key: string };
type WorkBudget = { remaining: number };
type Range = {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
};

type Search = {
  before: readonly string[];
  after: readonly string[];
  range: Range;
  beforeLength: number;
  afterLength: number;
  offset: number;
  budget: WorkBudget | undefined;
};

function spendWork(budget: WorkBudget | undefined): boolean {
  if (!budget) return true;
  if (budget.remaining === 0) return false;
  budget.remaining--;
  return true;
}

function snake(search: Search, start: number, diagonal: number, reverse: boolean): number | undefined {
  const { before, after, range, beforeLength, afterLength, budget } = search;
  let x = start;
  let y = x - diagonal;
  while (x < beforeLength && y < afterLength) {
    const oldIndex = reverse ? range.beforeEnd - x - 1 : range.beforeStart + x;
    const newIndex = reverse ? range.afterEnd - y - 1 : range.afterStart + y;
    if (before[oldIndex] !== after[newIndex]) break;
    if (!spendWork(budget)) return undefined;
    x++;
    y++;
  }
  return x;
}

function advance(
  search: Search,
  path: Int32Array,
  other: Int32Array,
  limit: { start: number; end: number },
  distance: number,
  reverse: boolean,
): SequencePair | undefined {
  const { range, beforeLength, afterLength, offset, budget } = search;
  const delta = beforeLength - afterLength;
  for (let diagonal = -distance + limit.start; diagonal <= distance - limit.end; diagonal += 2) {
    if (!spendWork(budget)) return undefined;
    const index = offset + diagonal;
    const prior = path[index - 1] ?? -1;
    const next = path[index + 1] ?? -1;
    const start = diagonal === -distance || (diagonal !== distance && prior < next) ? next : prior + 1;
    const x = snake(search, start, diagonal, reverse);
    if (x === undefined) return undefined;
    const y = x - diagonal;
    path[index] = x;
    if (x > beforeLength) limit.end += 2;
    else if (y > afterLength) limit.start += 2;
    else if (reverse !== (delta % 2 !== 0)) {
      const otherX = other[offset + delta - diagonal] ?? -1;
      if (otherX >= 0 && x + otherX >= beforeLength) {
        return {
          before: range.beforeStart + (reverse ? beforeLength - x : x),
          after: range.afterStart + (reverse ? afterLength - y : y),
        };
      }
    }
  }
  return undefined;
}

/** Find an exact Myers middle split without encoding tokens as UTF-16 units. */
function bisect(
  before: readonly string[],
  after: readonly string[],
  range: Range,
  budget?: WorkBudget,
): SequencePair | undefined {
  const beforeLength = range.beforeEnd - range.beforeStart;
  const afterLength = range.afterEnd - range.afterStart;
  const maxDistance = Math.ceil((beforeLength + afterLength) / 2);
  const offset = maxDistance + 1;
  const forward = new Int32Array(2 * maxDistance + 3).fill(-1);
  const backward = new Int32Array(2 * maxDistance + 3).fill(-1);
  forward[offset + 1] = 0;
  backward[offset + 1] = 0;
  const forwardLimit = { start: 0, end: 0 };
  const backwardLimit = { start: 0, end: 0 };
  const search = { before, after, range, beforeLength, afterLength, offset, budget };
  for (let distance = 0; distance <= maxDistance; distance++) {
    const front = advance(search, forward, backward, forwardLimit, distance, false);
    if (front) return front;
    if (budget?.remaining === 0) return undefined;
    const back = advance(search, backward, forward, backwardLimit, distance, true);
    if (back) return back;
    if (budget?.remaining === 0) return undefined;
  }
  return undefined;
}

/** Myers LCS; an exhausted budget leaves only the unresolved range's shared ends. */
function commonSequence(before: readonly string[], after: readonly string[], budget?: WorkBudget): SequencePair[] {
  const pairs: SequencePair[] = [];
  const pending: Range[] = [{
    beforeStart: 0, beforeEnd: before.length,
    afterStart: 0, afterEnd: after.length,
  }];
  while (pending.length > 0) {
    const range = pending.pop();
    if (!range) break;
    let { beforeStart, beforeEnd, afterStart, afterEnd } = range;
    while (beforeStart < beforeEnd && afterStart < afterEnd
      && before[beforeStart] === after[afterStart]) {
      pairs.push({ before: beforeStart++, after: afterStart++ });
    }
    while (beforeStart < beforeEnd && afterStart < afterEnd
      && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd--;
      afterEnd--;
    }
    if (beforeEnd < range.beforeEnd) {
      pending.push({
        beforeStart: beforeEnd, beforeEnd: range.beforeEnd,
        afterStart: afterEnd, afterEnd: range.afterEnd,
      });
    }
    if (beforeStart === beforeEnd || afterStart === afterEnd) continue;
    if (budget?.remaining === 0) continue;
    if (beforeEnd - beforeStart === 1) {
      const found = after.indexOf(before[beforeStart] as string, afterStart);
      if (found !== -1 && found < afterEnd) pairs.push({ before: beforeStart, after: found });
      continue;
    }
    if (afterEnd - afterStart === 1) {
      const found = before.indexOf(after[afterStart] as string, beforeStart);
      if (found !== -1 && found < beforeEnd) pairs.push({ before: found, after: afterStart });
      continue;
    }
    const split = bisect(before, after, { beforeStart, beforeEnd, afterStart, afterEnd }, budget);
    if (!split) continue;
    pending.push({
      beforeStart: split.before, beforeEnd,
      afterStart: split.after, afterEnd,
    });
    pending.push({
      beforeStart, beforeEnd: split.before,
      afterStart, afterEnd: split.after,
    });
  }
  return pairs;
}

/** Match IDs, then unmatched content, and retain the stationary subsequence. */
export function matchSequence(
  before: readonly SequenceItem[],
  after: readonly SequenceItem[],
): SequencePair[] {
  const byId = new Map<string, number>();
  before.forEach((item, index) => {
    if (item.id && !byId.has(item.id)) byId.set(item.id, index);
  });
  const oldUsed = new Set<number>();
  const newUsed = new Set<number>();
  const pairs: SequencePair[] = [];
  after.forEach((item, index) => {
    const old = item.id ? byId.get(item.id) : undefined;
    if (old === undefined || oldUsed.has(old)) return;
    pairs.push({ before: old, after: index });
    oldUsed.add(old);
    newUsed.add(index);
  });
  const oldRemaining = before.flatMap((_, index) => oldUsed.has(index) ? [] : [index]);
  const newRemaining = after.flatMap((_, index) => newUsed.has(index) ? [] : [index]);
  for (const pair of commonSequence(
    oldRemaining.map((index) => (before[index] as SequenceItem).key),
    newRemaining.map((index) => (after[index] as SequenceItem).key),
  )) {
    pairs.push({ before: oldRemaining[pair.before] as number, after: newRemaining[pair.after] as number });
  }
  pairs.sort((left, right) => left.after - right.after);

  const tails: number[] = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index++) {
    const current = pairs[index] as SequencePair;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const tail = pairs[tails[middle] as number] as SequencePair;
      if (tail.before < current.before) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1] as number;
    tails[low] = index;
  }
  const kept: SequencePair[] = [];
  let cursor = tails.at(-1) ?? -1;
  while (cursor !== -1) {
    kept.push(pairs[cursor] as SequencePair);
    cursor = previous[cursor] as number;
  }
  return kept.reverse();
}

const words = new Intl.Segmenter("en", { granularity: "word" });
const MAX_WORD_DIFF_WORK = 5_000_000;
// Structural JSON uses word marks within this combined character bound; keep them exact.
const EXACT_WORD_DIFF_LENGTH = 4096;

export function diffWords(before: string, after: string): TextSpan[] {
  if (before === after) return before ? [{ kind: "unchanged", text: before }] : [];
  const oldWords = Array.from(words.segment(before), ({ segment }) => segment);
  const newWords = Array.from(words.segment(after), ({ segment }) => segment);
  const spans: TextSpan[] = [];
  const append = (kind: TextSpan["kind"], text: string) => {
    if (!text) return;
    const previous = spans.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else spans.push({ kind, text });
  };
  let oldIndex = 0;
  let newIndex = 0;
  const budget = before.length + after.length <= EXACT_WORD_DIFF_LENGTH
    ? undefined : { remaining: MAX_WORD_DIFF_WORK };
  for (const pair of commonSequence(oldWords, newWords, budget)) {
    append("removed", oldWords.slice(oldIndex, pair.before).join(""));
    append("added", newWords.slice(newIndex, pair.after).join(""));
    append("unchanged", oldWords[pair.before] as string);
    oldIndex = pair.before + 1;
    newIndex = pair.after + 1;
  }
  append("removed", oldWords.slice(oldIndex).join(""));
  append("added", newWords.slice(newIndex).join(""));
  return spans;
}
