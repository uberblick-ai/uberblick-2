import type { ChartSeries, ChartSeriesMapping } from "./chart-data.js";

export interface ChartPanelRange { min: number; max: number; declared?: [number, number] }

/** Declared spans replace the line zero rule; bar groups always include zero. */
export function chartValueRanges(series: ChartSeries[], mappings: ChartSeriesMapping[], groupKeys: string[]): ChartPanelRange[] {
  const groups = new Map<string, ChartPanelRange>();
  const barGroups = new Set(groupKeys.filter((_, index) => series[index]?.type === "bar"));
  series.forEach((entry, index) => {
    const key = groupKeys[index] ?? "";
    let range = groups.get(key);
    const include = (value: number): void => {
      if (range === undefined) { range = { min: value, max: value }; groups.set(key, range); }
      else { range.min = Math.min(range.min, value); range.max = Math.max(range.max, value); }
    };
    const mapping = mappings[index];
    if (mapping?.range !== undefined) {
      include(mapping.range[0]);
      include(mapping.range[1]);
      if (range !== undefined) range.declared = [
        Math.min(range.declared?.[0] ?? mapping.range[0], mapping.range[0]),
        Math.max(range.declared?.[1] ?? mapping.range[1], mapping.range[1]),
      ];
    }
    if (mapping?.reference !== undefined) include(mapping.reference);
    for (const point of entry.points) {
      if (point.y !== null) include(point.y);
    }
  });
  for (const [key, range] of groups) {
    if (range.declared === undefined && range.min >= 0) range.min = 0;
    if (barGroups.has(key)) { range.min = Math.min(0, range.min); range.max = Math.max(0, range.max); }
  }
  return series.map((_, index) => groups.get(groupKeys[index] ?? "") ?? { min: 0, max: 1 });
}

/** Shared extrema let Chart.js choose comparable nice scales within a unit. */
export function chartPanelRanges(series: ChartSeries[], mappings: ChartSeriesMapping[] = []): ChartPanelRange[] {
  return chartValueRanges(series, mappings, series.map(entry => entry.unit || ""));
}

export interface ChartAxes {
  seriesAxes: ("y" | "yRight")[];
  leftUnit: string;
  rightUnit?: string;
  legendLabels: string[];
}

/** Mixed marks split by mark; otherwise mapping order chooses the left unit. */
export function chartAxes(series: ChartSeriesMapping[]): ChartAxes {
  const units = [...new Set(series.map((entry) => entry.unit || ""))];
  const mixed = series.some((entry) => entry.type === "bar") && series.some((entry) => entry.type !== "bar");
  const markUnit = (bar: boolean): string => {
    const markUnits = [...new Set(series.filter((entry) => (entry.type === "bar") === bar).map((entry) => entry.unit || ""))];
    return markUnits.length === 1 ? markUnits[0] ?? "" : "";
  };
  const leftUnit = mixed ? markUnit(false) : units.length < 3 ? units[0] ?? "" : "";
  const rightUnit = mixed ? markUnit(true) : units.length === 2 ? units[1] : undefined;
  return {
    seriesAxes: series.map((entry) => (mixed ? entry.type === "bar" : rightUnit !== undefined && (entry.unit || "") !== leftUnit) ? "yRight" : "y"),
    leftUnit,
    ...(rightUnit !== undefined ? { rightUnit } : {}),
    legendLabels: series.map((entry) => `${entry.label || entry.field}${units.length >= 2 && entry.unit ? ` (${entry.unit})` : ""}`),
  };
}

export function formatChartTick(value: number, unit: string, ticks: readonly { value: number }[], locale?: string): string {
  let magnitude = Math.abs(value);
  let step = Infinity;
  for (let index = 0; index < ticks.length; index += 1) {
    magnitude = Math.max(magnitude, Math.abs(ticks[index]?.value ?? 0));
    if (index > 0) {
      const delta = Math.abs((ticks[index]?.value ?? 0) - (ticks[index - 1]?.value ?? 0));
      if (delta > 0) step = Math.min(step, delta);
    }
  }
  // Preserve Chart.js's nice tick step even when Intl compacts by a locale-specific divisor.
  const maximumSignificantDigits = Number.isFinite(step) && magnitude > 0
    ? Math.min(21, Math.max(2, Math.floor(Math.log10(magnitude)) - Math.floor(Math.log10(step)) + 1))
    : 12;
  const number = new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits }).format(value);
  return `${number}${unit ? `${unit === "%" ? "" : " "}${unit}` : ""}`;
}

/** A sparse series keeps its markers, and an isolated gap value cannot disappear. */
export function chartPointRadius(points: readonly { y: number | null }[], index: number, plottedValues: number): number {
  if (points[index]?.y === undefined || points[index]?.y === null) return 0;
  if (plottedValues <= 40) return 2;
  const previous = points[index - 1]?.y;
  const next = points[index + 1]?.y;
  return (previous === undefined || previous === null) && (next === undefined || next === null) ? 2 : 0;
}
