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
  it("uses locale compact notation with at most one decimal and the axis unit", () => {
    expect(formatChartTick(1_540_000, "EUR", "en-US")).toBe("1.5M EUR");
    expect(formatChartTick(12_000, "", "en-US")).toBe("12K");
    expect(formatChartTick(-1_540_000, "EUR", "en-US")).toBe("-1.5M EUR");
    expect(formatChartTick(12_500, "", "de-DE")).toBe(new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 }).format(12_500));
  });

  it("attaches percent directly without scaling the value", () => {
    expect(formatChartTick(90, "%", "en-US")).toBe("90%");
    expect(formatChartTick(0, "%", "en-US")).toBe("0%");
    expect(formatChartTick(0.125, "%", "en-US")).toBe("0.1%");
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
