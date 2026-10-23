import { describe, expect, it, vi } from "vitest";
import { jsonChangeRows, jsonChangeStarts, jsonComparePanel, openFoldedChange } from "../src/editor/json-compare-panel.js";

let keys = 0;
/** Each panel gets its own fold state, which lives for the life of the tab. */
function panel() {
  keys += 1;
  const shown = jsonComparePanel(`test-${keys}`);
  document.body.append(shown.grid);
  return shown;
}

const BEFORE = JSON.stringify({ first: "draft", nested: { deep: { level: 1, label: "steady" } }, a: 1, b: 2, c: 3, d: 4, last: 1 });
const AFTER = JSON.stringify({ first: "final", nested: { deep: { level: 2, label: "steady" } }, a: 1, b: 2, c: 3, d: 4, last: 2, added: true });

describe("JSON comparison panel", () => {
  it("marks change rows, starting a change only where a run of them begins", () => {
    const shown = panel();
    expect(shown.show(BEFORE, AFTER)).toBe(true);
    const changes = jsonChangeRows(shown.grid).map(({ element, kind }) => `${element.dataset.path} ${kind}`);
    expect(changes).toEqual([".first changed", ".nested.deep.level changed", ".last changed", ".added added"]);
    // `.last` and `.added` are neighbours, so they are one change to step to.
    expect(jsonChangeStarts(shown.grid).map((row) => row.dataset.path)).toEqual([".first", ".nested.deep.level", ".last"]);
  });

  it("counts a folded container that hides a change, and opens it down to the change", () => {
    const shown = panel();
    shown.show(BEFORE, AFTER);
    shown.grid.querySelector<HTMLElement>('.ub-json-compare-after .ub-json-toggle[data-key=".nested"]')?.click();
    const folded = shown.grid.querySelector<HTMLElement>('[data-path=".nested"]');
    expect(folded?.dataset.folded).toBe("true");
    expect(folded?.dataset.change).toBe("changed");
    expect(folded?.querySelector(".ub-json-compare-after")?.getAttribute("data-mark")).toBe("~");
    if (folded == null) throw new Error("The folded row is missing");
    openFoldedChange(folded);
    expect(shown.grid.querySelector('[data-path=".nested.deep.level"]')).not.toBeNull();
    expect(shown.grid.querySelector("[data-folded]")).toBeNull();
  });

  it("searches keys and values on both sides and opens what holds the current match", () => {
    // jsdom has no scrolling.
    Element.prototype.scrollIntoView = vi.fn();
    const shown = panel();
    shown.show(BEFORE, AFTER);
    const matches = shown.search("b");
    expect(matches.map((match) => match.path)).toEqual([".nested.deep.label", ".b"]);
    // Both sides highlight what is shown: the key `label`, while `.b` is still in a folded run.
    expect(shown.grid.querySelectorAll(".ub-json-compare-before mark.ub-json-match")).toHaveLength(1);
    expect(shown.grid.querySelectorAll(".ub-json-compare-after mark.ub-json-match")).toHaveLength(1);
    // Folded unchanged keys open when a match lies inside their run.
    expect(shown.grid.querySelector('[data-path=".b"]')).toBeNull();
    shown.reveal(matches[1] ?? null);
    expect(shown.grid.querySelector('[data-path=".b"]')).not.toBeNull();
    expect(shown.grid.querySelectorAll("mark.ub-json-match-current")).toHaveLength(2);
  });

  it("draws nothing for text it cannot compare", () => {
    const shown = panel();
    expect(shown.show("{", AFTER)).toBe(false);
    expect(shown.grid.children).toHaveLength(0);
  });
});
