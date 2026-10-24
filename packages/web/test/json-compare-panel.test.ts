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
    expect(folded?.getAttribute("data-mark")).toBe("~");
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

  it("highlights a match that spans the marked pieces of a changed value", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const shown = panel();
    shown.show(JSON.stringify({ greeting: "alpha old omega" }), JSON.stringify({ greeting: "alpha new omega" }));
    const matches = shown.search("alpha new");
    expect(matches.map((match) => match.path)).toEqual([".greeting"]);
    shown.reveal(matches[0] ?? null);
    const current = [...shown.grid.querySelectorAll(".ub-json-compare-after mark.ub-json-match-current")];
    expect(current.map((mark) => mark.textContent).join("")).toBe("alpha new");
    expect(shown.grid.querySelectorAll(".ub-json-compare-before mark.ub-json-match")).toHaveLength(0);
  });

  it("keeps each side in its own pane and fold arrows as buttons", () => {
    const shown = panel();
    shown.show(BEFORE, AFTER);
    const panes = [...shown.grid.querySelectorAll<HTMLElement>(".ub-json-compare-pane")];
    expect(panes.map((pane) => pane.dataset.side)).toEqual(["before", "after"]);
    expect(panes[0]?.querySelectorAll(".ub-json-compare-after")).toHaveLength(0);
    expect(panes[0]?.children).toHaveLength(panes[1]?.children.length ?? -1);
    expect(shown.grid.querySelector(".ub-json-toggle")?.tagName).toBe("BUTTON");
  });

  it("selects all of one pane, and copies only its lines, from a caret inside it", () => {
    const shown = panel();
    shown.show(BEFORE, AFTER);
    const before = shown.grid.querySelector<HTMLElement>('.ub-json-compare-pane[data-side="before"]');
    if (before === null) throw new Error("The before pane is missing");
    before.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
    const selection = document.getSelection();
    expect(selection?.anchorNode).toBe(before);
    expect(selection?.focusNode).toBe(before);
    const data = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type: string, text: string) => data.set(type, text) } });
    before.dispatchEvent(copy);
    expect(data.get("text/plain")).toContain('"first": "draft"');
    expect(data.get("text/plain")).not.toContain("final");
    expect(data.get("text/plain")).not.toMatch(/unchanged keys/);
  });

  it("draws nothing for text it cannot compare", () => {
    const shown = panel();
    expect(shown.show("{", AFTER)).toBe(false);
    expect(shown.grid.children).toHaveLength(0);
  });
});
