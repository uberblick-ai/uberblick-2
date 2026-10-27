import { describe, expect, it } from "vitest";
import { diffWords, matchSequence } from "../src/revision-sequence.js";

function keys(values: readonly string[]) {
  return values.map((key) => ({ key }));
}

function exactLength(before: readonly string[], after: readonly string[]): number {
  const row = new Uint32Array(after.length + 1);
  for (const value of before) {
    let diagonal = 0;
    for (let index = 1; index <= after.length; index++) {
      const prior = row[index]!;
      row[index] = value === after[index - 1]
        ? diagonal + 1 : Math.max(row[index]!, row[index - 1]!);
      diagonal = prior;
    }
  }
  return row[after.length]!;
}

function expectExactSequence(before: readonly string[], after: readonly string[]) {
  const pairs = matchSequence(keys(before), keys(after));
  expect(pairs).toHaveLength(exactLength(before, after));
  let oldIndex = -1;
  let newIndex = -1;
  for (const pair of pairs) {
    expect(pair.before).toBeGreaterThan(oldIndex);
    expect(pair.after).toBeGreaterThan(newIndex);
    expect(before[pair.before]).toBe(after[pair.after]);
    oldIndex = pair.before;
    newIndex = pair.after;
  }
}

describe("revision sequence matching", () => {
  it("retains the stationary blocks when another block moves", () => {
    const before = ["a", "b", "c", "d"].map((id) => ({ id, key: id }));
    const after = [before[1]!, before[2]!, before[0]!, before[3]!];
    expect(matchSequence(before, after)).toEqual([
      { before: 1, after: 0 },
      { before: 2, after: 1 },
      { before: 3, after: 3 },
    ]);
  });

  it("matches IDs before considering equal content", () => {
    expect(matchSequence(
      [{ id: "a", key: "one" }, { id: "b", key: "two" }],
      [{ id: "a", key: "two" }, { id: "regenerated", key: "one" }],
    )).toEqual([{ before: 0, after: 0 }]);
  });

  it("takes the final LIS across both ID and content matches", () => {
    expect(matchSequence(
      [{ id: "a", key: "one" }, { id: "b", key: "two" }, { id: "c", key: "three" }],
      [{ id: "c", key: "edited" }, { id: "new-a", key: "one" }, { id: "new-b", key: "two" }],
    )).toEqual([{ before: 0, after: 1 }, { before: 1, after: 2 }]);
  });

  it("matches regenerated IDs while leaving newly edited content unmatched", () => {
    expect(matchSequence(
      [{ id: "a", key: "one" }, { id: "b", key: "two" }, { id: "c", key: "three" }],
      [{ id: "x", key: "one" }, { id: "y", key: "edited" }, { id: "z", key: "three" }],
    )).toEqual([{ before: 0, after: 0 }, { before: 2, after: 2 }]);
  });

  it("handles empty and duplicate sequences without reusing a position", () => {
    expect(matchSequence([], keys(["a"]))).toEqual([]);
    expect(matchSequence(keys(["a"]), [])).toEqual([]);
    expectExactSequence(["a", "a", "b", "a"], ["a", "b", "a", "a"]);
    expectExactSequence(["", "x", ""], ["", "", "x"]);
  });

  it("finds an exact LCS where fast-diff's half-match heuristic loses a match", () => {
    const before = [..."bcbcbbdbbddb"];
    const after = [..."abcbbbdcbccd"];
    expect(matchSequence(keys(before), keys(after))).toHaveLength(8);
    expectExactSequence(before, after);
  });

  it("keeps sequence matches exact beyond the word comparison's work budget", () => {
    const before = [...`${"*".repeat(1500)}!${"*".repeat(1500)}`];
    const after = [...`${"#".repeat(1500)}!${"#".repeat(1500)}`];
    expect(matchSequence(keys(before), keys(after))).toEqual([{ before: 1500, after: 1500 }]);
  });

  it("agrees with a quadratic oracle for every small duplicate sequence", () => {
    const sequences: string[][] = [[]];
    for (let length = 1; length <= 5; length++) {
      for (let mask = 0; mask < 2 ** length; mask++) {
        sequences.push(Array.from({ length }, (_, index) => (mask >> index) & 1 ? "a" : "b"));
      }
    }
    for (const before of sequences) {
      for (const after of sequences) expectExactSequence(before, after);
    }
  });

  it("agrees with the exact oracle across longer uneven sequences", () => {
    let state = 17;
    const random = (bound: number) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return (state >>> 16) % bound;
    };
    for (let trial = 0; trial < 500; trial++) {
      const before = Array.from({ length: random(40) }, () => String(random(5)));
      const after = Array.from({ length: random(40) }, () => String(random(5)));
      expectExactSequence(before, after);
    }
  });

  it("stays bounded with regenerated IDs and more than 65,536 distinct keys", () => {
    const before = Array.from({ length: 70_000 }, (_, index) => ({
      id: `before-${index}`, key: `content-${index}`,
    }));
    const after = before.map(({ key }, index) => ({ id: `after-${index}`, key }));
    after[0]!.key = "replacement-start";
    after[35_000]!.key = "replacement-middle";
    after[69_999]!.key = "replacement-end";
    const pairs = matchSequence(before, after);
    expect(pairs).toHaveLength(69_997);
    expect(pairs[0]).toEqual({ before: 1, after: 1 });
    expect(pairs.at(-1)).toEqual({ before: 69_998, after: 69_998 });
    expect(pairs.every(({ before: old, after: next }) => old === next)).toBe(true);
  });
});

describe("revision word spans", () => {
  it("reports a replacement by word and retains the surrounding text", () => {
    expect(diffWords("The old line.", "The new line.")).toEqual([
      { kind: "unchanged", text: "The " },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "unchanged", text: " line." },
    ]);
    expect(diffWords("same", "same")).toEqual([{ kind: "unchanged", text: "same" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it.each([
    ["", "hello"],
    ["goodbye", ""],
    ["first\nsecond", "first\nchanged"],
    ["café 👨‍👩‍👧‍👦, 日本語。", "café 👩🏽‍💻, 日本語！"],
    ["repeat repeat repeat", "repeat again repeat"],
    ["\t  before\r\n", "\t after\n"],
  ])("reconstructs Unicode and whitespace in %j and %j", (before, after) => {
    const spans = diffWords(before, after);
    expect(spans.filter(({ kind }) => kind !== "added").map(({ text }) => text).join("")).toBe(before);
    expect(spans.filter(({ kind }) => kind !== "removed").map(({ text }) => text).join("")).toBe(after);
    expect(spans.every(({ text }) => text.length > 0)).toBe(true);
    expect(spans.every(({ kind }, index) => spans[index - 1]?.kind !== kind)).toBe(true);
  });

  it("does not split an emoji grapheme into added or removed surrogate units", () => {
    expect(diffWords("👩🏽‍💻", "👨‍👩‍👧‍👦")).toEqual([
      { kind: "removed", text: "👩🏽‍💻" },
      { kind: "added", text: "👨‍👩‍👧‍👦" },
    ]);
  });

  it("retains exact word spans when a long comparison finishes within budget", () => {
    const shared = ` ${"shared ".repeat(1000)}`;
    expect(diffWords(`old${shared}end`, `new${shared}last`)).toEqual([
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "unchanged", text: shared },
      { kind: "removed", text: "end" },
      { kind: "added", text: "last" },
    ]);
  });

  it("deterministically coarsens an unresolved middle and preserves its shared ends", () => {
    const oldMiddle = `${"*".repeat(1500)}!${"*".repeat(1500)}`;
    const newMiddle = `${"#".repeat(1500)}!${"#".repeat(1500)}`;
    const before = `start ${oldMiddle} end`;
    const after = `start ${newMiddle} end`;
    const spans = diffWords(before, after);
    expect(spans).toEqual([
      { kind: "unchanged", text: "start " },
      { kind: "removed", text: oldMiddle },
      { kind: "added", text: newMiddle },
      { kind: "unchanged", text: " end" },
    ]);
    expect(diffWords(before, after)).toEqual(spans);
    expect(spans.filter(({ kind }) => kind !== "added").map(({ text }) => text).join("")).toBe(before);
    expect(spans.filter(({ kind }) => kind !== "removed").map(({ text }) => text).join("")).toBe(after);
  });

  it("keeps exact interior word marks at the structural JSON character bound", () => {
    const before = `${"*".repeat(1023)}!${"*".repeat(1024)}`;
    const after = `${"#".repeat(1023)}!${"#".repeat(1024)}`;
    expect(before.length + after.length).toBe(4096);
    expect(diffWords(before, after)).toEqual([
      { kind: "removed", text: "*".repeat(1023) },
      { kind: "added", text: "#".repeat(1023) },
      { kind: "unchanged", text: "!" },
      { kind: "removed", text: "*".repeat(1024) },
      { kind: "added", text: "#".repeat(1024) },
    ]);
  });

  it("shares one work budget across splits and preserves the remaining ranges' ends", () => {
    const old = "*".repeat(525);
    const next = "#".repeat(525);
    const before = `start ${old}?${old}!${old}:${old} end`;
    const after = `start ${next}?${next}!${next}:${next} end`;
    const spans = diffWords(before, after);
    expect(spans).toEqual([
      { kind: "unchanged", text: "start " },
      { kind: "removed", text: `${old}?${old}` },
      { kind: "added", text: `${next}?${next}` },
      { kind: "unchanged", text: "!" },
      { kind: "removed", text: `${old}:${old}` },
      { kind: "added", text: `${next}:${next}` },
      { kind: "unchanged", text: " end" },
    ]);
    expect(spans.filter(({ kind }) => kind !== "added").map(({ text }) => text).join("")).toBe(before);
    expect(spans.filter(({ kind }) => kind !== "removed").map(({ text }) => text).join("")).toBe(after);
  });

  it.each([
    ["5,000-word log", (word: string) => JSON.stringify({ log: `${word} `.repeat(5000) })],
    ["50-object array", (word: string) => JSON.stringify(Array.from({ length: 50 }, (_, id) => ({ id, message: `${word} `.repeat(500) })), null, 2)],
    ["100-object array", (word: string) => JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, message: `${word} `.repeat(500) })), null, 2)],
  ] as const)("bounds spans and reconstructs the %s rewrite", (_, build) => {
    const before = build("old");
    const after = build("new");
    const spans = diffWords(before, after);
    expect(spans.map(({ kind }) => kind)).toEqual(["unchanged", "removed", "added", "unchanged"]);
    expect(spans.filter(({ kind }) => kind !== "added").map(({ text }) => text).join("")).toBe(before);
    expect(spans.filter(({ kind }) => kind !== "removed").map(({ text }) => text).join("")).toBe(after);
    expect(diffWords(before, after)).toEqual(spans);
  });

  it("handles a word vocabulary larger than a UTF-16 token encoding", () => {
    const tokens = Array.from({ length: 66_000 }, (_, index) => `word${index}`);
    const before = tokens.join(" ");
    tokens[33_000] = "replacement";
    const after = tokens.join(" ");
    const spans = diffWords(before, after);
    expect(spans.filter(({ kind }) => kind === "removed")).toEqual([
      { kind: "removed", text: "word33000" },
    ]);
    expect(spans.filter(({ kind }) => kind === "added")).toEqual([
      { kind: "added", text: "replacement" },
    ]);
    expect(spans.filter(({ kind }) => kind !== "added").map(({ text }) => text).join("")).toBe(before);
    expect(spans.filter(({ kind }) => kind !== "removed").map(({ text }) => text).join("")).toBe(after);
  });
});
