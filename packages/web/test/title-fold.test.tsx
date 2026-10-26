/**
 * Mention completion folds cached titles before matching a substring.
 *
 * The corpus is chosen so that each row is the *reason* for a rule: `École` and
 * `İSTANBUL` exercise removable marks, `किताब` is the
 * spacing mark the fold deliberately keeps, and `Straße` and `ISPARTA`
 * are the two folds that stay out — full case folding and a Turkish locale's
 * dotless `ı`.
 */

import { describe, expect, it } from "vitest";
import { mentionCandidates } from "../src/mentions.js";
import type { DocLinkCandidate } from "../src/editor/doc-links.js";
import { foldForTitleMatch } from "../src/title-fold.js";

/** One uuid per title, so a row is identifiable when two titles fold alike. */
const CORPUS: readonly (readonly [string, string])[] = [
  ["b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31", "École"],
  ["1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73", "İSTANBUL"],
  ["7c2e5a11-3f80-4d66-b1a9-8e4d2c6f0a55", "İstanbul harbour"],
  ["3b8a52d4-12c7-4c8f-9a61-9f18e35d7c2a", "किताब"],
  ["0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d", "Straße"],
  ["9d5c7b31-8e42-4a09-b6f1-27c0a4e83d16", "ISPARTA"],
  ["5e1a9f04-3c68-4b27-8d95-16f2b70c4a83", "Roadmap"],
];

const CANDIDATES: DocLinkCandidate[] = CORPUS.map(([docId, label]) => ({
  docId,
  label,
}));

const EVERY_TITLE = CORPUS.map(([, title]) => title);

/** The titles the `@` picker offers for `query`, in a comparable order. */
function pickerAnswer(query: string): string[] {
  return mentionCandidates(CANDIDATES, [], query, null)
    .map((candidate) => candidate.label)
    .sort();
}

describe("the @ picker matches folded title substrings", () => {
  const cases: Array<[string, string[]]> = [
    // The two removable-mark matches, and the direction the store's index
    // folds: a non-spacing mark is not part of what was typed.
    ["ecole", ["École"]],
    ["istanbul", ["İSTANBUL", "İstanbul harbour"]],
    // Typed with the diacritic, the same document is still the answer, because
    // the query is folded too rather than only the title.
    ["École", ["École"]],
    // A spacing mark is part of the word. `किताब` differs from `कतब` by two
    // spacing vowel signs, which the fold keeps, so the two stay distinct.
    ["कतब", []],
    ["किताब", ["किताब"]],
    // Still a plain substring over the title alone, and still not full Unicode
    // case folding.
    ["stan", ["İSTANBUL", "İstanbul harbour"]],
    ["STRASSE", []],
    ["straße", ["Straße"]],
    // The dotless `ı` is a different letter, not a locale away from `i`: the
    // fold is `toLowerCase`, so an ordinary `I` keeps its dot on every machine.
    ["ısparta", []],
    ["isparta", ["ISPARTA"]],
    ["I", ["ISPARTA", "İSTANBUL", "İstanbul harbour"]],
    // An empty field offers every candidate.
    ["", EVERY_TITLE],
  ];

  it("answers every case the same way in the @ picker", () => {
    for (const [query, expected] of cases) {
      expect(pickerAnswer(query), JSON.stringify(query)).toEqual([...expected].sort());
    }
  });

  it("folds the query and the title through one function, not two copies", () => {
    // Query and title share the fold: `İ` decomposes to `I` plus
    // a combining dot the fold drops, and `toLowerCase` is locale-independent.
    expect(foldForTitleMatch("İSTANBUL")).toBe("istanbul");
    expect(foldForTitleMatch("École")).toBe("ecole");
    expect(foldForTitleMatch("I")).toBe("i");
    expect(foldForTitleMatch("किताब")).toBe("किताब");
    expect(foldForTitleMatch("Straße")).toBe("straße");
  });
});
