import { describe, expect, it } from "vitest";
import { chartAxes, chartPanelRanges, chartValueRanges, chartPointRadius, formatChartTick } from "../src/editor/chart-presentation.js";
import type { ChartSeries } from "../src/editor/chart-data.js";

describe("panel unit ranges", () => {
  const series = (values: (number | null)[], unit?: string, type: ChartSeries["type"] = "line"): ChartSeries => ({
    field: "value", label: "Value", type, ...(unit !== undefined ? { unit } : {}),
    points: values.map((y, x) => ({ x, y, id: String(x) })),
  });

  it("shares nonadjacent units and treats absent and empty units as one group", () => {
    expect(chartPanelRanges([series([20, 40], "%"), series([1_000], "ms"), series([null, 90], "%"), series([5]), series([12], "")])).toEqual([
      { min: 0, max: 90 }, { min: 0, max: 1_000 }, { min: 0, max: 90 }, { min: 0, max: 12 }, { min: 0, max: 12 },
    ]);
  });

  it("applies the zero rule per group, keeping all-negative ranges below zero", () => {
    expect(chartPanelRanges([series([-10, -2], "ms"), series([20], "%"), series([-8], "ms"), series([-1, 4])])).toEqual([
      { min: -10, max: -2 }, { min: 0, max: 20 }, { min: -10, max: -2 }, { min: -1, max: 4 },
    ]);
  });

  it("retains empty panels and shares degenerate extrema for native scale expansion", () => {
    const ranges = chartPanelRanges([series([null]), series([0], "%"), series([-10], "ms"), series([null], "ms")]);
    expect(ranges).toEqual([{ min: 0, max: 1 }, { min: 0, max: 0 }, { min: -10, max: -10 }, { min: -10, max: -10 }]);
  });

  it("includes zero in negative unit groups containing any bar panel, including empty bars", () => {
    expect(chartPanelRanges([
      series([-10, -2], "ms"), series([-8], "ms", "bar"),
      series([-20], "%"), series([null], "%", "bar"),
      series([-4], undefined, "bar"), series([-1], ""), series([-9], "s"),
    ])).toEqual([
      { min: -10, max: 0 }, { min: -10, max: 0 },
      { min: -20, max: 0 }, { min: -20, max: 0 },
      { min: -4, max: 0 }, { min: -4, max: 0 }, { min: -9, max: -9 },
    ]);
  });

  it("unions declared spans per unit, replaces zero and widens for data and references in any group member", () => {
    expect(chartPanelRanges([
      series([60, 90], "%"), series([2, 5], "ms"), series([null], "%"), series([-5, 110], "%"),
    ], [
      { field: "value", range: [50, 100] }, { field: "value", range: [1, 7] },
      { field: "value", range: [40, 80], reference: 120 }, { field: "value" },
    ])).toEqual([
      { min: -5, max: 120, declared: [40, 100] }, { min: 1, max: 7, declared: [1, 7] },
      { min: -5, max: 120, declared: [40, 100] }, { min: -5, max: 120, declared: [40, 100] },
    ]);
  });

  it("preserves exact positive and negative spans, even for an empty series", () => {
    expect(chartPanelRanges([series([60, 90]), series([null], "ms"), series([-39, 15], "%")], [
      { field: "value", range: [50, 100] }, { field: "value", range: [-7, -1] }, { field: "value", range: [-100, 100] },
    ])).toEqual([
      { min: 50, max: 100, declared: [50, 100] }, { min: -7, max: -1, declared: [-7, -1] }, { min: -100, max: 100, declared: [-100, 100] },
    ]);
  });

  it("includes reference-only values in the shared range while retaining automatic zero scaling", () => {
    expect(chartPanelRanges([series([60, 90]), series([null]), series([-10], "ms")], [
      { field: "value" }, { field: "value", reference: -20 }, { field: "value", reference: -1 },
    ])).toEqual([{ min: -20, max: 90 }, { min: -20, max: 90 }, { min: -10, max: -1 }]);
  });

  it("combines overlay ranges by assigned axis rather than by unit", () => {
    expect(chartValueRanges([series([3], "%"), series([4], "ms"), series([5], "requests")], [
      { field: "value", range: [1, 7] }, { field: "value", range: [-20, 20] }, { field: "value", reference: 30 },
    ], ["y", "y", "y"])).toEqual(Array.from({ length: 3 }, () => ({ min: -20, max: 30, declared: [-20, 20] })));
  });

  it("widens declared positive and negative spans to zero for every unit group containing bars", () => {
    expect(chartPanelRanges([
      series([60], "%"), series([null], "%", "bar"), series([-5], "ms", "bar"), series([3], "s"),
    ], [
      { field: "value", range: [50, 100], reference: 120 }, { field: "value", type: "bar" },
      { field: "value", type: "bar", range: [-10, -1] }, { field: "value", range: [1, 7] },
    ])).toEqual([
      { min: 0, max: 120, declared: [50, 100] }, { min: 0, max: 120, declared: [50, 100] },
      { min: -10, max: 0, declared: [-10, -1] }, { min: 1, max: 7, declared: [1, 7] },
    ]);
  });

  it("widens declared bar axes to zero while preserving a mixed chart's independent line range", () => {
    const mappings = [
      { field: "responses", type: "bar" as const, unit: "count", range: [-10, -1] as [number, number] },
      { field: "score", unit: "%", range: [50, 100] as [number, number] },
      { field: "more", type: "bar" as const, unit: "other", reference: -0.5 },
    ];
    expect(chartValueRanges([
      series([-5], "count", "bar"), series([60], "%"), series([null], "other", "bar"),
    ], mappings, chartAxes(mappings).seriesAxes)).toEqual([
      { min: -10, max: 0, declared: [-10, -1] }, { min: 50, max: 100, declared: [50, 100] },
      { min: -10, max: 0, declared: [-10, -1] },
    ]);
  });
});

describe("chart axis and legend units", () => {
  it("keeps a single shared unit on the axis and names even a single series", () => {
    expect(chartAxes([{ field: "latency", label: "Latency", unit: "ms" }])).toEqual({
      seriesAxes: ["y"], leftUnit: "ms", legendLabels: ["Latency"],
    });
    expect(chartAxes([{ field: "first", unit: "ms" }, { field: "second", label: "", unit: "ms" }])).toEqual({
      seriesAxes: ["y", "y"], leftUnit: "ms", legendLabels: ["first", "second"],
    });
  });

  it("compares absent and empty units as one unit", () => {
    expect(chartAxes([{ field: "first" }, { field: "second", unit: "" }])).toEqual({
      seriesAxes: ["y", "y"], leftUnit: "", legendLabels: ["first", "second"],
    });
  });

  it("assigns repeated units to the first series's left unit and the other right unit", () => {
    expect(chartAxes([
      { field: "latency", label: "Latency", unit: "ms" },
      { field: "errors", label: "Errors", unit: "requests" },
      { field: "p99", unit: "ms" },
      { field: "traffic", unit: "requests" },
    ])).toEqual({
      seriesAxes: ["y", "yRight", "y", "yRight"], leftUnit: "ms", rightUnit: "requests",
      legendLabels: ["Latency (ms)", "Errors (requests)", "p99 (ms)", "traffic (requests)"],
    });
  });

  it("allows either the left or right unit to be absent", () => {
    expect(chartAxes([{ field: "count" }, { field: "latency", unit: "ms" }, { field: "other", unit: "" }])).toEqual({
      seriesAxes: ["y", "yRight", "y"], leftUnit: "", rightUnit: "ms",
      legendLabels: ["count", "latency (ms)", "other"],
    });
    expect(chartAxes([{ field: "latency", unit: "ms" }, { field: "count" }])).toEqual({
      seriesAxes: ["y", "yRight"], leftUnit: "ms", rightUnit: "",
      legendLabels: ["latency (ms)", "count"],
    });
  });

  it("uses one unitless axis for three or more distinct units, including no unit", () => {
    expect(chartAxes([{ field: "latency", unit: "ms" }, { field: "count" }, { field: "rate", unit: "%" }])).toEqual({
      seriesAxes: ["y", "y", "y"], leftUnit: "", legendLabels: ["latency (ms)", "count", "rate (%)"],
    });
  });

  it("uses the existing unit rules for grouped bars", () => {
    expect(chartAxes([{ field: "first", type: "bar", unit: "ms" }, { field: "second", type: "bar", unit: "requests" }])).toEqual({
      seriesAxes: ["y", "yRight"], leftUnit: "ms", rightUnit: "requests", legendLabels: ["first (ms)", "second (requests)"],
    });
    expect(chartAxes([{ field: "first", type: "bar" }, { field: "second", type: "bar", unit: "" }])).toEqual({
      seriesAxes: ["y", "y"], leftUnit: "", legendLabels: ["first", "second"],
    });
  });

  it("puts bars right and lines left regardless of order or shared unit", () => {
    expect(chartAxes([
      { field: "responses", type: "bar", unit: "count" }, { field: "score", unit: "count" },
      { field: "other", type: "line", unit: "count" }, { field: "more", type: "bar", unit: "count" },
    ])).toEqual({
      seriesAxes: ["yRight", "y", "y", "yRight"], leftUnit: "count", rightUnit: "count",
      legendLabels: ["responses", "score", "other", "more"],
    });
  });

  it("labels mixed axes only when their own series share a unit, normalizing absent and empty", () => {
    expect(chartAxes([
      { field: "score", unit: "%" }, { field: "responses", type: "bar" },
      { field: "time", unit: "ms" }, { field: "other", type: "bar", unit: "" },
    ])).toEqual({
      seriesAxes: ["y", "yRight", "y", "yRight"], leftUnit: "", rightUnit: "",
      legendLabels: ["score (%)", "responses", "time (ms)", "other"],
    });
    expect(chartAxes([
      { field: "responses", type: "bar", unit: "count" }, { field: "score", unit: "%" },
      { field: "time", type: "bar", unit: "ms" }, { field: "other", type: "line", unit: "%" },
    ])).toEqual({
      seriesAxes: ["yRight", "y", "yRight", "y"], leftUnit: "%", rightUnit: "",
      legendLabels: ["responses (count)", "score (%)", "time (ms)", "other (%)"],
    });
  });
});

describe("compact chart ticks", () => {
  function labels(values: number[], unit = "", locale = "en-US"): string[] {
    const ticks = values.map(value => ({ value }));
    return values.map(value => formatChartTick(value, unit, ticks, locale));
  }

  it("keeps broad ranges compact and appends the axis unit", () => {
    expect(labels([0, 500_000, 1_000_000, 1_500_000], "EUR")).toEqual(["0 EUR", "500K EUR", "1M EUR", "1.5M EUR"]);
    expect(labels([0, 6_000, 12_000])).toEqual(["0", "6K", "12K"]);
    expect(labels([-1_500_000, -1_000_000, -500_000], "EUR")).toEqual(["-1.5M EUR", "-1M EUR", "-500K EUR"]);
  });

  it("attaches percent directly without scaling the value", () => {
    expect(labels([0, 30, 60, 90], "%")).toEqual(["0%", "30%", "60%", "90%"]);
    expect(labels([0, 0.05, 0.1, 0.15], "%")).toEqual(["0%", "0.05%", "0.1%", "0.15%"]);
  });

  it.each([
    [[1_000, 1_050, 1_100, 1_150, 1_200], "", ["1K", "1.05K", "1.1K", "1.15K", "1.2K"]],
    [[99.9, 99.92, 99.94, 99.96, 99.98, 100], "%", ["99.9%", "99.92%", "99.94%", "99.96%", "99.98%", "100%"]],
    [[0.05, 0.1, 0.15, 0.2, 0.25], "s", ["0.05 s", "0.1 s", "0.15 s", "0.2 s", "0.25 s"]],
    [[0, 0.05, 0.1, 0.15], "", ["0", "0.05", "0.1", "0.15"]],
    [[1_200_000, 1_220_000, 1_240_000, 1_260_000, 1_280_000, 1_300_000], "EUR", ["1.2M EUR", "1.22M EUR", "1.24M EUR", "1.26M EUR", "1.28M EUR", "1.3M EUR"]],
    [[-1_200, -1_150, -1_100, -1_050, -1_000], "", ["-1.2K", "-1.15K", "-1.1K", "-1.05K", "-1K"]],
    [[0, 0.1, 0.1 + 0.2, 0.4], "", ["0", "0.1", "0.3", "0.4"]],
  ] as const)("preserves the scale's tick precision for %j", (values, unit, expected) => {
    expect(labels([...values], unit)).toEqual(expected);
  });

  it("preserves fine steps across each locale's compact thresholds", () => {
    const values = [10_000, 10_050, 10_100, 10_150, 10_200];
    expect(labels(values, "", "ja-JP")).toEqual(["1万", "1.005万", "1.01万", "1.015万", "1.02万"]);
    expect(labels([99.9, 99.92, 99.94], "%", "de-DE")).toEqual(["99,9%", "99,92%", "99,94%"]);
  });

  it("retains numeric precision when there is no tick step", () => {
    expect(formatChartTick(0.125, "%", [{ value: 0.125 }], "en-US")).toBe("0.125%");
    expect(formatChartTick(0, "", [{ value: 0 }], "en-US")).toBe("0");
  });
});

describe("chart point visibility", () => {
  it("shows points through 40 plotted series values, and hides a dense 41-value series", () => {
    const forty = Array.from({ length: 40 }, (_, y) => ({ y }));
    expect(forty.every((_, index) => chartPointRadius(forty, index, 40) === 2)).toBe(true);
    const dense = [...forty, { y: 40 }];
    expect(dense.every((_, index) => chartPointRadius(dense, index, 41) === 0)).toBe(true);
  });

  it("counts numeric values per series rather than all records or gap placeholders", () => {
    const sparse = Array.from({ length: 60 }, (_, index) => ({ y: index === 20 || index === 21 ? index : null }));
    expect(chartPointRadius(sparse, 20, 2)).toBe(2);
    expect(chartPointRadius(sparse, 21, 2)).toBe(2);
    expect(chartPointRadius(sparse, 19, 2)).toBe(0);
  });

  it("keeps an isolated zero between gaps and at either edge of a long series", () => {
    const dense = Array.from({ length: 41 }, (_, y) => ({ y }));
    const points = [{ y: 0 }, { y: null }, ...dense, { y: null }, { y: 0 }, { y: null }, { y: 0 }];
    expect(chartPointRadius(points, 0, 44)).toBe(2);
    expect(chartPointRadius(points, 44, 44)).toBe(2);
    expect(chartPointRadius(points, 46, 44)).toBe(2);
    expect(chartPointRadius(points, 2, 44)).toBe(0);
    expect(chartPointRadius(points, 1, 44)).toBe(0);
  });

  it("does not treat removed connect placeholders as gaps", () => {
    const gap = [...Array.from({ length: 41 }, (_, y) => ({ y })), { y: null }, { y: 0 }, { y: null }];
    const connect = gap.filter((point) => point.y !== null);
    expect(chartPointRadius(gap, 42, 42)).toBe(2);
    expect(chartPointRadius(connect, 41, 42)).toBe(0);
  });
});
