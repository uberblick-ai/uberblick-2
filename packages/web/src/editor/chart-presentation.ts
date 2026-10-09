import type { ChartSeriesMapping } from "./chart-data.js";

export interface ChartAxes {
  seriesAxes: ("y" | "yRight")[];
  leftUnit: string;
  rightUnit?: string;
  legendLabels: string[];
}

/** The mapping order chooses the left unit; absent and empty units are equal. */
export function chartAxes(series: ChartSeriesMapping[]): ChartAxes {
  const units = [...new Set(series.map((entry) => entry.unit || ""))];
  const leftUnit = units.length < 3 ? units[0] ?? "" : "";
  const rightUnit = units.length === 2 ? units[1] : undefined;
  return {
    seriesAxes: series.map((entry) => rightUnit !== undefined && (entry.unit || "") !== leftUnit ? "yRight" : "y"),
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
