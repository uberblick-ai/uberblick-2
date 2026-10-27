/** Locale formatting and accessible presentation stay in the web client. */
import type { ChartConfig, ChartProjection, ChartReady, TableProjection } from "@uberblick/schema";
export {
  CHART_RECORD_LIMIT, CHART_MIN_HEIGHT, CHART_MAX_HEIGHT, chartDate,
  parseChartConfig, prepareChart,
} from "@uberblick/schema";
export type {
  ChartConfig, ChartProjection, ChartReady, ChartSeries, ChartSeriesMapping,
} from "@uberblick/schema";

const DAY = 86_400_000;

export function chartNumberFormatter(locale?: string): (value: number) => string {
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 12 }).format;
}

/** A full table needs at most four date shapes, rather than one Intl instance per cell. */
export function chartDateFormatter(locale?: string): (value: number) => string {
  const dates = new Map<number, Intl.DateTimeFormat>();
  return (value) => {
    const date = new Date(value);
    const era = date.getUTCFullYear() <= 0;
    const intraday = value % DAY !== 0;
    const key = Number(era) + 2 * Number(intraday);
    let formatter = dates.get(key);
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat(locale, {
        timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
        ...(era ? { era: "short" } as const : {}),
        ...(intraday ? { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" } as const : {}),
      });
      dates.set(key, formatter);
    }
    return formatter.format(date);
  };
}

export function formatChartNumber(value: number, locale?: string): string {
  return chartNumberFormatter(locale)(value);
}
export function formatChartX(value: number, type: ChartConfig["x"]["type"], locale?: string): string {
  return type === "number" ? formatChartNumber(value, locale) : chartDateFormatter(locale)(value);
}
export function chartAccessibleName(config: ChartConfig): string {
  const bars = config.y.filter((series) => series.type === "bar").length;
  const kind = bars === config.y.length ? "Bar" : bars > 0 ? "Line and bar" : "Line";
  return config.title || `${kind} chart of ${config.y.map((series) => series.label || series.field).join(", ")} by ${config.x.label || config.x.field}`;
}
export function chartAccessibleDescription(chart: ChartReady, locale?: string): string {
  const latest = chart.series.map((series) => {
    const point = series.points.findLast((candidate) => candidate.y !== null);
    return `${series.label}: ${point?.y !== undefined && point.y !== null ? `${formatChartNumber(point.y, locale)}${series.unit ? ` ${series.unit}` : ""}` : "no plotted value"}`;
  });
  return `${chart.plottedCount} plotted ${chart.plottedCount === 1 ? "record" : "records"}. First ${chart.config.x.label || chart.config.x.field}: ${formatChartX(chart.firstX, chart.config.x.type, locale)}. Last: ${formatChartX(chart.lastX, chart.config.x.type, locale)}. Latest values: ${latest.join("; ")}.`;
}
export function chartDiagnosticsText(chart: ChartProjection | TableProjection): string {
  const counts = "diagnostics" in chart ? chart.diagnostics : undefined;
  if (counts === undefined) return "";
  const reasons = [
    [counts.invalidSchema, "invalid under the collection schema"],
    [counts.missingX, "absent or null x"],
    [counts.invalidX, "wrong-type or invalid x"],
    [counts.noNumericY, "without numeric y values"],
    [counts.limited, "outside the latest 5,000"],
  ] as const;
  const omitted = reasons.filter(([count]) => count > 0).map(([count, reason]) => `${count} ${reason}`).join("; ");
  const values = counts.series.flatMap((series) => [
    ...(series.missing > 0 ? [`${series.label}: ${series.missing} absent or null`] : []),
    ...(series.invalid > 0 ? [`${series.label}: ${series.invalid} wrong-type`] : []),
  ]).join("; ");
  const notPlotted = "notPlotted" in chart ? chart.notPlotted ?? 0 : 0;
  if (notPlotted === 0 && omitted === "" && values === "") return "";
  return `${notPlotted} records not plotted${omitted ? ` (${omitted})` : ""}.${values ? ` Omitted series values: ${values}.` : ""}`;
}
