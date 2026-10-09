import { describe, expect, it } from "vitest";
import { chartAxes, chartPointRadius, formatChartTick } from "../src/editor/chart-presentation.js";

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
