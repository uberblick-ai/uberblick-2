/**
 * One fold for one title, wherever the title is typed at (#965).
 *
 * The claim under test is an *equivalence*, so it is asserted against both real
 * matchers rather than against the helper they share: every case below runs the
 * same query through the Documents page filter — the mounted `DocumentList`,
 * driven by a keystroke into its field — and through the `@` picker's
 * `filterMentions` over candidates carrying the same titles, and both sides
 * have to answer with the same documents. A regression that repaired only one
 * surface would still pass a test of the helper; it cannot pass this one.
 *
 * The corpus is chosen so that each row is the *reason* for a rule: `École` and
 * `İSTANBUL` are the two matches #956 lost and this restores, `किताब` is the
 * spacing mark the owner's fold deliberately keeps, and `Straße` and `ISPARTA`
 * are the two folds that stay out — full case folding and a Turkish locale's
 * dotless `ı`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { DirectoryEntry } from "@uberblick/schema";
import { DocumentList } from "../src/shell/DocumentList.js";
import { filterMentions } from "../src/editor/mention-menu.js";
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

const ENTRIES: DirectoryEntry[] = CORPUS.map(([uuid, title]) => ({
  uuid,
  title,
  tags: [],
}));

const CANDIDATES: DocLinkCandidate[] = CORPUS.map(([docId, label]) => ({
  docId,
  label,
}));

const EVERY_TITLE = CORPUS.map(([, title]) => title);

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(() => {
  if (mounted === null) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

/** Change a controlled input through the native setter, like a keystroke. */
function typeInto(input: HTMLInputElement, value: string): void {
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  native?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The titles the Documents page keeps for `query`, in a comparable order. */
async function listAnswer(query: string): Promise<string[]> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(
      <DocumentList
        connection={null}
        entries={ENTRIES}
        groups={[]}
        onSelect={() => {}}
        onTogglePin={null}
      />,
    );
  });
  const field = host.querySelector<HTMLInputElement>(".ub-docs-search");
  if (field === null) throw new Error("the filter field is missing");
  await act(async () => typeInto(field, query));
  return [...host.querySelectorAll(".ub-docs-title")]
    .map((node) => node.textContent ?? "")
    .sort();
}

/** The titles the `@` picker offers for `query`, in a comparable order. */
function pickerAnswer(query: string): string[] {
  return filterMentions(CANDIDATES, query, null)
    .map((candidate) => candidate.label)
    .sort();
}

describe("the Documents filter and the @ picker match one title one way", () => {
  it.each([
    // The two matches #956 lost, and the direction the store's index already
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
    // An empty field lists everything, on both surfaces.
    ["", EVERY_TITLE],
  ])("answers %j with the same documents on both surfaces", async (query, expected) => {
    const wanted = [...expected].sort();
    expect(await listAnswer(query)).toEqual(wanted);
    expect(pickerAnswer(query)).toEqual(wanted);
  });

  it("folds the query and the title through one function, not two copies", () => {
    // The equivalence above is a property of the surfaces; this is why it
    // cannot drift. `İ` decomposes to `I` plus a combining dot the fold drops,
    // and `toLowerCase` is locale-independent by specification — the two things
    // a second, hand-rolled copy of the rule has historically got wrong.
    expect(foldForTitleMatch("İSTANBUL")).toBe("istanbul");
    expect(foldForTitleMatch("École")).toBe("ecole");
    expect(foldForTitleMatch("I")).toBe("i");
    expect(foldForTitleMatch("किताब")).toBe("किताब");
    expect(foldForTitleMatch("Straße")).toBe("straße");
  });
});
