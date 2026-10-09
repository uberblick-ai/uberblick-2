/** A chart derives a bounded view from the shared reader; it never repairs data. */
import { compareCodePoints } from "@uberblick/schema";
import type { DocData, JSONObject } from "@uberblick/schema";
import { bindCollection, incompatible, keys, name, numeric, object, optionalText, own } from "./view-data.js";

export const CHART_RECORD_LIMIT = 5_000;

export interface ChartSeriesMapping { field: string; label?: string; unit?: string }
export interface ChartConfig {
  version: 1;
  type: "line";
  collection: string;
  x: { field: string; type: "number" | "date"; label?: string };
  y: ChartSeriesMapping[];
  title?: string;
  missing: "gap" | "connect";
}
export interface ChartPoint { x: number; y: number | null; id: string }
export interface ChartSeries { field: string; label: string; unit?: string; points: ChartPoint[] }
export interface ChartDiagnostics {
  invalidSchema: number;
  missingX: number;
  invalidX: number;
  noNumericY: number;
  /** Older records having a numeric y; missing-only rows are counted above. */
  limited: number;
  series: { label: string; missing: number; invalid: number }[];
}
export interface ChartReady {
  status: "ready";
  config: ChartConfig;
  series: ChartSeries[];
  recordCount: number;
  eligibleCount: number;
  plottedCount: number;
  firstX: number;
  lastX: number;
  notPlotted: number;
  diagnostics: ChartDiagnostics;
  notice?: string;
}
export interface ChartProblem {
  status: "invalid-configuration" | "collection-absent" | "collection-unusable" | "mapping-incompatible" | "no-records";
  message: string;
  diagnostics?: ChartDiagnostics;
  notPlotted?: number;
  notice?: string;
}
export type ChartProjection = ChartReady | ChartProblem;

export function parseChartConfig(source: string):
  { ok: true; config: ChartConfig } | { ok: false; message: string } {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return { ok: false, message: "Invalid chart configuration: source must be JSON." }; }
  if (!object(value) || !keys(value, ["version", "type", "collection", "x", "y", "title", "missing"]) ||
      value.version !== 1 || value.type !== "line" || !name(value.collection) ||
      !object(value.x) || !keys(value.x, ["field", "type", "label"]) ||
      !name(value.x.field) || (value.x.type !== "number" && value.x.type !== "date") ||
      !optionalText(value.x, "label") || !Array.isArray(value.y) || value.y.length < 1 || value.y.length > 8 ||
      !value.y.every((series: unknown) => object(series) && keys(series, ["field", "label", "unit"]) &&
        name(series.field) && optionalText(series, "label") && optionalText(series, "unit")) ||
      !optionalText(value, "title") ||
      (Object.hasOwn(value, "missing") && value.missing !== "gap" && value.missing !== "connect")) {
    return { ok: false, message: "Invalid chart configuration: expected a version 1 line mapping with one x field and one to eight y series; unknown keys are not supported." };
  }
  // Defaulting is a detached view value, never a write to the source block.
  return { ok: true, config: { ...value, missing: value.missing ?? "gap" } as ChartConfig };
}

const DAY = 86_400_000;
// RFC 3339's complete-date/date-time grammar, with an explicit timezone. Native
// Date parsing alone accepts nonstandard strings and normalizes impossible days.
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2}))?$/;
// Announced UTC leap-second boundaries, from IERS Bulletin 72 (July 2026):
// https://hpiers.obspm.fr/iers/bul/bulc/Leap_Second.dat
const LEAP_SECOND_BOUNDARIES = new Set([
  "1972-07-01", "1973-01-01", "1974-01-01", "1975-01-01", "1976-01-01", "1977-01-01", "1978-01-01",
  "1979-01-01", "1980-01-01", "1981-07-01", "1982-07-01", "1983-07-01", "1985-07-01", "1988-01-01",
  "1990-01-01", "1991-01-01", "1992-07-01", "1993-07-01", "1994-07-01", "1996-01-01", "1997-07-01",
  "1999-01-01", "2006-01-01", "2009-01-01", "2012-07-01", "2015-07-01", "2017-01-01",
]);

/** ISO date-only values are UTC days; RFC 3339 offsets identify the same instant. */
export function chartDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DATE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(0);
  // setUTCFullYear handles 0000..0099 without Date.UTC's 1900 offset.
  instant.setUTCFullYear(year, month - 1, day);
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) return null;
  if (match[4] === undefined) return instant.getTime();
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] === undefined ? 0 : Number(`0.${match[7]}`) * 1_000;
  const zone = match[8] ?? "";
  const offsetHours = /^[Zz]$/.test(zone) ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = /^[Zz]$/.test(zone) ? 0 : Number(zone.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 60 || offsetHours > 23 || offsetMinutes > 59) return null;
  const offset = (offsetHours * 60 + offsetMinutes) * 60_000 * (zone.startsWith("-") ? -1 : 1);
  const result = instant.getTime() + hour * 3_600_000 + minute * 60_000 + second * 1_000 + fraction - offset;
  if (second === 60) {
    // Unix milliseconds cannot represent a leap second separately. It occupies
    // the following instant; keep both records if another observation ties it.
    // RFC 3339 permits :60 only when a leap second occurred, with shifted offsets.
    const next = new Date(result - fraction);
    if (!LEAP_SECOND_BOUNDARIES.has(next.toISOString().slice(0, 10)) ||
        next.getUTCHours() !== 0 || next.getUTCMinutes() !== 0 || next.getUTCSeconds() !== 0) return null;
  }
  return result;
}

export function projectChart(config: ChartConfig, data: DocData | null): ChartProjection {
  const binding = bindCollection(data, config.collection, "Chart");
  if (binding.status !== "ready") return binding;
  const { collection, schema } = binding;
  const badField = incompatible(schema, config.x.field, config.x.type) ? config.x.field
    : config.y.find((series) => incompatible(schema, series.field, "number"))?.field;
  if (badField !== undefined) return { status: "mapping-incompatible", message: `Chart mapping is incompatible with the schema: field “${badField}” is missing or has an incompatible type.` };

  const diagnostics: ChartDiagnostics = {
    invalidSchema: 0, missingX: 0, invalidX: 0, noNumericY: 0, limited: 0,
    series: config.y.map((series) => ({ label: series.label || series.field, missing: 0, invalid: 0 })),
  };
  const invalid = new Set(collection.invalidRecordIds);
  const rows: { id: string; x: number; values: unknown[]; hasY: boolean }[] = [];
  for (const record of collection.records) {
    if (invalid.has(record.id) || !object(record.value)) { diagnostics.invalidSchema += 1; continue; }
    const rawX = own(record.value as JSONObject, config.x.field);
    if (rawX === undefined || rawX === null) { diagnostics.missingX += 1; continue; }
    const x = config.x.type === "number" ? (numeric(rawX) ? rawX : null) : chartDate(rawX);
    if (x === null) { diagnostics.invalidX += 1; continue; }
    const values = config.y.map((series) => own(record.value as JSONObject, series.field));
    const hasY = values.some(numeric);
    if (!hasY) diagnostics.noNumericY += 1;
    rows.push({ id: record.id, x, values, hasY });
  }
  rows.sort((a, b) => a.x - b.x || compareCodePoints(a.id, b.id));
  const excluded = Math.max(0, rows.length - CHART_RECORD_LIMIT);
  diagnostics.limited = rows.slice(0, excluded).filter((row) => row.hasY).length;
  const selected = rows.slice(excluded);
  const series: ChartSeries[] = config.y.map((mapping, index) => ({
    field: mapping.field,
    label: mapping.label || mapping.field,
    ...(mapping.unit !== undefined ? { unit: mapping.unit } : {}),
    points: selected.flatMap((row): ChartPoint[] => {
      const value = row.values[index];
      if (numeric(value)) return [{ x: row.x, y: value, id: row.id }];
      const count = diagnostics.series[index];
      if (value === undefined || value === null) {
        if (count !== undefined) count.missing += 1;
        return config.missing === "connect" ? [] : [{ x: row.x, y: null, id: row.id }];
      }
      if (count !== undefined) count.invalid += 1;
      // Wrong types never become zero or a bridge authorized only for absence.
      return [{ x: row.x, y: null, id: row.id }];
    }),
  }));
  const plotted = selected.filter((row) => row.hasY);
  const notice = excluded > 0 ? { notice: `Showing the latest 5,000 of ${rows.length} records` } : {};
  const notPlotted = collection.records.length - plotted.length;
  const first = plotted[0];
  const last = plotted[plotted.length - 1];
  if (first === undefined || last === undefined) return {
    status: "no-records", message: "No plottable records in this chart collection.", diagnostics, notPlotted, ...notice,
  };
  return {
    status: "ready", config, series, recordCount: collection.records.length, eligibleCount: rows.length,
    plottedCount: plotted.length, firstX: first.x, lastX: last.x, notPlotted, diagnostics, ...notice,
  };
}

export function prepareChart(source: string, data: DocData | null): ChartProjection {
  const parsed = parseChartConfig(source);
  return parsed.ok ? projectChart(parsed.config, data) : { status: "invalid-configuration", message: parsed.message };
}

export function formatChartNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 12 }).format(value);
}
export function formatChartX(value: number, type: ChartConfig["x"]["type"], locale?: string): string {
  if (type === "number") return formatChartNumber(value, locale);
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
    ...(date.getUTCFullYear() <= 0 ? { era: "short" } as const : {}),
    ...(value % DAY === 0 ? {} : { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" } as const),
  }).format(date);
}
export function chartAccessibleName(config: ChartConfig): string {
  return config.title || `Line chart of ${config.y.map((series) => series.label || series.field).join(", ")} by ${config.x.label || config.x.field}`;
}
export function chartAccessibleDescription(chart: ChartReady, locale?: string): string {
  const latest = chart.series.map((series) => {
    const point = series.points.findLast((candidate) => candidate.y !== null);
    return `${series.label}: ${point?.y !== undefined && point.y !== null ? `${formatChartNumber(point.y, locale)}${series.unit ? ` ${series.unit}` : ""}` : "no plotted value"}`;
  });
  return `${chart.plottedCount} plotted ${chart.plottedCount === 1 ? "record" : "records"}. First ${chart.config.x.label || chart.config.x.field}: ${formatChartX(chart.firstX, chart.config.x.type, locale)}. Last: ${formatChartX(chart.lastX, chart.config.x.type, locale)}. Latest values: ${latest.join("; ")}.`;
}
export function chartDiagnosticsText(chart: ChartProjection): string {
  const counts = chart.diagnostics;
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
  if ((chart.notPlotted ?? 0) === 0 && omitted === "" && values === "") return "";
  return `${chart.notPlotted ?? 0} records not plotted${omitted ? ` (${omitted})` : ""}.${values ? ` Omitted series values: ${values}.` : ""}`;
}
