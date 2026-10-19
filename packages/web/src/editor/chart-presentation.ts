import type { ChartSeries, ChartSeriesMapping } from "./chart-data.js";

export interface ChartPanelRange { min: number; max: number }

/** Shared extrema let Chart.js choose comparable nice scales within a unit. */
export function chartPanelRanges(series: ChartSeries[]): ChartPanelRange[] {
  const groups = new Map<string, ChartPanelRange>();
  const barUnits = new Set(series.filter((entry) => entry.type === "bar").map((entry) => entry.unit || ""));
  for (const entry of series) {
    const unit = entry.unit || "";
    for (const point of entry.points) {
      if (point.y === null) continue;
      const range = groups.get(unit);
      if (range === undefined) groups.set(unit, { min: point.y, max: point.y });
      else { range.min = Math.min(range.min, point.y); range.max = Math.max(range.max, point.y); }
    }
  }
  for (const [unit, range] of groups) {
    if (range.min >= 0) range.min = 0;
    if (barUnits.has(unit)) { range.min = Math.min(0, range.min); range.max = Math.max(0, range.max); }
  }
  return series.map(entry => groups.get(entry.unit || "") ?? { min: 0, max: 1 });
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
