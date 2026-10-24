import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonComparePanel } from "../src/editor/json-compare-panel.js";

let keys = 0;
const nested = { inner: "needle" };
const cases = [
  { name: "object to scalar", before: nested, after: "replacement", side: "before" },
  { name: "scalar to object", before: "replacement", after: nested, side: "after" },
  { name: "array to scalar", before: [nested], after: "replacement", side: "before" },
  { name: "scalar to array", before: "replacement", after: [nested], side: "after" },
];

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe.each(cases)("JSON comparison search: $name", ({ before, after, side }) => {
  it.each(["inner", "needle"])("finds and reveals nested %s in a compact type change", (query) => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    keys += 1;
    const shown = jsonComparePanel(`type-search-${keys}`);
    document.body.append(shown.grid);
    expect(shown.show(JSON.stringify({ outer: { field: before } }), JSON.stringify({ outer: { field: after } }))).toBe(true);
    shown.grid.querySelector<HTMLElement>('.ub-json-compare-before .ub-json-toggle[data-key=".outer"]')?.click();
    expect(shown.grid.querySelector('[data-path=".outer.field"]')).toBeNull();

    const matches = shown.search(query);
    expect(matches.map((match) => match.path)).toEqual([".outer.field"]);
    shown.reveal(matches[0] ?? null);

    expect(shown.grid.querySelector('[data-path=".outer.field"]')).not.toBeNull();
    const highlights = [...shown.grid.querySelectorAll(`.ub-json-compare-${side} .ub-json-match-current`)];
    expect(highlights.map((mark) => mark.textContent)).toEqual([query]);
    expect(shown.grid.querySelectorAll(`.ub-json-compare-${side === "before" ? "after" : "before"} .ub-json-match`)).toHaveLength(0);
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(scroll.mock.instances).toEqual([highlights[0]]);
  });

  it("searches the compact value without highlighting its separator or trailing comma", () => {
    keys += 1;
    const shown = jsonComparePanel(`type-search-${keys}`);
    document.body.append(shown.grid);
    expect(shown.show(JSON.stringify({ field: before, same: "steady" }), JSON.stringify({ field: after, same: "steady" }))).toBe(true);

    expect(shown.search(":").map((match) => match.path)).toEqual([".field"]);
    expect([...shown.grid.querySelectorAll(`.ub-json-compare-${side} .ub-json-match`)].map((mark) => mark.textContent)).toEqual([":"]);
    expect(shown.grid.querySelectorAll(`.ub-json-compare-${side === "before" ? "after" : "before"} .ub-json-match`)).toHaveLength(0);

    expect(shown.search(",")).toEqual([]);
    expect(shown.grid.querySelectorAll(".ub-json-match")).toHaveLength(0);
  });
});

it("does not find a row separator beside an empty compact value", () => {
  keys += 1;
  const shown = jsonComparePanel(`type-search-${keys}`);
  document.body.append(shown.grid);
  expect(shown.show('{"field":{},"same":"steady"}', '{"field":"replacement","same":"steady"}')).toBe(true);

  expect(shown.search(":")).toEqual([]);
  expect(shown.grid.querySelectorAll(".ub-json-match")).toHaveLength(0);
});
