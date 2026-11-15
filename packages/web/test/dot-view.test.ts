import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { applyDocData, prepareDot, readDocData } from "@uberblick/schema";
import type { DotReady, DotSeriesMapping } from "@uberblick/schema";
import type { Chart, Element } from "chart.js";
import { dotCategoryValues, dotConfiguration, dotDefaultHeight, dotDiagnosticsText, dotRowValues } from "../src/editor/dot-view.js";

function ready(y: DotSeriesMapping[] = [{ field: "old", label: "Old", unit: "%" }, { field: "today", label: "Today", unit: "%" }], connect = true): DotReady {
  const doc = new Y.Doc();
  const directory = new Y.Doc();
  applyDocData(doc, directory, [{ collection: "systems", schema: { version: 1, schema: { type: "object" } }, upsert: [
    { id: "a", value: { name: "Repeated", old: 12.5, today: 9.9, change: "−2.6" } },
    { id: "b", value: { name: "Repeated", old: 11.1, today: 13.6, change: "<b>+2.5</b>" } },
    { id: "empty", value: { name: "Full category label with several long words", old: null, change: { reason: "missing" } } },
  ] }]);
  const result = prepareDot(JSON.stringify({ version: 1, type: "dot", collection: "systems", category: { field: "name", label: "System" }, y, connect, note: "change" }), readDocData(doc));
  doc.destroy(); directory.destroy();
  if (result.status !== "ready") throw new Error(result.message);
  return result;
}

const colors = { color: "#334155", borderTopColor: "#ddd", fontFamily: "sans-serif", fontSize: "12px", lineHeight: "16px" } as CSSStyleDeclaration;

function drawing(result: DotReady, width = 600, rowSpacing = 50) {
  const configuration = dotConfiguration(result, colors, ["red", "blue"]);
  const plugin = configuration.plugins?.[0];
  if (plugin === undefined) throw new Error("Dot decorations are absent");
  const paint = vi.fn();
  const move = vi.fn();
  const line = vi.fn();
  const configure = vi.fn();
  const update = vi.fn();
  const measure = (text: string) => ({ width: text.length * 6, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 6,
    actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 6 });
  const fixture = {
    width,
    ctx: { save() {}, restore() {}, measureText: measure, fillText: paint, beginPath() {}, moveTo: move, lineTo: line, stroke() {} },
    chartArea: { left: 80, right: width, top: 0, bottom: 200, width: width - 80, height: 200 },
    options: { font: { family: "sans-serif", size: 12, lineHeight: "16px" } },
    scales: { x: { left: 80, right: width, top: 200, bottom: 224, width: width - 80, height: 24,
      configure, update, getPixelForValue: (value: number) => value * 10 },
      y: { getPixelForValue: (value: number) => 25 + value * rowSpacing } },
    getDatasetMeta: (index: number) => ({ data: result.rows.map((row, rowIndex) => ({ x: (row.values[index] ?? 0) * 10, y: 25 + rowIndex * rowSpacing })) }),
  };
  const chart = fixture as unknown as Chart<"line">;
  return { fixture, chart, plugin, paint, move, line, configure, update };
}

describe("dot plot presentation", () => {
  it("uses category indices for separate duplicate rows, hollow then filled native markers and a value axis away from zero", () => {
    const result = ready();
    const configuration = dotConfiguration(result, colors, ["red", "blue"]);
    expect(configuration.type).toBe("line");
    expect(configuration.options?.indexAxis).toBe("y");
    expect(configuration.options?.scales?.y?.type).toBe("category");
    expect(configuration.options?.scales?.x).toMatchObject({ type: "linear", beginAtZero: false, suggestedMin: 9.9, suggestedMax: 13.6 });
    expect(configuration.data.labels).toEqual(["Repeated", "Repeated", "Full category label with several long words"]);
    expect(configuration.data.datasets[0]).toMatchObject({ data: [12.5, 11.1, null], showLine: false, backgroundColor: "transparent", borderColor: "red", pointStyle: "circle" });
    expect(configuration.data.datasets[1]).toMatchObject({ data: [9.9, 13.6, null], showLine: false, backgroundColor: "blue", borderColor: "blue", pointStyle: "circle" });
    expect(configuration.options?.plugins?.legend?.labels).toMatchObject({ usePointStyle: true, pointStyle: "circle" });
    const single = dotConfiguration(ready([{ field: "old" }], false), colors, ["red"]);
    expect(single.data.datasets[0]?.backgroundColor).toBe("red");
    expect(configuration.options?.interaction).toEqual({ mode: "index", axis: "y", intersect: false });
  });

  it("keeps declared minimum ranges, widened references and shared units on the same native value axis", () => {
    const fixed = dotConfiguration(ready([{ field: "old", range: [8, 15], reference: 14 }], false), colors, []);
    expect(fixed.options?.scales?.x).toMatchObject({ min: 8, max: 15 });
    const widened = dotConfiguration(ready([{ field: "old", range: [10, 12], reference: 20 }], false), colors, []);
    expect(widened.options?.scales?.x).toMatchObject({ min: 10, suggestedMax: 20 });
    expect(widened.options?.scales?.x?.max).toBeUndefined();
    const configuration = dotConfiguration(ready(), colors, []);
    const ticks = configuration.options?.scales?.x?.ticks as { callback: (value: number) => string };
    expect(ticks.callback(10)).toBe("10 %");
    const mixed = dotConfiguration(ready([{ field: "old", unit: "ms" }, { field: "today", unit: "%" }]), colors, []);
    const mixedTicks = mixed.options?.scales?.x?.ticks as typeof ticks;
    expect(mixedTicks.callback(10)).toBe("10");
    const empty = dotConfiguration(ready([{ field: "old" }, { field: "today", unit: "" }]), colors, []);
    const emptyTicks = empty.options?.scales?.x?.ticks as typeof ticks;
    expect(emptyTicks.callback(10)).toBe("10");
  });

  it("keeps native rounded ticks while preventing rounding alone from including zero", () => {
    const result = ready();
    const finish = (domain: [number, number], min: number, max: number, values: number[]) => {
      const hook = dotConfiguration({ ...result, domain }, colors, []).options?.scales?.x?.afterBuildTicks;
      if (hook === undefined) throw new Error("Value scale tick hook is absent");
      const scale = { min, max, ticks: values.map(value => ({ value })) };
      hook(scale as Parameters<typeof hook>[0]);
      return scale;
    };
    expect(finish([0.01, 0.09], 0, 0.1, [0, 0.02, 0.04, 0.06, 0.08, 0.1])).toEqual({ min: 0.01, max: 0.1,
      ticks: [0.02, 0.04, 0.06, 0.08, 0.1].map(value => ({ value })) });
    expect(finish([-0.09, -0.01], -0.1, 0, [-0.1, -0.08, -0.06, -0.04, -0.02, 0])).toEqual({ min: -0.1, max: -0.01,
      ticks: [-0.1, -0.08, -0.06, -0.04, -0.02].map(value => ({ value })) });
    expect(finish([0, 0.09], 0, 0.1, [0, 0.05, 0.1]).min).toBe(0);
    expect(finish([0.01, 0.01], 0, 0.02, [0, 0.01, 0.02]).min).toBe(0.01);
  });

  it("formats joined direction in axis order, unjoined mapping order, equal values and single surviving values", () => {
    const result = ready();
    expect(dotRowValues(result, result.rows[0]!)).toBe("9.9 % ← 12.5 %");
    expect(dotRowValues(result, result.rows[1]!)).toBe("11.1 % → 13.6 %");
    expect(dotRowValues(result, { ...result.rows[0]!, values: [12.5, 12.5] })).toBe("12.5 % → 12.5 %");
    expect(dotRowValues({ ...result, config: { ...result.config, connect: false } }, result.rows[0]!)).toBe("12.5 % · 9.9 %");
    expect(dotRowValues(result, { ...result.rows[0]!, values: [null, 9.9] })).toBe("9.9 %");
    expect(dotCategoryValues(result, result.rows[0]!).map(({ label, value }) => [label, value])).toEqual([["Old", "12.5 %"], ["Today", "9.9 %"]]);
  });

  it("keeps full tooltip content in mapping order, including literal notes and long values, while wrapping to the canvas", () => {
    const result = ready();
    const configuration = dotConfiguration(result, colors, []);
    const callbacks = configuration.options?.plugins?.tooltip?.callbacks as unknown as {
      label: (this: unknown, item: { dataIndex: number }) => string[];
      title: (this: unknown, items: { dataIndex: number }[]) => string[];
    };
    const context = { chart: { width: 150, ctx: { save() {}, restore() {}, measureText: (text: string) => ({ width: text.length * 6 }) } } };
    expect(callbacks.label.call(context, { dataIndex: 1 })).toEqual(["Old: 11.1 %", "Today: 13.6 %", "<b>+2.5</b>"]);
    expect(callbacks.label.call(context, { dataIndex: 2 }).join("")).toBe('{"reason":"missing"}');
    expect(callbacks.title.call(context, [{ dataIndex: 2 }]).join("")).toBe(result.rows[2]?.label);
    const huge = { ...result, rows: [{ ...result.rows[0]!, values: [1e308, null], note: "Full note that must not be lost" }] };
    const hugeCallbacks = dotConfiguration(huge, colors, []).options?.plugins?.tooltip?.callbacks as unknown as typeof callbacks;
    const lines = hugeCallbacks.label.call(context, { dataIndex: 0 });
    expect(lines.join("")).toBe(`Old: ${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 12 }).format(1e308)} %Full note that must not be lost`);
    expect(lines.every(text => text.length * 6 <= 118)).toBe(true);
  });

  it("reserves row text outside dots, preserves full values and shortens only a note", () => {
    const baseline = ready();
    const result = { ...baseline, rows: baseline.rows.map((row, index) => index === 1 ? { ...row, note: "A very long note ".repeat(40) } : row) };
    const { fixture, chart, plugin, paint, configure, update } = drawing(result);
    plugin.afterLayout?.(chart, {}, {});
    expect(fixture.chartArea.width).toBeGreaterThanOrEqual(120);
    expect(fixture.scales.x.right).toBe(fixture.chartArea.right);
    expect(configure).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(fixture.chartArea.width, 24,
      { left: 80, right: 600 - fixture.chartArea.right, top: 0, bottom: 0, width: fixture.chartArea.width, height: 24 });
    plugin.afterDatasetsDraw?.(chart, {}, {}, false);
    expect(paint.mock.calls.map(call => call[0])).toContain("9.9 % ← 12.5 %");
    expect(paint.mock.calls.map(call => call[0])).toContain("11.1 % → 13.6 %");
    expect(paint.mock.calls.some(call => String(call[0]).startsWith("A very long note") && String(call[0]).endsWith("…"))).toBe(true);
    expect(paint.mock.calls.every(call => Number(call[1]) >= fixture.chartArea.right + 12)).toBe(true);
    expect(paint.mock.calls.every(call => Number(call[1]) + String(call[0]).length * 6 <= 600)).toBe(true);
  });

  it("omits row text instead of truncating values when width or row spacing cannot hold it", () => {
    const baseline = ready();
    const result = { ...baseline, rows: [{ ...baseline.rows[0]!, values: [1e308, null] }, baseline.rows[1]!] };
    const narrow = drawing(result, 400);
    narrow.plugin.afterLayout?.(narrow.chart, {}, {});
    narrow.plugin.afterDatasetsDraw?.(narrow.chart, {}, {}, false);
    expect(narrow.paint.mock.calls.map(call => call[0])).not.toContain(dotRowValues(result, result.rows[0]!));
    expect(narrow.paint.mock.calls.map(call => call[0])).toContain("11.1 % → 13.6 %");
    const dense = drawing(baseline, 600, 3);
    dense.plugin.afterLayout?.(dense.chart, {}, {});
    dense.plugin.afterDatasetsDraw?.(dense.chart, {}, {}, false);
    expect(dense.paint.mock.calls.map(call => call[0])).toContain("9.9 % ← 12.5 %");
    expect(dense.paint.mock.calls.map(call => call[0])).not.toContain("11.1 % → 13.6 %");
  });

  it("keeps fitting values when a note's glyph ink overhangs its measured advance", () => {
    const baseline = ready([{ field: "today", unit: "%" }], false);
    const result = { ...baseline, rows: [{ ...baseline.rows[0]!, values: [83.5], note: "Stored note with overhanging glyphs" }] };
    const { fixture, chart, plugin, paint } = drawing(result, 300);
    fixture.ctx.measureText = text => ({ width: text.length * 6, actualBoundingBoxLeft: text ? 1 : 0,
      actualBoundingBoxRight: text.length * 6 + (/[A-Za-z…]/u.test(text) ? 20 : 1),
      actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 6 });
    plugin.afterLayout?.(chart, {}, {});
    plugin.afterDatasetsDraw?.(chart, {}, {}, false);
    expect(paint.mock.calls.map(call => call[0])).toContain("83.5 %");
    expect(paint.mock.calls.every(call => Number(call[1]) >= fixture.chartArea.right + 12)).toBe(true);
    expect(paint.mock.calls.every(call => Number(call[1]) + fixture.ctx.measureText(String(call[0])).actualBoundingBoxRight <= 300)).toBe(true);
  });

  it("draws each reference once and connects only complete pairs behind native markers", () => {
    const baseline = ready([{ field: "old", reference: 10 }, { field: "today", reference: 10 }]);
    const result = { ...baseline, rows: [baseline.rows[0]!, { ...baseline.rows[1]!, values: [11.1, null] }] };
    const { chart, plugin, move, line } = drawing(result);
    plugin.beforeDatasetsDraw?.(chart, { cancelable: true }, {});
    expect(move.mock.calls).toEqual([[100, 0], [120, 25]]);
    expect(line.mock.calls).toEqual([[100, 200], [104, 25]]);
  });

  it("scales geometry alone at extreme values and grows defaults within height bounds", () => {
    const baseline = ready([{ field: "old", label: "Large", range: [-1e308, 1e308], reference: 1e308 }], false);
    const result = { ...baseline, coordinateDivisor: 1e308, domain: [-1, 1] as [number, number], rows: [{ id: "large", label: "Large", values: [1e308] }] };
    expect(dotConfiguration(result, colors, []).data.datasets[0]?.data).toEqual([1]);
    expect(dotConfiguration(result, colors, []).options?.scales?.x).toMatchObject({ min: -1, max: 1 });
    expect(dotCategoryValues(result, result.rows[0]!)[0]?.value).toBe(new Intl.NumberFormat(undefined, { maximumSignificantDigits: 12 }).format(1e308));
    expect(dotDefaultHeight(ready())).toBe(200);
    expect(dotDefaultHeight({ ...result, rows: Array.from({ length: 100 }, () => result.rows[0]!) })).toBe(600);
    expect(dotDiagnosticsText(ready())).toContain("1 without numeric series values");
  });

  it("uses native row hover to keep full details reachable outside the tooltip", () => {
    const result = ready();
    const selected: string[] = [];
    const hover = dotConfiguration(result, colors, [], undefined, id => selected.push(id)).options?.onHover;
    if (hover === undefined) throw new Error("Native hover callback is absent");
    const chart = {} as Chart<"line">;
    hover.call(chart, { type: "mousemove", native: null, x: 5, y: 5 }, [{ datasetIndex: 0, index: 1, element: {} as Element }], chart);
    expect(selected).toEqual(["b"]);
  });
});
