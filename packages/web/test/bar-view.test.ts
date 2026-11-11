import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDocData, prepareBar, readDocData } from "@uberblick/schema";
import type { BarReady, BarSeriesMapping } from "@uberblick/schema";
import { barAxisLabel, barCategoryValues, barConfiguration, barCoordinateText, barDefaultHeight, barDiagnosticsText } from "../src/editor/bar-view.js";
import { chartAccessibleDescription, chartAccessibleName } from "../src/editor/chart-data.js";
import type { Chart, Element } from "chart.js";

function ready(y: BarSeriesMapping[] = [{ field: "a", label: "First", unit: "ms" }, { field: "b", label: "Second", unit: "ms" }], orientation = "vertical"): BarReady {
  const doc = new Y.Doc();
  const directory = new Y.Doc();
  applyDocData(doc, directory, [{ collection: "groups", schema: { version: 1, schema: { type: "object" } }, upsert: [
    { id: "a", value: { name: "Repeated", a: 2, b: 3 } },
    { id: "b", value: { name: "Repeated", a: -5, b: -7 } },
    { id: "empty", value: { name: "Full category name with several long words", a: null } },
  ] }]);
  const result = prepareBar(JSON.stringify({ version: 1, type: "bar", collection: "groups", category: { field: "name", label: "Category" }, y, orientation }), readDocData(doc));
  doc.destroy(); directory.destroy();
  if (result.status !== "ready") throw new Error(result.message);
  return result;
}
const colors = { color: "#334155", borderTopColor: "#ddd", fontFamily: "sans-serif", fontSize: "12px", lineHeight: "16px" } as CSSStyleDeclaration;

describe("category bar presentation", () => {
  it("uses native category indices to preserve duplicate and empty groups, with separate author and unstacked namespaces", () => {
    const result = ready([
      { field: "a", stack: "series:2" }, { field: "b", stack: "series:2" }, { field: "a" }, { field: "b", stack: "different" },
    ]);
    const configuration = barConfiguration(result, colors, ["red", "blue", "green", "purple"]);
    expect(configuration.data.labels).toEqual(["Repeated", "Repeated", "Full category name with several long words"]);
    expect(configuration.data.datasets.map(dataset => dataset.stack)).toEqual(["stack:series:2", "stack:series:2", "series:2", "stack:different"]);
    expect(configuration.data.datasets[0]?.data).toEqual([2, -5, null]);
    expect(configuration.data.datasets[1]?.data).toEqual([3, -7, null]);
    expect(configuration.options?.interaction).toEqual({ mode: "index", axis: "x", intersect: false });
    expect(configuration.options?.scales?.x?.type).toBe("category");
    expect(configuration.options?.scales?.y).toMatchObject({ type: "linear", stacked: true, beginAtZero: true, suggestedMin: -12, suggestedMax: 5 });
    expect(configuration.options?.plugins?.legend?.display).toBe(true);
  });

  it("flips the native index axis horizontally and applies only a shared unit to value ticks", () => {
    const result = ready(undefined, "horizontal");
    const configuration = barConfiguration(result, colors, ["red", "blue"]);
    expect(configuration.options?.indexAxis).toBe("y");
    expect(configuration.options?.scales?.y?.type).toBe("category");
    expect(configuration.options?.interaction).toEqual({ mode: "index", axis: "y", intersect: false });
    expect(configuration.options?.plugins?.legend?.maxHeight).toBe(600);
    const authored = barConfiguration({ ...result, config: { ...result.config, height: 100 } }, colors, []);
    expect(authored.options?.plugins?.legend?.maxHeight).toBeUndefined();
    const ticks = configuration.options?.scales?.x?.ticks as { callback: (value: number) => string };
    expect(ticks.callback(5)).toBe("5 ms");
    const different = barConfiguration(ready([{ field: "a", unit: "ms" }, { field: "b", unit: "%" }]), colors, []);
    const differentTicks = different.options?.scales?.y?.ticks as typeof ticks;
    expect(differentTicks.callback(5)).toBe("5");
    const empty = barConfiguration(ready([{ field: "a" }, { field: "b", unit: "" }]), colors, []);
    const emptyTicks = empty.options?.scales?.y?.ticks as typeof ticks;
    expect(emptyTicks.callback(5)).toBe("5");
  });

  it("keeps exact authored ranges until signed stacks or references widen the value axis", () => {
    const range = barConfiguration(ready([{ field: "a", range: [-10, 10], reference: 8 }]), colors, []);
    expect(range.options?.scales?.y).toMatchObject({ min: -10, max: 10, beginAtZero: true });
    const widened = barConfiguration(ready([{ field: "a", range: [0, 4], reference: 20 }]), colors, []);
    expect(widened.options?.scales?.y).toMatchObject({ suggestedMin: -5, suggestedMax: 20 });
    expect(widened.options?.scales?.y?.max).toBeUndefined();
  });

  it("keeps full labels and numeric values in mapping order independently of series colour", () => {
    const result = ready([{ field: "b", label: "Second", unit: "ms" }, { field: "a", label: "First", unit: "%" }]);
    const row = result.rows[0]!;
    expect(barCategoryValues(result, row).map(({ label, value }) => [label, value])).toEqual([["Second", "3 ms"], ["First", "2 %"]]);
    const configuration = barConfiguration(result, colors, []);
    const callbacks = configuration.options?.plugins?.tooltip?.callbacks as unknown as {
      label: (item: { dataIndex: number }) => string[];
      title: (this: unknown, items: { dataIndex: number }[]) => string[];
    };
    expect(callbacks.label({ dataIndex: 0 })).toEqual(["Second: 3 ms", "First: 2 %"]);
    const title = callbacks.title.call({ chart: { width: 140, ctx: { save() {}, restore() {}, measureText: (text: string) => ({ width: text.length * 6 }) } } }, [{ dataIndex: 2 }]);
    expect(title.join("")).toBe(result.rows[2]?.label);
    expect(title.every(line => line.length * 6 <= 108)).toBe(true);
    expect(callbacks.label({ dataIndex: 2 })).toEqual([]);
    expect(chartAccessibleName(result.config)).toBe("Bar chart of Second, First by Category");
    expect(chartAccessibleDescription(result)).toBe("2 plotted records in 3 categories. Select a category to read its full label and numeric series values.");
  });

  it("shortens only axis text and grows horizontal defaults within the existing height bounds", () => {
    expect(barAxisLabel("A long category", 48, text => text.length * 6)).toBe("A long …");
    expect(barAxisLabel("😀😀😀", 18, text => Array.from(text).length * 6)).toBe("😀😀😀");
    expect(barAxisLabel("Full\nlabel", 100, text => text.length * 6)).toBe("Full label");
    const result = ready();
    expect(barDefaultHeight(result)).toBeUndefined();
    const horizontal = { ...result, config: { ...result.config, orientation: "horizontal" as const } };
    expect(barDefaultHeight(horizontal)).toBe(200);
    expect(barDefaultHeight({ ...horizontal, rows: Array.from({ length: 100 }, () => result.rows[0]!) })).toBe(600);
    expect(barDiagnosticsText(result)).toContain("1 without numeric series values");
    expect(barDiagnosticsText(result)).toContain("First: 1 null; Second: 1 absent");
  });

  it("scales only numeric coordinates at extreme magnitudes and restores exact authored values in details", () => {
    const baseline = ready([{ field: "a", label: "Large", range: [-1e308, 1e308], reference: 1e308 }]);
    const result = { ...baseline, coordinateDivisor: 1e308, domain: [-1, 1] as [number, number],
      rows: [{ id: "large", label: "Large", values: [1e308] }] };
    const configuration = barConfiguration(result, colors, []);
    expect(configuration.data.datasets[0]?.data).toEqual([1]);
    expect(configuration.options?.scales?.y).toMatchObject({ min: -1, max: 1 });
    expect(barCategoryValues(result, result.rows[0]!).map(({ value }) => value)).toEqual([new Intl.NumberFormat(undefined, { maximumSignificantDigits: 12 }).format(1e308)]);
    expect(barCoordinateText(2, 1e308)).toBe("2e308");
    expect(barCoordinateText(1, 1e308)).toBe("1e308");
    expect(barCoordinateText(-4, 1e308)).toBe("-4e308");
    expect(barCoordinateText(5, 1)).toBe("5");
  });

  it("uses the native hover category to expose full values outside a short canvas tooltip", () => {
    const result = ready();
    const selected: string[] = [];
    const configuration = barConfiguration(result, colors, [], undefined, id => selected.push(id));
    const hover = configuration.options?.onHover;
    if (hover === undefined) throw new Error("Native hover callback is absent");
    const chart = {} as Chart<"bar">;
    hover.call(chart, { type: "mousemove", native: null, x: 5, y: 5 }, [{ datasetIndex: 0, index: 2, element: {} as Element }], chart);
    expect(selected).toEqual(["empty"]);
    hover.call(chart, { type: "mouseout", native: null, x: 5, y: 5 }, [], chart);
    expect(selected).toEqual(["empty"]);
  });
});
